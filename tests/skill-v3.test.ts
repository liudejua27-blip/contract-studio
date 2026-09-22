import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync} from 'fflate';
import {contentFixture,intakeFixture} from './fixtures';
import {documentStructureProblems,normalizeParts} from '../src/lib/contract-document';
import {businessCheckProblems} from '../src/lib/business-checks';
import {sceneQuestions} from '../src/lib/contract-library/guided-policy';
import {collectIntake} from '../src/server/ai';
import {renderContract} from '../src/server/documents';
import {legalSkillBundle} from '../src/server/agent/legal-skills';

const fact=(value:string)=>({value,quote:value});
const env={CONTRACT_AI_API_KEY:'fixture-only',CONTRACT_AI_BASE_URL:'https://model.test'};
const response=(result:unknown)=>Response.json({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name:'update_contract_spec',arguments:JSON.stringify({result})}}]}}]});

test('party metadata is checked against its owner, including combined legacy contact sentences',()=>{
 const c=contentFixture();c.documentProfile='cn-contract-v2';c.parties[0].email='a@example.test';assert.deepEqual(documentStructureProblems(c),[]);
 c.parties[0].email='b@example.test';assert.match(documentStructureProblems(c).join('；'),/其他参与方/);
 c.parties[0].details='b@example.test';assert.match(documentStructureProblems(c).join('；'),/其他主体说明/);c.parties[0].details='a@example.test';
 delete c.parties[0].email;c.confirmation!.facts.partyB_signing=fact('乙方授权代表张三在青岛市测试路签名并盖章');
 c.parties[0].authorizedRepresentative='张三';c.parties[0].address='青岛市测试路';c.parties[0].signatureMethod='signature_and_seal';
 assert.equal(documentStructureProblems(c).filter(s=>/其他参与方/.test(s)).length,3);
 delete c.parties[0].authorizedRepresentative;delete c.parties[0].address;delete c.parties[0].signatureMethod;
 c.parties[1].authorizedRepresentative='张三';c.parties[1].address='青岛市测试路';c.parties[1].signatureMethod='signature_and_seal';assert.deepEqual(documentStructureProblems(c),[]);
});

test('a party field cannot override a different owner explicitly named in its evidence',()=>{
 const c=contentFixture();c.documentProfile='cn-contract-v2';c.confirmation!.facts.partyA_email=fact('乙方邮箱 wrong@example.test');c.parties[0].email='wrong@example.test';
 assert.ok(documentStructureProblems(c).length);
 c.confirmation!.facts.partyA_method=fact('甲方无需盖章');c.parties[0].signatureMethod='seal';assert.match(documentStructureProblems(c).join('；'),/签署方式缺少/);
});

test('explicit signing data cannot disappear to bypass ownership checks',()=>{
 const c=contentFixture();c.documentProfile='cn-contract-v2';c.confirmation!.facts.partyB_signatureMethod=fact('乙方签名并盖章');
 assert.match(documentStructureProblems(c).join('；'),/乙方已确认的签署方式.*不得遗漏/);
 c.parties[1].signatureMethod='signature_and_seal';assert.deepEqual(documentStructureProblems(c),[]);
});

test('merely mentioning refunds or actual revenue does not answer refund allocation',()=>{
 const i=intakeFixture('general');i.facts.scope=fact('门店销售合作');i.facts.revenue=fact('按实收收入甲方60%、乙方40%分成，每月底结算');i.facts.collection=fact('乙方收款');i.facts.settlement=fact('乙方向甲方支付分成');
 assert.ok(sceneQuestions(i).some(q=>q.fieldId==='revenueAdjustments'));
 i.facts.specialTerms=fact('退款怎么处理还没定');assert.ok(sceneQuestions(i).some(q=>q.fieldId==='revenueAdjustments'));
 const check={fieldId:'revenueAdjustments',status:'deferred' as const,evidence:['退款怎么处理还没定']};assert.deepEqual(businessCheckProblems([check],i.facts,['退款怎么处理还没定']),[]);assert.ok(businessCheckProblems([check],i.facts,['其他不变']).length);
});

test('semantic answered state prevents repeated questions across fields, with source evidence',async()=>{
 const old=fetch,i=intakeFixture('general');i.facts.scope=fact('门店合作销售分成，甲方补货，乙方经营');i.facts.exchange=fact('甲方六成，乙方四成，月底分账');i.facts.specialTerms=fact('钱先进乙方账户，再把甲方那份打过去；按折后到账款分钱，退给客人的那部分不算收入');
 const answer=i.facts.specialTerms.value;
 try{globalThis.fetch=async()=>response({templateId:'general',facts:[],businessChecks:['collection','settlement','revenueAdjustments'].map(fieldId=>({fieldId,status:'answered',evidence:[answer]}))});
  const r=await collectIntake([{id:'m',role:'user',content:answer,createdAt:''}],i,env);
  assert.ok(!r.intake!.missing.some(id=>['collection','settlement','revenueAdjustments'].includes(id)));assert.equal(r.intake!.businessChecks!.length,3);
 }finally{globalThis.fetch=old}
});

