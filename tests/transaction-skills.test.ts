import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {draftConfirmed,collectIntake,verifyConfirmedDraft} from '../src/server/ai';
import {contentFixture,intakeFixture} from './fixtures';
import {draftingPlan} from '../src/lib/contract-library/general';
import {exportProblems} from '../src/lib/contract-library/playbooks';
import {legalSkillBundle,readLegalSkill} from '../src/server/agent/legal-skills';
import {auditApplications} from '../src/server/agent/skill-audit';
import {runStructuredAgent} from '../src/server/agent/runtime';
import {documentBody} from '../src/lib/skill-audit';
import {renderContract,extractDocxText} from '../src/server/documents';
const env={CONTRACT_AI_API_KEY:'fixture-only',CONTRACT_AI_BASE_URL:'https://model.test'};
const call=(name:string,args:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
const path='platform/transaction-contract/SKILL.md';
const ruleQuote='区分交付、使用许可与权利转让，不因交付源码或设备推定权利转让。';

test('a named family does not discard mixed modules or custom business facts',async()=>{
 const previous=intakeFixture(),value='软件与咖啡机一起提供用于店内运营，设备仍归甲方；收入按分成约定执行';
 previous.facts.specialTerms={value,quote:value};
 assert.deepEqual(draftingPlan(previous,[]).modules,['equipment','revenue','operations']);
 const old=fetch;try{
  globalThis.fetch=async()=>call('update_contract_spec',{result:{templateId:'software',ruleFamilies:['equipment-lease','not-registered'],facts:[{fieldId:'dataExitPlan',value:'退出时导出数据后关闭账号',quote:'退出时导出数据后关闭账号'}]}});
  const result=await collectIntake([{id:'m',role:'user',content:'退出时导出数据后关闭账号',createdAt:''}],previous,env);
  assert.equal(result.intake!.facts.dataExitPlan.value,'退出时导出数据后关闭账号');assert.deepEqual(result.intake!.ruleFamilies,['equipment-lease']);assert.equal(result.intake!.facts.price.value,previous.facts.price.value);
 }finally{globalThis.fetch=old;}
});

test('drafts can change headings and choose actual attachments, including no attachment',async()=>{
 const old=fetch;try{
  const draft=contentFixture();draft.sections=[{title:'本次开发、交付与权利安排',content:draft.sections.map(s=>s.content).join('。')}];draft.attachments=[];
  globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));assert.doesNotMatch(request.messages[0].content,/正文条款标题必须逐一使用|附件必须且只包含/);assert.match(request.messages[0].content,/按本笔交易组织/);return call('submit_contract_draft',{result:draft});};
  const content=await draftConfirmed(intakeFixture(),env);
  assert.deepEqual(exportProblems(content),[]);assert.equal(content.attachments?.length,0);assert.ok(content.skillAudit!.receipts.some(r=>r.path===path&&r.method==='injected'));
  assert.deepEqual(content.skillAudit!.applications,[],'loading alone must not become an application');
  const text=extractDocxText(await renderContract(content));assert.match(text,/本次开发、交付与权利安排/);assert.doesNotMatch(text,/功能与交付清单|Skill|ruleApplications/);
  content.attachments=[{title:'实际交接记录',content:'源码和部署资料随系统交付。'}];assert.deepEqual(exportProblems(content),[]);
  content.sections.push({title:'资料',content:'参见附件《不存在的附件》。'});assert.ok(exportProblems(content).some(p=>p.includes('不存在的附件')));
 }finally{globalThis.fetch=old;}
});

