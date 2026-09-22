import test from 'node:test';
import assert from 'node:assert/strict';
import {compileTransactionUpdate,intakeSchema} from '../src/lib/transaction-update';
import {unresolvedTransactionFields,transactionQuestions} from '../src/lib/transaction-state';
import {intakeFixture,contentFixture} from './fixtures';
import {exportProblems} from '../src/lib/contract-library/playbooks';
const update=(input:Record<string,unknown>,previous=intakeFixture(),texts:string[]=[])=>compileTransactionUpdate(intakeSchema.parse({templateId:previous.templateId,facts:[],...input}),previous,texts).intake!;

test('modern transaction readiness does not change merely because its reference family changes',()=>{
 const previous=intakeFixture();delete previous.facts.deliverables;
 const modern=update({},previous);
 assert.deepEqual(modern.missing,[]);
 for(const templateId of ['general','software','purchase','nda','service'])assert.deepEqual(unresolvedTransactionFields({...modern,templateId}),[],templateId);
 modern.confirmedAt=new Date().toISOString();const c=contentFixture();c.confirmation=modern;assert.deepEqual(exportProblems(c),[]);
});

test('complete two-installment answer in wan is retained through validation and persistence',()=>{
 const quote='两次付款，签约4万、验收4万';const previous=intakeFixture();previous.facts.price={value:'总价8万',quote:'总价8万'};
 const i=update({facts:[{fieldId:'payment',value:quote,quote}],businessChecks:[{fieldId:'payment',status:'answered',evidence:[quote]}]},previous,[quote]);
 assert.equal(i.facts.payment.value,quote);assert.deepEqual(i.missing,[]);assert.deepEqual(i.conflicts,[]);assert.deepEqual(transactionQuestions(i),[]);
});

test('partial payment answer is retained while only the remaining decision is asked',()=>{
 const quote='分两次付';const i=update({facts:[{fieldId:'payment',value:quote,quote}],businessChecks:[{fieldId:'payment',status:'missing',evidence:[quote],question:'两次各付多少？'}]},intakeFixture(),[quote]);
 assert.equal(i.facts.payment.value,quote);assert.deepEqual(transactionQuestions(i),[{fieldId:'payment',question:'两次各付多少？'}]);
});

test('missing internal mapping is repaired before publishing a repetitive user question',()=>{
 const previous=intakeFixture();const quote=previous.facts.term.value;previous.facts.delivery=previous.facts.term;delete previous.facts.term;
 assert.throws(()=>update({},previous),/内部.*term/);
 const i=update({businessChecks:[{fieldId:'term',status:'answered',evidence:[quote]}]},previous);
 assert.deepEqual(i.missing,[]);assert.equal(i.facts.term,undefined);assert.equal(i.facts.delivery.value,quote);
});

test('a natural explicit acceptance uses the existing proposal and clears its question',()=>{
 const previous=intakeFixture();delete previous.facts.payment;previous.missing=['payment'];previous.businessChecks=[{fieldId:'payment',status:'missing',evidence:[],question:'怎么付款？'}];
 previous.businessProposals=[{id:'p1',fieldId:'payment',value:'签约付一半，验收付另一半'}];
 const pending=update({businessChecks:previous.businessChecks},previous,['先保留这个建议']);assert.equal(pending.facts.payment,undefined);
 const i=update({acceptedProposalIds:['p1']},previous,['那就按你刚刚提的，一半一半办吧']);
 assert.equal(i.facts.payment.value,previous.businessProposals[0].value);assert.equal(i.facts.payment.source,'accepted_proposal');assert.deepEqual(i.missing,[]);
 assert.throws(()=>update({acceptedProposalIds:['nonexistent']},previous,['同意']),/不存在/);
});

test('rejected evidence cannot mutate previously saved facts or lawyer notes',()=>{
 const previous=intakeFixture();previous.reviewNotes=['律师核对权利边界'];const before=structuredClone(previous);
 assert.throws(()=>update({facts:[{fieldId:'price',value:'9万',quote:'9万'}]},previous,['其他不变']),/引用不是用户原话/);
 assert.deepEqual(previous,before);
});

