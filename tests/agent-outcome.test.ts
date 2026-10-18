import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AgentOutcomePanel} from '../src/components/AgentOutcomePanel';
import {conversationSchema} from '../src/lib/transaction-update';
import {verificationSchema,validateVerification,recordAgentOutcome,completionReply} from '../src/lib/agent-outcome';
import {intakeIsCurrent} from '../src/lib/intake-state';
import {reviewVersionProblem} from '../src/lib/review-policy';
import {documentBody,sha256} from '../src/lib/skill-audit';
import {startWorkflow,controlWorkflow,type WorkflowStore} from '../src/server/workflow';
import {reviseConfirmedDraft} from '../src/server/ai';
import {publicJob} from '../src/server/job-subscription';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Contract,ContractContent,User} from '../src/lib/types';
import {contentFixture,intakeFixture} from './fixtures';

const user:User={id:'owner',name:'客户',email:'fixture@example.test',role:'client'};
const env={CONTRACT_AI_API_KEY:'local-fixture',CONTRACT_AI_BASE_URL:'https://model.test'};
const reply=(result:unknown)=>Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
function memory(content?:ContractContent){
 let c:Contract={id:crypto.randomUUID(),ownerId:user.id,ownerName:user.name,title:'测试合同',createdAt:'',updatedAt:'',messages:[],reviews:[],versions:content?[{id:'saved',number:1,kind:'draft',source:'ai',fileKey:'old.docx',createdAt:'2026-01-01T00:00:00Z',content:structuredClone(content)}]:[],workflow:{inputRevision:0,intake:structuredClone(content?.confirmation||intakeFixture())}};
 let revision=0,puts=0;
 const store:WorkflowStore={environment:env,load:async()=>({contract:structuredClone(c),revision}),save:async(next,expected)=>{assert.equal(expected,revision);c=structuredClone(next);revision++;return structuredClone(c);},put:async()=>{puts++;return 'test-sha';},limit:async()=>{}};
 return {store,get:()=>c,puts:()=>puts,change:async(fn:(value:Contract)=>void)=>{const snap=await store.load();fn(snap.contract);await store.save(snap.contract,snap.revision);}};
}
async function atVerification(content:ContractContent){
 const m=memory(),id=crypto.randomUUID();
 await m.change(c=>{c.workflow!.job={id,messageId:'generated',phase:'verify',status:'pending',attempt:0,createdAt:'',updatedAt:'',content:structuredClone(content),versionId:'new'};});
 return {...m,id};
}

test('read-only questions preserve confirmed facts, Word eligibility and idempotency with one model call',async()=>{
 const old=fetch,base=contentFixture(),m=memory(base),before=structuredClone(m.get()),id=crypto.randomUUID();let calls=0;
 try{
  globalThis.fetch=async(_url,init)=>{calls++;assert.ok(String(init?.body).includes(base.sections[0].content));return reply({action:'answer',reply:'第八条说明通知、争议解决与生效，不会因此修改现有约定。'});};
  await startWorkflow(m.store,user,{requestId:id,message:'第八条是什么意思？'});
  assert.equal(intakeIsCurrent(m.get()),false);
  const c=await controlWorkflow(m.store,user,id,'run');
  assert.equal(calls,1);assert.deepEqual(c.workflow!.intake,before.workflow!.intake);
  assert.equal(c.workflow!.inputRevision,before.workflow!.inputRevision);assert.deepEqual(c.versions,before.versions);
  assert.equal(intakeIsCurrent(c),true);assert.equal(reviewVersionProblem(c,c.versions[0]),undefined);assert.equal(m.puts(),0);
  await startWorkflow(m.store,user,{requestId:id,message:'第八条是什么意思？'});await controlWorkflow(m.store,user,id,'run');
  assert.equal(calls,1);assert.equal(m.get().messages.length,2);
 }finally{globalThis.fetch=old;}
});

