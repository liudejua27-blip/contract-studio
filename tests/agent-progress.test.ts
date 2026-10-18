import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {runStructuredAgent} from '../src/server/agent/runtime';
import {mergeStageProgress,stageArguments} from '../src/server/agent/stage-progress';
import {compileTransactionUpdate,intakeSchema} from '../src/lib/transaction-update';
import {intakeFixture} from './fixtures';
const call=(result:unknown,complete=true,offsets?:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name:'save_result',arguments:JSON.stringify({result,complete,offsets})}}]}}]});
async function fixture(fn:(env:Record<string,string>)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'agent-progress-')),old=fetch;try{await fn({CONTRACT_AI_API_KEY:'test',CONTRACT_AI_BASE_URL:'https://model.test',CONTRACT_PI_SESSION_DIR:dir});}finally{globalThis.fetch=old;await rm(dir,{recursive:true,force:true});}}
const schema=z.object({title:z.string(),sections:z.array(z.object({title:z.string(),content:z.string()})).min(1)});
const input=(environment:Record<string,string>)=>({incremental:true,prompt:'整理本阶段合同',messages:[{role:'user' as const,content:'用户原话'}],toolName:'save_result',schema,stage:'draft' as const,environment});

test('partial submission preserves facts by identity and retries indexed sections idempotently',()=>{
 const old={facts:[{fieldId:'price',value:'100'},{fieldId:'payment',value:'分两期'}],sections:[{title:'范围'},{title:'日期'}]};
 const next=mergeStageProgress(old,{facts:[{fieldId:'price',value:'200'}],sections:[{title:'新日期'}]},{sections:1});
 assert.deepEqual(next.facts,[{fieldId:'price',value:'200'},{fieldId:'payment',value:'分两期'}]);
 assert.deepEqual(mergeStageProgress(next,{sections:[{title:'新日期'}]},{sections:1}),next);
 assert.throws(()=>mergeStageProgress(old,{sections:[]},{sections:5}),/skip/);
 assert.equal(stageArguments(schema).safeParse({result:{sections:[{title:'缺少正文'}]},complete:false}).success,false);
});

test('truncation changes output allowance and instruction, never executes incomplete arguments',async()=>fixture(async env=>{
 const requests:any[]=[];let validations=0;
 globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));if(requests.length===1)return Response.json({choices:[{finish_reason:'length',message:{tool_calls:[{id:'bad',type:'function',function:{name:'save_result',arguments:'{"result":'}}]}}]});return call({title:'合同',sections:[{title:'条款',content:'正文'}]});};
 const result=await runStructuredAgent({...input(env),validate:()=>{validations++;}});
 assert.equal(result.value.title,'合同');assert.equal(validations,1);assert.equal(requests.length,2);
 assert.ok(requests[1].max_tokens>requests[0].max_tokens);assert.notDeepEqual(requests[1].messages,requests[0].messages);assert.ok(!JSON.stringify(requests[1].messages).includes('"id":"bad"'));
}));

test('durable progress survives a failed run and restores in another worker with final validation',async()=>fixture(async env=>{
 let transcript:string|null=null,n=0,checked=0;
 const checkpoint={load:async()=>transcript,save:async(text:string)=>{transcript=text;}};
 const context={ownerId:'a',contractId:'b',requestId:'same',history:[],checkpoint};
 globalThis.fetch=async()=>{if(++n===1)return call({title:'已保存标题'},false);assert.ok(transcript?.includes('已保存标题'));return Response.json({error:'down'},{status:503});};
 await assert.rejects(runStructuredAgent({...input(env),context}));
 globalThis.fetch=async(_url,init)=>{const b=JSON.parse(String(init?.body));assert.match(b.messages[0].content,/已保存标题/);assert.ok(!b.messages.some((m:any)=>m.role==='tool'));return call({sections:[{title:'条款',content:'补齐正文'}]});};
 const result=await runStructuredAgent({...input({...env,CONTRACT_PI_SESSION_DIR:join(env.CONTRACT_PI_SESSION_DIR,'worker-b')}),context,validate:()=>{checked++;}});
 assert.equal(result.value.title,'已保存标题');assert.equal(checked,1);
 globalThis.fetch=async()=>{throw new Error('Accepted result must be cached');};
 assert.equal((await runStructuredAgent({...input(env),context})).value.title,'已保存标题');
}));

