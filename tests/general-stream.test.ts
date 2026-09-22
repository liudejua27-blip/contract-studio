import {intakeFixture} from './fixtures';
import test from 'node:test';
import assert from 'node:assert/strict';
import {collectIntake,draftConfirmed} from '../src/server/ai';
import {publicPreview,sseData} from '../src/lib/agent-stream';
import {readModelResponse} from '../src/server/agent/model-stream';
import {legalSkillContext,readLegalSkill,LEGAL_SKILL_SOURCE} from '../src/server/agent/legal-skills';
import {renderContract,extractDocxText} from '../src/server/documents';
import {exportProblems} from '../src/lib/contract-library/playbooks';
import type {Intake,ContractContent} from '../src/lib/types';
const env={CONTRACT_AI_API_KEY:'test',CONTRACT_AI_BASE_URL:'https://model.test'};
const values={partyA:'甲咖啡公司',partyB:'乙门店公司',scope:'甲方提供咖啡机放在乙方店里运营，双方按销售收入分成',exchange:'销售收入甲方60%、乙方40%，每月月底结算',term:'2026年10月1日起合作一年',equipment:'咖啡机归甲方，甲方负责维修，结束后甲方取回',revenue:'销售收入不扣成本，甲方60%、乙方40%，每月月底结算',operations:'甲方负责咖啡豆及补货费用，乙方负责店内经营和水电费用'};
const facts=Object.fromEntries(Object.entries(values).map(([id,value])=>[id,{value,quote:value}]));
const intake=():Intake=>({templateId:'general',facts:structuredClone(facts),missing:[],conflicts:[],summaryId:crypto.randomUUID(),confirmedAt:new Date().toISOString(),policyVersion:'test'});
const call=(name:string,result:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'call',type:'function',function:{name,arguments:JSON.stringify({result})}}]}}]});
function response(frames:unknown[]){const bytes=new TextEncoder().encode(frames.map(f=>'data: '+JSON.stringify(f)+'\r\n\r\n').join('')+'data: [DONE]\r\n\r\n');return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});}
test('unknown-family transaction asks material business questions and preserves lawyer notes across family changes',async()=>{
 const old=fetch;try{globalThis.fetch=async()=>call('update_contract_spec',{templateId:'general',businessChecks:['equipment','operations','collection','settlement','revenueAdjustments'].map(fieldId=>({fieldId,status:'missing',evidence:[],question:'请说明'+fieldId+'的安排？'})),facts:Object.entries(facts).filter(([id])=>!['equipment','revenue','operations'].includes(id)).map(([fieldId,f])=>({fieldId,...f}))});
 const previous={...intake(),templateId:'service',facts:{specialTerms:{value:'不做独家合作',quote:'不做独家合作'}},reviewNotes:['合作终止安排请律师重点审查']};
 const r=await collectIntake([{id:'m',role:'user',content:Object.values(values).join('；'),createdAt:''}],previous,env);
 assert.equal(r.intake!.templateId,'general');assert.deepEqual(r.intake!.missing,['equipment','operations','collection','settlement','revenueAdjustments']);assert.equal(r.intake!.facts.specialTerms.value,'不做独家合作');assert.ok(r.intake!.reviewNotes!.includes('合作终止安排请律师重点审查'));assert.doesNotMatch(r.reply,/管辖|法律适用/);assert.ok((r.reply.match(/\d\./g)||[]).length<=3);
 }finally{globalThis.fetch=old}
});
test('general coffee transaction reaches validated Word with provenance and dynamic clauses',async()=>{
 const old=fetch;const i=intake();const text=Object.values(values).join('。');
 const draft:ContractContent={title:'咖啡机运营合作协议',parties:[{role:'甲方',name:values.partyA},{role:'乙方',name:values.partyB}],sections:[{title:'合作事项与分工',content:text},{title:'终止与设备返还',content:'合作结束后甲方取回咖啡机，双方结算已产生的收入。'}],attachments:[{title:'交易安排清单',content:text}],missing:[],signing:''};
 try{globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));assert.equal(request.stream,true);assert.match(request.messages[0].content,/独立起草指引/);assert.match(request.messages[1].content,/销售收入/);assert.ok(request.tools.some((t:any)=>t.function.name==='get_legal_skill'));return call('submit_contract_draft',draft)};
 const content=await draftConfirmed(i,env);assert.equal(content.confirmation!.draftingPlan!.mode,'general');assert.deepEqual(content.confirmation!.draftingPlan!.modules,['equipment','revenue','operations']);assert.deepEqual(exportProblems(content),[]);const bytes=await renderContract(content);assert.match(extractDocxText(bytes),/销售收入甲方60%/);assert.ok(content.drafting!.sources.some(s=>s.url.includes('pa1nrui1/legal-skills')));
 }finally{globalThis.fetch=old}
});
test('provider SSE survives split UTF8 and tool arguments and only publishes public preview',async()=>{
 const args=JSON.stringify({result:{title:'咖啡机合作',sections:[{title:'收入结算',content:'销售收入按约定分配'}]}});const frames=[{choices:[{delta:{reasoning_content:'PRIVATE',tool_calls:[{index:0,id:'c',function:{name:'submit_contract_draft',arguments:args.slice(0,55)}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:args.slice(55)}}]},finish_reason:'tool_calls'}]}];
 const events:any[]=[];const result=await readModelResponse(response(frames),'draft',e=>events.push(e));assert.equal(result.choices[0].message.tool_calls[0].function.arguments,args);assert.doesNotMatch(JSON.stringify(events),/PRIVATE|tool_calls/);assert.equal(publicPreview('{"quote":"SECRET","reply":"请说明费用"}','intake'),'请说明费用');assert.equal(publicPreview(args,'verify'),'');
 await assert.rejects(readModelResponse(response([{choices:[{delta:{content:'partial'}}]}]),'draft'),/Incomplete/);
});
test('skill is pinned, available in all stages, paths cannot escape the allowlist',()=>{
 assert.match(LEGAL_SKILL_SOURCE.commit,/^[a-f0-9]{40}$/);for(const stage of ['intake','draft','verify'] as const){const context=legalSkillContext(stage);assert.match(context,/中国法律/);assert.doesNotMatch(context,/claude-legal-skill/);assert.match(context,/尚未接通/);}
 assert.match(readLegalSkill('合同起草/references/特许合作类.md').content,/合作/);assert.throws(()=>readLegalSkill('../../.env.local'));
});
test('revenue terms satisfy commercial exchange and invalid quotation is corrected inside the Agent',async()=>{
 const old=fetch;let n=0;const entries=Object.entries(facts).filter(([id])=>id!=='exchange').map(([fieldId,f])=>({fieldId,...f}));
 try{globalThis.fetch=async(_url,init)=>{n++;if(n===1)return call('update_contract_spec',{templateId:'general',facts:[{fieldId:'partyA',value:values.partyA,quote:'模型改写的不存在原文'}]});assert.ok(JSON.parse(String(init?.body)).messages.some((m:any)=>m.role==='tool'&&m.content.includes('逐字复制')));return call('update_contract_spec',{templateId:'general',facts:entries,businessChecks:['collection','settlement','revenueAdjustments'].map(fieldId=>({fieldId,status:'missing',evidence:[],question:'请说明'+fieldId+'的安排？'}))});};
 const r=await collectIntake([{id:'m',role:'user',content:Object.values(values).join('；'),createdAt:''}],undefined,env);assert.equal(n,2);assert.deepEqual(r.intake!.missing,['collection','settlement','revenueAdjustments']);assert.equal(r.intake!.facts.exchange,undefined);assert.equal(r.intake!.facts.revenue.value,values.revenue);
 }finally{globalThis.fetch=old}
});
test('unknown routing falls back to general, preserves facts and lawyer notes, and invalidates confirmation',async()=>{
 const old=fetch;try{globalThis.fetch=async()=>call('update_contract_spec',{templateId:null,facts:[],reviewNotes:['需要专项核对']});const i=intake();i.reviewNotes=['已有待审事项'];const r=await collectIntake([{id:'m',role:'user',content:'现在交易结构需要调整',createdAt:''}],i,env);assert.deepEqual(r.intake!.facts,i.facts);assert.equal(r.intake!.confirmedAt,undefined);assert.equal(r.intake!.templateId,'general');assert.deepEqual(r.intake!.conflicts,[]);assert.ok(r.intake!.reviewNotes!.includes('已有待审事项'));assert.ok(r.intake!.reviewNotes!.includes('需要专项核对'));}finally{globalThis.fetch=old}
});
test('common handling proposes payment once, retains proposal, and explicit adoption records its source',async()=>{
 const old=fetch;try{
 const previous=intakeFixture();delete previous.facts.payment;previous.missing=['payment'];
 globalThis.fetch=async()=>call('update_contract_spec',{templateId:'software',facts:[],businessProposals:[{fieldId:'payment',value:'签约后支付50%，验收后支付50%。'}]});
 const msg=(content:string)=>({id:crypto.randomUUID(),role:'user' as const,content,createdAt:''});
 const first=await collectIntake([msg('按常见方式处理')],previous,env);
 assert.equal(first.intake!.businessProposals!.length,1);assert.equal(first.intake!.businessProposals![0].fieldId,'payment');assert.ok(!first.intake!.facts.payment);assert.doesNotMatch(first.reply,/准备怎么付款/);
 const second=await collectIntake([msg('按常见方式处理'),msg('先保留这个建议')],first.intake,env);
 assert.equal(second.intake!.businessProposals![0].value,first.intake!.businessProposals![0].value);
 const third=await collectIntake([msg('采用建议：'+second.intake!.businessProposals![0].value)],second.intake,env);
 assert.equal(third.intake!.facts.payment.source,'accepted_proposal');assert.ok(!third.intake!.missing.includes('payment'));
 }finally{globalThis.fetch=old}
});
test('stream flushes its last visible characters even inside throttle window',async()=>{
 const events:any[]=[];await readModelResponse(response([{choices:[{delta:{content:'{"reply":"完整回答"}'},finish_reason:'stop'}]}]),'intake',e=>events.push(e));
 assert.equal(events.at(-1).text,'完整回答');
});
test('interrupted provider response is retried without exposing an unfinished reply as saved',async()=>{
 const old=fetch;let calls=0;const events:any[]=[];
 try{globalThis.fetch=async()=>{calls++;if(calls===1)return response([{choices:[{delta:{content:'{"reply":"未完成'}}]}]);return call('update_contract_spec',{templateId:'software',facts:[]});};
 const result=await collectIntake([{id:'m',role:'user',content:'我要开发软件',createdAt:''}],intakeFixture(),env,e=>events.push(e));
 assert.equal(calls,2);assert.ok(result.intake);assert.ok(events.some(e=>e.type==='activity'&&e.label.includes('自动恢复')));assert.doesNotMatch(result.reply,/未完成/);
 }finally{globalThis.fetch=old}
});
test('known source delivery and month/day dates are retained despite model rewriting; two installments still need a proposal',async()=>{
 const old=fetch;try{
 const previous=intakeFixture();previous.facts.price={value:'8万元',quote:'8万元'};delete previous.facts.deliverables;
 const term='项目从9月25号开始，10月25号完成',source='软件做完后，源代码需要一起交付',payment='这8万元打算分2次付';
 globalThis.fetch=async()=>call('update_contract_spec',{templateId:'software',facts:[{fieldId:'term',value:'2026年9月25日开始，2026年10月25日完成',quote:term},{fieldId:'sourceDelivery',value:source,quote:source},{fieldId:'payment',value:payment,quote:payment}],businessProposals:[{fieldId:'payment',value:'签约后支付50%，验收后支付50%。'}]});
 const r=await collectIntake([{id:'m',role:'user',content:source+'。'+payment+'.付款方式按照常见方式处理。'+term,createdAt:''}],previous,env);
 assert.equal(r.intake!.facts.term.value,term);assert.equal(r.intake!.facts.sourceDelivery.value,source);assert.equal(r.intake!.facts.payment.value,payment);assert.ok(r.intake!.missing.includes('payment'));assert.ok(r.intake!.businessProposals!.some(p=>p.fieldId==='payment'));assert.doesNotMatch(r.reply,/什么时候开始|交给你哪些/);
 }finally{globalThis.fetch=old}
});
test('refusing source delivery is not converted into an affirmative deliverable',async()=>{
 const old=fetch;const previous=intakeFixture();delete previous.facts.deliverables;try{globalThis.fetch=async()=>call('update_contract_spec',{templateId:'software',facts:[{fieldId:'sourceDelivery',value:'不提供源码',quote:'不提供源码'}]});const r=await collectIntake([{id:'m',role:'user',content:'不提供源码',createdAt:''}],previous,env);assert.equal(r.intake!.facts.deliverables,undefined);}finally{globalThis.fetch=old}
});
test('explicitly accepting the last missing proposal preserves known facts without another model call',async()=>{
 const {intakeFixture}=await import('./fixtures');const previous=intakeFixture('software');delete previous.facts.payment;delete previous.confirmedAt;previous.missing=['payment'];previous.businessProposals=[{id:'proposal',fieldId:'payment',value:'签署后支付50%，验收后支付50%'}];const known=structuredClone(previous.facts),old=fetch;
 try{globalThis.fetch=async()=>{throw new Error('adoption must not re-extract facts')};const r=await collectIntake([{id:'m',role:'user',content:'采用建议：'+previous.businessProposals[0].value,createdAt:''}],previous,env);assert.deepEqual(r.intake!.missing,[]);assert.equal(r.intake!.facts.payment.source,'accepted_proposal');for(const [id,fact] of Object.entries(known))assert.deepEqual(r.intake!.facts[id],fact);}finally{globalThis.fetch=old}
});
