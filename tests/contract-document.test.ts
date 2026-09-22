import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {contentFixture,intakeFixture} from './fixtures';
import {collectIntake,draftConfirmed,validateNumericFacts,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract,extractDocxText,assertContractLayout} from '../src/server/documents';
import {normalizeParts,documentStructureProblems,signingChecklist} from '../src/lib/contract-document';
import {documentBody} from '../src/lib/skill-audit';
import {publicPreview} from '../src/lib/agent-stream';
import {sceneQuestions} from '../src/lib/contract-library/guided-policy';
import type {ContractContent,Intake} from '../src/lib/types';

const env={CONTRACT_AI_API_KEY:'fixture-only',CONTRACT_AI_BASE_URL:'https://model.test'};
const call=(name:string,result:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify({result})}}]}}]});
const fact=(value:string)=>({value,quote:value});
function threeParty(){
 const c=contentFixture();c.documentProfile='cn-contract-v2';
 c.confirmation!.facts.partyC=fact('丙方张三是自然人，负责提供业务资料');
 c.parties.push({role:'丙方',name:'张三',subjectType:'individual'});
 c.parties[0].subjectType='organization';c.parties[1].subjectType='organization';
 c.confirmation!.participants=c.parties.map((p,i)=>({role:p.role,name:p.name,subjectType:p.subjectType,factId:'party'+String.fromCharCode(65+i)}));
 return c;
}
test('multi-party intake stays evidence bound; real Word retains every participant and signature kind',async()=>{
 const old=fetch,c=threeParty();try{
  globalThis.fetch=async()=>call('update_contract_spec',{templateId:'software',participants:c.confirmation!.participants,facts:[{fieldId:'partyC',...c.confirmation!.facts.partyC}]});
  const r=await collectIntake([{id:'m',role:'user',content:c.confirmation!.facts.partyC.value,createdAt:''}],intakeFixture(),env);
  assert.equal(r.intake!.participants!.length,3);assert.deepEqual(r.intake!.missing,[]);
  const bytes=await renderContract(c),text=extractDocxText(bytes);assert.match(text,/丙方：张三/);assert.match(text,/本人签名/);
  c.parties.pop();assert.ok(documentStructureProblems(c).some(s=>s.includes('缺少已确认的参与方')));
 }finally{globalThis.fetch=old;}
});

test('signing information reaches Word, unknown administrative details do not block a draft',async()=>{
 const c=threeParty();c.parties[0].authorizedRepresentative='李四';c.parties[0].address='青岛市测试路';c.signing='签署地点：青岛市';
 c.confirmation!.facts.partyA_signing=fact('甲方授权签署人李四，地址青岛市测试路。签署地点：青岛市');
 const t=extractDocxText(await renderContract(c));assert.match(t,/授权签署人：李四/);assert.match(t,/签署地点：青岛市/);assert.match(t,/签署日期：______年____月____日/);
 assert.ok(signingChecklist(c).some(p=>p.items.length>0));
 c.parties[0].email='invented@example.test';assert.ok(documentStructureProblems(c).some(s=>s.includes('缺少用户依据')));
});

test('explicit signature method requires evidence and remains different from generic signing slots',async()=>{
 const c=threeParty();c.parties[0].signatureMethod='signature_and_seal';
 await assert.rejects(renderContract(c),/签署方式缺少用户依据/);
 c.confirmation!.facts.partyA_method=fact('甲方签名并盖章');assert.match(extractDocxText(await renderContract(c)),/签名并盖章/);
});

function rich(){
 const c=threeParty();c.sections=[{title:'款项安排',content:'',blocks:[{kind:'heading',level:2,text:'付款计划'},{kind:'table',columns:['节点','金额'],rows:[['签署后','4000元'],['验收后','4000元']]},{kind:'list',items:['交付完整源码','按功能清单验收']}]}];
 c.attachments=[{title:'功能与交付清单',content:'',blocks:[{kind:'table',columns:['成果','交付形式'],rows:[['完整源码','线上交付'],['部署说明','电子文档']]}],signatureRequired:true}];
 return normalizeParts(c);
}
test('tables and nested clauses use actual Word structure, A4, repeating headers and total pages',async()=>{
 const c=rich(),bytes=await renderContract(c);assertContractLayout(bytes);const files=unzipSync(bytes),xml=new TextDecoder().decode(files['word/document.xml']);
 assert.equal((xml.match(/<w:tbl>/g)||[]).length,4,'two data tables and two signing tables');
 assert.equal((xml.match(/<w:tblHeader/g)||[]).length,2);assert.match(xml,/w:cantSplit/);assert.match(xml,/w:eastAsia="宋体"/);assert.match(xml,/w:w="11906"/);assert.match(xml,/w:line="360"/);
 assert.match(new TextDecoder().decode(files['word/footer1.xml']),/NUMPAGES/);
 assert.match(extractDocxText(bytes),/4000元/);assert.match(extractDocxText(bytes),/附件确认/);
 const before=documentBody(c);c.sections[0].blocks![1]={kind:'table',columns:['节点','金额'],rows:[['签署后','9000元']]};
 assert.notEqual(documentBody(c),before);await assert.rejects(renderContract(c),/结构化内容与核对正文不一致/);
 normalizeParts(c);assert.throws(()=>validateNumericFacts(c,Object.values(c.confirmation!.facts).map(f=>f.value).join('\n')),/未确认数值|合计/);
});

