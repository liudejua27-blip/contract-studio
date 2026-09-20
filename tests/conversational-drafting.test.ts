import test from 'node:test';import assert from 'node:assert/strict';
import {generateContractReply} from '../src/server/ai';import {blankTemplate,inspectDraft} from '../src/lib/contract-library/engine';import {getTemplate} from '../src/lib/contract-library/catalog';
const env={CONTRACT_AI_API_KEY:'fake',CONTRACT_AI_BASE_URL:'https://model.test'};
async function withModel(route:any,action:(calls:any[])=>Promise<void>){const previous=globalThis.fetch;const calls:any[]=[];globalThis.fetch=async(_url,init)=>{const b=JSON.parse(String(init?.body));calls.push(b);return Response.json({choices:[{message:{content:JSON.stringify(b.messages[0].content.includes('CONTRACT_ROUTER_V1')?route:blankTemplate(getTemplate(route.templateId||'service')!))}}]})};try{await action(calls)}finally{globalThis.fetch=previous}}
test('semantic routing writes a draft from plain description with no template name or generate flag',async()=>{
 const prompt='我们开小店，请人做一个手机扫码点单的东西，代码做好给我们';
 await withModel({templateId:'software',action:'draft',reason:'定制开发点单软件',facts:[{fieldId:'scope',quote:'手机扫码点单'},{fieldId:'price',quote:'费用100万元'}]},async calls=>{
  const r=await generateContractReply({mode:'live',generate:false,prompt,title:'未命名合同',messages:[],environment:env});assert.equal(r.content?.drafting?.templateId,'software');assert.equal(r.content?.drafting?.selection,'ai');assert.equal(calls.length,2);assert.ok(calls[1].messages[1].content.includes('源码'));assert.equal(r.content?.drafting?.findings.find(f=>f.id==='field:scope')?.status,'REVIEW');assert.equal(r.content?.drafting?.findings.find(f=>f.id==='field:price')?.status,'UNKNOWN');assert.ok(r.reply.includes('生成了 Word'));
 });
});
test('ambiguous business gets one question and no document generation',async()=>{
 await withModel({templateId:null,action:'ask',reason:'没有业务描述',question:'这次对方要为你做什么，还是你为对方做什么？',facts:[]},async calls=>{const r=await generateContractReply({mode:'live',generate:false,prompt:'帮我弄份合同',title:'合同',messages:[],environment:env});assert.equal(r.content,null);assert.equal(calls.length,1);assert.ok(r.reply.endsWith('？'));});
});
test('latest clarification is sent to router and may replace old explicit marker',async()=>{
 await withModel({templateId:'equipment-lease',action:'draft',reason:'最新要求只租设备',facts:[]},async calls=>{const r=await generateContractReply({mode:'live',generate:false,prompt:'更正，不是买，只租三台设备',title:'旧采购合同',messages:[{id:'x',role:'user',content:'【起草模板：purchase@2026.09.20.1】\n采购设备',createdAt:'2026-09-20'}],environment:env});assert.equal(r.content?.drafting?.templateId,'equipment-lease');assert.ok(calls[0].messages.at(-1).content.includes('不是买'));});
});
test('unsupported category is not silently assigned a professional template',async()=>{
 await withModel({templateId:null,action:'draft',reason:'劳动合同未覆盖',facts:[]},async()=>{const r=await generateContractReply({mode:'live',generate:false,prompt:'先写一份劳动合同草稿',title:'合同',messages:[],environment:env});assert.equal(r.content?.drafting,undefined);assert.ok(r.content?.missing.includes('合同类型与适用规则待确认'));assert.ok(r.reply.includes('通用'));});
});
test('unknown model template ids fail closed',async()=>{
 await withModel({templateId:'invented',action:'draft',reason:'test'},async()=>{await assert.rejects(generateContractReply({mode:'live',generate:false,prompt:'起草',title:'合同',messages:[],environment:env}),(e:any)=>e.code==='AI_INVALID_ROUTING');});
});
test('facts require exact user evidence and cannot turn into approval',()=>{
 const t=getTemplate('software')!;const report=inspectDraft(blankTemplate(t),t,'我们需要源码','ai',[{fieldId:'deliverables',quote:'我们需要源码'},{fieldId:'price',quote:'20万元'}]);assert.equal(report.findings.find(f=>f.id==='field:deliverables')?.status,'REVIEW');assert.equal(report.findings.find(f=>f.id==='field:price')?.status,'UNKNOWN');assert.equal(report.reviewStatus,'pending_lawyer_review');
});
