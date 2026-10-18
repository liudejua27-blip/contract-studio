import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {resultToolParameters} from '../src/server/agent/tool-schema';
import {businessCheckProblems} from '../src/lib/business-checks';
import {unresolvedTransactionFields,transactionQuestions} from '../src/lib/transaction-state';
import {collectIntake} from '../src/server/ai';
import {startWorkflow} from '../src/server/workflow';
import {exportProblems} from '../src/lib/contract-library/playbooks';
import {contentFixture,intakeFixture} from './fixtures';
import {legalSkillBundle,LEGAL_SKILL_ADAPTER} from '../src/server/agent/legal-skills';
import type {Contract,Message} from '../src/lib/types';
const env={CONTRACT_AI_API_KEY:'fixture-only',CONTRACT_AI_BASE_URL:'https://model.test'};
const fact=(value:string)=>({value,quote:value});
const message=(content:string):Message=>({id:crypto.randomUUID(),role:'user',content,createdAt:''});
const response=(result:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name:'update_contract_spec',arguments:JSON.stringify({result})}}]}}]});

test('real schema advertises nested properties, required fields and bounds while execution keeps refinements',()=>{
 const schema=z.object({amount:z.number().min(1),rows:z.array(z.object({name:z.string().min(1)})).min(1),optional:z.string().optional()});
 const parameters=resultToolParameters(schema) as any;
 assert.equal(parameters.properties.result.properties.amount.type,'number');
 assert.equal(parameters.properties.result.properties.amount.minimum,1);
 assert.equal(parameters.properties.result.properties.rows.items.properties.name.minLength,1);
 assert.deepEqual(parameters.properties.result.required,['amount','rows']);
 assert.equal(schema.safeParse({amount:0,rows:[]}).success,false);
});

test('cross-field answers are accepted at conversation, workflow confirmation and Word export gates',async()=>{
 const i=intakeFixture(),answer=i.facts.term.value;delete i.facts.term;
 i.facts.specialTerms=fact(answer);i.businessChecks=[{fieldId:'term',status:'answered',evidence:[answer]}];
 assert.deepEqual(unresolvedTransactionFields(i),[]);
 const c=contentFixture();c.confirmation=i;assert.deepEqual(exportProblems(c),[]);
 const user={id:'client',name:'客户',email:'test@example.test',role:'client' as const};
 const contract:Contract={id:'contract',ownerId:user.id,ownerName:user.name,title:'test',createdAt:'',updatedAt:'',versions:[],messages:[],reviews:[],workflow:{intake:i}};
 const saved=await startWorkflow({load:async()=>({contract:structuredClone(contract),revision:0}),save:async c=>c,put:async()=>'',limit:async()=>{}},user,{requestId:crypto.randomUUID(),confirmId:i.summaryId});
 assert.equal(saved.workflow?.job?.phase,'generate');
});

test('inapplicable commercial fields need evidence and cannot erase the transaction itself',()=>{
 const i=intakeFixture('service');delete i.facts.price;delete i.facts.payment;i.facts.specialTerms=fact('本次服务无偿，双方互不收取费用');
 i.businessChecks=['price','payment'].map(fieldId=>({fieldId,status:'not_applicable',evidence:[i.facts.specialTerms.value],reason:'本次无偿服务无付款义务'}));
 assert.deepEqual(unresolvedTransactionFields(i),[]);
 assert.ok(businessCheckProblems([{fieldId:'payment',status:'not_applicable',evidence:['用户没说过'],reason:'无偿'}],i.facts,[]).length);
 assert.ok(businessCheckProblems([{fieldId:'partyA',status:'not_applicable',evidence:[i.facts.specialTerms.value],reason:'不重要'}],i.facts,[]).length);
 i.facts.specialTerms=fact('付款还没定');assert.ok(unresolvedTransactionFields(i).includes('payment'));
});

test('invalidated evidence reopens a custom commercial gap rather than silently losing it',()=>{
 const i=intakeFixture();i.facts.specialTerms=fact('顾客钱先进乙方账户');i.businessChecks=[{fieldId:'collection',status:'answered',evidence:[i.facts.specialTerms.value]}];
 assert.deepEqual(unresolvedTransactionFields(i),[]);delete i.facts.specialTerms;
 assert.ok(unresolvedTransactionFields(i).includes('collection'));
});