test('draft tool tables survive normalization, verification, audit and export',async()=>{
 const old=fetch,c=rich();try{
  c.sections[0].content='';c.attachments![0].content='';
  globalThis.fetch=async(_url,init)=>String(init?.body).includes('CONTRACT_VERIFY_V2')?call('submit_consistency_check',{verdict:'consistent',issues:[],reviewNotes:[]}):call('submit_contract_draft',c);
  const d=await draftConfirmed(c.confirmation!,env);await verifyConfirmedDraft(d,env);
  assert.match(d.sections[0].content,/4000元/);assert.match(d.sections.at(-1)!.content,/附件《功能与交付清单》/);
  assert.deepEqual(documentStructureProblems(d),[]);assert.ok(d.skillAudit!.consistency);assert.match(extractDocxText(await renderContract(d)),/电子文档/);
 }finally{globalThis.fetch=old;}
});

test('table streaming publishes only document cells and headings, never legal notes or metadata',()=>{
 const c=rich();const json=JSON.stringify({result:{...c,sections:c.sections.map(s=>({...s,content:''})),reviewNotes:['PRIVATE'],ruleApplications:[{text:'SECRET'}]}});
 for(let i=1;i<=json.length;i+=13){const preview=publicPreview(json.slice(0,i),'draft');assert.doesNotMatch(preview,/PRIVATE|SECRET|factId|registrationId/);}
 assert.match(publicPreview(json,'draft'),/4000元/);assert.match(publicPreview(json,'draft'),/交付完整源码/);
});

const revenueIntake=():Intake=>({templateId:'general',facts:{partyA:fact('甲方测试甲公司'),partyB:fact('乙方测试乙门店'),scope:fact('门店合作按销售收入分成'),exchange:fact('销售收入甲方60%、乙方40%'),term:fact('合作一年'),revenue:fact('每月底按销售收入分成')},missing:[],conflicts:[],summaryId:'s'});
test('revenue followups use all retained answers and disappear when answered in other fields',()=>{
 const i=revenueIntake();assert.deepEqual(sceneQuestions(i).filter(q=>['collection','settlement','revenueAdjustments'].includes(q.fieldId)).map(q=>q.fieldId),['collection','settlement','revenueAdjustments']);
 i.facts.specialTerms=fact('顾客钱由乙方收取，每月底向甲方支付60%，按实收扣除退款后的收入计算');
 assert.ok(!sceneQuestions(i).some(q=>['collection','settlement','revenueAdjustments'].includes(q.fieldId)));
 const simple=intakeFixture();assert.ok(!sceneQuestions(simple).some(q=>q.fieldId==='collection'));
});

test('scene proposals are offered after scene detection, are not facts, and deferred questions are not repeated',async()=>{
 const old=fetch,i=revenueIntake();i.facts.collection=fact('乙方统一收款');i.facts.settlement=fact('乙方向甲方支付分成款');
 try{
  globalThis.fetch=async()=>call('update_contract_spec',{templateId:'general',facts:[],businessProposals:[{fieldId:'revenueAdjustments',value:'按照打折后实际收到且扣除退款的销售收入分成。'}]});
  let r=await collectIntake([{id:'m',role:'user',content:'退款按常见方式处理',createdAt:''}],i,env);
  assert.equal(r.intake!.businessProposals!.length,1);assert.equal(r.intake!.facts.revenueAdjustments,undefined);assert.doesNotMatch(r.reply,/退款要从收入/);
  globalThis.fetch=async()=>call('update_contract_spec',{templateId:'general',facts:[],deferredFields:[{fieldId:'revenueAdjustments',quote:'退款口径还没定'}]});
  r=await collectIntake([{id:'m',role:'user',content:'退款口径还没定',createdAt:''}],i,env);
  assert.ok(r.intake!.deferredFields!.includes('revenueAdjustments'));assert.doesNotMatch(r.reply,/退款要从收入/);assert.ok(r.intake!.reviewNotes!.some(s=>s.includes('退款与折扣口径')));
 }finally{globalThis.fetch=old;}
});

test('legacy body digests and Word exports remain readable without requiring newly added signing fields',async()=>{
 const c=contentFixture();const before=documentBody(c);assert.ok(!before.includes('documentProfile'));
 assert.ok((await renderContract(c)).length>1000);assert.ok(signingChecklist(c).some(p=>p.items.length));assert.equal(documentBody(c),before);
});

test('table shape and concealed unresolved text cannot bypass export',async()=>{
 const c=rich();c.sections[0].blocks=[{kind:'table',columns:['名称','数量'],rows:[['待补充']]}];normalizeParts(c);
 await assert.rejects(renderContract(c),/列数不一致|占位符/);
});

test('currency units in table headers cannot conceal an invented amount',()=>{
 const c=rich();c.sections[0].blocks=[{kind:'table',columns:['节点','金额（元）'],rows:[['签署后','9,999']]}];normalizeParts(c);
 assert.throws(()=>validateNumericFacts(c,Object.values(c.confirmation!.facts).map(f=>f.value).join('\n')),/未确认数值/);
});

test('live-case regression: operational answers in scope do not require duplicate fields',()=>{
 const i=revenueIntake();i.facts.scope=fact('甲方提供咖啡机和点单软件，机器一直归甲方，甲方负责维修和咖啡豆补货及其费用；乙方负责门店运营、水电及其费用。终止后机器由甲方取回。');
 assert.ok(!sceneQuestions(i).some(q=>['operations','equipment'].includes(q.fieldId)));
});
