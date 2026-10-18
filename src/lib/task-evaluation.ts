import {z} from 'zod';
import {digest} from './feedback-evaluation';
export const taskCaseSchema=z.object({
 id:z.string().regex(/^[a-z0-9_-]+$/),split:z.enum(['development','holdout']),description:z.string().min(1),
 messages:z.array(z.string().min(1)).min(1),question:z.string().optional(),revision:z.string().optional(),
 criteria:z.array(z.string().min(1)).min(1),
 materials:z.array(z.object({id:z.string().uuid(),name:z.string(),sha256:z.string().regex(/^[a-f0-9]{64}$/),purpose:z.enum(['transaction','reference']),status:z.enum(['ready','partial','needs_ocr']),warnings:z.array(z.string()),size:z.number(),createdAt:z.string(),chunkCount:z.number(),chunks:z.array(z.object({id:z.string(),location:z.string(),text:z.string()}))})).optional(),
});
export type TaskCase=z.infer<typeof taskCaseSchema>;
export const taskRunSchema=z.object({version:z.literal(1),mode:z.enum(['replay','live']),caseHash:z.string(),configurationHash:z.string(),createdAt:z.string(),
 results:z.array(z.object({id:z.string(),status:z.enum(['completed','failed']),error:z.string().optional(),durationMs:z.number(),modelCalls:z.number(),
  contract:z.unknown(),artifactHash:z.string(),automatic:z.array(z.object({name:z.string(),passed:z.boolean()})),
 }))});
export type TaskRun=z.infer<typeof taskRunSchema>;
export const taskReviewSchema=z.object({runHash:z.string(),reviewer:z.string().trim().min(1),results:z.array(z.object({id:z.string(),criteria:z.array(z.object({index:z.number().int().min(0),verdict:z.enum(['pass','fail','uncertain']),reason:z.string().trim().min(1)}))}))});
export function scoreTaskRun(cases:TaskCase[],run:TaskRun,review:z.infer<typeof taskReviewSchema>,target=.95){
 if(!(target>0&&target<=1))throw new Error('目标通过率无效');
 if(run.caseHash!==digest(cases)||review.runHash!==digest(run))throw new Error('评审不对应本次任务及输出');
 for(const list of [cases,run.results,review.results])if(new Set(list.map(x=>x.id)).size!==list.length)throw new Error('重复样本');
 if([...run.results,...review.results].some(x=>!cases.some(c=>c.id===x.id)))throw new Error('未知样本');
 for(const r of run.results)if(digest(r.contract)!==r.artifactHash)throw new Error('任务输出已改变');
 const results=cases.map(c=>{
  const r=run.results.find(x=>x.id===c.id),assessment=review.results.find(x=>x.id===c.id);
  if(assessment&&(new Set(assessment.criteria.map(x=>x.index)).size!==assessment.criteria.length||assessment.criteria.some(x=>x.index>=c.criteria.length)))throw new Error('评审标准索引重复或越界');
  const verdict=!r||r.status==='failed'||r.automatic.some(x=>!x.passed)||assessment?.criteria.some(x=>x.verdict==='fail')?'fail':assessment?.criteria.length===c.criteria.length&&assessment.criteria.every(x=>x.verdict==='pass')?'pass':'uncertain';
  return {id:c.id,split:c.split,verdict};
 });
 const summarize=(split:'development'|'holdout')=>{const items=results.filter(x=>x.split===split),passed=items.filter(x=>x.verdict==='pass').length;return {total:items.length,passed,uncertain:items.filter(x=>x.verdict==='uncertain').length,passRate:items.length?passed/items.length:0,target,targetMet:run.mode==='live'&&items.length>0&&passed>=Math.ceil(target*items.length)};};
 return {mode:run.mode,scope:run.mode==='live'?'真实模型完整起草任务与人工评审；不代表律师审定或线上容量':'本地模型替身流程回放；不计入真实质量通过率',development:summarize('development'),holdout:summarize('holdout'),results};
}
