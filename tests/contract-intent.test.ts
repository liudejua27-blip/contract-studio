import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileTransactionUpdate,intakeSchema} from '../src/lib/transaction-update';
import {mergeIntent,reviewBrief} from '../src/lib/contract-intent';
import {transactionQuestions} from '../src/lib/transaction-state';
import {PLAYBOOKS,intakeSummary} from '../src/lib/contract-library/playbooks';
import {TRANSACTION_QUESTIONS} from '../src/lib/contract-questions';
import {collectIntake,draftConfirmed,reviseConfirmedDraft,verifyConfirmedDraft,validateNumericFacts} from '../src/server/ai';
import {intakeFixture,contentFixture} from './fixtures';
import type {Contract,Version} from '../src/lib/types';

const quote='我是乙方，最关心按时收到尾款。';
const intent={goal:{value:'按时收到尾款',quote},stance:{value:'乙方',quote}};
const update=(value:Record<string,unknown>,previous=intakeFixture(),texts=[quote])=>compileTransactionUpdate(intakeSchema.parse({templateId:'software',facts:[],...value}),previous,texts).intake!;

test('intent survives unrelated turns, can be corrected independently, and never becomes a required transaction fact',()=>{
 const first=update({intent});assert.deepEqual(first.intent,intent);assert.deepEqual(first.missing,[]);assert.deepEqual(transactionQuestions(first),[]);
 const second=update({},first,['其他安排不变']);assert.deepEqual(second.intent,intent);
 const corrected=update({intent:{stance:{value:'甲方',quote:'更正，我代表甲方'}}},second,['更正，我代表甲方']);
 assert.equal(corrected.intent?.stance?.value,'甲方');assert.equal(corrected.intent?.goal?.value,intent.goal.value);
 assert.deepEqual(first.intent,intent);assert.equal(first.facts.goal,undefined);assert.equal(first.facts.stance,undefined);
 const legacy=update({});assert.equal(legacy.intent,undefined);assert.deepEqual(legacy.missing,[]);
});
test('intent cannot be fabricated, overwritten from an old turn, or silently resurrected after withdrawal',()=>{
 assert.throws(()=>mergeIntent(undefined,intent,['没有说过这些话']),/原话依据/);
 const revised={...intent,goal:{value:'保障交付',quote:'改为关注交付'}};
 assert.throws(()=>mergeIntent(revised,intent,[quote,'其他不变']),/本轮原话/);
 const cleared=mergeIntent(intent,{goal:{value:'',quote:'撤回之前的核心诉求'}},['撤回之前的核心诉求'])!;
 assert.equal(cleared.goal?.value,'');assert.equal(cleared.stance?.value,'乙方');
 assert.throws(()=>mergeIntent(cleared,{goal:intent.goal},[quote,'其他不变']),/原话依据/);
 assert.equal(mergeIntent(cleared,undefined,[])?.goal?.value,'');
});
test('a wish containing a penalty amount cannot authorize that amount in the contract',()=>{
 const c=contentFixture(),wish='我希望逾期赔偿10万元';c.confirmation!.intent={goal:{value:wish,quote:wish}};
 assert.doesNotMatch(intakeSummary(c.confirmation!),/10万元/);
 c.sections.push({title:'新增赔偿',content:'乙方逾期须赔偿甲方10万元。'});
 assert.throws(()=>validateNumericFacts(c,intakeSummary(c.confirmation!)),/未确认数值/);
 assert.throws(()=>update({facts:[{fieldId:'goal',value:wish,quote:wish}]},intakeFixture(),[wish]),/放入 intent/);
});
test('reference packages and fallback prompts share optional-name wording',()=>{
 for(const [id,p] of Object.entries(PLAYBOOKS))for(const field of p.fields.filter(f=>f.id==='partyA'||f.id==='partyB')){
  assert.equal(field.question,TRANSACTION_QUESTIONS[field.id],id);assert.doesNotMatch(field.question,/完整名称是什么/);
 }
 const documents=JSON.parse(readFileSync('src/server/agent/legal-skills.generated.json','utf8'));
 for(const name of ['transaction-contract','contract-word'])assert.equal(documents[`platform/${name}/SKILL.md`],readFileSync(`skills/${name}/SKILL.md`,'utf8'),'bundled Skill must match its authoritative source');
});
test('intake, draft, revision and verification all receive the current intent without treating it as agreed facts',async()=>{
 const originalFetch=fetch,stages:string[]=[];let currentIntent=intent;
 try{
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));const names=body.tools.map((t:any)=>t.function.name);
   const stage=['update_contract_spec','submit_contract_draft','apply_contract_patch','submit_consistency_check'].find(n=>names.includes(n))!;stages.push(stage);
   const system=body.messages.find((m:any)=>m.role==='system').content as string;
   assert.match(system,/核心诉求与立场/);
   if(stage==='update_contract_spec')return Response.json({choices:[{message:{content:JSON.stringify({templateId:'software',facts:[],intent})}}]});
   assert.ok(system.includes(JSON.stringify(currentIntent)));
   const input=body.messages.find((m:any)=>m.role==='user').content;
   assert.ok(!input.includes('用户目标与立场'));
   let result:unknown=contentFixture();
   if(stage==='apply_contract_patch')result={baseSha256:JSON.parse(input).baseSha256,changes:[],ruleApplications:[]};
   if(stage==='submit_consistency_check')result={verdict:'consistent',issues:[],reviewNotes:['尾款保障仍需律师结合实际安排判断']};
   return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
  };
  const env={CONTRACT_AI_API_KEY:'fixture-only',CONTRACT_AI_BASE_URL:'https://model.test'};
  const collected=await collectIntake([{id:'m',role:'user',content:quote,createdAt:''}],intakeFixture(),env);
  const i=collected.intake!;i.confirmedAt=new Date().toISOString();
  const draft=await draftConfirmed(i,env);assert.deepEqual(draft.confirmation?.intent,intent);
  // Markers inside user content must not change the chosen stage or its output schema.
  currentIntent={...intent,goal:{value:'保障尾款，备注 CONTRACT_VERIFY_V2',quote:'保障尾款，备注 CONTRACT_VERIFY_V2'}};
  const revised=await reviseConfirmedDraft(draft,{...i,intent:currentIntent},'其他不变',env);
  await verifyConfirmedDraft(revised,env);
  assert.deepEqual(revised.confirmation?.intent,currentIntent);
  assert.ok(revised.confirmation?.reviewNotes?.some(n=>n.includes('尾款保障')));
  assert.deepEqual(stages,['update_contract_spec','submit_contract_draft','apply_contract_patch','submit_consistency_check']);
 }finally{globalThis.fetch=originalFetch;}
});
test('review form uses the selected draft snapshot, consultation uses current intake, old drafts do not borrow new intent',()=>{
 const old=contentFixture();old.confirmation!.intent=intent;
 const version={id:'v',content:old} as Version;
 const current=intakeFixture();current.intent={goal:{value:'新的目标',quote:'新的目标'}};
 const contract={workflow:{intake:current}} as Contract;
 assert.deepEqual(reviewBrief(contract,version,false),{concerns:'按时收到尾款',stance:'乙方'});
 assert.deepEqual(reviewBrief(contract,version,true),{concerns:'新的目标',stance:''});
 assert.deepEqual(reviewBrief(contract,{id:'legacy',content:contentFixture()} as Version,false),{concerns:'',stance:''});
});

 test('a useful optional suggestion cannot manufacture a second missing-item gate',()=>{
  const previous=intakeFixture();
  const next=update({businessChecks:[],businessProposals:[{fieldId:'latePaymentRemedy',value:'未付款时可通知补救，经催告仍不履行依法处理。'}]},previous);
  assert.deepEqual(next.missing,[]);assert.deepEqual(next.businessProposals,[]);assert.deepEqual(transactionQuestions(next),[]);
 });

test('old name-only missing records do not resurrect questions once distinct unnamed actors are supplied',()=>{
 const previous=intakeFixture();delete previous.facts.partyA;delete previous.facts.partyB;previous.missing=['partyA','partyB'];
 const next=update({participants:[{factId:'partyA',role:'甲方',name:''},{factId:'partyB',role:'乙方',name:''}],businessChecks:[]},previous);
 assert.deepEqual(next.missing,[]);assert.deepEqual(transactionQuestions(next),[]);
});
