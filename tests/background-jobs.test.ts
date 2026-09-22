import test from 'node:test';
import assert from 'node:assert/strict';
import {createBackgroundLoop,createProgressWriter} from '../src/server/background-jobs';
import {observeJob} from '../src/server/job-subscription';
import {sseData} from '../src/lib/agent-stream';
import {createAgentJobRunner} from '../src/lib/agent-job-runner';
import {createAgentViewStore} from '../src/lib/agent-view-store';
import {startWorkflow,controlWorkflow,type WorkflowStore} from '../src/server/workflow';
import type {Contract,GenerationJob,User} from '../src/lib/types';
import {contentFixture} from './fixtures';
const actor:User={id:'owner',name:'客户',email:'test@example.test',role:'client'};
const job=(phase:GenerationJob['phase']='export'):GenerationJob=>({id:'job',messageId:'m',versionId:'v',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),phase,status:'pending',attempt:0,execution:'background',content:contentFixture()});
const contract=(j=job()):Contract=>({id:'c',ownerId:actor.id,ownerName:actor.name,title:'合同',messages:[],versions:[],reviews:[],createdAt:'',updatedAt:'',workflow:{job:j}});
function memory(initial=contract(),put:WorkflowStore['put']=async()=>'hash'){
 let value=initial,revision=0;const store:WorkflowStore={background:true,load:async()=>({contract:structuredClone(value),revision}),save:async(c,r)=>{assert.equal(r,revision);value=structuredClone(c);revision++;return structuredClone(value);},put,limit:async()=>{}};return {store,get:()=>value};
}
const waitUntil=async(fn:()=>boolean)=>{for(let n=0;n<100&&!fn();n++)await new Promise(r=>setTimeout(r,5));assert.ok(fn(),'condition did not settle');};

