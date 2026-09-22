import type {Intake} from './types';
import {businessCheckProblems} from './business-checks';
import {requiredFields} from './contract-library/intake-policy';
import {hasTransactionFact,GENERAL_CORE,GENERAL_FIELDS} from './contract-library/general';
import {PLAYBOOKS} from './contract-library/playbooks';
import {PLAIN_QUESTIONS} from './contract-library/guided-policy';

export const businessField=(id:string)=>/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(id)&&!/^party[A-T]_(?:address|email|phone|contactName|registrationId|legalRepresentative|authorizedRepresentative|signature(?:Method)?|signing)$/.test(id)&&!['__proto__','constructor','prototype','disputes','breach','ip','tax','invoice','rights'].includes(id);

/** Templates are retrieval hints. Legacy frozen records keep their original gate. */
export function transactionCoreFields(i:Intake){
 if(i.assessmentVersion!=='transaction-v1')return requiredFields(i.templateId).map(f=>f.id);
 const represented=(id:string)=>!!i.facts[id]||!!i.businessChecks?.some(c=>c.fieldId===id);
 // A semantic item may be represented together or separately, independent of contract family.
 return GENERAL_CORE.flatMap(id=>id==='scope'&&!represented('scope')&&represented('goods')?['goods']
  :id==='exchange'&&!represented('exchange')&&!represented('revenue')&&(represented('price')||represented('payment'))?['price','payment']:[id]);
}
export function transactionCoreKnown(i:Intake,id:string){
 const known=(key:string)=>{
  const check=i.businessChecks?.find(c=>c.fieldId===key);
  if(check)return (check.status==='answered'||check.status==='not_applicable')&&!businessCheckProblems([check],i.facts,[]).length;
  return hasTransactionFact(i.facts,key);
 };
 if(known(id))return true;
 if(i.assessmentVersion!=='transaction-v1')return false;
 return id==='scope'?known('goods'):id==='exchange'?known('price')&&known('payment'):false;
}

/** One projection for interview, confirmation and export; no keyword-based second interview. */
export function unresolvedTransactionFields(i:Intake):string[]{
 const checks=new Map((i.businessChecks||[]).filter(c=>businessField(c.fieldId)).map(c=>[c.fieldId,c]));
 const core=transactionCoreFields(i);
 return [...new Set([...checks.keys(),...core])].filter(id=>{
  const check=checks.get(id);
  const resolved=check&&(check.status==='answered'||check.status==='not_applicable'||check.status==='standard')&&!businessCheckProblems([check],i.facts,[]).length&&!(check.status==='standard'&&(i.deferredFields?.includes(id)||i.withdrawnFields?.includes(id)||core.includes(id)&&!['acceptance','breach','invoice','tax','disputes','warranty'].includes(id)));
  if(resolved)return false;
  if(check&&(check.status==='answered'||check.status==='not_applicable'||check.status==='standard'))return true;
  // Core unknown facts can be handed to a lawyer, but cannot silently become a complete draft.
  if(i.deferredFields?.includes(id))return core.includes(id)&&!transactionCoreKnown(i,id);
  if(check?.status==='missing')return true;
  return core.includes(id)&&!transactionCoreKnown(i,id)&&!i.suggestions?.[id];
 });
}

export function transactionFieldLabel(i:Intake,id:string){return i.businessChecks?.find(c=>c.fieldId===id)?.label||PLAYBOOKS[i.templateId]?.fields.find(f=>f.id===id)?.label||GENERAL_FIELDS.find(f=>f.id===id)?.label||(/^party[C-T]$/.test(id)?'其他参与方':'其他交易安排');}

export function transactionQuestions(i:Intake){
 return unresolvedTransactionFields(i).filter(id=>!i.deferredFields?.includes(id)&&!i.businessProposals?.some(p=>p.fieldId===id)).slice(0,3).map(fieldId=>({
  fieldId,
  question:i.businessChecks?.find(c=>c.fieldId===fieldId&&c.status==='missing')?.question
   ||(fieldId==='partyA'?'第一方是谁，在这次交易中负责什么？':fieldId==='partyB'?'另一方是谁，在这次交易中负责什么？':PLAIN_QUESTIONS[fieldId])
   ||GENERAL_FIELDS.find(f=>f.id===fieldId)?.question||PLAYBOOKS[i.templateId]?.fields.find(f=>f.id===fieldId)?.question||'这项尚未明确的生意安排，你准备怎么处理？',
 }));
}

export function intakeReply(i:Intake,acknowledgement:string){
 if(i.conflicts.length)return [i.conflicts.length===1?'有一处需要确认：':'有几处需要确认：',...i.conflicts.slice(0,3)].join('\n');
 const questions=transactionQuestions(i);
 const parts=[acknowledgement.trim()];
 if(questions.length)parts.push(questions.map(q=>q.question).join('\n'));
 if(i.businessProposals?.length)parts.push('下面是供你选择的安排，采用后才会写入交易记录。');
 if(i.deferredFields?.length){
  const labels=i.deferredFields.map(id=>transactionFieldLabel(i,id));
  parts.push(labels.join('、')+'尚未约定，已保留给后续沟通，不用重复回答。');
 }
 if(!i.missing.length)parts.push('请核对交易摘要，确认后我来起草。');
 else if(!questions.length&&!i.businessProposals?.length)parts.push('可以请律师协助把未定事项谈清楚，确认后再生成合同。');
 return parts.filter(Boolean).join('\n');
}
