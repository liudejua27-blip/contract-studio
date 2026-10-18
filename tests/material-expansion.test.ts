import test from 'node:test';
import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
import {dirname} from 'node:path';
import {ocrPdfPages} from '../src/server/material-ocr';
import {extractMaterial} from '../src/server/material-parser';
import {pdfFixture} from './pdf-fixture';
import {mergeMaterialConflicts,type MaterialDocument,type MaterialConflict} from '../src/lib/materials';
import {intakeSchema,compileTransactionUpdate} from '../src/lib/transaction-update';
import {intakeFixture} from './fixtures';
import {expandLegalSource} from '../src/server/agent/legal-search';
import {legalSourcePage,validateLegalCitations,type LegalSource} from '../src/lib/legal-research';

test('local OCR bounds page work, uses arguments without shell and removes private temp files',async()=>{
 let dir='',calls=0;const result=await ocrPdfPages(Buffer.from('fixture'),[1,2,3],{CONTRACT_OCR_ENABLED:'true',CONTRACT_OCR_MAX_PAGES:'1'},async(file,args,timeout)=>{
  calls++;assert.ok(timeout>0&&timeout<=45000);
  if(file==='pdftoppm'){assert.equal(args[1],'1');dir=dirname(args.at(-2)!);await access(args.at(-2)!);return '';}
  assert.equal(file,'tesseract');assert.deepEqual(args.slice(1),['stdout','-l','chi_sim+eng']);return '扫描页的合同原文';
 });
 assert.equal(calls,2);assert.equal(result.pages.get(1),'扫描页的合同原文');assert.ok(result.warnings.some(x=>x.includes('部分扫描页')));await assert.rejects(access(dir));
});
test('OCR disabled, unavailable and busy states return explicit missing coverage without external calls',async()=>{
 let calls=0;assert.equal((await ocrPdfPages(Buffer.from('x'),[1],{},async()=>{calls++;return '';})).pages.size,0);assert.equal(calls,0);
 const fail=await ocrPdfPages(Buffer.from('x'),[1],{CONTRACT_OCR_ENABLED:'true'},async()=>{throw new Error('missing binary');});assert.ok(fail.warnings.some(x=>x.includes('识别程序')));
 let release!:()=>void,started!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
 const first=ocrPdfPages(Buffer.from('x'),[1],{CONTRACT_OCR_ENABLED:'true'},async()=>{started();await held;return '文字';});
 await ready;const busy=await ocrPdfPages(Buffer.from('x'),[1],{CONTRACT_OCR_ENABLED:'true'});assert.match(busy.warnings[0],/正在处理/);release();await first;
});
test('PDF parser labels OCR evidence as partial and leaves text-layer documents untouched',async()=>{
 const scanned=await extractMaterial('scan.pdf',pdfFixture(''),async(_bytes,pages)=>{assert.deepEqual(pages,[1]);return {pages:new Map([[1,'识别金额8000元，须核对原件']]),warnings:['识别结果需核对']};});
 assert.equal(scanned.status,'partial');assert.match(scanned.chunks[0].location,/第1页.*OCR/);assert.match(scanned.chunks[0].text,/8000/);
 const regular=await extractMaterial('text.pdf',pdfFixture('Visible text'),async()=>{throw new Error('must not OCR text pages');});assert.equal(regular.status,'ready');
});
function material(text:string):MaterialDocument{return {id:crypto.randomUUID(),name:'约定.txt',sha256:'a'.repeat(64),purpose:'transaction',size:10,status:'ready',createdAt:'',warnings:[],chunkCount:1,chunks:[{id:'text-1',location:'正文',text}]};}
test('material conflicts retain exact competing sources until a current user choice; stale or template evidence cannot count',()=>{
 const a=material('总价8000元'),b=material('总价9000元'),ref=(m:MaterialDocument)=>({materialId:m.id,sha256:m.sha256,chunkId:'text-1',quote:m.chunks[0].text});
 const conflict:MaterialConflict={topic:'总价',question:'本次采用哪一份金额？',alternatives:[ref(a),ref(b)]};
 const first=compileTransactionUpdate(intakeSchema.parse({templateId:'software',facts:[],materialConflicts:[conflict]}),intakeFixture(),['结合两份材料'],[a,b]).intake!;
 assert.deepEqual(first.materialConflicts,[conflict]);assert.ok(first.conflicts.some(x=>x.includes('总价')));
 assert.equal(mergeMaterialConflicts([conflict],[],[],'其他补充',[a,b]).length,1);
 assert.throws(()=>mergeMaterialConflicts([conflict],[],[{topic:'总价',quote:'采用8000元'}],'没有说过',[a,b]),/本轮/);
 const resolved=compileTransactionUpdate(intakeSchema.parse({templateId:'software',facts:[],resolvedMaterialConflicts:[{topic:'总价',quote:'采用8000元'}]}),first,['采用8000元'],[a,b]).intake!;assert.deepEqual(resolved.materialConflicts,[]);assert.equal(resolved.conflicts.length,0);
 assert.deepEqual(mergeMaterialConflicts([conflict],[],[],'',[a]),[]);
 assert.throws(()=>mergeMaterialConflicts([],[conflict],[],'',[a,{...b,purpose:'reference'}]),/参考范本/);
 assert.throws(()=>mergeMaterialConflicts([],[{...conflict,alternatives:[ref(a),ref(a)]}],[],'',[a]),/两个不同/);
 assert.throws(()=>mergeMaterialConflicts([],[{...conflict,alternatives:[ref(a),{...ref(b),quote:'虚构'}]}],[],'',[a,b]),/逐字定位/);
});
const source:LegalSource={id:'old-source',title:'官方页',url:'https://www.npc.gov.cn/law/fixture.html',excerpt:'原来的搜索摘要供核对',retrievedAt:'2026-01-01',validity:'not_verified',contentType:'search_snippet'};
test('official page expansion preserves old source, paginates new text and validates citations beyond the first page',async()=>{
 const old=fetch,original=structuredClone(source),text='文'.repeat(7100)+'后半页的原文依据供核对';try{
  globalThis.fetch=async(url,init)=>{assert.equal(url,'https://api.tavily.com/extract');assert.deepEqual(JSON.parse(String(init?.body)).urls,[source.url]);return Response.json({results:[{url:source.url,raw_content:text}]});};
  const search=await expandLegalSource(source,{TAVILY_API_KEY:'fixture'}),expanded=search.sources[0];assert.equal(search.status,'available');assert.equal(expanded.parentSourceId,source.id);assert.equal(expanded.validity,'not_verified');assert.deepEqual(source,original);assert.notEqual(expanded.id,source.id);
  const first=legalSourcePage(expanded),next=legalSourcePage(expanded,first.nextOffset!);assert.equal(first.excerpt.length,7000);assert.match(next.excerpt,/后半页/);assert.equal(next.nextOffset,null);
  validateLegalCitations({legalCitations:[{sourceId:expanded.id,quote:'后半页的原文依据供核对',use:'核对'}]},[search]);assert.throws(()=>legalSourcePage(expanded,-1));
  globalThis.fetch=async()=>Response.json({results:[{url:source.url,raw_content:'字'.repeat(60000)}]});const capped=(await expandLegalSource(source,{TAVILY_API_KEY:'fixture'})).sources[0];assert.equal(capped.excerpt.length,50000);assert.equal(capped.extraction?.status,'truncated');
 }finally{globalThis.fetch=old;}
});
test('HTTP success without a matching extracted official URL remains failure; unknown URLs cannot be fetched',async()=>{
 const old=fetch;let calls=0;try{
  globalThis.fetch=async()=>{calls++;return Response.json({results:[{url:'https://evil.test',raw_content:'wrong source'}],failed_results:[{url:source.url}]});};
  assert.equal((await expandLegalSource(source,{TAVILY_API_KEY:'fixture'})).status,'failed');assert.equal((await expandLegalSource(source,{})).status,'unavailable');
  await assert.rejects(expandLegalSource({...source,url:'http://127.0.0.1/private'},{TAVILY_API_KEY:'fixture'}));assert.equal(calls,1);
 }finally{globalThis.fetch=old;}
});

