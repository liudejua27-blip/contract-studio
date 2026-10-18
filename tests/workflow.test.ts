import test from 'node:test';import assert from 'node:assert/strict';
import {startWorkflow,controlWorkflow,type WorkflowStore} from '../src/server/workflow';import {exportProblems} from '../src/lib/contract-library/playbooks';import {contentFixture,intakeFixture} from './fixtures';import type {Contract,User} from '../src/lib/types';
const u:User={id:'client',name:'客户',email:'a@example.test',role:'client'};
function memory(){let c:Contract={id:'contract',ownerId:u.id,ownerName:u.name,title:'未命名',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),versions:[],messages:[],reviews:[]},revision=0,puts=0;const store:WorkflowStore={load:async()=>({contract:structuredClone(c),revision}),save:async(next,rev)=>{if(rev!==revision)throw new Error('conflict');c=structuredClone(next);revision++;return structuredClone(c)},put:async()=>{puts++;return'sha'},limit:async()=>{},environment:{CONTRACT_AI_API_KEY:'fake',CONTRACT_AI_BASE_URL:'https://model.test'}};return{store,get:()=>c,puts:()=>puts};}
test('submission persists message before model, duplicate request is idempotent and active job blocks another submission',async()=>{const m=memory(),input={requestId:crypto.randomUUID(),message:'做一个点单小程序'};const c=await startWorkflow(m.store,u,input);assert.equal(c.messages.length,1);assert.equal(c.workflow?.job?.status,'pending');await startWorkflow(m.store,u,input);assert.equal(m.get().messages.length,1);await assert.rejects(startWorkflow(m.store,u,{...input,requestId:crypto.randomUUID()}));await assert.rejects(startWorkflow(m.store,{...u,id:'other'},input));});
test('failed model is persisted, retry and refresh preserve request and do not duplicate the user message',async()=>{const old=fetch,m=memory(),input={requestId:crypto.randomUUID(),message:'做小程序'};try{await startWorkflow(m.store,u,input);globalThis.fetch=async()=>Response.json({}, {status:502});let c=await controlWorkflow(m.store,u,input.requestId,'run');assert.equal(c.workflow?.job?.status,'failed');assert.equal(c.workflow?.job?.code,'AI_PROVIDER_ERROR');await controlWorkflow(m.store,u,input.requestId,'retry');globalThis.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify({templateId:'software',facts:[],conflicts:[],reply:'',businessChecks:['partyA','partyB','scope','exchange','term'].map(fieldId=>({fieldId,status:'missing',question:'这项怎么安排？'}))})}}]});c=await controlWorkflow(m.store,u,input.requestId,'run');assert.equal(c.workflow?.job?.status,'completed');assert.equal(c.messages.filter(m=>m.role==='user').length,1);assert.ok(c.workflow?.intake?.missing.length);assert.equal(c.versions.length,0);}finally{globalThis.fetch=old}});
test('confirmation is bound to current summary, export checkpoint survives replay and writes one version',async()=>{const old=fetch,m=memory();let snap=await m.store.load();snap.contract.workflow={intake:{...intakeFixture(),confirmedAt:undefined}};await m.store.save(snap.contract,snap.revision);await assert.rejects(startWorkflow(m.store,u,{requestId:crypto.randomUUID(),confirmId:crypto.randomUUID()}));const id=crypto.randomUUID();let c=await startWorkflow(m.store,u,{requestId:id,confirmId:m.get().workflow!.intake!.summaryId});try{globalThis.fetch=async(_u,init)=>Response.json({choices:[{message:{content:JSON.stringify(String(init?.body).includes('CONTRACT_VERIFY_V2')?{verdict:'consistent',issues:[]}:contentFixture())}}]});c=await controlWorkflow(m.store,u,id,'run');assert.equal(c.workflow?.job?.phase,'verify');c=await controlWorkflow(m.store,u,id,'run');assert.equal(c.workflow?.job?.phase,'export');assert.equal(c.versions.length,0);c=await controlWorkflow(m.store,u,id,'run');await controlWorkflow(m.store,u,id,'run');assert.equal(c.versions.length,1);assert.equal(m.puts(),1);assert.equal(exportProblems(c.versions[0].content!).length,0);}finally{globalThis.fetch=old}});
test('cancellation fences an in-flight completion; expired leases become recoverable errors',async()=>{const old=fetch,m=memory(),id=crypto.randomUUID();await startWorkflow(m.store,u,{requestId:id,message:'做小程序'});let release!:()=>void;const held=new Promise<void>(r=>release=r);try{globalThis.fetch=async()=>{await held;return Response.json({choices:[{message:{content:JSON.stringify({templateId:'software',facts:[],conflicts:[]})}}]})};const run=controlWorkflow(m.store,u,id,'run');await new Promise(r=>setTimeout(r,5));await controlWorkflow(m.store,u,id,'cancel');release();await run;assert.equal(m.get().workflow?.job?.status,'cancelled');assert.equal(m.get().messages.length,1);const next=crypto.randomUUID();await startWorkflow(m.store,u,{requestId:next,message:'继续'});const snap=await m.store.load();Object.assign(snap.contract.workflow!.job!,{status:'running',leaseUntil:new Date(0).toISOString()});await m.store.save(snap.contract,snap.revision);const c=await controlWorkflow(m.store,u,next,'run');assert.equal(c.workflow?.job?.code,'JOB_INTERRUPTED');}finally{globalThis.fetch=old}});
test('export rejects placeholders, internal instructions, missing attachment and missing confirmation',()=>{assert.ok(exportProblems({...contentFixture(),confirmation:undefined}).length);assert.ok(exportProblems({...contentFixture(),attachments:[]}).length);assert.ok(exportProblems({...contentFixture(),sections:[{title:'范围',content:'待补充'}]}).length);assert.ok(exportProblems({...contentFixture(),sections:[{title:'来源',content:'起草参考 github.com'}]}).length);});
test('legacy requirement-only review does not lock drafting; real document review does',async()=>{
 const m=memory();const snap=await m.store.load();snap.contract.reviews=[{id:'legacy',submittedVersionId:null,lawyerId:null,status:'waiting',stance:'甲方',concerns:'',requirements:'历史需求',submittedAt:'',messages:[]}];await m.store.save(snap.contract,snap.revision);
 const c=await startWorkflow(m.store,u,{requestId:crypto.randomUUID(),message:'继续生成合同'});assert.equal(c.workflow!.job!.status,'pending');assert.equal(c.reviews[0].requirements,'历史需求');
 const n=memory();const other=await n.store.load();other.contract.reviews=[{...snap.contract.reviews[0],submittedVersionId:'word'}];await n.store.save(other.contract,other.revision);await assert.rejects(startWorkflow(n.store,u,{requestId:crypto.randomUUID(),message:'修改'}),/审核沟通/);
});
test('quality review notes are persisted through export and reach the saved Word version metadata',async()=>{
 const old=fetch,m=memory();const snap=await m.store.load();snap.contract.workflow={intake:{...intakeFixture(),confirmedAt:undefined}};await m.store.save(snap.contract,snap.revision);const id=crypto.randomUUID();await startWorkflow(m.store,u,{requestId:id,confirmId:m.get().workflow!.intake!.summaryId});
 try{globalThis.fetch=async(_url,init)=>Response.json({choices:[{message:{content:JSON.stringify(String(init?.body).includes('CONTRACT_VERIFY_V2')?{verdict:'consistent',issues:[],reviewNotes:['律师核查许可边界']}:contentFixture())}}]});await controlWorkflow(m.store,u,id,'run');await controlWorkflow(m.store,u,id,'run');await controlWorkflow(m.store,u,id,'run');assert.ok(m.get().versions[0].content!.confirmation!.reviewNotes!.includes('律师核查许可边界'));}finally{globalThis.fetch=old}
});

