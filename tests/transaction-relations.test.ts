import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeRelations,relationSchema} from '../src/lib/transaction-relations';
import {compileTransactionUpdate,intakeSchema} from '../src/lib/transaction-update';
import {planContractRevision,rebaseClauseLinks,sealClauseMap,validateClauseLinks,revisionRecord} from '../src/lib/contract-impact';
import {applyContractPatch,contractPatchSchema} from '../src/lib/contract-patch';
import {draftConfirmed,reviseConfirmedDraft,verifyConfirmedDraft} from '../src/server/ai';
import {documentBody,sha256} from '../src/lib/skill-audit';
import {publicPreview} from '../src/lib/agent-stream';
import type {Intake,ContractContent} from '../src/lib/types';
import {contentFixture,intakeFixture} from './fixtures';

const fact=(value:string)=>({value,quote:value});
function mixed():Intake{
 const i:Intake={templateId:'general',assessmentVersion:'transaction-v1',facts:{scope:fact('甲方提供咖啡机给乙方使用，乙方经营门店，丙方受乙方委托收款。'),equipment:fact('甲方向乙方交付咖啡机，所有权仍归甲方。'),operations:fact('设备交付后乙方经营门店，丙方向乙方提供收款服务。'),revenue:fact('丙方收取销售收入，每月向甲方支付三成，向乙方支付七成。'),exchange:fact('按销售收入分成，不另外支付服务费。'),term:fact('合作期限一年。')},participants:[{factId:'partyA',role:'甲方（设备方）',name:''},{factId:'partyB',role:'乙方（经营方）',name:''},{factId:'partyC',role:'丙方（收款方）',name:''}],missing:[],conflicts:[],summaryId:'mixed',confirmedAt:'2026-09-26'};
 i.relations=[relationSchema.parse({id:'equipment_use',from:'partyA',to:['partyB'],action:'交付咖啡机供使用，保留所有权',factIds:['equipment'],quote:i.facts.equipment.quote}),relationSchema.parse({id:'operations',from:'partyB',to:['partyA'],action:'经营门店',factIds:['operations'],quote:i.facts.operations.quote,dependsOn:['equipment_use']}),relationSchema.parse({id:'settlement',from:'partyC',to:['partyA','partyB'],action:'按三成和七成分别结算',factIds:['revenue'],quote:i.facts.revenue.quote,dependsOn:['operations']})];
 return i;
}
async function linked(){
 const i=mixed(),c:ContractContent={title:'三方设备运营合作合同',parties:i.participants!,sections:[{title:'设备',content:i.facts.equipment.value},{title:'经营',content:i.facts.operations.value},{title:'结算',content:i.facts.revenue.value},{title:'保密',content:'各方对获知的商业秘密保密。'}],attachments:[{title:'结算清单',content:i.facts.revenue.value}],signing:'各方签署',missing:[],confirmation:i};
 await sealClauseMap(c,i,[{target:'section',index:0,factIds:['equipment'],relationIds:['equipment_use'],quote:c.sections[0].content},{target:'section',index:1,factIds:['operations'],relationIds:['operations'],quote:c.sections[1].content},{target:'section',index:2,factIds:['revenue'],relationIds:['settlement'],quote:c.sections[2].content},{target:'attachment',index:0,factIds:['revenue'],relationIds:['settlement'],quote:c.attachments![0].content}]);
 return c;
}

test('mixed multi-party obligations preserve separate unnamed actors and do not create extra intake questions',()=>{
 const previous=mixed(),before=structuredClone(previous);
 const result=compileTransactionUpdate(intakeSchema.parse({templateId:'general',facts:[],businessChecks:[],relationUpdates:{upsert:previous.relations}}),previous,['其他不变']).intake!;
 assert.deepEqual(result.relations,previous.relations);assert.deepEqual(result.missing,[]);assert.equal(result.participants?.length,3);assert.deepEqual(previous,before);
 assert.deepEqual(mergeRelations(result,result,undefined,'继续').relations,previous.relations);
});

test('source correction invalidates old dependent interpretations, without asking the user to restate known facts',()=>{
 const previous=mixed(),current=structuredClone(previous);current.facts.equipment=fact('取消设备提供，乙方自备设备。');
 const result=mergeRelations(previous,current,undefined,'乙方自备设备');
 assert.deepEqual(result.relations,[]);assert.deepEqual(result.relationReview,['equipment_use','operations','settlement']);
 const corrected=relationSchema.parse({...previous.relations![2],dependsOn:[],quote:current.facts.revenue.quote});
 const repaired=mergeRelations({...current,...result},current,{upsert:[corrected],remove:[]},'其他不变');
 assert.equal(repaired.relations[0].id,'settlement');assert.ok(!repaired.relationReview.includes('settlement'));
});

