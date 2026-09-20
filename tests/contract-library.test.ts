import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTRACT_TEMPLATES,getTemplate,SOURCES} from '../src/lib/contract-library/catalog';
import {blankTemplate,inspectDraft,resolveTemplate,annotateMessage,selectedTemplate,templatePrompt} from '../src/lib/contract-library/engine';
import {renderContract,extractDocxText} from '../src/server/documents';
import {generateContractReply} from '../src/server/ai';
import type {Message} from '../src/lib/types';
const message=(content:string):Message=>({id:'test',role:'user',content,createdAt:'2026-09-20'});
test('every category is versioned, attributed and has distinct drafting content',()=>{
 assert.equal(CONTRACT_TEMPLATES.length,12);assert.equal(new Set(CONTRACT_TEMPLATES.map(t=>t.id)).size,12);
 for(const t of CONTRACT_TEMPLATES){assert.equal(t.status,'pending_lawyer_review');assert.ok(t.fields.length>=8);assert.ok(t.clauses.length>=9);assert.ok(t.risks.length>=6);assert.equal(new Set(t.fields.map(f=>f.id)).size,t.fields.length);assert.equal(new Set(t.clauses.map(c=>c.id)).size,t.clauses.length);for(const id of t.sourceIds)assert.ok(SOURCES[id].url.startsWith('https://'));}
 assert.ok(!getTemplate('nda')!.fields.some(f=>f.id==='price'));
});
test('explicit selection persists and overrides inference; unknown types remain unclassified',()=>{
 const history=[message(annotateMessage('要一份保密协议','nda'))];assert.equal(selectedTemplate(history),'nda');assert.equal(resolveTemplate(history,'增加一个软件开发保密范围').template?.id,'nda');assert.equal(resolveTemplate(history,'改为采购合同','purchase').template?.id,'purchase');assert.equal(resolveTemplate([],'我需要签一份合同').selection,'unclassified');assert.equal(resolveTemplate([],'小程序开发合同').template?.id,'software');
});
test('headers alone are not clause evidence and unknowns never become pass',()=>{
 const t=getTemplate('nda')!;const draft=blankTemplate(t);draft.sections=[{title:'保密信息、例外、披露、返还、销毁',content:'双方另行约定。'}];draft.missing=[];
 const report=inspectDraft(draft,t,'','explicit');assert.equal(report.findings.find(f=>f.id==='clause:scope')?.status,'UNKNOWN');assert.ok(report.findings.every(f=>['UNKNOWN','REVIEW'].includes(f.status)));assert.equal(report.findings.find(f=>f.id==='risk:placeholders')?.status,'UNKNOWN');
});
test('evidence is an exact substring with a location; facts need user-labelled input',()=>{
 const t=getTemplate('software')!,draft=blankTemplate(t);const report=inspectDraft(draft,t,'甲方名称与角色：甲方\n总价与税费：[待补充]','explicit');assert.equal(report.findings.find(f=>f.id==='field:partyA')?.status,'REVIEW');assert.equal(report.findings.find(f=>f.id==='field:price')?.status,'UNKNOWN');for(const f of report.findings.filter(f=>f.evidence&&f.kind!=='field'))assert.ok([draft.parties.map(p=>`${p.role}：${p.name} ${p.details||''}`).join('\n'),...draft.sections.map(s=>s.content),draft.signing].some(s=>s.includes(f.evidence!.quote)));
});
test('reference templates render separately from clean contract exports',async()=>{
 for(const t of CONTRACT_TEMPLATES){const draft=blankTemplate(t);draft.drafting=inspectDraft(draft,t,'','explicit');await assert.rejects(renderContract(draft));const doc=await renderContract(draft,{template:true});const text=extractDocxText(doc);assert.ok(text.includes(t.name));assert.ok(!text.includes('起草参考：'));assert.ok(draft.drafting.sources.length>0);}
});