test('check validation uses the same verbatim evidence as stored facts, avoiding needless model retries',async()=>{
 const old=fetch;let calls=0;const quote='甲方测试甲公司';
 try{globalThis.fetch=async()=>{calls++;return response({templateId:'software',facts:[{fieldId:'partyA',value:'测试甲公司',quote}],businessChecks:[{fieldId:'partyA',status:'answered',evidence:[quote]},...['partyB','scope','price','payment','term','deliverables'].map(fieldId=>({fieldId,status:'missing',evidence:[],question:'请说明'+fieldId+'？'}))]})};
  const r=await collectIntake([{id:'m',role:'user',content:quote,createdAt:''}],undefined,env);assert.equal(calls,1);assert.equal(r.intake!.facts.partyA.value,quote);assert.equal(r.intake!.businessChecks![0].status,'answered');
 }finally{globalThis.fetch=old}
});

test('a missing semantic decision asks only the remaining detail; unprovided deferral is rejected',async()=>{
 const old=fetch,i=intakeFixture('software');
 try{globalThis.fetch=async()=>response({templateId:'software',facts:[],businessChecks:[{fieldId:'term',status:'missing',evidence:[],question:'开始日期是今年的吗？'}]});
  const r=await collectIntake([{id:'m',role:'user',content:'日期按之前说的',createdAt:''}],i,env);assert.deepEqual(r.intake!.missing,['term']);assert.match(r.reply,/开始日期是今年的吗/);assert.ok(r.intake!.facts.term);
 }finally{globalThis.fetch=old}
 assert.ok(businessCheckProblems([{fieldId:'term',status:'deferred',evidence:[]}],i.facts,['日期按之前说的']).length);
});

test('an explicit undecided business item remains in lawyer notes without repeated questions or invented facts',async()=>{
 const old=fetch,i=intakeFixture('general'),quote='退款怎么算还没定';i.facts.scope=fact('门店销售分成合作');i.facts.exchange=fact('甲方60%、乙方40%，每月底结算');i.facts.revenue=i.facts.exchange;i.facts.collection=fact('乙方统一收款');i.facts.settlement=fact('乙方向甲方支付分成');
 try{globalThis.fetch=async()=>response({templateId:'general',facts:[],businessChecks:[{fieldId:'revenueAdjustments',status:'deferred',evidence:[quote]}]});
  const r=await collectIntake([{id:'m',role:'user',content:quote,createdAt:''}],i,env);assert.ok(r.intake!.deferredFields!.includes('revenueAdjustments'));assert.ok(r.intake!.reviewNotes!.some(s=>s.includes('退款与折扣')));assert.equal(r.intake!.facts.revenueAdjustments,undefined);assert.doesNotMatch(r.reply,/退款要从收入里扣|关键信息已经齐了/);assert.match(r.reply,/尚未约定/);assert.deepEqual(r.intake!.missing,[]);
 }finally{globalThis.fetch=old}
});

test('nested clause headings become real multi-level Word numbering; missing parents are rejected',async()=>{
 const c=contentFixture();c.sections[0]={title:'开发范围',content:'',blocks:[{kind:'heading',level:2,text:'交付约定'},{kind:'paragraph',text:'交付完整源码'},{kind:'heading',level:3,text:'源码形式'},{kind:'paragraph',text:'线上交付'}]};normalizeParts(c);
 const files=unzipSync(await renderContract(c)),numbering=new TextDecoder().decode(files['word/numbering.xml']);
 assert.match(numbering,/1\.%1\.%2/);assert.match(numbering,/w:ilvl="1"/);
 c.sections[0].blocks!.shift();normalizeParts(c);await assert.rejects(renderContract(c),/缺少二级父标题/);
});

test('current skills really reach intake, draft and verify with traceable version receipts',async()=>{
 for(const stage of ['intake','draft','verify'] as const){const bundle=await legalSkillBundle(stage);assert.ok(bundle.receipts.some(r=>r.path==='platform/transaction-contract/SKILL.md'&&r.source.commit==='4.3.1'));assert.ok(bundle.prompt.includes('businessChecks'));if(stage!=='intake')assert.ok(bundle.receipts.some(r=>r.path==='platform/contract-word/SKILL.md'&&r.source.commit==='3.0.0'));}
});
