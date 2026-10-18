import {z} from 'zod';
import type {ContractContent} from './types';
import {partText} from './contract-document';
import {documentBody,sha256} from './skill-audit';
import {legalCitationsSchema} from './legal-research';

const goalAssessmentSchema=z.object({
 status:z.enum(['addressed','partial','unaddressed','needs_lawyer']),
 explanation:z.string().trim().min(1).max(1200),
 clauses:z.array(z.object({target:z.enum(['section','attachment']),index:z.number().int().min(0),quote:z.string().trim().min(1).max(1200)})).max(12).default([]),
});
export const verificationSchema=z.object({
 legalCitations:legalCitationsSchema,
 verdict:z.enum(['consistent','inconsistent','uncertain']),
 issues:z.array(z.string().trim().min(1).max(1000)).max(20),
 reviewNotes:z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
 uncertainty:z.object({kind:z.enum(['fact','professional']),reason:z.string().trim().min(1).max(1000),question:z.string().trim().min(1).max(300).optional()}).optional(),
 goalAssessment:goalAssessmentSchema.optional(),
});
export type VerificationResult=z.infer<typeof verificationSchema>;
export type AgentOutcome={
 version:1;contentSha256:string;checkedAt:string;consistency:'consistent'|'needs_lawyer';reviewNotes:string[];
 goal?:z.infer<typeof goalAssessmentSchema>&{value:string};
};
export const GOAL_STATUS_LABELS:Record<NonNullable<AgentOutcome['goal']>['status'],string>={addressed:'已有条款回应',partial:'部分落实',unaddressed:'尚未落实',needs_lawyer:'需要律师判断'};

/** Validate evidence against the actual exported body; never use a model-supplied goal as fact. */
export function validateVerification(result:VerificationResult,content:ContractContent){
 if(result.verdict==='consistent'&&(result.issues.length||result.uncertainty))throw new Error('通过的核验不能同时报告事实冲突或不确定性。');
 if(result.verdict==='inconsistent'&&!result.issues.length)throw new Error('事实冲突须列出具体差异和对应文字。');
 if(result.verdict==='uncertain'&&result.uncertainty?.kind==='professional'&&result.issues.length)throw new Error('专业判断不能掩盖已报告的事实差异，请将专业事项放 reviewNotes 并单独报告事实结论。');
 const goal=result.goalAssessment;
 if(!goal)return;
 if(!content.confirmation?.intent?.goal?.value)throw new Error('当前用户未提供核心诉求，不能虚构诉求落实结论。');
 if(goal.status==='addressed'&&!goal.clauses.length)throw new Error('宣称已有条款回应诉求时，须引用本版条款。');
 for(const link of goal.clauses){
  const part=(link.target==='section'?content.sections:content.attachments||[])[link.index];
  if(!part||!partText(part).includes(link.quote))throw new Error('诉求落实引用无法在本版正文或附件定位，请核对最终索引和原文。');
 }
}

export async function recordAgentOutcome(content:ContractContent,result:VerificationResult){
 const value=content.confirmation?.intent?.goal?.value;
 const reviewNotes=[...new Set([...result.reviewNotes,...(result.uncertainty?[result.uncertainty.reason]:[])])];
 content.agentOutcome={version:1,contentSha256:await sha256(documentBody(content)),checkedAt:new Date().toISOString(),
  consistency:result.verdict==='consistent'?'consistent':'needs_lawyer',reviewNotes,
  ...(value?{goal:{value,...(result.goalAssessment||{status:'needs_lawyer' as const,explanation:'本轮未形成有依据的诉求落实结论，请由负责律师结合本版合同核对。',clauses:[]})}}:{}),
 };
}

/** Also used in the completion message, so the result remains visible without another UI step. */
export function completionReply(content:ContractContent){
 const outcome=content.agentOutcome,goal=outcome?.goal;
 const notes=outcome?.reviewNotes||[];
 return ['合同 Word 初稿已生成，可以下载或提交律师完善。',
  ...(goal?[`关于你的核心诉求“${goal.value}”：${GOAL_STATUS_LABELS[goal.status]}。${goal.explanation}`]:[]),
  ...(notes.length?['需律师核对：'+notes.slice(0,3).join('；')+(notes.length>3?'。其余事项见本版起草说明。':'')]:[]),
 ].join('\n\n');
}
