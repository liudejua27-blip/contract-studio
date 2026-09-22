import {z} from 'zod';
import type {Intake} from './types';
import {STANDARD_RULE_IDS} from './standard-terms';
import {participantSchema} from './contract-document-schema';
import {participantProblems} from './contract-document';
import {businessCheckProblems,type BusinessCheck} from './business-checks';
import {businessField,transactionCoreFields,transactionCoreKnown,unresolvedTransactionFields,intakeReply,transactionFieldLabel} from './transaction-state';
import {evidenceValue,proposalProblems} from './intake-guidance';
import {PLAYBOOKS} from './contract-library/playbooks';
import {EXTENDED} from './contract-library/extended';
import {GUIDED_POLICY_VERSION,defaultsFor} from './contract-library/guided-policy';
import {draftingPlan} from './contract-library/general';
import {intakeFactIssues} from './contract-library/fact-checks';

const businessCheckSchema=z.object({fieldId:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).max(80),status:z.enum(['answered','missing','deferred','not_applicable','standard']).describe('missing：重要安排尚未说清；deferred：用户明确说这一项商业安排尚未决定，即使重要也不重复追问；answered：实际安排已有答案，不受用户不懂法律措辞影响。'),defaultRule:z.enum(STANDARD_RULE_IDS).optional(),evidence:z.array(z.string().min(1).max(4000)).max(8).default([]),question:z.string().max(100).optional(),reason:z.string().max(500).describe('missing 说明这个缺口为什么影响主要义务；standard 说明为何普通规则足够，不需用户选择。').optional(),label:z.string().max(80).optional()});
const intakeResultSchema=z.object({reply:z.string().max(180).describe('一句日常语言接住本轮新增内容，通常30—80字。不复述完整摘要、不插入问题、不解释法律、不虚报完成。').default(''),businessChecks:z.array(businessCheckSchema).max(30).default([]),participants:z.array(participantSchema).min(2).max(20).optional(),templateId:z.string().trim().max(100).nullable().default(null),ruleFamilies:z.array(z.string().max(80)).max(5).default([]),facts:z.array(z.object({fieldId:z.string().min(1).max(80).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).refine(id=>!['__proto__','constructor','prototype'].includes(id)),value:z.string().trim().min(1).max(2000),quote:z.string().trim().min(1).max(4000),evidence:z.array(z.string().trim().min(1).max(4000)).max(8).optional()})).max(30),clearedFields:z.array(z.string()).max(30).default([]),conflicts:z.array(z.string().max(500)).max(10).default([]),reviewNotes:z.array(z.string().max(500)).max(10).default([]),deferredFields:z.array(z.object({fieldId:z.string(),quote:z.string().min(1).max(4000)})).max(10).default([]),businessProposals:z.array(z.object({fieldId:z.string(),value:z.string().min(1).max(2000)})).max(3).default([]),acceptedProposalIds:z.array(z.string()).max(3).default([])});
// Read old cached/model results once at the boundary; new tools expose only businessChecks.
export const intakeSchema=z.preprocess((input:any)=>{
 if(!input||typeof input!=='object')return input;
 const checks=Array.isArray(input.businessChecks)?[...input.businessChecks]:[];
 for(const gap of [...(Array.isArray(input.materialGaps)?input.materialGaps:[]),...(Array.isArray(input.questions)?input.questions:[])]){
  if(!checks.some(c=>c?.fieldId===gap?.fieldId))checks.push({...gap,status:'missing',evidence:[]});
 }
 for(const d of Array.isArray(input.deferredFields)?input.deferredFields:[])if(!checks.some(c=>c?.fieldId===d?.fieldId))checks.push({fieldId:d.fieldId,status:'deferred',evidence:[d.quote]});
 for(const proposal of Array.isArray(input.businessProposals)?input.businessProposals:[])if(!checks.some(c=>c?.fieldId===proposal?.fieldId))checks.push({fieldId:proposal.fieldId,status:'missing',evidence:[],question:'这个建议符合你的安排吗？'});
 return {...input,businessChecks:checks};
},intakeResultSchema);
export type IntakeUpdate=z.output<typeof intakeSchema>;
export type TransactionResult={intake?:Intake;reply:string};

