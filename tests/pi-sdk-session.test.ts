import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {z} from 'zod';
import {runStructuredAgent} from '../src/server/agent/runtime';
import type {AgentRunContext} from '../src/server/agent/types';
import type {Message} from '../src/lib/types';
import {intakeFixture} from './fixtures';
const message=(content:string,id=crypto.randomUUID()):Message=>({id,role:'user',content,createdAt:new Date().toISOString()});
const call=(name:string,args:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
async function fixture(fn:(dir:string,env:Record<string,string>)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'contract-pi-'));const old=fetch;try{await fn(dir,{CONTRACT_PI_SESSION_DIR:dir,CONTRACT_AI_API_KEY:'test-only',CONTRACT_AI_BASE_URL:'https://model.test'});}finally{globalThis.fetch=old;await rm(dir,{recursive:true,force:true});}}
const input=(environment:Record<string,string>,context:AgentRunContext)=>({prompt:'根据本次交易整理结果',messages:context.history.map(({role,content})=>({role,content})),toolName:'save_result',schema:z.object({ok:z.boolean()}),environment,context,stage:'intake' as const});

test('full SDK resumes a private session, imports old messages once, caches accepted retries and isolates owners',async()=>fixture(async(dir,env)=>{
 const history=[message('源码需要交付；9月25日开始，10月25日完成。')];
 const context={ownerId:'owner-a',contractId:'same-contract',requestId:'r1',history};let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.tool_choice,'auto');assert.deepEqual(body.tools.map((t:any)=>t.function.name).sort(),['find_transaction_history','get_legal_skill','save_result']);return call('save_result',{result:{ok:true}})};
 const first=await runStructuredAgent(input(env,context));assert.equal(first.trace.runtime,'pi-sdk');assert.equal(first.trace.resumed,false);
 const retry=await runStructuredAgent(input(env,context));assert.equal(retry.trace.resumed,true);assert.equal(calls,1);
 const longer=[...history,...Array.from({length:30},(_,i)=>message('业务补充 '+i)),message('金额改为90000元，其他约定不变')];
 globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.equal(body.messages.filter((m:any)=>m.content===history[0].content).length,1);assert.ok(body.messages.some((m:any)=>m.content===longer.at(-1)!.content));return call('save_result',{result:{ok:true}})};
 const second=await runStructuredAgent(input(env,{...context,requestId:'r2',history:longer}));assert.equal(second.trace.resumed,true);
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.ok(!JSON.stringify(body).includes('9月25日'));return call('save_result',{result:{ok:true}})};
 await runStructuredAgent(input(env,{...context,ownerId:'owner-b',history:[message('另一份保密交易')]}));
 const directories=await readdir(dir);assert.equal(directories.length,2);
 const files=await Promise.all(directories.map(d=>readFile(join(dir,d,'session.jsonl'),'utf8')));assert.ok(files.some(f=>f.includes('toolResult')));assert.ok(files.every(f=>!f.includes('test-only')));
}));

