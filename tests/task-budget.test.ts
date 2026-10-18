import test from 'node:test';
import assert from 'node:assert/strict';
import {createTaskBudget,reserveBudgetCall,settleBudgetCall,TaskBudgetError,estimateInputTokens} from '../src/lib/task-budget';
import {startWorkflow,controlWorkflow,type WorkflowStore} from '../src/server/workflow';
import {intakeFixture,contentFixture} from './fixtures';
import type {Contract,User} from '../src/lib/types';

test('task budget caps output, reconciles reported usage, and rejects exhausted calls/tokens/time',()=>{
 const b=createTaskBudget({CONTRACT_TASK_MAX_TOKENS:'100',CONTRACT_TASK_MAX_MODEL_CALLS:'2',CONTRACT_TASK_MAX_DURATION_MS:'1000'},10);
 const r=reserveBudgetCall(b,80,30,20);assert.equal(r.maxOutputTokens,20);assert.equal(r.timeoutMs,990);
 settleBudgetCall(b,r,{inputTokens:10,outputTokens:20,durationMs:50});assert.equal(b.accountedTokens,30);assert.equal(b.modelMs,50);
 const r2=reserveBudgetCall(b,20,20,30);settleBudgetCall(b,r2,{inputTokens:20,outputTokens:10,durationMs:10});assert.equal(b.accountedTokens,60);
 assert.throws(()=>reserveBudgetCall(b,1,1,40),TaskBudgetError);
 assert.throws(()=>reserveBudgetCall(createTaskBudget({CONTRACT_TASK_MAX_TOKENS:'10'},0),10,1,1),TaskBudgetError);
 assert.throws(()=>reserveBudgetCall(createTaskBudget({CONTRACT_TASK_MAX_DURATION_MS:'10'},0),1,1,10),TaskBudgetError);
 assert.ok(estimateInputTokens({content:'合同'})>=Buffer.byteLength(JSON.stringify({content:'合同'})));
});
test('unknown/crashed usage remains charged and stale settlements cannot release reservations',()=>{
 const b=createTaskBudget({},0),lost=reserveBudgetCall(b,100,50,1);
 const next=reserveBudgetCall(b,20,30,2);assert.equal(b.accountedTokens,200);assert.equal(b.unknownCalls,1);
 assert.throws(()=>settleBudgetCall(b,lost,{inputTokens:0,outputTokens:0,durationMs:0}),/changed/);
 settleBudgetCall(b,next,{inputTokens:10,outputTokens:null,durationMs:20});assert.equal(b.accountedTokens,190);assert.equal(b.unknownCalls,2);assert.equal(b.inputTokens,10);assert.equal(b.pending,undefined);
});
const user:User={id:'budget-user',name:'合成客户',email:'budget@example.test',role:'client'};
function memory(maxCalls=2){
 let c:Contract={id:'budget-contract',ownerId:user.id,ownerName:user.name,title:'测试',createdAt:'',updatedAt:'',versions:[],messages:[],reviews:[],workflow:{intake:{...intakeFixture(),confirmedAt:undefined}}},revision=0;
 const store:WorkflowStore={environment:{CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test',CONTRACT_TASK_MAX_MODEL_CALLS:String(maxCalls)},load:async()=>({contract:structuredClone(c),revision}),save:async(v,r)=>{assert.equal(r,revision);revision++;c=structuredClone(v);return structuredClone(c);},put:async()=> 'sha',limit:async()=>{}};
 return {store,get:()=>c};
}
test('budget persists across draft and verification; Word export needs no extra model call',async()=>{
 const old=fetch,m=memory();let calls=0;try{
  globalThis.fetch=async(_u,init)=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(String(init?.body).includes('CONTRACT_VERIFY_V2')?{verdict:'consistent',issues:[]}:contentFixture())}}],usage:{prompt_tokens:100,completion_tokens:50}});};
  const id=crypto.randomUUID();await startWorkflow(m.store,user,{requestId:id,confirmId:m.get().workflow!.intake!.summaryId});
  for(let n=0;n<3;n++)await controlWorkflow(m.store,user,id,'run');
  const job=m.get().workflow!.job!;assert.equal(job.status,'completed');assert.equal(job.budget!.calls,2);assert.equal(job.budget!.accountedTokens,300);assert.equal(calls,2);assert.equal(m.get().versions.length,1);
 }finally{globalThis.fetch=old;}
});
test('exhaustion prevents a new network call and manual retry does not reset quota or erase draft',async()=>{
 const old=fetch,m=memory(1);let calls=0;try{
  globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(contentFixture())}}],usage:{prompt_tokens:100,completion_tokens:50}});};
  const id=crypto.randomUUID();await startWorkflow(m.store,user,{requestId:id,confirmId:m.get().workflow!.intake!.summaryId});await controlWorkflow(m.store,user,id,'run');await controlWorkflow(m.store,user,id,'run');
  assert.equal(m.get().workflow!.job!.code,'AI_TASK_BUDGET_EXCEEDED');const draft=structuredClone(m.get().workflow!.job!.content);
  await controlWorkflow(m.store,user,id,'retry');await controlWorkflow(m.store,user,id,'run');assert.equal(calls,1);assert.deepEqual(m.get().workflow!.job!.content,draft);assert.equal(m.get().workflow!.job!.budget!.calls,1);
 }finally{globalThis.fetch=old;}
});
test('failed usage persistence stops retrying the provider and preserves the outstanding reservation',async()=>{
 const old=fetch,m=memory();let calls=0;const save=m.store.save;
 m.store.save=async(c,r)=>{const b=c.workflow?.job?.budget;if(b&&b.calls===1&&!b.pending&&b.accountedTokens===150)throw new Error('storage unavailable');return save(c,r);};
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify(contentFixture())}}],usage:{prompt_tokens:100,completion_tokens:50}});};
  const id=crypto.randomUUID();await startWorkflow(m.store,user,{requestId:id,confirmId:m.get().workflow!.intake!.summaryId});await controlWorkflow(m.store,user,id,'run');
  assert.equal(calls,1);assert.equal(m.get().workflow!.job!.code,'AI_BUDGET_RECORD_FAILED');assert.ok(m.get().workflow!.job!.budget!.pending);
 }finally{globalThis.fetch=old;}
});