test('an answer cannot submit transaction fields, and legacy updates still parse',()=>{
 assert.equal(conversationSchema.safeParse({action:'answer',reply:'回答',facts:[{fieldId:'price',value:'1元',quote:'1元'}]}).success,false);
 assert.equal(conversationSchema.safeParse({action:'answer',reply:'回答',intent:{goal:{value:'改目标',quote:'改目标'}}}).success,false);
 assert.equal(conversationSchema.parse({templateId:'software',facts:[]}).action,'update');
});

test('real changes invalidate confirmation; earlier hypothetical questions are excluded from the patch request',async()=>{
 const old=fetch,m=memory(contentFixture()),questionId=crypto.randomUUID(),editId=crypto.randomUUID();
 try{
  globalThis.fetch=async()=>reply({action:'answer',reply:'这里只解释可能性，不修改约定。'});
  await startWorkflow(m.store,user,{requestId:questionId,message:'如果预付款改成零会怎样？先别修改。'});await controlWorkflow(m.store,user,questionId,'run');
  globalThis.fetch=async()=>reply({action:'update',templateId:'software',facts:[],reply:'只调整第二条文字，其他约定保留。'});
  await startWorkflow(m.store,user,{requestId:editId,message:'请把第二条写简洁些，金额不变。'});await controlWorkflow(m.store,user,editId,'run');
  assert.equal(m.get().workflow!.intake!.confirmedAt,undefined);assert.equal(m.get().workflow!.inputRevision,1);
  const c=await startWorkflow(m.store,user,{requestId:crypto.randomUUID(),confirmId:m.get().workflow!.intake!.summaryId});
  assert.match(c.workflow!.job!.revisionRequest!,/第二条/);assert.doesNotMatch(c.workflow!.job!.revisionRequest!,/预付款改成零/);
 }finally{globalThis.fetch=old;}
});

test('read-only answers do not clear an earlier failed change or material invalidation',async()=>{
 const old=fetch,m=memory(contentFixture()),id=crypto.randomUUID();
 await m.change(c=>{c.workflow!.inputRevision=2;});
 try{globalThis.fetch=async()=>reply({action:'answer',reply:'解释，不修改。'});await startWorkflow(m.store,user,{requestId:id,message:'这是什么意思？'});const c=await controlWorkflow(m.store,user,id,'run');assert.equal(c.workflow!.inputRevision,2);assert.equal(intakeIsCurrent(c),false);assert.equal(reviewVersionProblem(c,c.versions[0])?.code,'VERSION_OUTDATED');}
 finally{globalThis.fetch=old;}
});

test('a failed change followed by a question remains unconfirmed and cannot submit the old Word',async()=>{
 const old=fetch,m=memory(contentFixture()),changeId=crypto.randomUUID(),questionId=crypto.randomUUID();
 try{
  globalThis.fetch=async()=>Response.json({}, {status:502});
  await startWorkflow(m.store,user,{requestId:changeId,message:'总价改为9000元'});await controlWorkflow(m.store,user,changeId,'run');
  assert.equal(m.get().workflow!.intake!.confirmedAt,undefined);
  globalThis.fetch=async()=>reply({action:'answer',reply:'这里只解释，不处理上一条未完成的变更。'});
  await startWorkflow(m.store,user,{requestId:questionId,message:'什么叫验收？'});const c=await controlWorkflow(m.store,user,questionId,'run');
  assert.equal(c.workflow!.intake!.confirmedAt,undefined);assert.equal(intakeIsCurrent(c),false);assert.equal(reviewVersionProblem(c,c.versions[0])?.code,'VERSION_OUTDATED');
 }finally{globalThis.fetch=old;}
});

