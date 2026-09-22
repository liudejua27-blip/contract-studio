import test from 'node:test';
import assert from 'node:assert/strict';
import {PLAYBOOKS,exportProblems} from '../src/lib/contract-library/playbooks';
import {EXTENDED} from '../src/lib/contract-library/extended';
import {CORE_FIELDS,defaultsFor} from '../src/lib/contract-library/guided-policy';
import {collectIntake,draftConfirmed,verifyConfirmedDraft} from '../src/server/ai';
import {renderContract,extractDocxText} from '../src/server/documents';
import {intakeFactIssues} from '../src/lib/contract-library/fact-checks';
import type {Intake} from '../src/lib/types';
const env={CONTRACT_AI_API_KEY:'test',CONTRACT_AI_BASE_URL:'https://model.test'};
test('each new category can intake, confirm, validate and export its own sections and attachment',async()=>{
 const old=fetch;try{for(const id of Object.keys(EXTENDED)){
 const p=PLAYBOOKS[id];const facts=Object.fromEntries(CORE_FIELDS[id].map(k=>[k,{value:k==='price'?'8000元':k==='payment'?'签约后支付8000元':k==='partyA'?'示例甲公司':k==='partyB'?'示例乙公司':'双方已明确的'+k,quote:k==='price'?'8000元':k==='payment'?'签约后支付8000元':k==='partyA'?'示例甲公司':k==='partyB'?'示例乙公司':'双方已明确的'+k}]));
 let content:any;
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)),prompt=body.messages[0].content;return Response.json({choices:[{message:{content:JSON.stringify(prompt.includes('CONTRACT_INTAKE_V2')?{templateId:id,facts:Object.entries(facts).map(([fieldId,f])=>({fieldId,...f})),businessChecks:['scope','exchange','term'].map(fieldId=>({fieldId,status:'answered',evidence:Object.values(facts).slice(0,8).map(f=>f.quote)}))}:prompt.includes('CONTRACT_VERIFY_V2')?{verdict:'consistent',issues:[]}:content)}}]})};
 const r=await collectIntake([{id:'m',role:'user',content:Object.values(facts).map(f=>f.quote).join('；'),createdAt:''}],undefined,env);
 assert.deepEqual(r.intake!.missing,[],id);assert.ok(r.intake!.reviewNotes!.length);r.intake!.confirmedAt=new Date().toISOString();
 content={title:id+'合同',parties:[{role:'甲方',name:'示例甲公司'},{role:'乙方',name:'示例乙公司'}],sections:p.clauses.map(title=>({title,content:'双方按照上述实际交易约定履行。'})),attachments:p.attachments.map(title=>({title,content:Object.values(facts).map(f=>f.value).join('；')})),signing:'',missing:[]};
 const draft=await draftConfirmed(r.intake!,env);await verifyConfirmedDraft(draft,env);assert.deepEqual(exportProblems(draft),[]);const bytes=await renderContract(draft);assert.ok(extractDocxText(bytes).includes(p.attachments[0]));
 }}finally{globalThis.fetch=old}
});
test('NDA does not require payment; monthly rent is not compared to quarterly payment as a total',()=>{
 assert.ok(!CORE_FIELDS.nda.includes('price'));const i:Intake={templateId:'nda',facts:{},missing:[],conflicts:[],summaryId:'x'};assert.equal(defaultsFor(i).invoice,undefined);assert.ok(defaultsFor(i).confidentiality);
 i.templateId='house-lease';i.facts={price:{value:'每月3000元',quote:'每月3000元'},payment:{value:'每季度支付9000元',quote:'每季度支付9000元'}};assert.deepEqual(intakeFactIssues(i),[]);
});
test('an abbreviated end date inherits the explicitly stated year; an unrelated date still fails',async()=>{
 const {validateNumericFacts}=await import('../src/server/ai');
 const c:any={title:'服务合同',parties:[],sections:[{title:'期间',content:'2026年10月31日结束'}],signing:'',missing:[]};
 assert.doesNotThrow(()=>validateNumericFacts(c,'2026年10月1日至10月31日'));
 c.sections[0].content='2027年10月31日结束';assert.throws(()=>validateNumericFacts(c,'2026年10月1日至10月31日'));
});
