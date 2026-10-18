import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {feedbackSchema,validateSourceQuotes,assertDeidentified,matchingPreferences,auditPreferences,type ClausePreference} from '../src/lib/review-learning';
import {evaluationSet,readEvaluationSet,digest,scoreFeedback} from '../src/lib/feedback-evaluation';
import {draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {contentFixture,intakeFixture} from './fixtures';
const preference:ClausePreference={id:crypto.randomUUID(),revision:1,confirmedAt:'2026-09-26',title:'验收表达',guidance:'分开说明验收与补救，不假设默认验收。',templateId:'software',stance:'甲方',when:'软件功能交付',unless:'用户已有相反明确安排'};
const feedback=()=>({requestId:crypto.randomUUID(),beforeVersionId:'before',afterVersionId:'after',beforeQuote:'逾期视为验收',afterQuote:'验收需要明确确认',category:'risk' as const,reason:'避免以沉默当验收',preference});
const sample=()=>({id:crypto.randomUUID(),revision:1,category:'risk',confirmedAt:'2026-09-26',scenario:'委托方购买定制软件，双方要求明确确认验收，请起草验收条款。',expected:'保留明确确认验收，不增加沉默通过安排。',criteria:['是否保留明确确认','是否没有增加沉默通过'],split:'holdout' as const,deidentified:true as const});
test('feedback requires a useful output, and negotiated facts cannot become reusable preferences',()=>{
 assert.ok(feedbackSchema.safeParse(feedback()).success);
 assert.equal(feedbackSchema.safeParse({...feedback(),category:'negotiated'}).success,false);
 assert.equal(feedbackSchema.safeParse({...feedback(),preference:undefined}).success,false);
 assert.equal(feedbackSchema.safeParse({...feedback(),beforeQuote:'',afterQuote:''}).success,false);
});
test('source evidence is verbatim, changed, and bound to both immutable versions',()=>{
 const f=feedbackSchema.parse(feedback());validateSourceQuotes(f,'验收：逾期视为验收。','验收：验收需要明确确认。');
 assert.throws(()=>validateSourceQuotes(f,'不存在','验收需要明确确认'),/逐字/);
 assert.throws(()=>validateSourceQuotes({...f,afterQuote:f.beforeQuote},'逾期视为验收','逾期视为验收'),/没有变化/);
 assert.throws(()=>validateSourceQuotes({...f,beforeQuote:''},'验收需要明确确认','验收需要明确确认'),/仍存在/);
});
test('preference matching does not cross stance or contract family and stays bounded',()=>{
 const i=intakeFixture();i.intent={stance:{value:'甲方',quote:'我代表甲方'}};
 assert.deepEqual(matchingPreferences([preference],i),[preference]);assert.deepEqual(matchingPreferences([preference],undefined),[]);
 assert.equal(matchingPreferences([{...preference,stance:'乙方'}],i).length,0);assert.equal(matchingPreferences([{...preference,templateId:'purchase'}],i).length,0);
 assert.equal(matchingPreferences([{...preference,stance:''}],i).length,1);assert.equal(matchingPreferences(Array.from({length:15},()=>preference),i).length,12);
});
test('preference adoption receipts cannot cite another owner or an absent clause',()=>{
 const c=contentFixture(),quote=c.sections[0].content;
 const use={id:preference.id,decision:'applied' as const,reason:'适用',quote};assert.equal(auditPreferences(c,[preference],[use]).uses.length,1);
 assert.throws(()=>auditPreferences(c,[],[use]),/不存在/);assert.throws(()=>auditPreferences(c,[preference],[{...use,quote:'凭空插入条款'}]),/实际文字/);
 assert.throws(()=>auditPreferences(c,[preference],[use,use]),/重复/);assert.equal(auditPreferences(c,[preference],[]).uses.length,0);
});
test('sample screening blocks known identities without claiming complete anonymization',()=>{
 assert.doesNotThrow(()=>assertDeidentified(sample()));for(const scenario of ['张某真实姓名需要验收','隐私有限公司业务','联系13812345678'])assert.throws(()=>assertDeidentified({...sample(),scenario},['张某真实姓名']));
});
test('evaluation exports only curated sample fields with a stable dataset fingerprint',()=>{
 const c={...sample(),contractId:'private-contract',beforeQuote:'private-original',ownerId:'secret'};
 const set=evaluationSet([c]);assert.ok(!JSON.stringify(set).includes('private'));assert.equal(readEvaluationSet(set).hash,set.hash);
 assert.throws(()=>readEvaluationSet({...set,cases:[{...set.cases[0],expected:'篡改'}]}),/校验/);assert.throws(()=>evaluationSet([c,c]),/重复/);
});
test('evaluation cannot pass missing or uncertain human assessments, and reports development separately',()=>{
 const set=evaluationSet([sample(),{...sample(),split:'development'}]);
 const output={setHash:set.hash,model:'fixture',createdAt:'now',results:set.cases.map(c=>({id:c.id,candidate:'验收须明确确认'}))};
 const reviews={setHash:set.hash,outputHash:digest(output),reviewer:'测试评审',results:[] as any[]};
 assert.equal(scoreFeedback(set,output,reviews).holdout.targetMet,false);assert.equal(scoreFeedback(set,output,reviews).holdout.uncertain,1);
 reviews.results=set.cases.map(c=>({id:c.id,criteria:c.criteria.map((_,index)=>({index,verdict:'pass',reason:'符合匿名场景'}))}));
 assert.equal(scoreFeedback(set,output,reviews).holdout.targetMet,true);assert.equal(scoreFeedback(set,output,reviews).development.total,1);
 reviews.results[0].criteria[0].verdict='uncertain';assert.equal(scoreFeedback(set,output,reviews).holdout.targetMet,false);
 assert.throws(()=>scoreFeedback(set,{...output,results:[]},reviews),/不属于/);
});
test('evaluation rejects duplicated judgments instead of inflating pass counts',()=>{
 const set=evaluationSet([sample()]),output={setHash:set.hash,model:'fixture',createdAt:'now',results:[{id:set.cases[0].id,candidate:'结果'}]},criterion={index:0,verdict:'pass' as const,reason:'通过'};
 assert.throws(()=>scoreFeedback(set,output,{setHash:set.hash,outputHash:digest(output),reviewer:'测试评审',results:[{id:set.cases[0].id,criteria:[criterion,criterion]}]}),/重复/);
});
test('actual drafting tools read confirmed preferences, record use and pass the frozen audit into verification',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'contract-feedback-')),saved=fetch,i=intakeFixture(),c=contentFixture();let calls=0;
 i.intent={stance:{value:'甲方',quote:'我代表甲方'}};
 const tool=(name:string,result:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(result)}}]}}]});
 try{
  globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));if(calls===1){assert.ok(body.tools.some((t:any)=>t.function.name==='get_clause_preferences'));return tool('get_clause_preferences',{});}if(calls===2){assert.match(JSON.stringify(body.messages),/分开说明验收与补救/);return tool('submit_contract_draft',{result:{...c,preferenceUses:[{id:preference.id,decision:'applied',reason:'采用了明确验收表达',quote:c.sections[0].content}]}});}assert.match(JSON.stringify(body.messages),/preferenceAudit/);return tool('submit_consistency_check',{result:{verdict:'consistent',issues:[]}});};
  const env={CONTRACT_PI_SESSION_DIR:dir,CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test'},context={ownerId:'owner',contractId:'contract',requestId:'draft',history:[],clausePreferences:[preference]};
  const draft=await draftConfirmed(i,env,undefined,undefined,context);assert.equal(draft.preferenceAudit?.uses[0].id,preference.id);assert.deepEqual(draft.preferenceAudit?.candidates,[preference]);await verifyConfirmedDraft(draft,env,undefined,{...context,requestId:'verify'});assert.equal(calls,3);
 }finally{globalThis.fetch=saved;await rm(dir,{recursive:true,force:true});}
});