test('retrying a failed read-only question restores the exact original confirmation',async()=>{
 const old=fetch,m=memory(contentFixture()),before=structuredClone(m.get().workflow!.intake),id=crypto.randomUUID();
 try{
  globalThis.fetch=async()=>Response.json({}, {status:502});
  await startWorkflow(m.store,user,{requestId:id,message:'解释验收条款'});await controlWorkflow(m.store,user,id,'run');
  await controlWorkflow(m.store,user,id,'retry');globalThis.fetch=async()=>reply({action:'answer',reply:'仅解释验收条款，原约定保留。'});
  const c=await controlWorkflow(m.store,user,id,'run');assert.deepEqual(c.workflow!.intake,before);assert.equal(reviewVersionProblem(c,c.versions[0]),undefined);
 }finally{globalThis.fetch=old;}
});

test('cancelled read-only work cannot restore confirmation or append a late answer',async()=>{
 const old=fetch,m=memory(contentFixture()),id=crypto.randomUUID();
 let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 try{
  globalThis.fetch=async()=>{entered();await gate;return reply({action:'answer',reply:'迟到的回答'});};
  await startWorkflow(m.store,user,{requestId:id,message:'解释这份合同'});
  const run=controlWorkflow(m.store,user,id,'run');await ready;await controlWorkflow(m.store,user,id,'cancel');release();await run;
  assert.equal(m.get().workflow!.job!.status,'cancelled');assert.equal(m.get().workflow!.inputRevision,1);assert.equal(m.get().messages.length,1);assert.equal(m.puts(),0);
 }finally{release?.();globalThis.fetch=old;}
});

test('read-only completion cannot roll back a newer material revision',async()=>{
 const old=fetch,m=memory(contentFixture()),id=crypto.randomUUID();
 let entered!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 try{
  globalThis.fetch=async()=>{entered();await gate;return reply({action:'answer',reply:'本轮仅解释'});};
  await startWorkflow(m.store,user,{requestId:id,message:'解释条款'});
  const run=controlWorkflow(m.store,user,id,'run');await ready;
  await m.change(c=>{c.workflow!.inputRevision=2;delete c.workflow!.intake!.confirmedAt;});release();await run;
  assert.equal(m.get().workflow!.inputRevision,2);assert.equal(m.get().workflow!.intake!.confirmedAt,undefined);assert.equal(intakeIsCurrent(m.get()),false);
 }finally{release?.();globalThis.fetch=old;}
});

test('fact uncertainty preserves the candidate and waits without blind repair or export',async()=>{
 const old=fetch,base=contentFixture(),m=await atVerification(base);let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return reply({verdict:'uncertain',issues:[],uncertainty:{kind:'fact',reason:'材料对付款节点存在两种描述，尚无法确认哪份有效',question:'付款节点以哪份材料为准？'}});};
  let c=await controlWorkflow(m.store,user,m.id,'run');
  assert.equal(c.workflow!.job!.code,'FACT_CHECK_UNCERTAIN');assert.equal(c.workflow!.job!.status,'failed');assert.equal(c.workflow!.job!.repairCount,undefined);
  assert.deepEqual(c.workflow!.job!.content,base);assert.equal(m.puts(),0);assert.match(c.workflow!.job!.error!,/哪份材料/);
  await controlWorkflow(m.store,user,m.id,'run');assert.equal(calls,1);
  await controlWorkflow(m.store,user,m.id,'retry');assert.equal(m.get().workflow!.job!.phase,'verify');
  globalThis.fetch=async()=>reply({verdict:'consistent',issues:[]});c=await controlWorkflow(m.store,user,m.id,'run');assert.equal(c.workflow!.job!.phase,'export');
 }finally{globalThis.fetch=old;}
});