test('relationship withdrawal and correction reject fabricated references and update collisions',()=>{
 const i=mixed(),r=i.relations![0];
 for(const invalid of [{...r,from:'partyD'},{...r,factIds:['unknown']},{...r,quote:'用户没有说的话'},{...r,dependsOn:['unknown']},{...r,to:['partyA']}])assert.throws(()=>mergeRelations(i,i,{upsert:[invalid],remove:[]},''));
 assert.throws(()=>mergeRelations(i,i,{upsert:[r,r],remove:[]},''),/重复/);
 assert.throws(()=>mergeRelations(i,i,{upsert:[],remove:[{id:r.id,quote:'撤回设备提供'}]},'其他不变'),/本轮原话/);
 const removed=mergeRelations(i,i,{upsert:[],remove:[{id:r.id,quote:'撤回设备提供'}]},'撤回设备提供');
 assert.deepEqual(removed.relations,[]);assert.ok(!removed.relationReview.includes(r.id));
});

test('role changes invalidate prior obligations even if party names remain blank',()=>{
 const previous=mixed(),current=structuredClone(previous);current.participants![2].role='丙方（仅介绍方）';
 const result=mergeRelations(previous,current,undefined,'');
 assert.equal(result.relations.length,2);assert.deepEqual(result.relationReview,['settlement']);
});

test('a changed settlement identifies its text, appendix and upstream performance while leaving unrelated clauses out',async()=>{
 const c=await linked(),i=structuredClone(c.confirmation!);i.facts.revenue=fact('丙方每月向甲方支付四成，向乙方支付六成。');
 const plan=await planContractRevision(c,i);
 assert.deepEqual(plan.changedFacts,['revenue']);assert.deepEqual(new Set(plan.affectedRelations),new Set(['settlement','operations','equipment_use']));
 assert.deepEqual(plan.candidates.map(c=>c.target+':'+c.index),['section:0','section:1','section:2','attachment:0']);
 assert.equal(plan.reviewAll,false);assert.deepEqual(plan.unmappedFacts,[]);
});

test('old, externally edited, intent-changed and unlinked versions get a whole-document review fallback',async()=>{
 const c=await linked(),i=structuredClone(c.confirmation!);
 const old=structuredClone(c);delete old.clauseMap;assert.equal((await planContractRevision(old,i)).reviewAll,true);
 const external=structuredClone(c);external.sections[0].content+='外部编辑';assert.equal((await planContractRevision(external,i)).candidates.length,0);assert.equal((await planContractRevision(external,i)).reviewAll,true);
 i.intent={goal:{value:'保持经营自主',quote:'保持经营自主'}};assert.equal((await planContractRevision(c,i)).reviewAll,true);
 i.facts.specialTerms=fact('不得独家合作');assert.deepEqual((await planContractRevision(c,i)).unmappedFacts,['specialTerms']);
});

test('two consecutive edits rebase clause links, preserve unrelated text, and plan from the latest confirmed version',async()=>{
 const base=await linked(),i=structuredClone(base.confirmation!);i.facts.revenue=fact('丙方每月向甲方支付四成，向乙方支付六成。');i.relations![2]={...i.relations![2],action:'按四成和六成分别结算',quote:i.facts.revenue.quote};
 const plan=await planContractRevision(base,i),body=i.facts.revenue.value;
 const patch=contractPatchSchema.parse({baseSha256:plan.baseSha256,changes:[{op:'remove',target:'section',index:0,reason:'设备约定合并到经营条款'},{op:'replace',target:'section',index:1,part:{title:'设备与经营',content:base.sections[0].content+base.sections[1].content},reason:'合并'},{op:'replace',target:'section',index:2,part:{title:'结算',content:body},reason:'调整比例'},{op:'replace',target:'attachment',index:0,part:{title:'结算清单',content:body},reason:'同步清单'}],clauseLinks:[{target:'section',index:0,factIds:['equipment','operations'],relationIds:['equipment_use','operations'],quote:base.sections[0].content},{target:'section',index:1,factIds:['revenue'],relationIds:['settlement'],quote:body},{target:'attachment',index:0,factIds:['revenue'],relationIds:['settlement'],quote:body}]});
 const next=applyContractPatch(base,patch,plan.baseSha256);next.confirmation=i;await sealClauseMap(next,i,rebaseClauseLinks(base,i,patch,plan.baseSha256));
 assert.deepEqual(next.sections[2],base.sections[3]);assert.deepEqual(base.confirmation,mixed());
 const record=revisionRecord(plan,patch,base);assert.equal(record.outcomes.find(o=>o.sourceIndex===2)?.resultIndex,1);
 const later=structuredClone(i);later.facts.revenue=fact('丙方每季度结算，比例不变。');
 const again=await planContractRevision(next,later);assert.notEqual(again.baseSha256,plan.baseSha256);assert.ok(again.candidates.some(c=>c.target==='section'&&c.index===1&&c.title==='结算'));assert.ok(!again.candidates.some(c=>c.title==='保密'));
 const noChange=contractPatchSchema.parse({baseSha256:again.baseSha256,changes:[]});
 const inherited=rebaseClauseLinks(next,later,noChange,again.baseSha256);assert.ok(inherited.every(l=>!l.factIds.includes('revenue')));
});

