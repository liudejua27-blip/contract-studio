import test from 'node:test';
import assert from 'node:assert/strict';
import {intakeFactIssues,priceTerms} from '../src/lib/contract-library/fact-checks';
import {evidenceValue,proposalProblems} from '../src/lib/intake-guidance';
import {defaultsFor} from '../src/lib/contract-library/guided-policy';
import {unresolvedTransactionFields,transactionQuestions} from '../src/lib/transaction-state';
import {businessCheckProblems} from '../src/lib/business-checks';
import {collectIntake,validateNumericFacts} from '../src/server/ai';
import {scoreIntake} from '../scripts/eval-contract-score';
import {intakeFixture,contentFixture} from './fixtures';
import type {Message} from '../src/lib/types';
const fact=(value:string)=>({value,quote:value});
const env={CONTRACT_AI_API_KEY:'fixture-only',CONTRACT_AI_BASE_URL:'https://model.test'};
const message=(content:string):Message=>({id:crypto.randomUUID(),role:'user',content,createdAt:''});
const response=(result:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name:'update_contract_spec',arguments:JSON.stringify({result})}}]}}]});

test('everyday prices and overlapping citations work without erasing payment arithmetic',()=>{
 for(const [price,payment,total] of [
  ['总共1800块含税','先付900块，验收后付900块',180000],
  ['总共3万','开工付15000元，验收付15000元',3000000],
  ['价格改成4000','先付2000元，定稿付2000元',400000],
  ['总价80000元；开发系统，总价80000元。','首款40000元，尾款40000元',8000000],
  ['每把100块，一共3000块','验收后付清',300000],
  ['互不收钱','不需要付款',0],
 ] as const){const i=intakeFixture();i.facts.price=fact(price);i.facts.payment=fact(payment);assert.deepEqual(intakeFactIssues(i),[],price);assert.deepEqual(priceTerms(i).amountsInCents,[total]);}
 const i=intakeFixture();i.facts.price=fact('1800块');i.facts.payment=fact('先付900块，尾款1000块');assert.ok(intakeFactIssues(i).some(s=>s.includes('合计')));
 i.facts.price=fact('总价3000元或总价4000元');assert.ok(intakeFactIssues(i).length);
 i.facts.price=fact('不提供免费服务');assert.ok(intakeFactIssues(i).length);assert.notEqual(priceTerms(i).basis,'free');
});

test('periodic service fees do not require a fabricated total',()=>{
 const i=intakeFixture('service');i.facts.price=fact('一个月1200');i.facts.payment=fact('每季度付3600元');
 assert.equal(priceTerms(i).basis,'periodic');assert.deepEqual(intakeFactIssues(i),[]);
 assert.deepEqual(priceTerms(i).amountsInCents,[120000]);
});

test('draft verification uses the same money interpretation as intake, including bare payments and remainder',()=>{
 const c=contentFixture('purchase'),i=c.confirmation!;i.facts.price=fact('总共1800块含税');i.facts.payment=fact('先付500，剩下验收后付');
 c.sections=[{title:'价款与付款',content:'合同总价1800元，首款500元，尾款1300元。'}];
 assert.doesNotThrow(()=>validateNumericFacts(c,'总共1800块含税；先付500，剩下验收后付'));
 c.sections[0].content='合同总价1800元，首款500元，尾款1400元。';assert.throws(()=>validateNumericFacts(c,'总共1800块含税；先付500，剩下验收后付'));
 i.facts.price=fact('价格改成4000');i.facts.payment=fact('签约与验收后各付一半');c.sections[0].content='合同总价4000元，首款2000元，尾款2000元。';assert.doesNotThrow(()=>validateNumericFacts(c,'价格改成4000；签约与验收后各付一半'));
});

test('cross-field amount evidence still checks quantity and unit price in everyday language',()=>{
 const i=intakeFixture('purchase');delete i.facts.price;i.facts.totalPrice=fact('一共3000块');i.facts.goods=fact('买50把椅子，每把100块');i.facts.payment=fact('收货后付清');
 i.businessChecks=[{fieldId:'price',status:'answered',evidence:['一共3000块']}];
 assert.ok(intakeFactIssues(i).some(s=>s.includes('5000元')&&s.includes('优惠')));
 i.facts.discount=fact('优惠2000元');assert.deepEqual(intakeFactIssues(i),[]);
 delete i.facts.discount;i.facts.goods=fact('买50个水杯，每个100毫升');assert.deepEqual(intakeFactIssues(i),[]);
 i.facts.payment=fact('先付2000，尾款2000');assert.ok(intakeFactIssues(i).some(s=>s.includes('合计')));
 delete i.facts.totalPrice;i.businessChecks=[];i.facts.price=fact('每把100元');i.facts.goods=fact('买50把椅子，每把100元');i.facts.payment=fact('收货后付清');assert.deepEqual(intakeFactIssues(i),[]);assert.equal(priceTerms(i).basis,'unit');
});

test('source citations are retained without multiplying identical monetary obligations',()=>{
 const short='总价80000元',long='开发系统，总价80000元。';
 assert.equal(evidenceValue({value:'80000元',quote:short,evidence:[long]}),long);
 assert.equal(evidenceValue({value:'先付900；余款验收后付',quote:'先付900',evidence:['余款验收后付']}),'先付900；余款验收后付');
});