test('asking a question after a failed generation keeps its candidate and retry entry',async()=>{
 const old=fetch,base=contentFixture(),m=await atVerification(base),questionId=crypto.randomUUID();
 await m.change(c=>{c.workflow!.intake=structuredClone(base.confirmation);});
 try{
  globalThis.fetch=async()=>reply({verdict:'uncertain',issues:[],uncertainty:{kind:'fact',reason:'需要核对付款安排'}});
  await controlWorkflow(m.store,user,m.id,'run');
  globalThis.fetch=async()=>reply({action:'answer',reply:'可以补充付款材料，原稿还在。'});
  await startWorkflow(m.store,user,{requestId:questionId,message:'我要准备什么材料？'});
  assert.ok(m.get().workflow!.job!.continuation?.content);assert.equal(publicJob(m.get().workflow!.job!).continuation,undefined);
  const c=await controlWorkflow(m.store,user,questionId,'run');
  assert.equal(c.messages.at(-1)!.content,'可以补充付款材料，原稿还在。');assert.equal(c.workflow!.job!.status,'failed');assert.equal(c.workflow!.job!.phase,'verify');assert.equal(c.workflow!.job!.code,'FACT_CHECK_UNCERTAIN');assert.deepEqual(c.workflow!.job!.content,base);
  await controlWorkflow(m.store,user,questionId,'retry');globalThis.fetch=async()=>reply({verdict:'consistent',issues:[]});await controlWorkflow(m.store,user,questionId,'run');await controlWorkflow(m.store,user,questionId,'run');assert.equal(m.puts(),1);
 }finally{globalThis.fetch=old;}
});

test('manual retry rechecks uncertainty instead of replaying the persisted Pi result forever',async()=>{
 const old=fetch,m=await atVerification(contentFixture()),dir=await mkdtemp(join(tmpdir(),'contract-retry-'));let transcript:string|null=null,calls=0;
 m.store.agentSessions=true;m.store.environment={...env,CONTRACT_PI_SESSION_DIR:dir};m.store.sessionCheckpoint=()=>({load:async()=>transcript,save:async(value)=>{transcript=value;}});
 try{
  globalThis.fetch=async()=>{calls++;return reply(calls===1?{verdict:'uncertain',issues:[],uncertainty:{kind:'fact',reason:'暂时无法核对'}}:{verdict:'consistent',issues:[]});};
  await controlWorkflow(m.store,user,m.id,'run');assert.equal(m.get().workflow!.job!.code,'FACT_CHECK_UNCERTAIN');assert.ok(transcript);
  await controlWorkflow(m.store,user,m.id,'retry');await controlWorkflow(m.store,user,m.id,'run');assert.equal(calls,2);assert.equal(m.get().workflow!.job!.phase,'export');
 }finally{globalThis.fetch=old;await rm(dir,{recursive:true,force:true});}
});

test('professional uncertainty exports a clearly marked draft and carries the goal explanation to the lawyer',async()=>{
 const old=fetch,base=contentFixture();base.confirmation!.intent={goal:{value:'保障尾款收取',quote:'我最担心收不到尾款'}};
 base.skillAudit={version:1,contentSha256:await sha256(documentBody(base)),receipts:[],applications:[]};
 const m=await atVerification(base);
 try{
  globalThis.fetch=async()=>reply({verdict:'uncertain',issues:[],uncertainty:{kind:'professional',reason:'验收与付款条款能否充分保障尾款，需要律师结合实际业务判断'},goalAssessment:{status:'partial',explanation:'已写明尾款节点，逾期验收时的处理仍需律师完善。',clauses:[{target:'section',index:0,quote:'验收通过后支付4000元'}]}});
  let c=await controlWorkflow(m.store,user,m.id,'run');assert.equal(c.workflow!.job!.phase,'export');assert.equal(c.workflow!.job!.repairCount,undefined);
  c=await controlWorkflow(m.store,user,m.id,'run');const content=c.versions[0].content!;
  assert.equal(m.puts(),1);assert.equal(content.agentOutcome!.consistency,'needs_lawyer');assert.equal(content.skillAudit!.consistency!.status,'needs_lawyer');
  assert.equal(content.agentOutcome!.goal!.value,base.confirmation!.intent.goal!.value);assert.deepEqual(content.sections,base.sections);
  assert.match(c.messages.at(-1)!.content,/部分落实/);assert.match(c.messages.at(-1)!.content,/律师/);
  const html=renderToStaticMarkup(React.createElement(AgentOutcomePanel,{content}));assert.match(html,/本版起草说明/);assert.match(html,/保障尾款收取/);assert.match(html,/验收通过后支付4000元/);
 }finally{globalThis.fetch=old;}
});