test('grounded no-charge assessment is shared by financial and document checks',async()=>{
 const {intakeFactIssues,priceTerms,draftFactIssues}=await import('../src/lib/contract-library/fact-checks');
 const previous=intakeFixture();const quote='把一台型号A1的咖啡机无偿借给乙方';
 const i=update({facts:[{fieldId:'price',value:quote,quote}],clearedFields:['payment'],businessChecks:[{fieldId:'price',status:'not_applicable',evidence:[quote],reason:'无偿借用'},{fieldId:'payment',status:'not_applicable',evidence:[quote],reason:'无付款义务'}]},previous,[quote]);
 assert.deepEqual(intakeFactIssues(i),[]);assert.equal(priceTerms(i).basis,'free');assert.deepEqual(i.missing,[]);
 const c=contentFixture();c.confirmation=i;c.sections=[{title:'费用',content:'合同总价为100元。'}];assert.ok(draftFactIssues(c).length);
});

test('interview evaluation scores the material-supply question, not its internal field spelling',async()=>{
 const {scoreIntake}=await import('../scripts/eval-contract-score');const i=intakeFixture();i.missing=['material_supply'];i.businessChecks=[{fieldId:'material_supply',status:'missing',evidence:[],question:'材料由哪一方采购提供？'}];
 assert.deepEqual(scoreIntake({missing:'materials'},i),[]);
 i.businessChecks[0].question='准备什么时候开工？';assert.ok(scoreIntake({missing:'materials'},i).length);
 i.businessChecks[0].question='超过两次修改怎么收费？';assert.ok(scoreIntake({noQuestionPatterns:['超过.{0,10}修改']},i).length);
});

test('internal evidence repair names the missing span and never demands a repeated user answer',async()=>{
 const {businessCheckProblems}=await import('../src/lib/business-checks');
 const i=intakeFixture();const problems=businessCheckProblems([{fieldId:'price',status:'answered',evidence:['每把100块，一共3000块']}],i.facts,['每把100块，一共3000块']);
 assert.equal(problems.length,1);assert.match(problems[0],/每把100块，一共3000块/);assert.match(problems[0],/facts.evidence/);assert.match(problems[0],/不得让用户重说/);
});

test('mixed total and installments, and stale revision evidence, are repaired internally before a user sees conflicts',async()=>{
 const {collectIntake}=await import('../src/server/ai');const old=fetch;let calls=0;
 const first='3000块，先付1500，定稿后付1500',second='价格改成4000，先付2000，定稿后付2000';
 const message=(content:string)=>({id:crypto.randomUUID(),role:'user' as const,content,createdAt:''});
 const env={CONTRACT_AI_API_KEY:'fixture-only',CONTRACT_AI_BASE_URL:'https://model.test'};
 try{
  globalThis.fetch=async(_url,init)=>{
   calls++;const revision=calls>2;const raw=revision?second:first;const n=revision?'2000':'1500';
   const payment='先付'+n+'，定稿后付'+n;const price=revision?'价格改成4000':'3000块';
   if(calls%2===0)assert.match(String(init?.body),/总价也计入分期/);
   const bad=calls%2===1;
   const result={templateId:'software',facts:bad?['price','payment'].map(fieldId=>({fieldId,value:'模型整理值',quote:raw,evidence:revision?[raw,first]:[raw]})):[{fieldId:'price',value:price,quote:price},{fieldId:'payment',value:payment,quote:payment}]};
   return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
  };
  const initial=await collectIntake([message(first)],intakeFixture(),env);assert.equal(calls,2);assert.deepEqual(initial.intake!.conflicts,[]);
  const corrected=await collectIntake([message(first),message(second)],initial.intake,env);assert.equal(calls,4);assert.deepEqual(corrected.intake!.conflicts,[]);assert.equal(corrected.intake!.facts.payment.value,'先付2000，定稿后付2000');assert.doesNotMatch(corrected.intake!.facts.price.value,/3000/);
 }finally{globalThis.fetch=old}
});