test('application audit binds loaded rule text and exact contract location, rejects invented provenance',async()=>{
 const transaction=intakeFixture();transaction.templateId='general';transaction.facts.equipment={value:'机器归甲方所有',quote:'机器归甲方所有'};
 const bundle=await legalSkillBundle('draft',['general'],transaction);
 assert.ok(bundle.receipts.some(r=>r.path.endsWith('知识产权与IT类.md')));
 assert.ok(bundle.receipts.some(r=>r.path.endsWith('租赁类.md')));assert.ok(bundle.receipts.every(r=>/^[a-f0-9]{64}$/.test(r.sha256)));
 const content=contentFixture(),quote='设备交付仅供乙方在约定场所使用，设备所有权仍归甲方。';
 content.sections.push({title:'设备使用',content:quote});
 const valid={path,ruleQuote,location:'设备使用',quote};
 const audit=await auditApplications(content,bundle.receipts,[valid,{...valid,path:'not-loaded.md'},{...valid,quote:'模型编造的合同文字并未写入正文'},{...valid,ruleQuote:'这条规则实际上没有出现在参考原文里'}]);
 assert.deepEqual(audit.applications.map(a=>a.status),['located','unverified','unverified','unverified']);assert.ok(audit.applications[0].receiptId);
  content.skillAudit=audit;
  const before=await renderContract(content);assert.ok(before.length>0);
  const reorder=(v:any):any=>Array.isArray(v)?v.map(reorder):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).reverse().map(([k,x])=>[k,reorder(x)])):v;
  const persisted=reorder(content);assert.equal(documentBody(persisted),documentBody(content));assert.ok((await renderContract(persisted)).length>0);
 content.sections.at(-1)!.content='设备所有权转给乙方。';await assert.rejects(renderContract(content),/正文与规则应用记录不一致/);await assert.rejects(verifyConfirmedDraft(content,env),/正文已变更/);
});

test('full SDK records only successful skill reads and retains receipts on cached retries',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'contract-skills-')),old=fetch;
 let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;if(calls===1)return call('get_legal_skill',{path:'not-registered.md'});if(calls===2)return call('get_legal_skill',{path});return call('save_result',{result:{ok:true}});};
  const input={prompt:'检查规则',messages:[{role:'user' as const,content:'检查规则'}],schema:z.object({ok:z.boolean()}),toolName:'save_result',stage:'draft' as const,environment:{...env,CONTRACT_PI_SESSION_DIR:directory},context:{ownerId:'test',contractId:'test',requestId:'one',history:[]}};
  const first=await runStructuredAgent(input),retry=await runStructuredAgent(input);
  assert.equal(calls,3);assert.equal(first.trace.skillReads!.length,1);assert.equal(first.trace.skillReads![0].path,path);assert.equal(first.trace.skillReads![0].method,'tool');assert.deepEqual(retry.trace.skillReads,first.trace.skillReads);
  assert.throws(()=>readLegalSkill(path,-1));assert.throws(()=>readLegalSkill(path,Number.MAX_SAFE_INTEGER));
 }finally{globalThis.fetch=old;await rm(directory,{recursive:true,force:true});}
});

test('draft/verify receipt stages and Word content share one immutable content digest',async()=>{
 const old=fetch;try{
  const draft=contentFixture(),quote='交付不自动转让未约定转让的权利，第三方组件遵守相应许可。';draft.sections.push({title:'权利边界',content:quote});
  globalThis.fetch=async(_url,init)=>String(init?.body).includes('CONTRACT_VERIFY_V2')?call('submit_consistency_check',{result:{verdict:'consistent',issues:[],reviewNotes:['律师复核许可边界']}}):call('submit_contract_draft',{result:{...draft,ruleApplications:[{path,ruleQuote,location:'权利边界',quote}]}});
  const content=await draftConfirmed(intakeFixture(),env);await verifyConfirmedDraft(content,env);
  assert.equal(content.skillAudit!.applications[0].status,'located');assert.equal(content.skillAudit!.consistency!.contentSha256,content.skillAudit!.contentSha256);assert.ok(content.skillAudit!.receipts.some(r=>r.stage==='verify'));assert.ok(content.confirmation!.reviewNotes!.includes('律师复核许可边界'));
  assert.doesNotMatch(extractDocxText(await renderContract(content)),/律师复核许可边界|ruleQuote|Skill/);
 }finally{globalThis.fetch=old;}
});