test('custom material gap stays open until a cross-field answer resolves it',async()=>{
 const old=fetch;const i=intakeFixture();let result:any={templateId:'software',facts:[],businessChecks:[{fieldId:'dataExitPlan',status:'missing',evidence:[],question:'合作结束后，已有数据怎么交还？'}]};
 try{
  globalThis.fetch=async()=>response(result);
  const first=await collectIntake([message('还要考虑退出的数据处理')],i,env);
  assert.deepEqual(first.intake!.missing,['dataExitPlan']);assert.match(first.reply,/怎么交还/);
  result={templateId:'software',facts:[],businessChecks:first.intake!.businessChecks};const second=await collectIntake([message('其他不变')],first.intake,env);assert.deepEqual(second.intake!.missing,['dataExitPlan']);
  const answer='结束时把数据导出给甲方，然后删除乙方副本';result={templateId:'software',reply:'数据导出和删除的安排已记下。',facts:[{fieldId:'specialTerms',...fact(answer)}],businessChecks:[{fieldId:'dataExitPlan',status:'answered',evidence:[answer]}]};
  const third=await collectIntake([message(answer)],second.intake,env);assert.deepEqual(third.intake!.missing,[]);assert.match(third.reply,/数据导出和删除/);assert.doesNotMatch(third.reply,/怎么交还/);
 }finally{globalThis.fetch=old}
});

test('deferred issue resolved in another field clears stale lawyer handoff notes',async()=>{
 const old=fetch,i=intakeFixture();i.deferredFields=['dataExitPlan'];i.reviewNotes=['尚未确定的生意安排：dataExitPlan，请与客户沟通。','律师核查使用许可'];
 const answer='到期后数据导出给甲方并删除副本';
 try{globalThis.fetch=async()=>response({templateId:'software',facts:[{fieldId:'specialTerms',...fact(answer)}],businessChecks:[{fieldId:'dataExitPlan',status:'answered',evidence:[answer]}]});
 const r=await collectIntake([message(answer)],i,env);assert.deepEqual(r.intake!.deferredFields,[]);assert.ok(!r.intake!.reviewNotes!.some(n=>n.includes('dataExitPlan')));assert.ok(r.intake!.reviewNotes!.includes('律师核查使用许可'));
 }finally{globalThis.fetch=old}
});

test('optional signing details cannot become drafting blockers; custom business decisions still can',async()=>{
 const old=fetch;
 try{globalThis.fetch=async()=>response({templateId:'software',facts:[],businessChecks:[{fieldId:'partyA_signature',status:'missing',evidence:[],question:'甲方怎么签署？'},{fieldId:'hostingCost',status:'missing',evidence:[],question:'服务器费用由谁付？'}]});
 const r=await collectIntake([message('还包括服务器托管')],intakeFixture(),env);assert.deepEqual(r.intake!.missing,['hostingCost']);assert.doesNotMatch(r.reply,/怎么签署/);
 }finally{globalThis.fetch=old}
});

test('missing decisions, proposal adoption and tools use the canonical state with no keyword interview',async()=>{
 const old=fetch,i=intakeFixture();delete i.facts.payment;
 i.businessChecks=[{fieldId:'payment',status:'missing',evidence:[],question:'尾款什么时候付？'}];i.missing=['payment'];i.businessProposals=[{id:'proposal',fieldId:'payment',value:'签约付50%，验收后付50%'}];
 try{globalThis.fetch=async()=>{throw new Error('Adoption must not invoke model')};
 const r=await collectIntake([message('采用建议：签约付50%，验收后付50%')],i,env);assert.deepEqual(r.intake!.missing,[]);assert.deepEqual(transactionQuestions(r.intake!),[]);assert.equal(r.intake!.facts.payment.source,'accepted_proposal');
 }finally{globalThis.fetch=old}
});