test('the user current payment answer wins over an accepted proposal display string',()=>{
 const previous=intakeFixture();previous.facts.price={value:'总共8万元',quote:'总共8万元'};previous.businessProposals=[{id:'p',fieldId:'payment',value:'8万元分两次付：签约后支付50%（40000元）；验收后支付50%（40000元）。'}];
 const quote='签约先付4万，验收后付4万';const i=update({facts:[{fieldId:'payment',value:quote,quote}],businessChecks:[{fieldId:'payment',status:'answered',evidence:[quote]}],acceptedProposalIds:['p']},previous,[quote]);
 assert.equal(i.facts.payment.value,quote);assert.equal(i.facts.payment.source,'user');assert.deepEqual(i.conflicts,[]);
 const adopted=update({acceptedProposalIds:['p']},previous,['就采用这个分期安排']);
 assert.equal(adopted.facts.payment.source,'accepted_proposal');assert.deepEqual(adopted.conflicts,[]);
});

test('null, omitted and unregistered contract families share general drafting without losing evidence',()=>{
 for(const candidate of [{templateId:null},{templateId:'coffee_swap_2026'},{}]){
  const previous=intakeFixture();previous.reviewNotes=['已有律师事项'];const before=structuredClone(previous);
  const result=compileTransactionUpdate(intakeSchema.parse({facts:[],...candidate}),previous,[]).intake!;
  assert.equal(result.templateId,'general');assert.deepEqual(result.facts,previous.facts);assert.deepEqual(result.missing,[]);assert.deepEqual(result.conflicts,[]);assert.ok(result.reviewNotes!.includes('已有律师事项'));assert.equal(result.confirmedAt,undefined);assert.deepEqual(previous,before);
 }
});

test('uncertainty about legal language cannot negate a grounded payment answer',()=>{
 const quote='我不知道法律怎么写，但签约付4万、验收付4万';const previous=intakeFixture();previous.facts.price={value:'总价8万',quote:'总价8万'};
 const i=update({facts:[{fieldId:'payment',value:quote,quote}],businessChecks:[{fieldId:'payment',status:'answered',evidence:[quote]}]},previous,[quote]);
 assert.equal(i.facts.payment.value,quote);assert.deepEqual(i.missing,[]);assert.deepEqual(i.conflicts,[]);assert.deepEqual(transactionQuestions(i),[]);
});

test('professional IP drafting remains a sourced system rule rather than a legal question for the user',()=>{
 const previous=intakeFixture();previous.templateId='general';delete previous.facts.ip;
 const i=update({businessChecks:[{fieldId:'ip',status:'standard',defaultRule:'ip',reason:'用途已明确，权利衔接由系统起草并交律师复核'}]},previous);
 assert.ok(i.businessChecks!.some(c=>c.fieldId==='ip'&&c.status==='standard'));assert.match(i.defaults!.ip,/不因交付自动转让/);assert.equal(i.facts.ip,undefined);assert.deepEqual(transactionQuestions(i),[]);
});

test('modern drafting modules follow relevant semantic decisions, not a negated revenue keyword',()=>{
 const previous=intakeFixture(),quote='双方不另外付钱，也没有销售分成';previous.templateId='general';
 const i=update({facts:[{fieldId:'exchange',value:quote,quote}],businessChecks:['collection','settlement','revenueAdjustments'].map(fieldId=>({fieldId,status:'not_applicable',evidence:[quote],reason:'无分成结算'}))},previous,[quote]);
 assert.ok(!i.draftingPlan!.modules.includes('revenue'));
 const fixedPrice=update({businessChecks:[{fieldId:'collection',status:'answered',evidence:[previous.facts.partyB.value]}]},previous);
 assert.ok(!fixedPrice.draftingPlan!.modules.includes('revenue'));
});
