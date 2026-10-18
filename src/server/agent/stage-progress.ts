import {z,type ZodTypeAny} from 'zod';

/** Private work-in-progress, never a confirmed transaction or a published document. */
export type StageProgress={value:Record<string,unknown>;feedback?:string;outputTokens?:number};
function objectSchema(schema:ZodTypeAny):z.AnyZodObject {
 if(schema instanceof z.ZodEffects)return objectSchema(schema.innerType());
 if(schema instanceof z.ZodUnion)return objectSchema(schema.options.find((s:ZodTypeAny)=>s instanceof z.ZodEffects)||schema.options[0]);
 if(schema instanceof z.ZodObject)return schema;
 throw new Error('Incremental stages require an object result');
}
export function stageArguments(schema:ZodTypeAny){
 const shape=objectSchema(schema).shape;
 // Make only top-level fields optional: every supplied item still has its real schema.
 const fields:Record<string,ZodTypeAny>={};
 for(const [key,value] of Object.entries(shape))fields[key]=(value as ZodTypeAny).optional();

 const partial=schema instanceof z.ZodUnion?z.object(fields).passthrough():z.object(fields);
 const result=schema instanceof z.ZodUnion?z.union([schema.options[0],partial]):partial;
 const offsets=Object.fromEntries(['sections','attachments'].filter(key=>key in shape).map(key=>[key,z.number().int().min(0).optional()]));
 return z.object({result,complete:z.boolean().optional(),...(Object.keys(offsets).length?{offsets:z.object(offsets).strict().optional()}: {})}).strict();
}
const keyed:Record<string,string>={facts:'fieldId',businessChecks:'fieldId',participants:'factId',upsert:'id',remove:'id',resolvedMaterialConflicts:'topic',materialConflicts:'topic'};
function merge(old:unknown,next:unknown,key:string):unknown{
 if(Array.isArray(next)){
  const id=keyed[key];
  if(!id||!next.length)return structuredClone(next);
  const entries=new Map((Array.isArray(old)?old:[]).map(v=>[v[id],v]));
  for(const v of next)entries.set(v[id],structuredClone(v));
  return [...entries.values()];
 }
 if(next&&typeof next==='object'){
  const result:Record<string,unknown>={...(old&&typeof old==='object'&&!Array.isArray(old)?old:{})};
  for(const [k,v] of Object.entries(next)){
   if(['__proto__','constructor','prototype'].includes(k))throw new Error('Invalid progress key');
   result[k]=merge(result[k],v,k);
  }
  return result;
 }
 return next;
}
export function mergeStageProgress(old:Record<string,unknown>,patch:Record<string,unknown>,offsets?:{sections?:number;attachments?:number}){
 // A read-only answer may not inherit any pending mutation.
 if(patch.action==='answer')return structuredClone(patch);
 const result=merge(old,patch,'') as Record<string,unknown>;
 for(const key of ['sections','attachments'] as const){
  const offset=offsets?.[key];
  if(offset===undefined){
   if(Array.isArray(old[key])&&Array.isArray(patch[key])&&(patch[key] as unknown[]).length>0&&(patch[key] as unknown[]).length<(old[key] as unknown[]).length)throw new Error(key+' 已暂存 '+(old[key] as unknown[]).length+' 项。局部修正须用 offsets.'+key+' 指定0起始位置，或提供保留全部内容的数组，避免丢掉其他已写条款。');
   continue;
  }
  if(!Array.isArray(patch[key]))throw new Error(key+' offset requires items');
  const parts=structuredClone(Array.isArray(old[key])?old[key]:[]) as unknown[];
  if(offset>parts.length)throw new Error(key+' cannot skip positions');
  parts.splice(offset,(patch[key] as unknown[]).length,...patch[key] as unknown[]);result[key]=parts;
 }
 return result;
}
export function stageProgressSummary(value:Record<string,unknown>){
 return Object.fromEntries(Object.entries(value).map(([key,v])=>[key,Array.isArray(v)?{count:v.length,...(keyed[key]?{ids:v.map(item=>item[keyed[key]])}:{})}:typeof v==='object'&&v?Object.keys(v):'saved']));
}
export function incrementalInstructions(toolName:string){
 const common='结果工具支持分段暂存：complete=false 时只提交本次新增或修正的 result 字段；complete=true（默认）合并暂存后整体校验。已有字段不用重写，result={} 可提交已暂存结果。暂存不是事实确认或文件生成；校验失败只修正有问题的字段。';
 const details:Record<string,string>={
  update_contract_spec:'facts/businessChecks/participants 按 fieldId/fieldId/factId 合并；relationUpdates 的 upsert/remove 按 id 合并；同 ID 覆盖，空数组清空本阶段该集合。其他数组整体替换。复杂交易先暂存事实与主体，再补事项判断与关系。businessChecks 可用 evidenceFactIds 引用已有事实，避免重复原话。',
  submit_contract_draft:'正文 sections 和附件 attachments 可用 offsets 指定从0起始的位置分段写入；不指定则整体替换，必须保留其他已写内容。长合同可分批暂存条款，最后提交。',
  apply_contract_patch:'header 可增量补充；changes 只列原稿需改位置，数组整体替换，因此后续暂存 changes 时保留本阶段已经规划的其他修改。',
  submit_consistency_check:'只提交核验字段，不提交合同正文。issues、reviewNotes、goalAssessment.clauses 等数组整体替换。',
 };
 return common+(details[toolName]||'数组整体替换，省略的字段保留。');
}