test('a concrete contradiction still requests targeted repair instead of allowing export',async()=>{
 const old=fetch,m=await atVerification(contentFixture());
 try{globalThis.fetch=async()=>reply({verdict:'inconsistent',issues:['付款附件与已确认的尾款节点冲突']});const c=await controlWorkflow(m.store,user,m.id,'run');assert.equal(c.workflow!.job!.phase,'generate');assert.equal(c.workflow!.job!.repairCount,1);assert.match(c.workflow!.job!.repairFeedback!,/尾款节点/);assert.equal(m.puts(),0);}
 finally{globalThis.fetch=old;}
});

test('legacy unspecified uncertainty never silently becomes professional approval',async()=>{
 const old=fetch,m=await atVerification(contentFixture());
 try{globalThis.fetch=async()=>reply({verdict:'uncertain',issues:['无法确定付款事实']});await controlWorkflow(m.store,user,m.id,'run');assert.equal(m.get().workflow!.job!.code,'FACT_CHECK_UNCERTAIN');assert.equal(m.puts(),0);assert.equal(m.get().workflow!.job!.repairCount,undefined);}
 finally{globalThis.fetch=old;}
});

test('goal claims require real clause evidence and cannot hide contradictory verification results',()=>{
 const content=contentFixture();content.confirmation!.intent={goal:{value:'保障付款',quote:'保障付款'}};
 const result=verificationSchema.parse({verdict:'consistent',issues:[],goalAssessment:{status:'addressed',explanation:'付款条款回应诉求',clauses:[{target:'section',index:0,quote:'验收通过后支付4000元'}]}});
 validateVerification(result,content);
 assert.throws(()=>validateVerification({...result,goalAssessment:{...result.goalAssessment!,clauses:[]}},content),/须引用/);
 assert.throws(()=>validateVerification({...result,goalAssessment:{...result.goalAssessment!,clauses:[{target:'section',index:99,quote:'不存在'}]}},content),/无法/);
 assert.throws(()=>validateVerification({...result,verdict:'uncertain',issues:['金额错误'],uncertainty:{kind:'professional',reason:'待律师判断'}},content),/不能掩盖/);
 delete content.confirmation!.intent;assert.throws(()=>validateVerification(result,content),/未提供/);
});

test('missing assessments remain explicitly unassessed, withdrawn goals do not survive re-evaluation',async()=>{
 const content=contentFixture();content.confirmation!.intent={goal:{value:'防止欠款',quote:'防止欠款'}};
 await recordAgentOutcome(content,verificationSchema.parse({verdict:'consistent',issues:[]}));assert.equal(content.agentOutcome!.goal!.status,'needs_lawyer');assert.match(completionReply(content),/未形成有依据/);
 content.confirmation!.intent.goal!.value='';await recordAgentOutcome(content,verificationSchema.parse({verdict:'consistent',issues:[]}));assert.equal(content.agentOutcome!.goal,undefined);assert.doesNotMatch(completionReply(content),/防止欠款/);
});

test('local revision discards the previous goal assessment until the new version is checked',async()=>{
 const old=fetch,base=contentFixture();base.confirmation!.intent={goal:{value:'防止欠款',quote:'防止欠款'}};
 await recordAgentOutcome(base,verificationSchema.parse({verdict:'consistent',issues:[]}));const before=structuredClone(base.agentOutcome);
 try{
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)),input=JSON.parse(body.messages.find((m:any)=>m.role==='user').content);return reply({baseSha256:input.baseSha256,changes:[]});};
  const changed=await reviseConfirmedDraft(base,base.confirmation!,'其他不变',env);assert.equal(changed.agentOutcome,undefined);assert.deepEqual(base.agentOutcome,before);
 }finally{globalThis.fetch=old;}
});
