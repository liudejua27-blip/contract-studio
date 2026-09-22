import type {Intake} from './types';
import {STANDARD_RULE_IDS,type StandardRuleId} from './standard-terms';

/** Model owns semantic status; code checks retained evidence and structural invariants. */
export interface BusinessCheck {
 fieldId:string;
 status:'answered'|'missing'|'deferred'|'not_applicable'|'standard';
 defaultRule?:StandardRuleId;
 evidence:string[];
 question?:string;
 reason?:string;
 label?:string;
}
export const unresolvedBusiness=/不知道|不确定|尚未确定|未确定|没想好|没谈好|还没商量|尚未约定|还没定|未定|没有决定|尚未决定|再商量/;
const factSupports=(facts:Intake['facts'],quote:string)=>Object.values(facts).some(f=>[f.value,f.quote,...f.evidence||[]].some(text=>text.includes(quote)));
export function businessCheckProblems(checks:BusinessCheck[],facts:Intake['facts'],userTexts:string[],deferred:string[]=[]){
 const problems:string[]=[];
 if(new Set(checks.map(c=>c.fieldId)).size!==checks.length)problems.push('同一个生意事项只能有一个当前状态');
 for(const c of checks){
  if(c.status==='standard'&&(!c.defaultRule||!STANDARD_RULE_IDS.includes(c.defaultRule)||!c.reason?.trim()||/^(party[A-T]|scope|goods|exchange|price|payment|term|deliverables|delivery|collection|settlement|revenueAdjustments|materials|sourceDelivery|installation|maintenance|usage)$/.test(c.fieldId)))problems.push(`${c.fieldId}不能用普通法律条款代替主体、价款、履行、权利或费用分担等真实生意决定；standard 需要 defaultRule 和适用原因`);
  if(c.status==='answered'){
   if(!c.evidence.length)problems.push(`${c.fieldId}的已回答判断缺少事实证据`);
   const absent=c.evidence.filter(q=>!factSupports(facts,q));
   if(absent.length)problems.push(`${c.fieldId}的证据未保存在 facts 中：${JSON.stringify(absent)}。内部修复：若这些片段来自用户原话，把它们逐条加入对应 facts.evidence；否则引用已保存事实的原文片段。跨两个独立片段的证据应分成两条，不得让用户重说。`);
  }
  if(c.status==='missing'&&!c.question?.trim())problems.push(`${c.fieldId}缺少一个针对剩余缺口的日常语言问题`);
  if(c.status==='not_applicable'&&(!c.reason?.trim()||!c.evidence.length||c.evidence.some(q=>!factSupports(facts,q))||/^(party[A-T]|scope|goods|exchange)$/.test(c.fieldId)))problems.push(`${c.fieldId}不适用必须有实际交易依据和原因，主体及交易内容不能跳过`);
  if(c.status==='deferred'&&!deferred.includes(c.fieldId)&&(!c.evidence.length||!c.evidence.some(q=>userTexts.at(-1)?.includes(q))))problems.push(`${c.fieldId}暂未决定必须来自用户明确表达，不能由Agent自行跳过`);
 }
 return problems;
}
