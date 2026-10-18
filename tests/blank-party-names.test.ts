import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture} from './fixtures';
import {compileTransactionUpdate,intakeSchema} from '../src/lib/transaction-update';
import {transactionQuestions} from '../src/lib/transaction-state';
import {documentStructureProblems,signingChecklist} from '../src/lib/contract-document';
import {exportProblems} from '../src/lib/contract-library/playbooks';
import {renderContract,extractDocxText} from '../src/server/documents';
import {evaluationGate} from '../scripts/eval-gate';
const participants=[{factId:'partyA',role:'甲方',name:''},{factId:'partyB',role:'乙方',name:''}];
const fact=(value:string)=>({value,quote:value});
function blankDraft(){const c=contentFixture();c.documentProfile='cn-contract-v2';c.parties=[{role:'甲方',name:''},{role:'乙方',name:''}];c.confirmation!.participants=participants;c.confirmation!.facts.partyA=fact('甲方委托开发');c.confirmation!.facts.partyB=fact('乙方负责开发');return c;}

test('unnamed parties flow through intake, confirmation, Word and signing checklist',async()=>{
 const c=blankDraft();delete c.confirmation!.facts.partyA;delete c.confirmation!.facts.partyB;
 const facts=Object.entries(c.confirmation!.facts).map(([fieldId,f])=>({fieldId,...f}));
 const result=compileTransactionUpdate(intakeSchema.parse({templateId:'software',participants,facts}),undefined,facts.map(f=>f.quote));
 assert.deepEqual(result.intake!.missing,[]);assert.deepEqual(transactionQuestions(result.intake!),[]);
 c.confirmation={...result.intake!,confirmedAt:new Date().toISOString()};
 assert.deepEqual(exportProblems(c),[]);
 const text=extractDocxText(await renderContract(c));assert.match(text,/甲方：_{4,}/);assert.match(text,/乙方：_{4,}/);
 assert.equal(signingChecklist(c).filter(p=>p.items.includes('签署前补齐主体名称')).length,2);
});
test('blank names cannot borrow signing evidence from the other party',()=>{
 const c=blankDraft();c.confirmation!.facts.partyB_address=fact('乙方地址青岛测试路8号');
 c.parties[1].address='青岛测试路8号';assert.deepEqual(documentStructureProblems(c),[]);
 c.parties[0].address='青岛测试路8号';assert.ok(documentStructureProblems(c).some(e=>e.startsWith('甲方')&&e.includes('其他参与方')));
});
test('name supplementation remains grounded and an unknown price still blocks',()=>{
 const c=blankDraft();const previous=c.confirmation!;
 const input=intakeSchema.parse({templateId:'software',participants:[{...participants[0],name:'测试甲公司'},participants[1]],facts:[{fieldId:'partyA',...fact('甲方名称是测试甲公司')}],clearedFields:['price'],businessChecks:[{fieldId:'price',status:'missing',question:'总价准备约定多少？',evidence:[]}]});
 const result=compileTransactionUpdate(input,previous,['甲方名称是测试甲公司']);assert.equal(result.intake!.participants![0].name,'测试甲公司');assert.ok(result.intake!.missing.includes('price'));assert.ok(!result.intake!.missing.includes('partyB'));
 assert.throws(()=>compileTransactionUpdate({...input,participants:[{...participants[0],name:'编造企业'},participants[1]]},previous,['甲方名称是测试甲公司']),/名称必须来自/);
});
test('model evaluation accepts 19/20, rejects 18/20 and empty runs',()=>{
 assert.equal(evaluationGate(Array.from({length:20},(_,i)=>({passed:i<19}))).targetMet,true);
 assert.equal(evaluationGate(Array.from({length:20},(_,i)=>({passed:i<18}))).targetMet,false);
 assert.equal(evaluationGate([]).targetMet,false);
});
