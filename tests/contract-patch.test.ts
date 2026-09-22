import test from 'node:test';
import assert from 'node:assert/strict';
import {contractPatchSchema,applyContractPatch} from '../src/lib/contract-patch';
import {publicPreview} from '../src/lib/agent-stream';
import {documentBody,sha256} from '../src/lib/skill-audit';
import {reviseConfirmedDraft} from '../src/server/ai';
import {contentFixture} from './fixtures';
const hash='a'.repeat(64);
const patch=(changes:unknown[],more:Record<string,unknown>={})=>contractPatchSchema.parse({baseSha256:hash,changes,...more});

test('targeted edits use original positions and preserve every unmentioned part without mutation',()=>{
 const base=contentFixture(),before=structuredClone(base);
 const result=applyContractPatch(base,patch([{op:'remove',target:'section',index:0,reason:'移除重复'}, {op:'replace',target:'section',index:2,part:{title:'修改的条款',content:'新内容'},reason:'修正'}, {op:'append',target:'attachment',part:{title:'交接记录',content:'按实际交接登记'},reason:'交接需要'}]),hash);
 assert.deepEqual(base,before);assert.deepEqual(result.sections[0],base.sections[1]);assert.equal(result.sections[1].title,'修改的条款');assert.deepEqual(result.sections.slice(2),base.sections.slice(3));
 assert.deepEqual(result.parties,base.parties);assert.deepEqual(result.attachments!.slice(0,-1),base.attachments);assert.equal(result.exportReady,undefined);
});

test('stale, invalid and overlapping edits are rejected without changing the original',()=>{
 const base=contentFixture(),before=structuredClone(base);
 assert.throws(()=>applyContractPatch(base,patch([]),'b'.repeat(64)),/版本/);
 const remove={op:'remove',target:'section',index:0,reason:'删除'};
 assert.throws(()=>applyContractPatch(base,patch([remove,remove]),hash),/重复/);
 assert.throws(()=>applyContractPatch(base,patch([{...remove,index:999}]),hash),/不存在/);
 assert.throws(()=>applyContractPatch(base,patch(base.sections.map((_,index)=>({...remove,index}))),hash),/1至100/);
 assert.throws(()=>contractPatchSchema.parse({...base,baseSha256:hash,changes:[]}));assert.deepEqual(base,before);
});

test('only changed blocks are normalized; untouched text and signing remain identical',()=>{
 const base=contentFixture();base.sections[1]={title:'格式保留',content:'原有正文',blocks:[{kind:'paragraph',text:'原段落'}]};base.signing='青岛签署';
 const result=applyContractPatch(base,patch([{op:'replace',target:'attachment',index:0,part:{title:'付款计划',content:'模型的重复副本',blocks:[{kind:'table',columns:['节点','金额'],rows:[['签约','4000元'],['验收','4000元']]}]},reason:'更新表格'}]),hash);
 assert.deepEqual(result.sections,base.sections);assert.equal(result.signing,base.signing);assert.match(result.attachments![0].content,/4000元/);assert.doesNotMatch(result.attachments![0].content,/副本/);
});

test('revision streaming shows partial replacement text while hiding private metadata at every split',()=>{
 const source=JSON.stringify({result:{baseSha256:'PRIVATE',header:{title:'修订合同',reason:'PRIVATE'},changes:[{op:'replace',target:'section',index:1,reason:'PRIVATE',part:{title:'费用',content:'付款安排已更新。',blocks:[{kind:'table',columns:['节点','金额'],rows:[['验收','4000元']]}]}}],ruleApplications:[{quote:'PRIVATE'}]}});
 for(let n=1;n<=source.length;n++)assert.doesNotMatch(publicPreview(source.slice(0,n),'draft'),/PRIVATE|baseSha256|replace/);
 assert.match(publicPreview(source,'draft'),/付款安排已更新/);assert.match(publicPreview(source,'draft'),/4000元/);assert.equal(publicPreview(source,'verify'),'');
});

test('the same agent repairs a stale patch internally, preserves other clauses and rebinds its audit',async()=>{
 const old=fetch,base=contentFixture();base.confirmation!.reviewNotes=['上一版审查发现许可边界待核对'];const before=structuredClone(base);const current=structuredClone(base.confirmation!);current.reviewNotes=['本轮事项'];let calls=0;
 try{
  globalThis.fetch=async(_url,init)=>{
   calls++;const body=JSON.parse(String(init?.body));assert.match(body.messages[0].content,/CONTRACT_PATCH_V1/);
   const input=JSON.parse(body.messages.find((m:any)=>m.role==='user').content);
   if(calls===2)assert.match(JSON.stringify(body.messages),/原稿版本不匹配/);
   return Response.json({choices:[{message:{content:JSON.stringify({baseSha256:calls===1?'b'.repeat(64):input.baseSha256,changes:[{op:'replace',target:'section',index:1,part:{...base.sections[1],content:base.sections[1].content+'双方依约履行。'},reason:'衔接说明'}],ruleApplications:[]})}}]});
  };
  const result=await reviseConfirmedDraft(base,current,'修正衔接说明',{CONTRACT_AI_API_KEY:'fake',CONTRACT_AI_BASE_URL:'https://model.test'});
  assert.equal(calls,2);assert.deepEqual(base,before);assert.deepEqual(result.sections.filter((_,i)=>i!==1),base.sections.filter((_,i)=>i!==1));assert.deepEqual(result.attachments,base.attachments);
  assert.equal(result.skillAudit!.contentSha256,await sha256(documentBody(result)));assert.equal(result.skillAudit!.consistency,undefined);assert.deepEqual(result.confirmation!.reviewNotes,['本轮事项','上一版审查发现许可边界待核对']);
 }finally{globalThis.fetch=old}
});