test('published intake tool exposes one completeness decision and retains contextual acknowledgement',async()=>{
 const old=fetch;
 try{globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));const result=body.tools.find((t:any)=>t.function.name==='update_contract_spec').function.parameters.properties.result;
  const schema=result.anyOf.find((s:any)=>s.properties.action.const==='update'),answer=result.anyOf.find((s:any)=>s.properties.action.const==='answer');
  assert.ok(answer.properties.reply);assert.equal(answer.properties.facts,undefined);assert.equal(answer.additionalProperties,false);
  assert.ok(schema.properties.businessChecks.items.properties.evidence);assert.equal(schema.properties.questions,undefined);assert.equal(schema.properties.materialGaps,undefined);
  return response({templateId:'software',reply:'总价和交付安排都按你刚才说的保留。',facts:[]});
 };
 const r=await collectIntake([message('其他按刚才说的')],intakeFixture(),env);assert.match(r.reply,/总价和交付安排/);assert.deepEqual(r.intake!.missing,[]);
 }finally{globalThis.fetch=old}
});

test('stage bundles contain one adapter, with general manuals available only on demand',async()=>{
 const bundle=await legalSkillBundle('draft',['software']);assert.equal(bundle.prompt.split(LEGAL_SKILL_ADAPTER).length-1,1);
 assert.ok(bundle.receipts.some(r=>r.path.endsWith('知识产权与IT类.md')));assert.ok(!bundle.receipts.some(r=>r.path.endsWith('独立起草指引.md')));
 assert.ok(bundle.prompt.includes('独立起草指引.md'));
});

test('explicitly free prices survive financial checks without allowing a new charge',async()=>{
 const {intakeFactIssues,draftFactIssues}=await import('../src/lib/contract-library/fact-checks');
 const c=contentFixture('service');c.confirmation!.facts.price=fact('无偿，不收任何费用');delete c.confirmation!.facts.payment;
 assert.deepEqual(intakeFactIssues(c.confirmation!),[]);
 c.sections=[{title:'费用',content:'合同总价为100元。'}];assert.ok(draftFactIssues(c).length);
 c.confirmation!.facts.price=fact('价格没谈好');assert.ok(intakeFactIssues(c.confirmation!).length);
});

test('semantic deferral accepts colloquial evidence without requiring unknown keywords',()=>{
 const i=intakeFixture(),quote='钱怎么分期得等我们合伙人拍板';
 assert.ok(businessCheckProblems([{fieldId:'payment',status:'deferred',evidence:[quote]}],i.facts,['照旧']).length);
 assert.deepEqual(businessCheckProblems([{fieldId:'payment',status:'deferred',evidence:[quote]}],i.facts,[quote]),[]);
});

test('empty arguments for optional rule lookup are accepted; malformed JSON gets one bounded recovery',async()=>{
 const {runStructuredAgent}=await import('../src/server/agent/runtime');const old=fetch;let calls=0;
 const call=(name:string,args:string)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:args}}]}}]});
 try{
  globalThis.fetch=async()=>{calls++;return calls===1?call('get_contract_rules',''):call('save_result','{"result":{"ok":true}}')};
  const input={prompt:'test',messages:[{role:'user' as const,content:'test'}],schema:z.object({ok:z.boolean()}),toolName:'save_result',rules:{software:{}},environment:env};
  assert.equal((await runStructuredAgent(input)).value.ok,true);assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>{calls++;return call('save_result',calls===1?'{"result":':'{"result":{"ok":true}}')};
  assert.equal((await runStructuredAgent(input)).value.ok,true);assert.equal(calls,2);
  calls=0;globalThis.fetch=async()=>{calls++;return call('save_result','{"result":')};
  await assert.rejects(runStructuredAgent(input));assert.equal(calls,2);
 }finally{globalThis.fetch=old}
});

test('a business decision may cite any retained evidence, not only the selected display value',()=>{
 const i=intakeFixture();const quote='2026年10月10日前送到青岛测试路1号，乙方包运费';
 i.facts.delivery={value:'乙方包运费',quote,evidence:[quote,'乙方包运费']};
 const check={fieldId:'term',status:'answered' as const,evidence:[quote]};
 assert.deepEqual(businessCheckProblems([check],i.facts,[]),[]);
 delete i.facts.term;i.businessChecks=[check];assert.deepEqual(unresolvedTransactionFields(i),[]);
});

test('direct draft entry cannot bypass canonical completeness with a stale empty missing list',async()=>{
 const {draftConfirmed}=await import('../src/server/ai');const old=fetch;const i=intakeFixture();delete i.facts.payment;i.missing=[];
 try{globalThis.fetch=async()=>{throw new Error('must not invoke provider')};await assert.rejects(draftConfirmed(i,env),/关键约定/);}finally{globalThis.fetch=old}
});
