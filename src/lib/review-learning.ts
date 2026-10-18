import {partText} from './contract-document';
import {z} from 'zod';
import type {Intake,ContractContent} from './types';
export const feedbackCategories={factual:'事实错误',missing:'条款遗漏',risk:'风险处理',style:'表达偏好',negotiated:'本次协商安排'} as const;
const text=(max:number)=>z.string().trim().min(1).max(max);
export const preferenceSchema=z.object({title:text(100),guidance:text(1200),templateId:text(80),stance:z.string().trim().max(100),when:text(600),unless:text(600)});
export const sampleSchema=z.object({scenario:text(4000),expected:text(2000),criteria:z.array(text(400)).min(1).max(8),split:z.enum(['development','holdout']),deidentified:z.literal(true)});
export const feedbackSchema=z.object({requestId:z.string().uuid(),beforeVersionId:text(80),afterVersionId:text(80),beforeQuote:z.string().trim().max(2000),afterQuote:z.string().trim().max(2000),category:z.enum(['factual','missing','risk','style','negotiated']),reason:text(2000),preference:preferenceSchema.optional(),sample:sampleSchema.optional()}).superRefine((v,c)=>{
 if(!v.beforeQuote&&!v.afterQuote)c.addIssue({code:'custom',message:'请至少选择一段修改前或修改后的原文。'});
 if(!v.preference&&!v.sample)c.addIssue({code:'custom',message:'请选择沉淀条款偏好或评估样本。'});
 if(v.category==='negotiated'&&v.preference)c.addIssue({code:'custom',message:'本次协商安排不能自动推广为后续合同偏好；可仅记录评估样本。'});
});
export type FeedbackPayload=z.infer<typeof feedbackSchema>;
export type LearningState='none'|'pending'|'active'|'rejected'|'revoked';
export type LearningRecord={id:string;contractId:string;contractTitle:string;reviewId:string;ownerId:string;authorId:string;authorName:string;payload:FeedbackPayload;beforeSha256:string;afterSha256:string;preferenceState:LearningState;sampleState:LearningState;revision:number;createdAt:string;challenged:boolean;decisions:{kind:string;action:string;actorId:string;at:string;note:string}[]};
export type ClausePreference=z.infer<typeof preferenceSchema>&{id:string;revision:number;confirmedAt:string};
export const preferenceUsesSchema=z.array(z.object({id:text(80),decision:z.enum(['applied','skipped']),reason:text(600),quote:z.string().max(2000).optional()})).max(12).optional();
export type PreferenceUse=NonNullable<z.infer<typeof preferenceUsesSchema>>[number];
export type PreferenceAudit={candidates:ClausePreference[];uses:PreferenceUse[]};
export function matchingPreferences(preferences:ClausePreference[],intake?:Intake){
 if(!intake)return [];
 const families=new Set([intake.templateId,...intake.ruleFamilies||[]]);
 return preferences.filter(p=>families.has(p.templateId)&&(!p.stance||p.stance===intake.intent?.stance?.value)).slice(0,12);
}
export function auditPreferences(content:ContractContent,candidates:ClausePreference[],uses:PreferenceUse[]=[]):PreferenceAudit{
 const seen=new Set<string>(),body=[...content.sections,...content.attachments||[]].map(partText).join('\n');
 for(const use of uses){if(seen.has(use.id)||!candidates.some(p=>p.id===use.id))throw new Error('条款偏好来源不存在或重复，请重新核对');seen.add(use.id);if(use.decision==='applied'&&(!use.quote?.trim()||!body.includes(use.quote)))throw new Error('已采用的偏好必须引用当前合同中的实际文字');}
 return {candidates:structuredClone(candidates),uses:structuredClone(uses)};
}
export function validateSourceQuotes(payload:FeedbackPayload,before:string,after:string){
 if(payload.beforeQuote&&!before.includes(payload.beforeQuote)||payload.afterQuote&&!after.includes(payload.afterQuote))throw new Error('反馈原文必须能在所选版本中逐字定位');
 if(!payload.beforeQuote&&before.includes(payload.afterQuote)||!payload.afterQuote&&after.includes(payload.beforeQuote))throw new Error('新增或删除的片段在另一版本中仍存在，请选择实际变化');
 if(payload.beforeQuote===payload.afterQuote)throw new Error('所选原文没有变化，请选择实际修改的部分');
}
/** Heuristic screening supplements, but does not replace, explicit lawyer/admin anonymization review. */
export function assertDeidentified(sample:z.infer<typeof sampleSchema>,names:string[]=[]){
 const value=[sample.scenario,sample.expected,...sample.criteria].join('\n');
 if(/https?:\/\/|[\w.+-]+@[\w.-]+|\d{7,}|有限公司|统一社会信用代码|身份证号|银行账号/.test(value)||names.filter(n=>n.trim().length>=2).some(n=>value.includes(n.trim())))throw new Error('评估场景仍含可识别信息，请用虚构角色与情境重写后再提交');
}
