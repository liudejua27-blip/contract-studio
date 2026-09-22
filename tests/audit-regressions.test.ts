import test from 'node:test';
import assert from 'node:assert/strict';
import {intakeFixture,contentFixture} from './fixtures';
import type {Contract,Review,Version} from '../src/lib/types';
import {compileTransactionUpdate,intakeSchema} from '../src/lib/transaction-update';
import {transactionQuestions,unresolvedTransactionFields} from '../src/lib/transaction-state';
import {latestReview,reviewVersionProblem} from '../src/lib/review-policy';
import {summary} from '../src/lib/contract-list';
import {readModelResponse} from '../src/server/agent/model-stream';
import {observeJob} from '../src/server/job-subscription';
import {startWorkflow,controlWorkflow} from '../src/server/workflow';

function contract():Contract{const content=contentFixture();return {id:'c',ownerId:'u',ownerName:'客户',title:'合同',createdAt:'',updatedAt:'',messages:[],reviews:[],workflow:{intake:content.confirmation},versions:[{id:'v',kind:'draft',number:1,source:'ai',fileKey:'v.docx',content,createdAt:''}]};}
const review=(id:string,status:Review['status'],submittedAt:string):Review=>({id,status,submittedAt,submittedVersionId:'v',lawyerId:'l',stance:'甲方',concerns:'',requirements:'',messages:[]});

test('deferred payment preserves its known part, cannot confirm and does not repeat its question',()=>{
 const q='款项分两次付，具体比例还没谈好';const i=compileTransactionUpdate(intakeSchema.parse({templateId:'software',facts:[{fieldId:'payment',value:'款项分两次付',quote:'款项分两次付'}],businessChecks:[{fieldId:'payment',status:'deferred',evidence:['具体比例还没谈好']}]}),intakeFixture(),[q]).intake!;
 assert.equal(i.facts.payment.value,'款项分两次付');assert.ok(i.deferredFields?.includes('payment'));assert.ok(unresolvedTransactionFields(i).includes('payment'));assert.deepEqual(transactionQuestions(i),[]);assert.ok(i.reviewNotes?.some(n=>n.includes('付款')));
});
test('review selection is independent of storage order and prefers an open review',()=>{
 const a=review('old','completed','2026-09-20'),b=review('new','waiting','2026-09-22');
 for(const reviews of [[a,b],[b,a]]){assert.equal(latestReview(reviews)?.id,b.id);const c=contract();c.reviews=reviews;assert.equal(summary(c).displayStatus,'待律师接收');}
});
test('review requires the current confirmed Word; a later message invalidates the old Word',()=>{
 const c=contract(),v=c.versions[0];assert.equal(reviewVersionProblem(c,v),undefined);
 c.workflow!.inputRevision=1;assert.equal(reviewVersionProblem(c,v)?.code,'VERSION_OUTDATED');
 c.workflow!.inputRevision=0;delete c.workflow!.intake!.confirmedAt;assert.ok(reviewVersionProblem(c,v));
 const lawyer:Version={...v,id:'lawyer',kind:'review',source:'lawyer',content:null};c.versions.push(lawyer);
 assert.equal(reviewVersionProblem(c,lawyer),undefined);assert.ok(reviewVersionProblem(c,v));
});
test('a patch tool streams document text but never tool reasons, hashes or evidence',async()=>{
 const args=JSON.stringify({baseSha256:'private-hash',changes:[{op:'replace',target:'section',index:1,reason:'private-reason',part:{title:'价款及付款',content:'总价为2000元，分两次付款。'}}]});
 const wire=[{choices:[{delta:{tool_calls:[{index:0,id:'patch',function:{name:'apply_contract_patch',arguments:args}}]}}]},{choices:[{delta:{},finish_reason:'tool_calls'}]}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n';
 const previews:string[]=[];await readModelResponse(new Response(wire,{headers:{'content-type':'text/event-stream'}}),'draft',e=>{if(e.type==='preview')previews.push(e.text);});
 assert.ok(previews.some(t=>t.includes('2000元')));assert.doesNotMatch(previews.join(''),/private-hash|private-reason|baseSha256/);
});
test('progress polling hydrates the contract only once at its terminal boundary',async()=>{
 const c=contract();c.workflow!.job={id:'j',phase:'generate',status:'running',attempt:1,messageId:'m',versionId:'new',createdAt:'',updatedAt:''};let loads=0,peeks=0;
 const response=observeJob(async()=>{loads++;return c;},async()=>{assert.fail('separate progress query must not run');},'j',1,1000,async()=>{peeks++;if(peeks===3)c.workflow!.job!.status='completed';return {job:c.workflow!.job,snapshot:{jobId:'j',phase:'generate',label:'正在起草',text:'正文',revision:String(peeks)}};});
 assert.match(await response.text(),/正文/);assert.equal(peeks,3);assert.equal(loads,1);
});
test('lawyer Word cannot silently become a newly drafted AI contract, including an old pending job',async()=>{
 const c=contract();c.versions.push({...c.versions[0],id:'lawyer',number:2,kind:'review',source:'lawyer',content:null});const user={id:'u',name:'客户',email:'u@test',role:'client' as const};let saves=0;
 const store={load:async()=>({contract:structuredClone(c),revision:0}),save:async(next:Contract)=>{saves++;return next;},put:async()=>{assert.fail('must not write Word');return '';},limit:async()=>{assert.fail('must not consume quota');}};
 await assert.rejects(startWorkflow(store,user,{requestId:crypto.randomUUID(),message:'调整付款'}),(e:any)=>e.code==='LAWYER_REVISION_REQUIRED');
 c.workflow!.job={id:'j',phase:'generate',status:'pending',attempt:0,messageId:'m',versionId:'new',createdAt:'',updatedAt:''};const stopped=await controlWorkflow(store,user,'j','run');assert.equal(stopped.workflow!.job!.code,'LAWYER_REVISION_REQUIRED');assert.equal(saves,1);assert.deepEqual(stopped.versions,c.versions);
});