test('a confirmed revision uses a bound patch, preserves its prior version, verifies and exports once',async()=>{
 const old=fetch,m=memory(),base=contentFixture();const snap=await m.store.load();
 snap.contract.versions=[{id:'old-word',number:1,kind:'draft',source:'ai',fileKey:'old.docx',content:base,createdAt:''}];
 snap.contract.workflow={intake:{...intakeFixture(),confirmedAt:undefined}};
 snap.contract.messages=[{id:'edit',role:'user',content:'只把第二条改得简洁一些，其他措辞保留。',createdAt:new Date().toISOString()}];
 await m.store.save(snap.contract,snap.revision);const before=structuredClone(m.get().versions[0]);const id=crypto.randomUUID();
 let c=await startWorkflow(m.store,u,{requestId:id,confirmId:m.get().workflow!.intake!.summaryId});assert.deepEqual(c.workflow!.job!.content,base);
 let patches=0,checks=0;
 try{
  globalThis.fetch=async(_url,init)=>{
   const b=JSON.parse(String(init?.body)),verify=b.messages[0].content.includes('CONTRACT_VERIFY_V2');
   if(verify){checks++;return Response.json({choices:[{message:{content:JSON.stringify({verdict:'consistent',issues:[]})}}]});}
   assert.match(b.messages[0].content,/CONTRACT_PATCH_V1/);patches++;const input=JSON.parse(b.messages.find((x:any)=>x.role==='user').content);assert.match(input.request,/只把第二条改得简洁一些/);
   return Response.json({choices:[{message:{content:JSON.stringify({baseSha256:input.baseSha256,changes:[{op:'replace',target:'section',index:1,part:{...base.sections[1],content:base.sections[1].content+'双方依约履行。'},reason:'衔接说明'}]})}}]});
  };
  await controlWorkflow(m.store,u,id,'run');assert.equal(m.get().workflow!.job!.phase,'verify');assert.equal(m.puts(),0);
  await controlWorkflow(m.store,u,id,'run');assert.equal(m.get().workflow!.job!.phase,'export');assert.equal(m.puts(),0);
  c=await controlWorkflow(m.store,u,id,'run');await controlWorkflow(m.store,u,id,'run');
  assert.equal(patches,1);assert.equal(checks,1);assert.equal(m.puts(),1);assert.equal(c.versions.length,2);assert.deepEqual(c.versions[0],before);
  assert.deepEqual(c.versions[1].content!.sections.filter((_,i)=>i!==1),base.sections.filter((_,i)=>i!==1));
 }finally{globalThis.fetch=old}
});

test('background jobs stop after adaptive truncation recovery instead of retrying the same stage',async()=>{
 const old=fetch,m=memory(),id=crypto.randomUUID();m.store.background=true;
 m.store.environment={...m.store.environment,CONTRACT_AI_MAX_OUTPUT_TOKENS:'8000',CONTRACT_AI_MAX_RECOVERY_TOKENS:'16000'};
 let calls=0;try{
  globalThis.fetch=async()=>{calls++;return Response.json({choices:[{finish_reason:'length',message:{content:'incomplete'}}]});};
  await startWorkflow(m.store,u,{requestId:id,message:'复杂交易'});
  const c=await controlWorkflow(m.store,u,id,'run');
  assert.equal(calls,2);assert.equal(c.workflow!.job!.status,'failed');assert.equal(c.workflow!.job!.code,'AI_OUTPUT_TRUNCATED');assert.equal(c.workflow!.job!.nextAttemptAt,undefined);
 }finally{globalThis.fetch=old;}
});