/** The only writer of an Agent's transaction update. Validate exactly what will be persisted. */
export function compileTransactionUpdate(r:IntakeUpdate,previous:Intake|undefined,userTexts:string[]):TransactionResult{
 // An unknown reference family is not an unknown transaction. Facts still pass the same gates.
 const templateId=r.templateId&&Object.hasOwn(PLAYBOOKS,r.templateId)?r.templateId:'general';
 const p=PLAYBOOKS[templateId];
 const latest=userTexts.at(-1)||'';
 const facts=structuredClone(previous?.facts||{}),errors:string[]=[];
 for(const id of r.clearedFields)delete facts[id];
 for(const f of r.facts){
  const evidence=[...new Set([f.quote,...f.evidence||[]])];
  const invalid=evidence.filter(q=>!userTexts.some(text=>text.includes(q)));
  if(invalid.length){
   const excerpts=invalid.map(q=>{const source=userTexts.findLast(text=>text.includes(q.slice(0,10)))||latest;const start=Math.max(0,source.indexOf(q.slice(0,10))-40);return {attempted:q,actualUserExcerpt:source.slice(start,start+Math.min(1600,q.length+240))};});
   errors.push(f.fieldId+'引用不是用户原话，请逐字复制原文，在内部修复，不能让用户重说：'+JSON.stringify(excerpts));
  }
  facts[f.fieldId]={value:evidenceValue(f),quote:f.quote,evidence,source:'user'};
 }
 const deferred=[...r.deferredFields];
 for(const c of r.businessChecks)if(c.status==='deferred'){
  const quote=c.evidence.find(q=>latest.includes(q));if(quote)deferred.push({fieldId:c.fieldId,quote});
 }
 for(const d of deferred){
  if(!latest.includes(d.quote))errors.push(d.fieldId+'的未定状态必须引用本轮用户原话');
  // An unresolved detail does not retract the known part of the agreement.
  // Retractions use clearedFields; the deferred check still blocks core confirmation.
 }
 const previousProposals=previous?.businessProposals||[];
 for(const id of r.acceptedProposalIds)if(!previousProposals.some(p=>p.id===id))errors.push('不能接受不存在的建议：'+id);
 for(const proposal of previousProposals)if(latest===`采用建议：${proposal.value}`||latest.trim()&&r.acceptedProposalIds.includes(proposal.id)){
  // An explicit current answer wins over the wording of a previously offered suggestion.
  if(r.facts.some(f=>f.fieldId===proposal.fieldId))continue;
  facts[proposal.fieldId]={value:proposal.value,quote:latest,source:'accepted_proposal',proposalId:proposal.id,evidence:[latest,proposal.value]};
 }
 const retainCheck=(c:BusinessCheck)=>businessField(c.fieldId)||c.status==='standard'&&STANDARD_RULE_IDS.some(id=>id===c.fieldId);
 const checks=new Map((previous?.businessChecks||[]).filter(retainCheck).map(c=>[c.fieldId,c]));
 for(const id of previous?.missing||[])if(businessField(id)&&!checks.has(id)&&!facts[id])checks.set(id,{fieldId:id,status:'missing',evidence:[],question:p.fields.find(f=>f.id===id)?.question||'这项生意安排准备怎么处理？'});
 for(const id of r.clearedFields)checks.delete(id);
 for(const c of r.businessChecks)if(retainCheck(c))checks.set(c.fieldId,c);
 for(const [id,f] of Object.entries(facts))if(f.source==='accepted_proposal')checks.set(id,{fieldId:id,status:'answered',evidence:[f.value]});
 const intake:Intake={assessmentVersion:'transaction-v1',templateId,ruleFamilies:r.ruleFamilies.filter(id=>Object.hasOwn(PLAYBOOKS,id)),facts,businessChecks:[...checks.values()],suggestions:{},missing:[],conflicts:[...r.conflicts],summaryId:crypto.randomUUID(),policyVersion:GUIDED_POLICY_VERSION,withdrawnFields:[...new Set([...(previous?.withdrawnFields||[]),...r.clearedFields])].filter(id=>!facts[id]),reviewNotes:[...new Set([...previous?.reviewNotes||[],...r.reviewNotes,...EXTENDED[templateId]?.notes||[]])]};
 const participants=r.participants||previous?.participants?.filter(p=>facts[p.factId]?.value.includes(p.name));
 if(participants?.length){errors.push(...participantProblems(participants,facts));intake.participants=participants;}
 intake.deferredFields=[...new Set([...previous?.deferredFields||[],...deferred.map(d=>d.fieldId)])].filter(id=>businessField(id));
 errors.push(...businessCheckProblems(r.businessChecks.filter(retainCheck),facts,userTexts,previous?.deferredFields),...proposalProblems(r.businessProposals,facts));
 const core=transactionCoreFields(intake);
 for(const c of r.businessChecks)if(c.status==='standard'&&core.includes(c.fieldId))errors.push(c.fieldId+'是交易本身，不能用普通法律条款代替。');
 // Missing assessment is a tool error, never a question automatically invented for the user.
 const unassessed=[...new Set([...core.filter(id=>!transactionCoreKnown(intake,id)&&!checks.has(id)),...(previous?.missing||[]).filter(id=>businessField(id)&&!r.businessChecks.some(c=>c.fieldId===id)&&!r.clearedFields.includes(id)&&facts[id]?.source!=='accepted_proposal')])];
 if(unassessed.length)errors.push('请在内部完成这些事项的判断：'+unassessed.join('、')+'。先查已有事实，例如 delivery 中的日期可以回答 term。已有答案用 answered 引用现有事实，真正缺少才用 missing，普通法律事项用 standard。不要因字段名不同让用户重说。');
 if(errors.length)throw new Error([...new Set(errors)].join('；'));
 intake.deferredFields=intake.deferredFields.filter(id=>!intake.businessChecks?.some(c=>c.fieldId===id&&(c.status==='answered'||c.status==='not_applicable')&&!businessCheckProblems([c],facts,[]).length));
 const notes=intake.deferredFields.map(id=>`尚未确定的生意安排：${transactionFieldLabel(intake,id)}，请与客户沟通。`);
 intake.reviewNotes=[...new Set([...intake.reviewNotes!.filter(n=>!n.startsWith('尚未确定的生意安排：')||notes.includes(n)),...notes,'中国法律Skill提供起草参考；主体登记和现行法规未进行外部核验，请律师复核。'])];
 intake.missing=unresolvedTransactionFields(intake);
 intake.businessProposals=[...r.businessProposals,...previousProposals.filter(old=>!r.businessProposals.some(p=>p.fieldId===old.fieldId))].filter(p=>intake.missing.includes(p.fieldId)&&!['partyA','partyB','price'].includes(p.fieldId)).map(p=>({...p,id:crypto.randomUUID()}));
 intake.draftingPlan=draftingPlan(intake,p.clauses);intake.defaults=defaultsFor(intake);
 const numericIssues=intakeFactIssues(intake);
 if(numericIssues.length&&!r.conflicts.length)throw new Error('请内部复核金额或日期检查：'+numericIssues.join('；')+'。先检查是否把总价也计入分期、或把旧方案和最新更正拼成当前事实。payment 只引用实际期款及节点；更正后的 facts.evidence 只保留当前有效约定，历史已保存在对话。若确为用户给出的数值矛盾，再在 conflicts 中说明具体矛盾并简短询问，不能把抽取错误转嫁给用户。');
 intake.conflicts=[...new Set([...intake.conflicts.filter(n=>n!=='请明确一个合同总价，使用“金额＋元”，费用明细另行说明。'),...numericIssues])];
 return {intake,reply:intakeReply(intake,r.reply)};
}
