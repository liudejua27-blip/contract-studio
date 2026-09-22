import type {ContractContent} from '../../lib/types';
import {documentBody,sha256,type SkillAudit,type SkillReceipt,type RuleApplication} from '../../lib/skill-audit';
import {readLegalSkill} from './legal-skills';

/** Validate literal evidence, not the model's claim that a skill was used correctly. */
export async function auditApplications(content:ContractContent,receipts:SkillReceipt[],applications:RuleApplication[]):Promise<SkillAudit>{
 const parts=[...content.sections,...content.attachments||[]];
 const located=await Promise.all(applications.map(async application=>{
  const matches=receipts.filter(r=>r.stage==='draft'&&r.path===application.path);
  let receipt:SkillReceipt|undefined;
  for(const r of matches){const read=readLegalSkill(r.path,r.offset);if(await sha256(read.content)===r.sha256&&application.ruleQuote.trim().length>=8&&read.content.includes(application.ruleQuote)){receipt=r;break;}}
  const inBody=application.quote.trim().length>=8&&parts.some(p=>p.title===application.location&&p.content.includes(application.quote));
  return{...application,...(receipt?{receiptId:receipt.id}:{}),status:receipt&&inBody?'located' as const:'unverified' as const,...(!receipt||!inBody?{reason:!receipt?'未在本次载入的参考中找到该规则原文':'未在指定正文或附件中找到该段文字'}:{})};
 }));
 return{version:1,contentSha256:await sha256(documentBody(content)),receipts,applications:located};
}
