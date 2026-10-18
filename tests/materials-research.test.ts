import {pdfFixture as pdf} from './pdf-fixture';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extractMaterial,MAX_MATERIAL_BYTES} from '../src/server/material-parser';
import {renderContract} from '../src/server/documents';
import {materialEvidence,readMaterial,type MaterialDocument} from '../src/lib/materials';
import {compileTransactionUpdate,intakeSchema} from '../src/lib/transaction-update';
import {searchLegalSources,officialLegalUrl,assertPublicLegalQuery} from '../src/server/agent/legal-search';
import {retainLegalResearch,validateLegalCitations} from '../src/lib/legal-research';
import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {contentFixture,intakeFixture} from './fixtures';

const material=(purpose:'transaction'|'reference'='transaction'):MaterialDocument=>({id:'f6021462-8e1b-486b-804c-c9a650113390',name:'约定.txt',purpose,sha256:'a'.repeat(64),size:100,status:'ready',warnings:[],createdAt:'2026-09-26',chunkCount:1,chunks:[{id:'text-1',location:'正文 · 片段1',text:'交付完整源码、部署说明、操作文档和管理账号，线上交付'}]});
const reference=(m=material())=>({materialId:m.id,sha256:m.sha256,chunkId:m.chunks[0].id,quote:m.chunks[0].text});