test('untouched clause links shift after deletion and changed parts never retain obsolete mappings',async()=>{
 const c=await linked(),hash=c.clauseMap!.contentSha256,patch=contractPatchSchema.parse({baseSha256:hash,changes:[{op:'remove',target:'section',index:0,reason:'合并'}]});
 const links=rebaseClauseLinks(c,c.confirmation!,patch,hash);
 assert.equal(links.find(l=>l.relationIds.includes('settlement')&&l.target==='section')?.index,1);
 assert.ok(!links.some(l=>l.factIds.includes('equipment')));
 const next=applyContractPatch(c,patch,hash);assert.equal(next.clauseMap,undefined);validateClauseLinks(next,c.confirmation!,links);
 assert.throws(()=>validateClauseLinks(next,c.confirmation!,[{target:'section',index:0,quote:'不存在的句子',factIds:['operations'],relationIds:[]}]),/定位/);
 assert.throws(()=>validateClauseLinks(next,c.confirmation!,[{target:'section',index:0,quote:next.sections[0].content,factIds:['withdrawn'],relationIds:[]}]),/已撤回/);
});

test('relations, clause links and change reasons stay out of public draft streaming',()=>{
 const source=JSON.stringify({result:{title:'合作合同',clauseLinks:[{quote:'PRIVATE',factIds:['PRIVATE']}],relationUpdates:{upsert:[{action:'PRIVATE'}]},changes:[{op:'replace',target:'section',index:0,reason:'PRIVATE',part:{title:'费用',content:'按约支付。'}}]}});
 for(let n=1;n<=source.length;n++)assert.doesNotMatch(publicPreview(source.slice(0,n),'draft'),/PRIVATE/);
});

test('draft, two local edits and verification carry relations, rebased links and actual modification outcomes through real orchestration',async()=>{
 const saved=fetch,i=intakeFixture(),fixture=contentFixture();
 const relation=relationSchema.parse({id:'delivery',from:'partyB',to:['partyA'],action:'交付软件成果',factIds:['deliverables'],quote:i.facts.deliverables.quote});i.relations=[relation];
 let revisions=0,verified=false;
 try{
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body)),names=body.tools.map((t:any)=>t.function.name),input=body.messages.find((m:any)=>m.role==='user').content;
   let result:unknown;
   if(names.includes('submit_contract_draft')){
    assert.match(body.messages[0].content,/"id":"delivery"/);assert.match(input,/\[deliverables\]/);
    result={...fixture,clauseLinks:[{target:'section',index:0,factIds:['deliverables'],relationIds:['delivery'],quote:i.facts.deliverables.quote}]};
   }else if(names.includes('apply_contract_patch')){
    const data=JSON.parse(input);assert.equal(data.transaction.relations[0].id,'delivery');assert.equal(data.clauseLinks[0].index,0);assert.ok(data.impactPlan.baseSha256);revisions++;
    result={baseSha256:data.baseSha256,changes:[{op:'replace',target:'section',index:revisions,part:{...fixture.sections[revisions],content:fixture.sections[revisions].content+'各方依约履行。'},reason:'仅补充行文衔接'}]};
   }else{
    const data=JSON.parse(input);assert.equal(data.transaction.relations[0].id,'delivery');assert.equal(data.revision.changes[0].sourceIndex,2);assert.equal(data.clauseLinks[0].relationIds[0],'delivery');verified=true;result={verdict:'consistent',issues:[],reviewNotes:[]};
   }
   return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
  };
  const env={CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test'};
  const draft=await draftConfirmed(i,env),first=await reviseConfirmedDraft(draft,i,'完善第二条行文',env),second=await reviseConfirmedDraft(first,i,'完善第三条行文',env);
  await verifyConfirmedDraft(second,env);assert.equal(revisions,2);assert.equal(verified,true);assert.deepEqual(second.sections[1],first.sections[1]);assert.deepEqual(second.sections[0],draft.sections[0]);assert.equal(second.clauseMap!.contentSha256,await sha256(documentBody(second)));
 }finally{globalThis.fetch=saved;}
});