test('background loop completes a saved export without a browser and does not duplicate delivery',async()=>{
 let writes=0;const m=memory(contract(),async()=>{writes++;return'hash';});
 const loop=createBackgroundLoop({pollMs:5,scan:async()=>m.get().workflow!.job!.status==='pending'?[{id:'c',jobId:'job',actor}]:[],execute:async()=>controlWorkflow(m.store,actor,'job','run')});
 try{await waitUntil(()=>m.get().workflow!.job!.status==='completed');await loop.tick();assert.equal(writes,1);assert.equal(m.get().versions.length,1);}finally{await loop.stop();}
});
test('expired execution is reclaimed with a bounded budget, preserving the export checkpoint',async()=>{
 const m=memory();for(let i=0;i<3;i++){
  const s=await m.store.load();Object.assign(s.contract.workflow!.job!,{status:'running',lease:'dead',leaseUntil:new Date(0).toISOString()});await m.store.save(s.contract,s.revision);
  const c=await controlWorkflow(m.store,actor,'job','run');assert.ok(c.workflow!.job!.content);assert.equal(c.workflow!.job!.status,i<2?'pending':'failed');
 }assert.equal(m.get().workflow!.job!.code,'JOB_INTERRUPTED');
});
test('temporary storage outage retries only export, respecting backoff; permanent errors stop',async()=>{
 let writes=0;const m=memory(contract(),async()=>{writes++;if(writes===1)throw Object.assign(new Error('network'),{code:'ECONNRESET'});return'hash';});
 let c=await controlWorkflow(m.store,actor,'job','run');assert.equal(c.workflow!.job!.status,'pending');assert.equal(c.workflow!.job!.phase,'export');assert.equal(c.workflow!.job!.retryCount,1);
 await controlWorkflow(m.store,actor,'job','run');assert.equal(writes,1);
 const s=await m.store.load();s.contract.workflow!.job!.nextAttemptAt=new Date(0).toISOString();await m.store.save(s.contract,s.revision);
 c=await controlWorkflow(m.store,actor,'job','run');assert.equal(c.versions.length,1);assert.equal(writes,2);
 const bad=memory(contract(),async()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});});assert.equal((await controlWorkflow(bad.store,actor,'job','run')).workflow!.job!.status,'failed');
});
test('automatic retry budget ends after two retries and does not create a version',async()=>{
 const m=memory(contract(),async()=>{throw Object.assign(new Error('network'),{code:'ETIMEDOUT'});});
 for(let n=0;n<3;n++){const s=await m.store.load();delete s.contract.workflow!.job!.nextAttemptAt;await m.store.save(s.contract,s.revision);await controlWorkflow(m.store,actor,'job','run');}
 assert.equal(m.get().workflow!.job!.status,'failed');assert.equal(m.get().workflow!.job!.attempt,3);assert.equal(m.get().versions.length,0);
});
test('new Node submissions are owned by the background runtime',async()=>{
 const m=memory({...contract(),workflow:{}});const c=await startWorkflow(m.store,actor,{requestId:crypto.randomUUID(),message:'做软件'});assert.equal(c.workflow!.job!.execution,'background');
});
test('public progress is coalesced, serial, and retains the lease for stale-write fencing',async()=>{
 const saved:{text:string;lease:string}[]=[];const writer=createProgressWriter(async(s,lease)=>{saved.push({text:s.text,lease});},undefined,1000);
 writer.claim({...job('generate'),lease:'old'});writer.emit({type:'preview',text:'正文'});writer.emit({type:'preview',text:'正文完整'});await writer.flush();
 writer.claim({...job('verify'),lease:'new'});writer.emit({type:'activity',label:'核对中'});await writer.flush();assert.deepEqual(saved,[{text:'正文完整',lease:'old'},{text:'正文完整',lease:'new'}]);
});
test('reconnect restores a persisted snapshot, and disconnect stops only the subscription',async()=>{
 let c=contract({...job('generate'),status:'running',lease:'secret',repairFeedback:'private'}),reads=0;
 const load=async()=>{reads++;return c;};const progress=async()=>({jobId:'job',phase:'generate' as const,label:'正在写条款',text:'已保存正文',revision:'one'});
 const response=observeJob(load,progress,'job',5,1000);const frames=sseData(response.body!);const first=JSON.parse((await frames.next()).value!);assert.equal(first.type,'job');assert.equal(first.job.content,undefined);assert.equal(first.job.lease,undefined);assert.equal(first.job.repairFeedback,undefined);
 assert.equal(JSON.parse((await frames.next()).value!).type,'activity');assert.equal(JSON.parse((await frames.next()).value!).text,'已保存正文');await frames.return();
 const previous=reads;await new Promise(r=>setTimeout(r,20));assert.ok(reads<=previous+1);assert.equal(c.workflow!.job!.status,'running');
 c=contract({...job('export'),status:'completed'});const restored=[];for await(const frame of sseData(observeJob(load,progress,'job',5).body!))restored.push(JSON.parse(frame));assert.equal(restored.at(-1).contract.workflow.job.status,'completed');
});
test('browser subscribes to a running background job instead of executing phases',async()=>{
 const store=createAgentViewStore();let path='';const runner=createAgentJobRunner({store,load:async()=>contract(),error:()=>assert.fail(),update:()=>{},stream:async(p,emit)=>{path=p;emit({type:'preview',text:'恢复正文'});return contract({...job(),status:'completed'});}});
 await runner.run(contract({...job(),status:'running',leaseUntil:new Date(Date.now()+60000).toISOString()}));assert.ok(path.endsWith('/events'));assert.equal(store.get('c')?.text,'恢复正文');assert.equal(store.get('c')?.status,'completed');
});
test('network loss keeps a background task active with a reconnect message',async()=>{
 const running=contract({...job(),status:'running'}),store=createAgentViewStore();let errors=0;
 const runner=createAgentJobRunner({store,load:async()=>running,error:()=>errors++,update:()=>{},stream:async()=>{throw new Error('offline');}});await runner.run(running);assert.equal(errors,0);assert.equal(store.get('c')?.status,'running');assert.match(store.get('c')!.label,/恢复连接/);
});

test('two simultaneous executors claim once before producing any file',async()=>{
 let writes=0;const m=memory(contract(),async()=>{writes++;return'hash';});
 await Promise.allSettled([controlWorkflow(m.store,actor,'job','run'),controlWorkflow(m.store,actor,'job','run')]);
 assert.equal(writes,1);assert.equal(m.get().versions.length,1);
});

test('disconnect while entirely offline preserves running status and the visible draft',async()=>{
 const store=createAgentViewStore(),running=contract({...job(),status:'running'});
 const runner=createAgentJobRunner({store,load:async()=>{throw new Error('offline');},error:()=>assert.fail(),update:()=>{},stream:async(_path,emit)=>{emit({type:'preview',text:'已展示正文'});throw new Error('offline');}});
 await runner.run(running);assert.equal(store.get('c')?.status,'running');assert.equal(store.get('c')?.text,'已展示正文');assert.match(store.get('c')!.label,/恢复连接/);
});

test('invalid provider credentials stop without automatic retry',async()=>{
 const original=globalThis.fetch,m=memory({...contract(),workflow:{}});let calls=0;
 m.store.environment={CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.invalid'};
 try{globalThis.fetch=async()=>{calls++;return Response.json({}, {status:401});};
  const id=crypto.randomUUID();await startWorkflow(m.store,actor,{requestId:id,message:'采购显示器'});
  const c=await controlWorkflow(m.store,actor,id,'run');assert.equal(c.workflow!.job!.status,'failed');assert.equal(c.workflow!.job!.code,'AI_PROVIDER_REJECTED');assert.equal(calls,1);assert.equal(c.workflow!.job!.nextAttemptAt,undefined);
 }finally{globalThis.fetch=original;}
});
