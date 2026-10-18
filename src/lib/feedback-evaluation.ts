import {createHash} from 'node:crypto';
import {z} from 'zod';
import {sampleSchema} from './review-learning';
const sample=sampleSchema.extend({id:z.string().uuid(),revision:z.number().int().positive(),category:z.string(),confirmedAt:z.string()});
export const evaluationSetSchema=z.object({version:z.literal(1),createdAt:z.string(),hash:z.string(),cases:z.array(sample).max(10000)});
export type EvaluationSet=z.infer<typeof evaluationSetSchema>;
export const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function evaluationSet(cases:z.infer<typeof sample>[]):EvaluationSet{
 const parsed=z.array(sample).parse(cases);if(new Set(parsed.map(c=>c.id)).size!==parsed.length)throw new Error('样本ID重复');
 // No contract IDs, original quotations, customer names, or source Word contents leave this projection.
 return {version:1,createdAt:new Date().toISOString(),hash:digest(parsed),cases:parsed};
}
export function readEvaluationSet(value:unknown){const set=evaluationSetSchema.parse(value);if(set.hash!==digest(set.cases)||new Set(set.cases.map(c=>c.id)).size!==set.cases.length)throw new Error('评估样本清单校验失败');return set;}
export const outputsSchema=z.object({setHash:z.string(),model:z.string(),configuration:z.object({promptSha256:z.string(),skillSha256:z.string(),thinking:z.string(),effort:z.string()}).optional(),createdAt:z.string(),results:z.array(z.object({id:z.string(),candidate:z.string().max(16000),error:z.string().optional()}))});
export const assessmentsSchema=z.object({setHash:z.string(),outputHash:z.string(),reviewer:z.string().trim().min(1),results:z.array(z.object({id:z.string(),criteria:z.array(z.object({index:z.number().int().min(0),verdict:z.enum(['pass','fail','uncertain']),reason:z.string().trim().min(1).max(2000)}))}))});
export function scoreFeedback(set:EvaluationSet,outputs:z.infer<typeof outputsSchema>,assessments:z.infer<typeof assessmentsSchema>,target=0.95){
 if(!Number.isFinite(target)||target<=0||target>1)throw new Error('评估目标无效');
 if(outputs.setHash!==set.hash||assessments.setHash!==set.hash||assessments.outputHash!==digest(outputs))throw new Error('评审不属于这份样本或这次输出');
 for(const list of [outputs.results,assessments.results])if(new Set(list.map(r=>r.id)).size!==list.length||list.some(r=>!set.cases.some(c=>c.id===r.id)))throw new Error('评估结果包含重复或未知样本');
 const results=set.cases.map(c=>{
  const output=outputs.results.find(r=>r.id===c.id),review=assessments.results.find(r=>r.id===c.id);
  if(review&&(new Set(review.criteria.map(r=>r.index)).size!==review.criteria.length||review.criteria.some(r=>r.index>=c.criteria.length)))throw new Error('评审标准索引重复或越界');
  const verdict=!output||output.error||!output.candidate.trim()?'fail':review?.criteria.some(r=>r.verdict==='fail')?'fail':review?.criteria.length===c.criteria.length&&review.criteria.every(r=>r.verdict==='pass')?'pass':'uncertain';
  return {id:c.id,split:c.split,category:c.category,verdict};
 });
 const group=(items:typeof results)=>{const passed=items.filter(r=>r.verdict==='pass').length,uncertain=items.filter(r=>r.verdict==='uncertain').length;return {total:items.length,passed,failed:items.filter(r=>r.verdict==='fail').length,uncertain,passRate:items.length?passed/items.length:0,target,targetMet:items.length>0&&uncertain===0&&passed>=Math.ceil(items.length*target)};};
 return {setHash:set.hash,outputHash:digest(outputs),reviewer:assessments.reviewer,assessedAt:new Date().toISOString(),scope:'clause-level lawyer-reviewed evaluation; not production end-to-end or legal validity proof',development:group(results.filter(r=>r.split==='development')),holdout:group(results.filter(r=>r.split==='holdout')),results};
}
