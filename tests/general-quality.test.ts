import test from 'node:test';
import assert from 'node:assert/strict';
import {substantiveProblems} from '../src/lib/contract-library/quality';
import {contentFixture,intakeFixture} from './fixtures';
import {collectIntake,verifyConfirmedDraft} from '../src/server/ai';
const env={CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test'};
for(const [label,body] of [['软件','具体功能项由双方在开发过程中书面确认。'],['采购','采购数量后续另行确定。'],['服务','服务内容以后由双方确认。'],['通用合作','合作事项另行约定。']])test(label+' cannot conceal the original scope behind future agreement',()=>{
 const c=contentFixture();c.attachments=[{title:'实际履行清单',content:body}];assert.ok(substantiveProblems(c).some(p=>p.includes('实际履行清单')));
});
test('specific original scope and future change procedure remain allowed',()=>{
 const c=contentFixture();c.attachments=[{title:'清单',content:'双方确认服务内容为每月清洁办公室两次。新增服务内容及费用由双方另行书面确认。'}];assert.deepEqual(substantiveProblems(c),[]);
});
test('a material gap preserves known information and asks only the specific missing part',async()=>{
 const old=fetch;try{globalThis.fetch=async()=>Response.json({choices:[{message:{content:JSON.stringify({templateId:'service',facts:[],materialGaps:[{fieldId:'scope',question:'这次活动需要对方负责哪些工作？'}]})}}]});const previous=intakeFixture('service');previous.facts.scope={value:'举办门店开业活动',quote:'举办门店开业活动'};const r=await collectIntake([{id:'m',role:'user',content:'举办门店开业活动',createdAt:''}],previous,env);assert.equal(r.intake!.facts.scope.value,'举办门店开业活动');assert.ok(r.intake!.missing.includes('scope'));assert.match(r.reply,/这次活动需要对方负责哪些工作/);assert.doesNotMatch(r.reply,/总价|什么时候开始/);}finally{globalThis.fetch=old}
});
test('professional review notes survive a successful general quality review without becoming user questions',async()=>{
 const old=fetch;const c=contentFixture();c.confirmation!.reviewNotes=['原有律师事项'];try{globalThis.fetch=async(_url,init)=>{assert.match(String(init?.body),/核心约定的实质完整性/);return Response.json({choices:[{message:{content:JSON.stringify({verdict:'consistent',issues:[],reviewNotes:['请律师审查约定的使用许可边界']})}}]})};await verifyConfirmedDraft(c,env);assert.deepEqual(c.confirmation!.reviewNotes,['原有律师事项','请律师审查约定的使用许可边界']);}finally{globalThis.fetch=old}
});
test('business gaps use the single model decision and professional notes are retained',async()=>{
 const old=fetch;let calls=0;try{globalThis.fetch=async()=>{calls++;return Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'t'+calls,type:'function',function:{name:'update_contract_spec',arguments:JSON.stringify({result:{templateId:'service',facts:[],reviewNotes:['服务范围尚未明确，请律师确认'],businessChecks:[{fieldId:'scope',status:'missing',evidence:[],question:'这次活动需要对方负责哪些工作？'},...['partyA','partyB','exchange','term'].map(fieldId=>({fieldId,status:'missing',question:'这项怎么安排？'}))]}})}}]}}]})};const r=await collectIntake([{id:'m',role:'user',content:'活动服务',createdAt:''}],undefined,env);assert.equal(calls,1);assert.ok(r.intake!.reviewNotes!.length);assert.match(r.reply,/这次活动需要对方负责哪些工作/);}finally{globalThis.fetch=old}
});