test('material readers extract actual DOCX, UTF-8 and PDF text with stable locations; blank PDFs disclose missing OCR',async()=>{
 const doc=await extractMaterial('合同.docx',await renderContract(contentFixture()));assert.equal(doc.status,'ready');assert.match(doc.chunks.map(c=>c.text).join(''),/8000/);assert.ok(doc.warnings.length);
 const txt=await extractMaterial('说明.txt',Buffer.from('条款一\n用户的约定'));assert.equal(txt.chunks[0].id,'text-1');assert.match(txt.chunks[0].text,/用户的约定/);
 const parsed=await extractMaterial('contract.pdf',pdf('Payment after delivery'));assert.equal(parsed.status,'ready');assert.match(parsed.chunks[0].text,/Payment after delivery/);assert.match(parsed.chunks[0].location,/第1页/);
 const scanned=await extractMaterial('scanned.pdf',pdf(''));assert.equal(scanned.status,'needs_ocr');assert.equal(scanned.chunks.length,0);assert.ok(scanned.warnings.some(w=>/OCR|未读取/.test(w)));
});
test('unsupported, invalid, oversized and binary material payloads fail without pretending to read them',async()=>{
 for(const [name,bytes] of [['old.doc',Buffer.from('x')],['fake.pdf',Buffer.from('not PDF')],['fake.docx',Buffer.from('not ZIP')],['binary.txt',Buffer.from([0,1,2])],['huge.txt',Buffer.alloc(MAX_MATERIAL_BYTES+1)] ] as const)await assert.rejects(extractMaterial(name,bytes));
});
test('parallel PDF uploads have bounded worker admission and release slots after completion',async()=>{
 const attempts=await Promise.allSettled(Array.from({length:3},()=>extractMaterial('file.pdf',pdf('bounded worker'))));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,2);
 assert.equal(attempts.filter(r=>r.status==='rejected'&&r.reason.code==='MATERIAL_BUSY').length,1);
 assert.equal((await extractMaterial('next.pdf',pdf('next document'))).status,'ready');
});
test('material facts require exact authorized page evidence and reference templates cannot manufacture agreed terms',()=>{
 const m=material(),r=reference(m),previous=intakeFixture();
 const value=intakeSchema.parse({templateId:'software',facts:[{fieldId:'deliverables',value:r.quote,quote:r.quote,materialRefs:[r]}]});
 const i=compileTransactionUpdate(value,previous,['请结合文件起草'],[m]).intake!;
 assert.equal(i.facts.deliverables.source,'material');assert.deepEqual(i.facts.deliverables.materialRefs,[r]);assert.deepEqual(i.missing,[]);assert.equal(i.materialSources?.[0].id,m.id);assert.equal(i.confirmedAt,undefined);
 assert.throws(()=>materialEvidence([{...r,materialId:crypto.randomUUID()}],[m]),/当前可用/);
 assert.throws(()=>materialEvidence([{...r,quote:'凭空增加保证金'}],[m]),/逐字定位/);
 assert.throws(()=>materialEvidence([r],[{...m,purpose:'reference'}]),/参考范本/);
 assert.throws(()=>compileTransactionUpdate(value,previous,['请结合文件起草'],[]),/当前可用/);
});
test('withdrawn materials cannot silently preserve their old extracted facts in the next transaction snapshot',()=>{
 const m=material(),r=reference(m),previous=intakeFixture();previous.facts.extraMaterial={value:r.quote,quote:r.quote,source:'material',materialRefs:[r]};
 const i=compileTransactionUpdate(intakeSchema.parse({templateId:'software',facts:[]}),previous,['移出此材料'],[]).intake!;
 assert.equal(i.facts.extraMaterial,undefined);assert.deepEqual(i.materialSources,[]);assert.ok(previous.facts.extraMaterial);
});
test('material access is scoped to the supplied contract snapshot and paging reveals exact chunks only',()=>{
 const m=material();m.chunks=Array.from({length:5},(_,n)=>({id:'text-'+n,location:'段'+n,text:'段落'+n}));m.chunkCount=5;
 const page=readMaterial([m],m.id);assert.equal(page.chunks.length,3);assert.equal(page.nextOffset,3);assert.equal(readMaterial([m],m.id,3).nextOffset,null);
 assert.equal(readMaterial([m],m.id,0,'段落4').chunks[0].id,'text-4');assert.throws(()=>readMaterial([],m.id),/当前合同/);
});
test('legal retrieval only sends abstract queries to the configured provider and retains official evidence, dates and limitations',async()=>{
 const saved=fetch;try{
  globalThis.fetch=async(url,init)=>{assert.equal(url,'https://api.tavily.com/search');const body=JSON.parse(String(init?.body));assert.deepEqual(body.include_domains,['npc.gov.cn','gov.cn','court.gov.cn']);assert.equal(body.include_answer,false);assert.ok(!JSON.stringify(body).includes('私人合同'));
   return Response.json({results:[{title:'官方法律说明',url:'https://www.npc.gov.cn/law/example.html',raw_content:'一方履行义务应当符合双方约定。检索片段不保证现行有效。',published_date:'2026-01-01'},{title:'伪造官方域名',url:'https://npc.gov.cn.evil.test/law',content:'不可信'},{title:'本地',url:'http://127.0.0.1',content:'不可信'}]});};
  const result=await searchLegalSources('民法典 合同履行规则',{CONTRACT_LEGAL_SEARCH_API_KEY:'fixture'});assert.equal(result.status,'available');assert.equal(result.sources.length,1);assert.equal(result.sources[0].validity,'not_verified');assert.equal(result.sources[0].contentType,'page_excerpt');assert.equal(result.sources[0].publishedDate,'2026-01-01');
  validateLegalCitations({legalCitations:[{sourceId:result.sources[0].id,quote:'一方履行义务应当符合双方约定。',use:'核对履行表述'}]},[result]);
  assert.throws(()=>validateLegalCitations({legalCitations:[{sourceId:result.sources[0].id,quote:'未检索到的法条',use:'虚构'}]},[result]),/逐字定位/);
 }finally{globalThis.fetch=saved;}
});
test('private case identifiers and misleading URLs are rejected; unconfigured and unavailable retrieval remain explicit',async()=>{
 for(const q of ['张三 合同纠纷','测试有限公司 合同','赔偿10000元','手机号13800001111'])assert.throws(()=>assertPublicLegalQuery(q,['张三']));
 assert.equal(officialLegalUrl('https://npc.gov.cn@evil.test'),false);assert.equal(officialLegalUrl('http://www.gov.cn'),false);assert.equal(officialLegalUrl('https://www.court.gov.cn/a'),true);
 const unavailable=await searchLegalSources('合同履行',{});assert.equal(unavailable.status,'unavailable');assert.deepEqual(unavailable.sources,[]);
 const saved=fetch;try{globalThis.fetch=async()=>Response.json({}, {status:429});assert.equal((await searchLegalSources('合同履行',{TAVILY_API_KEY:'fixture'})).status,'failed');}finally{globalThis.fetch=saved;}
});
test('Pi tools read scoped materials and unavailable legal search, then persist source-grounded intake without a paid model',async()=>{
 const saved=fetch,dir=await mkdtemp(join(tmpdir(),'contract-material-agent-')),m=material(),r=reference(m);let calls=0;
 const tool=(name:string,args:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:'fixture-'+calls,type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
 try{
  globalThis.fetch=async(_url,init)=>{calls++;const b=JSON.parse(String(init?.body)),names=b.tools.map((t:any)=>t.function.name);assert.ok(names.includes('read_contract_material'));assert.ok(names.includes('search_legal_sources'));
   if(calls===1){assert.match(b.messages[0].content,/当前材料目录/);return tool('read_contract_material',{materialId:m.id});}
   if(calls===2){assert.match(JSON.stringify(b.messages),/线上交付/);return tool('search_legal_sources',{query:'民法典 合同履行'});}
   assert.match(JSON.stringify(b.messages),/法律检索未配置/);return tool('update_contract_spec',{result:{templateId:'software',facts:[{fieldId:'deliverables',value:r.quote,quote:r.quote,materialRefs:[r]}]}});
  };
  const messages=[{id:'m',role:'user' as const,content:'请读取这份交易说明，整理合同约定',createdAt:''}];
  const result=await collectIntake(messages,intakeFixture(),{CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test',CONTRACT_PI_SESSION_DIR:dir},undefined,{ownerId:'owner',contractId:'contract',requestId:'req',history:messages,materials:[m]});
  assert.equal(calls,3);assert.equal(result.intake?.facts.deliverables.source,'material');assert.equal(result.intake?.legalResearch?.[0].status,'unavailable');assert.deepEqual(result.intake?.missing,[]);
 }finally{globalThis.fetch=saved;await rm(dir,{recursive:true,force:true});}
});
test('retrieved legal quotations survive intake, draft and verification with their original source and timestamp',async()=>{
 const saved=fetch;let providerCalls=0,searches=0,sourceId='';const quote='一方履行义务应当符合双方约定。';
 const tool=(name:string,args:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
 try{
  globalThis.fetch=async(url,init)=>{
   if(String(url).includes('api.tavily.com')){searches++;return Response.json({results:[{title:'测试官方来源',url:'https://www.npc.gov.cn/law/fixture.html',raw_content:quote}]});}
   providerCalls++;const body=JSON.parse(String(init?.body)),names=body.tools.map((t:any)=>t.function.name);
   if(providerCalls===1)return tool('search_legal_sources',{query:'合同履行规则'});
   if(names.includes('update_contract_spec')){const result=body.messages.findLast((m:any)=>m.role==='tool');sourceId=JSON.parse(result.content).sources[0].id;return tool('update_contract_spec',{result:{templateId:'software',facts:[],legalCitations:[{sourceId,quote,use:'核对一般履行措辞'}]}});}
   if(names.includes('submit_contract_draft'))return tool('submit_contract_draft',{result:{...contentFixture(),legalCitations:[{sourceId,quote,use:'一般履行措辞参考'}]}});
   return tool('submit_consistency_check',{result:{verdict:'consistent',issues:[],legalCitations:[{sourceId,quote,use:'复核措辞'}]}});
  };
  const env={CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test',CONTRACT_LEGAL_SEARCH_API_KEY:'fixture'};
  const result=await collectIntake([{id:'m',role:'user',content:'请核对合同履行规则',createdAt:''}],intakeFixture(),env);
  assert.equal(result.intake?.legalResearch?.[0].sources[0].id,sourceId);assert.equal(result.intake?.legalCitations?.[0].quote,quote);
  result.intake!.confirmedAt=new Date().toISOString();const draft=await draftConfirmed(result.intake!,env);await verifyConfirmedDraft(draft,env);
  assert.equal(searches,1);assert.equal(draft.legalResearch?.[0].sources[0].id,sourceId);assert.ok(draft.legalCitations?.every(c=>c.sourceId===sourceId));assert.equal(draft.legalResearch?.[0].sources[0].validity,'not_verified');
 }finally{globalThis.fetch=saved;}
});

test('continuous legal research retains older cited sources while bounding unused history',()=>{
 const searches=Array.from({length:30},(_,n)=>({query:'query'+n,searchedAt:String(n),status:'available' as const,note:'fixture',sources:[{id:'source'+n,title:'source',url:'https://www.npc.gov.cn',excerpt:'原始法规片段供核对',retrievedAt:String(n),contentType:'page_excerpt' as const,validity:'not_verified' as const}]}));
 const citations=[{sourceId:'source0',quote:'原始法规片段供核对',use:'仍被引用'}];
 const kept=retainLegalResearch(searches,citations);assert.equal(kept.length,13);assert.equal(kept[0].sources[0].id,'source0');validateLegalCitations({legalCitations:citations},kept);
});