test('failed runs retain an audit branch but do not replay incomplete tools on recovery',async()=>fixture(async(dir,env)=>{
 const context={ownerId:'a',contractId:'b',requestId:'r',history:[message('采购100件') ]};let step=0;
 globalThis.fetch=async()=>{step++;if(step===1)return call('get_legal_skill',{path:'合同起草/SKILL.md'});return Response.json({choices:[{message:{content:''}}]});};
 await assert.rejects(runStructuredAgent(input(env,context)));
 globalThis.fetch=async(_url,init)=>{const b=JSON.parse(String(init?.body));assert.ok(!b.messages.some((m:any)=>m.role==='tool'));assert.equal(b.messages.filter((m:any)=>m.content==='采购100件').length,1);return call('save_result',{result:{ok:true}})};
 await runStructuredAgent(input(env,context));
 const [d]=await readdir(dir);const entries=(await readFile(join(dir,d,'session.jsonl'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.ok(entries.some(e=>e.message?.role==='toolResult'));assert.ok(entries.some(e=>e.customType==='contract_run'&&e.data.status==='completed'));
}));

test('two simultaneous runs cannot write the same contract session',async()=>fixture(async(_dir,env)=>{
 const context={ownerId:'a',contractId:'b',requestId:'r',history:[message('服务合同')]};let entered!:()=>void,finish!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>finish=r);
 globalThis.fetch=async()=>{entered();await gate;return call('save_result',{result:{ok:true}})};
 const first=runStructuredAgent(input(env,context));await ready;
 try{await assert.rejects(runStructuredAgent(input(env,{...context,requestId:'other'})),(e:any)=>e.code==='AI_SESSION_BUSY');}finally{finish();await first;}
}));

test('SDK compaction preserves access to original quotes and the latest fact ledger',async()=>fixture(async(dir,env)=>{
 const old=message('最初金额为80000元。');const history=[old,...Array.from({length:75},(_,i)=>message('背景材料'+i+'。'.repeat(1000))),message('最新更正：金额改为90000元。')];
 const transaction=intakeFixture();transaction.facts.price={value:'90000元',quote:'金额改为90000元'};
 const context={ownerId:'a',contractId:'b',requestId:'r1',history,transaction};let compacted=0,lookedUp=false;
 globalThis.fetch=async(_url,init)=>{
  const b=JSON.parse(String(init?.body));
  if(!b.tools?.length){compacted++;return Response.json({choices:[{finish_reason:'stop',message:{content:'早期记录提到80000元；存在后续更正，当前台账为准。'}}]});}
  assert.match(b.messages[0].content,/当前交易事实台账/);assert.match(b.messages[0].content,/90000元/);
  if(!lookedUp){lookedUp=true;return call('find_transaction_history',{query:'最初金额'});}
  assert.ok(b.messages.some((m:any)=>m.role==='tool'&&m.content.includes(old.content)));return call('save_result',{result:{ok:true}});
 };
 const result=await runStructuredAgent(input({...env,CONTRACT_AI_CONTEXT_WINDOW:'16000'},context));
 assert.ok(compacted>0);assert.ok(result.trace.compactions!>0);assert.ok(lookedUp);
 const [d]=await readdir(dir);const text=await readFile(join(dir,d,'session.jsonl'),'utf8');assert.match(text,/"type":"compaction"/);assert.ok(text.includes(old.content));
}));

test('ordinary model text is repaired inside the same SDK session instead of interrupting the user',async()=>fixture(async(_dir,env)=>{
 const context={ownerId:'a',contractId:'b',requestId:'r',history:[message('资料齐全，请整理')]};let n=0;
 globalThis.fetch=async(_url,init)=>{n++;if(n===1)return Response.json({choices:[{finish_reason:'stop',message:{content:'我正在整理这份合同。'}}]});const body=JSON.parse(String(init?.body));assert.ok(body.messages.some((m:any)=>m.content==='我正在整理这份合同。'));return call('save_result',{result:{ok:true}})};
 assert.equal((await runStructuredAgent(input(env,context))).value.ok,true);assert.equal(n,2);
}));

test('cancelling the workflow aborts the provider and releases the session lock',async()=>fixture(async(_dir,env)=>{
 let current=true;const context={ownerId:'a',contractId:'b',requestId:'r',history:[message('生成合同')],isCurrent:async()=>current};
 globalThis.fetch=async(_url,init)=>{current=false;return new Promise((_resolve,reject)=>{init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})});};
 await assert.rejects(runStructuredAgent(input(env,context)),(e:any)=>e.code==='AI_CANCELLED');
 current=true;globalThis.fetch=async()=>call('save_result',{result:{ok:true}});
 assert.equal((await runStructuredAgent(input(env,{...context,requestId:'retry'}))).value.ok,true);
}));


test('a new Node process restores the same SDK session without host credentials or in-process state',async()=>fixture(async(dir,env)=>{
 const history=[message('采购数量已经明确为100件。')];const context={ownerId:'restart-owner',contractId:'restart-contract',requestId:'first',history};
 globalThis.fetch=async()=>call('save_result',{result:{ok:true}});await runStructuredAgent(input(env,context));
 const script=`import {runStructuredAgent} from './src/server/agent/runtime.ts';import {z} from 'zod';
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init.body));if(!body.messages.some(m=>m.content==='采购数量已经明确为100件。'))throw new Error('history not restored');return Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};
 runStructuredAgent({prompt:'继续处理',messages:[{role:'user',content:'交付地点改为青岛。'}],schema:z.object({ok:z.boolean()}),toolName:'save_result',environment:JSON.parse(process.argv[1]),context:{ownerId:'restart-owner',contractId:'restart-contract',requestId:'second',history:[]}}).then(r=>{if(r.trace.runtime!=='pi-sdk'||!r.trace.resumed)throw new Error('not restored');console.log('restored')}).catch(()=>process.exitCode=1);`;
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','-e',script,JSON.stringify(env)]);assert.match(stdout,/restored/);
}));

test('intake and drafting default to high thinking while explicit off remains respected',async()=>fixture(async(_dir,environment)=>{
 const env={...environment,CONTRACT_AI_BASE_URL:'https://api.deepseek.com'};const seen:any[]=[];
 globalThis.fetch=async(_url,init)=>{seen.push(JSON.parse(String(init?.body)));return call('save_result',{result:{ok:true}})};
 const context={ownerId:'a',contractId:'policy',requestId:'intake',history:[message('交易事实')]};
 await runStructuredAgent(input(env,context));
 await runStructuredAgent({...input(env,{...context,requestId:'draft'}),stage:'draft'});
 await runStructuredAgent({...input({...env,CONTRACT_AI_THINKING:'off'},{...context,requestId:'explicit'})});
 for(const request of seen.slice(0,2)){assert.deepEqual(request.thinking,{type:'enabled'});assert.equal(request.reasoning_effort,'high');}assert.deepEqual(seen[2].thinking,{type:'disabled'});assert.equal(seen[2].reasoning_effort,undefined);
 assert.ok(seen[2].messages.filter((m:any)=>m.role==='assistant'&&m.tool_calls?.length).every((m:any)=>typeof m.reasoning_content==='string'));
}));