test('standard acceptance is nonblocking, remains separate from facts, and cannot hide core decisions',()=>{
 const i=intakeFixture();delete i.facts.acceptance;
 i.businessChecks=[{fieldId:'acceptance',status:'standard',defaultRule:'acceptance',reason:'按已知功能清单核对即可',evidence:[]}];
 assert.deepEqual(unresolvedTransactionFields(i),[]);assert.deepEqual(transactionQuestions(i),[]);assert.match(defaultsFor(i).acceptance,/沉默不视为/);assert.equal(i.facts.acceptance,undefined);
 delete i.facts.payment;i.businessChecks=[{fieldId:'payment',status:'standard',defaultRule:'breach',reason:'系统处理',evidence:[]}];assert.ok(unresolvedTransactionFields(i).includes('payment'));
 i.businessChecks=[{fieldId:'acceptance',status:'standard',defaultRule:'acceptance',reason:'普通条款',evidence:[]}];i.withdrawnFields=['acceptance'];assert.equal(defaultsFor(i).acceptance,undefined);assert.ok(unresolvedTransactionFields(i).includes('acceptance'));
});

test('unsafe acceptance and payment proposals remain rejected',()=>{
 const i=intakeFixture();
 for(const value of ['逾期未提出异议的视为验收合格。','交付后未回复，视为服务完成。'])assert.ok(proposalProblems([{fieldId:'acceptance',value}],i.facts).length);
 assert.deepEqual(proposalProblems([{fieldId:'acceptance',value:'沉默不视为验收通过。'}],i.facts),[]);
 i.facts.payment=fact('月底付');assert.ok(proposalProblems([{fieldId:'payment_method',value:'每月月底后3日内支付。'}],i.facts).length);
});

test('invalid date citation is fixed in the same agent loop, with no repeated date question',async()=>{
 const old=fetch;let calls=0;const raw='2026年10月1日至10月31日';const i=intakeFixture();delete i.facts.term;
 try{globalThis.fetch=async()=>response({templateId:'software',reply:'工期已记下。',facts:[{fieldId:'term',value:raw,quote:++calls===1?'2026年10月1日至2026年10月31日':raw}]});
 const r=await collectIntake([message(raw)],i,env);assert.equal(calls,2);assert.equal(r.intake!.facts.term.value,raw);assert.ok(!r.intake!.missing.includes('term'));assert.doesNotMatch(r.reply,/什么时候开始|什么时候交付/);
 }finally{globalThis.fetch=old}
});

test('proposal changing month-end payment is repaired before it is shown',async()=>{
 const old=fetch;let calls=0;const i=intakeFixture();i.facts.payment=fact('月底付');
 try{globalThis.fetch=async()=>response(++calls===1?{templateId:'software',facts:[],businessProposals:[{fieldId:'payment_method',value:'月底后3日内付款'}]}:{templateId:'software',reply:'月底付款的安排保留。',facts:[],businessProposals:[]});
 const r=await collectIntake([message('其他按常见方式处理')],i,env);assert.equal(calls,2);assert.equal(r.intake!.facts.payment.value,'月底付');assert.deepEqual(r.intake!.businessProposals,[]);assert.deepEqual(r.intake!.missing,[]);
 }finally{globalThis.fetch=old}
});

test('participant names are checked against retained user evidence, not model paraphrases',async()=>{
 const old=fetch;let calls=0;const i=intakeFixture();
 try{globalThis.fetch=async()=>{calls++;return response({templateId:'software',facts:[{fieldId:'partyA',value:'甲公司',quote:'测试甲公司'},{fieldId:'partyB',value:'乙公司',quote:'测试乙公司'}],participants:[{role:'甲方',name:'测试甲公司',factId:'partyA',subjectType:'organization'},{role:'乙方',name:'测试乙公司',factId:'partyB',subjectType:'organization'}]})};
 const r=await collectIntake([message('测试甲公司委托测试乙公司')],i,env);assert.equal(calls,1);assert.equal(r.intake!.participants![0].name,'测试甲公司');assert.equal(r.intake!.facts.partyA.value,'测试甲公司');
 }finally{globalThis.fetch=old}
});

test('resuming an old over-questioned conversation reassesses the stale gap inside the agent',async()=>{
 const old=fetch;let calls=0;const i=intakeFixture(),quote=i.facts.payment.value;
 i.missing=['paymentTimeline'];i.conflicts=['请明确一个合同总价，使用“金额＋元”，费用明细另行说明。'];i.businessChecks=[{fieldId:'paymentTimeline',status:'missing',evidence:[quote],question:'付款节点后几天付？'}];
 i.businessProposals=[{id:'old',fieldId:'paymentTimeline',value:'验收后5天付款'}];
 try{globalThis.fetch=async()=>{calls++;return response({templateId:'software',facts:[],businessChecks:[{fieldId:'payment',status:'answered',evidence:[quote]},...(calls>1?[{fieldId:'paymentTimeline',status:'answered',evidence:[quote]}]:[])],conflicts:i.conflicts})};
 const r=await collectIntake([message('付款早就说过了，其他按常见方式处理')],i,env);assert.equal(calls,2);assert.deepEqual(r.intake!.missing,[]);assert.deepEqual(r.intake!.conflicts,[]);assert.deepEqual(r.intake!.businessProposals,[]);
 }finally{globalThis.fetch=old}
});

test('evaluation fails unexpected blockers even when selected noMissing assertions pass',()=>{
 const i=intakeFixture();i.conflicts=['请重新提供总价'];assert.ok(scoreIntake({noMissing:['price']},i).length);
 i.conflicts=[];i.missing=['unnecessaryGap'];assert.ok(scoreIntake({ready:true},i).length);
 i.conflicts=['格式错误'];assert.ok(scoreIntake({conflict:true,conflictIncludes:'5000'},i).length);
});