test('Pi reads expanded official text by page and preserves new citation IDs through intake',async()=>{
 const {collectIntake}=await import('../src/server/ai');const old=fetch;let models=0,extracts=0,originalId='',expandedId='';const quote='后半页的原文依据供核对';
 const tool=(name:string,args:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}]});
 try{
  globalThis.fetch=async(url,init)=>{
   if(String(url)==='https://api.tavily.com/search')return Response.json({results:[{title:'官方页',url:source.url,content:source.excerpt}]});
   if(String(url)==='https://api.tavily.com/extract'){extracts++;return Response.json({results:[{url:source.url,raw_content:'字'.repeat(7100)+quote}]});}
   models++;const body=JSON.parse(String(init?.body));
   if(models===1)return tool('search_legal_sources',{query:'合同履行规则'});
   const last=JSON.parse(body.messages.findLast((m:any)=>m.role==='tool').content);
   if(models===2){originalId=last.sources[0].id;return tool('read_legal_source',{sourceId:originalId,expand:true});}
   if(models===3){expandedId=last.id;assert.equal(last.nextOffset,7000);return tool('read_legal_source',{sourceId:expandedId,offset:last.nextOffset});}
   if(models===4){assert.match(last.excerpt,/后半页/);return tool('read_legal_source',{sourceId:originalId,expand:true,offset:7000});}
   assert.equal(last.id,expandedId);return tool('update_contract_spec',{result:{templateId:'software',facts:[],legalCitations:[{sourceId:expandedId,quote,use:'核对后半页'}]}});
  };
  const result=await collectIntake([{id:'q',role:'user',createdAt:'',content:'按需核对合同履行规则'}],intakeFixture(),{CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test',TAVILY_API_KEY:'fixture'});
  assert.equal(models,5);assert.equal(extracts,1);assert.equal(result.intake!.legalCitations![0].sourceId,expandedId);assert.equal(result.intake!.legalResearch!.flatMap(r=>r.sources).length,2);
 }finally{globalThis.fetch=old;}
});