test('final semantic failure permits a patch without resubmitting unaffected sections',async()=>fixture(async env=>{
 let n=0;
 globalThis.fetch=async()=>{n++;return n===1?call({title:'错误标题',sections:[{title:'范围',content:'保持原文'}]}):call({title:'正确标题'});};
 const result=await runStructuredAgent({...input(env),validate:value=>{if(value.title!=='正确标题')throw new Error('修正标题');}});
 assert.equal(n,2);assert.equal(result.value.sections[0].content,'保持原文');
}));

test('new request identity cannot reuse unfinished candidate from an older user request',async()=>fixture(async env=>{
 let transcript:string|null=null,n=0;
 const context={ownerId:'a',contractId:'b',requestId:'old',history:[],checkpoint:{load:async()=>transcript,save:async(v:string)=>{transcript=v;}}};
 globalThis.fetch=async()=>++n===1?call({title:'撤回的旧标题'},false):Response.json({}, {status:400});
 await assert.rejects(runStructuredAgent({...input(env),context}));
 globalThis.fetch=async(_url,init)=>{assert.doesNotMatch(String(init?.body),/撤回的旧标题/);return call({title:'新合同',sections:[{title:'新范围',content:'新内容'}]});};
 await runStructuredAgent({...input(env),context:{...context,requestId:'new'}});
}));

test('business checks can reference existing evidence without inventing sources',()=>{
 const previous=intakeFixture();const r=intakeSchema.parse({templateId:'software',facts:[],businessChecks:[{fieldId:'payment',status:'answered',evidenceFactIds:['payment']}]});
 const result=compileTransactionUpdate(r,previous,[]);assert.ok(result.intake!.businessChecks!.find(c=>c.fieldId==='payment')!.evidence.length);assert.deepEqual(r.businessChecks[0].evidence,[]);
 r.businessChecks[0].evidenceFactIds=['invented'];assert.throws(()=>compileTransactionUpdate(r,previous,[]),/不存在/);
});

test('projection keeps the latest tool receipt and excludes older candidate arguments',async()=>fixture(async env=>{
 let n=0;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));n++;
  if(n===1)return call({title:'FIRST_CANDIDATE'},false);
  if(n===2)return call({title:'CURRENT_CANDIDATE'},false);
  assert.doesNotMatch(JSON.stringify(body.messages),/FIRST_CANDIDATE/);
  assert.equal(JSON.stringify(body.messages).split('CURRENT_CANDIDATE').length-1,2);
  assert.ok(body.messages.some((m:any)=>m.role==='tool'));
  return call({sections:[{title:'条款',content:'正文'}]});
 };
 assert.equal((await runStructuredAgent(input(env))).value.title,'CURRENT_CANDIDATE');
}));

test('exhausted truncation recovery stops at the ceiling without replaying the same request',async()=>fixture(async env=>{
 const requests:any[]=[];
 globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return Response.json({choices:[{finish_reason:'length',message:{content:'not-complete'}}]});};
 await assert.rejects(runStructuredAgent(input({...env,CONTRACT_AI_MAX_OUTPUT_TOKENS:'8000',CONTRACT_AI_MAX_RECOVERY_TOKENS:'16000'})),(e:any)=>e.code==='AI_OUTPUT_TRUNCATED');
 assert.deepEqual(requests.map(r=>r.max_tokens),[8000,16000]);
}));

test('referenced checks follow a corrected date without retaining superseded quotes',()=>{
 const previous=intakeFixture();previous.facts.deliveryDate={value:'11月20日完成',quote:'11月20日完成'};
 previous.businessChecks=[...(previous.businessChecks||[]),{fieldId:'delivery',status:'answered',evidenceFactIds:['deliveryDate'],evidence:['11月20日完成']}];
 const result=compileTransactionUpdate(intakeSchema.parse({templateId:'software',facts:[{fieldId:'deliveryDate',value:'11月27日完成',quote:'11月27日完成'}]}),previous,['11月27日完成']).intake!;
 assert.deepEqual(result.businessChecks!.find(c=>c.fieldId==='delivery')!.evidence,['11月27日完成']);assert.ok(!result.missing.includes('delivery'));
});

test('a partial correction cannot silently discard previously saved clauses',()=>{
 const old={sections:[{title:'费用',content:'正确金额'},{title:'许可',content:'权利边界'},{title:'责任',content:'保留责任'}]};
 assert.throws(()=>mergeStageProgress(old,{sections:[{title:'费用',content:'修正金额'}]}),/offsets.sections/);
 assert.deepEqual(mergeStageProgress(old,{sections:[{title:'费用',content:'修正金额'}]},{sections:0}).sections,[{title:'费用',content:'修正金额'},...old.sections.slice(1)]);
 assert.equal('offsets' in stageArguments(z.object({verdict:z.string()})).shape,false);
});
