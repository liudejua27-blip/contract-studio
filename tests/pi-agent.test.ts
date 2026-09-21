import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {runStructuredAgent} from '../src/server/agent/runtime';
import {collectIntake} from '../src/server/ai';
import {acceptSuggestions} from '../src/lib/contract-library/intake-policy';
import {CORE_FIELDS} from '../src/lib/contract-library/guided-policy';
import {intakeFixture} from './fixtures';
const env={CONTRACT_AI_API_KEY:'test',CONTRACT_AI_BASE_URL:'https://model.test'};
const call=(name:string,args:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
test('Pi executes a rule tool, sees validation failure, and corrects its terminal tool arguments',async()=>{
 const old=fetch;let n=0;
 try{globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));n++;
  if(n===1)return call('get_contract_rules',{});
  assert.ok(body.messages.some((m:any)=>m.role==='tool'));
  if(n===2)return call('save_result',{result:{amount:99}});
  assert.ok(body.messages.some((m:any)=>m.role==='tool'&&m.content.includes('金额不一致')));
  return call('save_result',{result:{amount:100}});
 };
 const result=await runStructuredAgent({prompt:'test',messages:[{role:'user',content:'100元'}],toolName:'save_result',schema:z.object({amount:z.number()}),rules:{currency:'CNY'},environment:env,validate:r=>{if(r.amount!==100)throw new Error('金额不一致')}});
 assert.equal(result.value.amount,100);assert.equal(n,3);assert.deepEqual(result.trace.tools,['get_contract_rules','save_result','save_result']);
 }finally{globalThis.fetch=old}
});
test('a model repeatedly calling tools is stopped by the finite Pi turn budget',async()=>{
 const old=fetch;let n=0;try{globalThis.fetch=async()=>{n++;return call('get_contract_rules',{})};await assert.rejects(runStructuredAgent({prompt:'test',messages:[{role:'user',content:'test'}],toolName:'save',schema:z.object({ok:z.boolean()}),rules:{},environment:env}),(e:any)=>e.code==='AI_AGENT_LIMIT');assert.equal(n,4)}finally{globalThis.fetch=old}
});
test('complete business facts produce a summary without asking legal questions; defaults stay separate',async()=>{
 const old=fetch;const i=intakeFixture();delete i.confirmedAt;for(const id of Object.keys(i.facts))if(!CORE_FIELDS.software.includes(id))delete i.facts[id];
 try{globalThis.fetch=async()=>call('update_contract_spec',{result:{templateId:'software',facts:[],conflicts:[]}});
 const r=await collectIntake([{id:'m',role:'user',content:'专业问题按常见方式处理',createdAt:''}],i,env);
 assert.deepEqual(r.intake!.missing,[]);assert.ok(r.intake!.defaults!.disputes);assert.equal(r.intake!.facts.disputes,undefined);assert.equal(acceptSuggestions(r.intake!).facts.disputes,undefined);assert.match(r.reply,/关键信息已经齐/);assert.ok(r.intake!.agentTrace!.tools.includes('update_contract_spec'));
 }finally{globalThis.fetch=old}
});
test('default policy cannot invent a price or revive an explicitly withdrawn professional term',async()=>{
 const old=fetch;const i=intakeFixture();delete i.facts.price;
 try{globalThis.fetch=async()=>call('update_contract_spec',{result:{templateId:'software',facts:[],clearedFields:['disputes'],conflicts:[],questions:[{fieldId:'disputes',question:'管辖法院选哪里？'}]}});
 const r=await collectIntake([{id:'m',role:'user',content:'价格没谈好，撤回原争议约定',createdAt:''}],i,env);
 assert.ok(r.intake!.missing.includes('price'));assert.equal(r.intake!.defaults!.disputes,undefined);assert.doesNotMatch(r.reply,/管辖法院/);assert.equal(r.intake!.facts.disputes,undefined);
 }finally{globalThis.fetch=old}
});
test('unknown payment offers a proposal once; explicit acceptance supplies facts without asking again',async()=>{
 const old=fetch;const i=intakeFixture();let payload:any={templateId:'software',facts:[],deferredFields:[{fieldId:'payment',quote:'两次付款比例没想好'}]};
 try{globalThis.fetch=async()=>call('update_contract_spec',{result:payload});
 const messages=[{id:'m',role:'user' as const,content:'两次付款比例没想好',createdAt:''}];
 const first=await collectIntake(messages,i,env);assert.equal(first.intake!.facts.payment,undefined);assert.deepEqual(first.intake!.deferredFields,['payment']);assert.equal(first.intake!.businessProposals!.length,1);assert.doesNotMatch(first.reply,/准备怎么付款/);
 const proposal=first.intake!.businessProposals![0];payload={templateId:'software',facts:[]};
 const second=await collectIntake([...messages,{id:'m2',role:'user',content:'采用建议：'+proposal.value,createdAt:''}],first.intake,env);
 assert.equal(second.intake!.facts.payment.source,'accepted_proposal');assert.equal(second.intake!.facts.payment.value,proposal.value);assert.deepEqual(second.intake!.missing,[]);assert.deepEqual(second.intake!.deferredFields,[]);
 }finally{globalThis.fetch=old}
});
test('semantic mismatches trigger at most two automatic redrafts and never export an unchecked file',async()=>{
 const {controlWorkflow}=await import('../src/server/workflow');const {contentFixture}=await import('./fixtures');
 const old=fetch;const user={id:'client',name:'test',email:'test@example.test',role:'client' as const};let rev=0,verifyCount=0;
 let c:any={id:'c',ownerId:user.id,ownerName:'test',title:'test',createdAt:'',updatedAt:'',messages:[],versions:[],reviews:[],workflow:{intake:intakeFixture(),job:{id:'j',messageId:'m',phase:'generate',status:'pending',attempt:0,createdAt:'',updatedAt:'',versionId:'v'}}};
 const store={load:async()=>({contract:structuredClone(c),revision:rev}),save:async(value:any,version:any)=>{assert.equal(version,rev);rev++;c=structuredClone(value);return c},put:async()=>{throw new Error('unchecked export')},limit:async()=>{},environment:env};
 try{globalThis.fetch=async(_url,init)=>{const b=JSON.parse(String(init?.body));const verify=b.messages[0].content.includes('CONTRACT_VERIFY_V2');if(verify)verifyCount++;return Response.json({choices:[{message:{content:JSON.stringify(verify?{verdict:'inconsistent',issues:['验收条件遗漏']}:contentFixture())}}]})};
 for(let n=0;n<8&&c.workflow.job.status!=='failed';n++)await controlWorkflow(store,user,'j','run');
 assert.equal(verifyCount,3);assert.equal(c.workflow.job.repairCount,2);assert.equal(c.workflow.job.status,'failed');assert.equal(c.versions.length,0);
 }finally{globalThis.fetch=old}
});
