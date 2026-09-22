import type {Intake} from '../src/lib/types';
import {proposalProblems} from '../src/lib/intake-guidance';
/** Checks observable interview outcomes; this is not a legal quality score. */
export function scoreIntake(c:any,intake:Intake|undefined){
 const errors:string[]=[];if(!intake)return ['没有交易记录'];
 const equivalent=(id:string,field:string)=>{
  if(id===field)return true;
  const concept=field==='revenueAdjustments'?/退款/:field==='maintenance'?/运维|维护/:field==='materials'?/材料/:undefined;
  return !!concept&&!!intake.businessChecks?.some(check=>check.fieldId===id&&concept.test((check.label||'')+(check.question||'')));
 };
 for(const id of c.noMissing||[])if(intake.missing.some(field=>equivalent(field,id)))errors.push('重复或无关追问：'+id);
 for(const pattern of c.noQuestionPatterns||[])if(intake.businessChecks?.some(check=>check.status==='missing'&&new RegExp(pattern).test(check.question||'')))errors.push('不必要的追问：'+pattern);
 if(c.missing&&!intake.missing.some(id=>equivalent(id,c.missing)))errors.push('遗漏实质问题：'+c.missing);
 if(c.deferred&&!intake.deferredFields?.some(id=>equivalent(id,c.deferred)))errors.push('未保留待沟通事项：'+c.deferred);
 if(c.proposal&&!intake.businessProposals?.some(p=>p.fieldId===c.proposal))errors.push('未提出建议：'+c.proposal);
 if(c.parties&&intake.participants?.length!==c.parties)errors.push('参与方遗漏');
 if(c.individual&&!intake.participants?.some(p=>p.subjectType==='individual'))errors.push('自然人身份遗漏');
 if(c.conflict&&!intake.conflicts.length)errors.push('未识别金额矛盾');
 if(!c.conflict&&intake.conflicts.length)errors.push('意外阻断：'+intake.conflicts.join('；'));
 if(c.ready&&(intake.missing.length||intake.conflicts.length))errors.push('完整交易仍无法起草：'+intake.missing.join('、'));
 if(c.conflictIncludes&&!intake.conflicts.some(text=>text.includes(c.conflictIncludes)))errors.push('未说明具体矛盾：'+c.conflictIncludes);
 errors.push(...proposalProblems(intake.businessProposals||[],intake.facts));
 if(c.absent&&intake.facts[c.absent])errors.push('撤回事实残留：'+c.absent);
 if(c.contains&&!Object.values(intake.facts).some(f=>f.value.includes(c.contains)))errors.push('关键事实遗漏：'+c.contains);
 return errors;
}
