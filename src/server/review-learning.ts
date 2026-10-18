import {createHash} from 'node:crypto';
import {z} from 'zod';
import {query,withTransaction,AppError} from './db';
import {storage,extractDocxText} from './documents';
import {feedbackSchema,validateSourceQuotes,assertDeidentified,matchingPreferences,type LearningRecord,type ClausePreference} from '../lib/review-learning';
import type {User,Intake} from '../lib/types';
import {PLAYBOOKS} from '../lib/contract-library/playbooks';
import {auditAccess} from './access-audit';
const scope=`(c.owner_id=$1 OR $2='admin' OR ($2='lawyer' AND r.lawyer_id=$1))`;
const selection=`SELECT l.*,c.owner_id,c.title AS contract_title,u.name AS author_name,r.client_response FROM review_learning l JOIN contracts c ON c.id=l.contract_id JOIN reviews r ON r.id=l.review_id JOIN users u ON u.id=l.author_id`;
const map=(r:any):LearningRecord=>({id:r.id,contractId:r.contract_id,contractTitle:r.contract_title,reviewId:r.review_id,ownerId:r.owner_id,authorId:r.author_id,authorName:r.author_name,payload:r.payload,beforeSha256:r.before_sha256,afterSha256:r.after_sha256,preferenceState:r.preference_state,sampleState:r.sample_state,revision:r.revision,createdAt:new Date(r.created_at).toISOString(),challenged:r.client_response==='changes_requested',decisions:r.decisions});
export async function listLearning(actor:User,contractId?:string,reviewId?:string,offset=0){
 const result=await query(`${selection} WHERE ${scope} AND ($3::text IS NULL OR c.id=$3) AND ($4::text IS NULL OR r.id=$4) ORDER BY l.created_at DESC,l.id DESC LIMIT 51 OFFSET $5`,[actor.id,actor.role,contractId??null,reviewId??null,Math.max(0,Math.min(100000,offset))]);
 return {items:result.rows.slice(0,50).map(map),hasMore:result.rows.length>50};
}
export async function createLearning(actor:User,contractId:string,reviewId:string,input:unknown){
 if(actor.role!=='lawyer')throw new AppError(403,'仅本轮审核律师可以整理反馈。','FORBIDDEN');
 const payload=feedbackSchema.parse(input);
 if(payload.preference&&!Object.hasOwn(PLAYBOOKS,payload.preference.templateId))throw new AppError(400,'请选择现有合同类型。','INVALID_SCOPE');
 await withTransaction(async db=>{
  await db.query('SELECT id FROM contracts WHERE id=$1 FOR UPDATE',[contractId]);
  const r=(await db.query(`SELECT r.*,c.owner_id FROM reviews r JOIN contracts c ON c.id=r.contract_id WHERE r.id=$1 AND c.id=$2 FOR UPDATE OF r`,[reviewId,contractId])).rows[0];
  if(!r||r.lawyer_id!==actor.id)throw new AppError(404,'审核记录不存在。','NOT_FOUND');
  if(r.status!=='completed'||r.client_response==='changes_requested')throw new AppError(409,'请以未被要求继续修改的已交付版本整理反馈。','LEARNING_SOURCE_UNSETTLED');
  const old=(await db.query('SELECT * FROM review_learning WHERE id=$1',[payload.requestId])).rows[0];
  if(old){if(old.review_id!==reviewId||JSON.stringify(sort(old.payload))!==JSON.stringify(sort(payload)))throw new AppError(409,'重试内容已变化，请重新提交。','CONFLICT');return;}
  if(payload.beforeVersionId!==r.submitted_version_id||payload.afterVersionId!==r.final_version_id)throw new AppError(409,'请使用本轮送审版与最终交付版。','LEARNING_SOURCE_MISMATCH');
  const rows=(await db.query('SELECT * FROM versions WHERE contract_id=$1 AND id=ANY($2::text[])',[contractId,[payload.beforeVersionId,payload.afterVersionId]])).rows;
  const before=rows.find(v=>v.id===payload.beforeVersionId),after=rows.find(v=>v.id===payload.afterVersionId);
  if(!before||!after)throw new AppError(409,'来源版本缺失。','LEARNING_SOURCE_MISMATCH');
  const read=async(v:any)=>{const bytes=await storage.get(v.file_key);if(!bytes||!v.sha256||createHash('sha256').update(bytes).digest('hex')!==v.sha256)throw new AppError(409,'来源文件校验失败，请核对原件。','LEARNING_SOURCE_MISMATCH');return extractDocxText(Buffer.from(bytes));};
  const [beforeText,afterText]=await Promise.all([read(before),read(after)]);
  try{validateSourceQuotes(payload,beforeText,afterText);if(payload.sample)assertDeidentified(payload.sample,(before.content?.parties||[]).map((p:any)=>p.name));}catch(e){throw new AppError(400,(e as Error).message,'INVALID_EVIDENCE');}
  if(payload.sample){
   await db.query("SELECT pg_advisory_xact_lock(hashtext('contract-learning-sample'))");
   const conflicts=await db.query(`SELECT 1 FROM review_learning WHERE payload ? 'sample' AND ((review_id=$1 AND payload->'sample'->>'split'<>$2) OR regexp_replace(payload->'sample'->>'scenario','[[:space:]]','','g')=regexp_replace($3,'[[:space:]]','','g')) LIMIT 1`,[reviewId,payload.sample.split,payload.sample.scenario]);
   if(conflicts.rowCount)throw new AppError(409,'相同场景不能重复计样本，同一审核来源不能跨开发与留出集。','SAMPLE_DUPLICATE_OR_SPLIT');
  }
  const count=(await db.query('SELECT count(*)::int AS n FROM review_learning WHERE review_id=$1',[reviewId])).rows[0].n;
  if(count>=50)throw new AppError(409,'本轮反馈已达50条，请整理已有记录。','LEARNING_LIMIT');
  await db.query(`INSERT INTO review_learning(id,contract_id,review_id,author_id,payload,before_sha256,after_sha256,preference_state,sample_state) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)`,[payload.requestId,contractId,reviewId,actor.id,JSON.stringify(payload),before.sha256,after.sha256,payload.preference?'pending':'none',payload.sample?'pending':'none']);
  await db.query('UPDATE contracts SET updated_at=now() WHERE id=$1',[contractId]);
  if(payload.preference)await db.query("INSERT INTO notifications(user_id,contract_id,message) VALUES($1,$2,'律师整理了条款偏好，请在“我的条款偏好”确认是否用于后续合同。')",[r.owner_id,contractId]);
  if(payload.sample)await db.query("INSERT INTO notifications(user_id,contract_id,message) SELECT id,$1,'有匿名评估样本待确认，请查看“反馈与质量积累”。' FROM users WHERE role='admin' AND NOT disabled",[contractId]);
 });
 await auditAccess(actor.id,payload.requestId);return (await listLearning(actor,contractId,reviewId)).items.find(x=>x.id===payload.requestId);
}
function sort(v:any):any{return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
export async function decideLearning(actor:User,id:string,input:unknown){
 const v=z.object({revision:z.number().int().positive(),kind:z.enum(['preference','sample']),action:z.enum(['confirm','reject','revoke']),note:z.string().trim().max(1000).default(''),deidentified:z.boolean().optional()}).parse(input);
 await withTransaction(async db=>{
  const access=(await db.query(`${selection} WHERE l.id=$3 AND ${scope}`,[actor.id,actor.role,id])).rows[0];
  if(!access)throw new AppError(404,'反馈不存在。','NOT_FOUND');
  await db.query('SELECT id FROM contracts WHERE id=$1 FOR UPDATE',[access.contract_id]);
  const r=(await db.query(`${selection} WHERE l.id=$3 AND ${scope} FOR UPDATE OF l,r`,[actor.id,actor.role,id])).rows[0];
  if(!r)throw new AppError(404,'反馈不存在。','NOT_FOUND');
  if(v.kind==='preference'?(actor.role!=='client'||actor.id!==r.owner_id):actor.role!=='admin')throw new AppError(403,v.kind==='preference'?'仅客户本人可以确认自己的条款偏好。':'仅管理员可以确认评估样本。','FORBIDDEN');
  if(r.revision!==v.revision)throw new AppError(409,'记录已变化，请刷新后重新核对。','CONFLICT');
  const col=v.kind==='preference'?'preference_state':'sample_state',state=r[col];
  if(state==='none')throw new AppError(400,'此反馈没有对应提案。','INVALID_INPUT');
  if(v.action==='confirm'){
   if(state!=='pending')throw new AppError(409,'此提案已处理；如需更正，请由律师重新整理。','CONFLICT');
   if(r.client_response==='changes_requested')throw new AppError(409,'来源交付已被要求继续修改，暂不采用。','LEARNING_SOURCE_UNSETTLED');
   if(v.kind==='sample'){if(!v.deidentified)throw new AppError(400,'请先确认样本已去除身份及商业秘密。','ANONYMIZATION_REQUIRED');try{assertDeidentified(r.payload.sample);}catch(e){throw new AppError(400,(e as Error).message,'INVALID_SAMPLE');}}
  }else if(v.action==='reject'&&state!=='pending'||v.action==='revoke'&&state!=='active')throw new AppError(409,'状态已变化，请刷新。','CONFLICT');
  await db.query(`UPDATE review_learning SET ${col}=$2,revision=revision+1,decisions=decisions||$3::jsonb WHERE id=$1`,[id,v.action==='confirm'?'active':v.action==='reject'?'rejected':'revoked',JSON.stringify([{kind:v.kind,action:v.action,actorId:actor.id,at:new Date().toISOString(),note:v.note}])]);
  await db.query('UPDATE contracts SET updated_at=now() WHERE id=$1',[r.contract_id]);
  await db.query("INSERT INTO notifications(user_id,contract_id,message) VALUES($1,$2,'你整理的反馈已有处理结果，请查看“反馈与质量积累”。')",[r.author_id,r.contract_id]);
 });await auditAccess(actor.id,id);return (await query(`${selection} WHERE l.id=$1`,[id])).rows.map(map)[0];
}
export async function loadClausePreferences(actor:User,intake?:Intake):Promise<ClausePreference[]>{
 if(actor.role!=='client'||!intake)return [];
 const rows=await query(`${selection} WHERE c.owner_id=$1 AND l.preference_state='active' AND r.client_response IS DISTINCT FROM 'changes_requested' AND l.payload->'preference'->>'templateId'=ANY($2::text[]) AND (l.payload->'preference'->>'stance'='' OR l.payload->'preference'->>'stance'=$3) ORDER BY l.created_at DESC,l.id DESC LIMIT 12`,[actor.id,[intake.templateId,...intake.ruleFamilies||[]],intake.intent?.stance?.value||'']);
 return matchingPreferences(rows.rows.map(r=>({...r.payload.preference,id:r.id,revision:r.revision,confirmedAt:r.decisions.findLast((d:any)=>d.kind==='preference'&&d.action==='confirm')?.at})),intake);
}
export async function approvedSamples(){
 return (await query(`${selection} WHERE l.sample_state='active' AND r.client_response IS DISTINCT FROM 'changes_requested' ORDER BY l.id`)).rows.map(r=>({id:r.id,revision:r.revision,category:r.payload.category,...r.payload.sample,confirmedAt:r.decisions.findLast((d:any)=>d.kind==='sample'&&d.action==='confirm')?.at}));
}
