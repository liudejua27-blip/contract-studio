import type {Contract,Review,Version} from './types';
import {intakeIsCurrent} from './intake-state';

export const isDocumentReview=(r:Review)=>!!(r.submittedVersionId||r.editingVersionId);
export function latestReview(reviews:Review[],documentsOnly=false):Review|undefined{
 return reviews.filter(r=>!documentsOnly||isDocumentReview(r)).sort((a,b)=>Number(a.status==='completed')-Number(b.status==='completed')||b.submittedAt.localeCompare(a.submittedAt)||b.id.localeCompare(a.id))[0];
}
export function lawyerRevisionRequired(c:Pick<Contract,'versions'>){return c.versions.at(-1)?.source==='lawyer';}
export function reviewVersionProblem(c:Pick<Contract,'workflow'|'versions'>,v:Version|undefined):{code:string;message:string}|undefined{
 if(!v)return {code:'VERSION_REQUIRED',message:'请先生成 Word 合同，再提交律师审核。'};
 const latest=c.versions.at(-1);
 if(v.source==='lawyer'){
  if(v.id!==latest?.id)return {code:'VERSION_NOT_CURRENT',message:'请在最新律师稿上申请修改，避免遗漏律师已修改的内容。'};
  return;
 }
 if(v.kind!=='draft'||!v.content?.confirmation?.confirmedAt)return {code:'VERSION_NOT_SUBMITTABLE',message:'请选择已确认约定并生成的 Word 初稿。'};
 const i=c.workflow?.intake,confirmation=v.content.confirmation;
 if(v.id!==latest?.id||!i?.confirmedAt||!intakeIsCurrent(c as Contract)||confirmation.summaryId!==i.summaryId||(confirmation.inputRevision??0)!==(c.workflow?.inputRevision??0))
  return {code:'VERSION_OUTDATED',message:'这份 Word 尚未包含最新约定。请先核对交易摘要并生成新版，再提交律师审核。'};
}
