import {randomUUID,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {query,withTransaction,AppError} from './db';
import {storage} from './documents';
import {extractMaterial} from './material-parser';
import {materialIndex,type MaterialDocument,type MaterialPurpose} from '../lib/materials';
import type {User,Workflow} from '../lib/types';
import {auditAccess} from './access-audit';


const visible=`(c.owner_id=$2 OR $3='admin' OR ($3='lawyer' AND (
 EXISTS(SELECT 1 FROM reviews r JOIN versions v ON v.id IN(r.submitted_version_id,r.handoff_version_id,r.editing_version_id,r.final_version_id)
 WHERE r.contract_id=c.id AND r.lawyer_id=$2 AND v.content->'confirmation'->'materialSources' @> jsonb_build_array(jsonb_build_object('id',m.id)))
 OR EXISTS(SELECT 1 FROM reviews r WHERE r.id=m.review_id AND r.contract_id=c.id AND r.lawyer_id=$2)
)))`;
const map=(r:any):MaterialDocument=>({id:r.id,name:r.name,purpose:r.purpose,sha256:r.sha256,size:r.size,status:r.status,warnings:r.warnings,chunks:r.chunks,chunkCount:r.chunks.length,createdAt:new Date(r.created_at).toISOString()});
export async function loadMaterials(actor:User,contractId:string):Promise<MaterialDocument[]>{
 const rows=await query(`SELECT m.* FROM contract_materials m JOIN contracts c ON c.id=m.contract_id WHERE c.id=$1 AND m.review_id IS NULL AND ${visible} AND (m.withdrawn_at IS NULL OR $3='lawyer') ORDER BY m.created_at,m.id`,[contractId,actor.id,actor.role]);
 return rows.rows.map(map);
}
export async function listMaterials(actor:User,contractId:string){
 const access=await query(`SELECT 1 FROM contracts c WHERE c.id=$1 AND (c.owner_id=$2 OR $3='admin' OR EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id=c.id AND r.lawyer_id=$2))`,[contractId,actor.id,actor.role]);
 if(!access.rowCount)throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');
 return materialIndex(await loadMaterials(actor,contractId));
}
async function mutable(client:PoolClient,actor:User,id:string):Promise<Workflow>{
 const row=(await client.query('SELECT owner_id,workflow FROM contracts WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!row||actor.role!=='client'||row.owner_id!==actor.id)throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');
 if(['running','pending'].includes(row.workflow?.job?.status))throw new AppError(409,'请等待当前任务完成或取消后再调整材料。','JOB_ACTIVE');
 if((await client.query("SELECT 1 FROM reviews WHERE contract_id=$1 AND status<>'completed' AND (submitted_version_id IS NOT NULL OR editing_version_id IS NOT NULL)",[id])).rowCount)throw new AppError(409,'当前合同正在审核，请通过审核沟通补充信息。','REVIEW_VERSION_FROZEN');
 return row.workflow||{};
}
async function invalidate(client:PoolClient,id:string,workflow:Workflow){
 workflow.inputRevision=(workflow.inputRevision||0)+1;if(workflow.intake)delete workflow.intake.confirmedAt;
 await client.query('UPDATE contracts SET workflow=$2::jsonb,workflow_revision=workflow_revision+1,updated_at=now() WHERE id=$1',[id,JSON.stringify(workflow)]);
}
export async function uploadMaterial(actor:User,contractId:string,file:{name:string;bytes:Buffer},purpose:unknown){
 const parsedPurpose=z.enum(['transaction','reference']).parse(purpose||'transaction');
 // Authorize before spending parser resources; lock and recheck before the actual write.
 await withTransaction(client=>mutable(client,actor,contractId));
 const extracted=await extractMaterial(file.name,file.bytes),id=randomUUID(),sha256=createHash('sha256').update(file.bytes).digest('hex');
 let storedId=id;
 const name=file.name.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f]/g,'').slice(0,240)||'材料';
 await withTransaction(async client=>{
  const workflow=await mutable(client,actor,contractId);
  const existing=(await client.query('SELECT id FROM contract_materials WHERE contract_id=$1 AND sha256=$2 AND purpose=$3 AND review_id IS NULL AND withdrawn_at IS NULL LIMIT 1',[contractId,sha256,parsedPurpose])).rows[0];
  if(existing){storedId=existing.id;return;}
  const count=(await client.query('SELECT count(*)::int AS n FROM contract_materials WHERE contract_id=$1',[contractId])).rows[0].n;
  if(count>=20)throw new AppError(409,'每份合同最多保存20份材料，请合并整理后上传。','MATERIAL_LIMIT');
  const key=`contracts/${contractId}/materials/${id}`;await storage.put(key,file.bytes,'application/octet-stream');
  await client.query('INSERT INTO contract_materials(id,contract_id,name,purpose,file_key,sha256,size,status,warnings,chunks) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)',[id,contractId,name,parsedPurpose,key,sha256,file.bytes.length,extracted.status,JSON.stringify(extracted.warnings),JSON.stringify(extracted.chunks)]);
  await invalidate(client,contractId,workflow);
 });
 await auditAccess(actor.id,storedId);return (await listMaterials(actor,contractId)).find(m=>m.id===storedId)!;
}
export async function withdrawMaterial(actor:User,contractId:string,id:string){
 await withTransaction(async client=>{
  const workflow=await mutable(client,actor,contractId);
  const changed=await client.query('UPDATE contract_materials SET withdrawn_at=COALESCE(withdrawn_at,now()) WHERE id=$1 AND contract_id=$2 AND review_id IS NULL RETURNING id',[id,contractId]);
  if(!changed.rowCount)throw new AppError(404,'材料不存在。','MATERIAL_NOT_FOUND');
  await invalidate(client,contractId,workflow);
 });return listMaterials(actor,contractId);
}
export async function materialFile(actor:User,contractId:string,id:string){
 const r=(await query(`SELECT m.* FROM contract_materials m JOIN contracts c ON c.id=m.contract_id WHERE c.id=$1 AND ${visible} AND m.id=$4`,[contractId,actor.id,actor.role,id])).rows[0];
 if(!r)throw new AppError(404,'材料不存在。','MATERIAL_NOT_FOUND');
 const bytes=await storage.get(r.file_key);if(!bytes||createHash('sha256').update(bytes).digest('hex')!==r.sha256)throw new AppError(409,'材料原件暂不可用或校验不一致。','MATERIAL_UNAVAILABLE');
 await auditAccess(actor.id,id);return {name:r.name,bytes};
}

async function reviewAccess(db:{query:PoolClient['query']},actor:User,contractId:string,reviewId:string,write=false){
 const row=(await db.query('SELECT c.owner_id,r.lawyer_id,r.status FROM contracts c JOIN reviews r ON r.contract_id=c.id WHERE c.id=$1 AND r.id=$2'+(write?' FOR UPDATE OF c,r':''),[contractId,reviewId])).rows[0];
 if(!row||!(actor.id===row.owner_id||actor.role==='lawyer'&&actor.id===row.lawyer_id||!write&&actor.role==='admin'))throw new AppError(404,'沟通记录不存在。','NOT_FOUND');
 if(write&&actor.role==='lawyer'&&row.status==='waiting')throw new AppError(409,'请先接收合同。','REVIEW_NOT_STARTED');
 return row;
}
export async function listReviewMaterials(actor:User,contractId:string,reviewId:string){
 await reviewAccess({query} as {query:PoolClient['query']},actor,contractId,reviewId);
 const rows=await query('SELECT * FROM contract_materials WHERE contract_id=$1 AND review_id=$2 ORDER BY created_at,id',[contractId,reviewId]);
 return materialIndex(rows.rows.map(map));
}
export async function uploadReviewMaterial(actor:User,contractId:string,reviewId:string,file:{name:string;bytes:Buffer}){
 await withTransaction(db=>reviewAccess(db,actor,contractId,reviewId,true));
 const extracted=await extractMaterial(file.name,file.bytes),sha256=createHash('sha256').update(file.bytes).digest('hex');
 const name=file.name.split(/[\\/]/).at(-1)!.replace(/[\x00-\x1f]/g,'').slice(0,240)||'补充材料';
 await withTransaction(async db=>{
  const access=await reviewAccess(db,actor,contractId,reviewId,true);
  if((await db.query('SELECT 1 FROM contract_materials WHERE contract_id=$1 AND review_id=$2 AND sha256=$3',[contractId,reviewId,sha256])).rowCount)return;
  if(Number((await db.query('SELECT count(*) AS n FROM contract_materials WHERE review_id=$1',[reviewId])).rows[0].n)>=50)throw new AppError(409,'补充材料已达50份，请整理后再上传。','MATERIAL_LIMIT');
  const id=randomUUID(),key=`contracts/${contractId}/materials/${id}`;
  await storage.put(key,file.bytes,'application/octet-stream');
  await db.query(`INSERT INTO contract_materials(id,contract_id,review_id,name,purpose,file_key,sha256,size,status,warnings,chunks)
    VALUES($1,$2,$3,$4,'transaction',$5,$6,$7,$8,$9::jsonb,$10::jsonb)`,[id,contractId,reviewId,name,key,sha256,file.bytes.length,extracted.status,JSON.stringify(extracted.warnings),JSON.stringify(extracted.chunks)]);
  await db.query('INSERT INTO review_messages(id,review_id,author_id,content) VALUES($1,$2,$3,$4)',[randomUUID(),reviewId,actor.id,'补充材料：'+name]);
  const recipient=actor.id===access.owner_id?access.lawyer_id:access.owner_id;
  if(recipient)await db.query('INSERT INTO notifications(user_id,contract_id,message) VALUES($1,$2,$3)',[recipient,contractId,'合同有新的补充材料，请打开沟通查看。']);
  await db.query('UPDATE contracts SET updated_at=now() WHERE id=$1',[contractId]);
 });
 await auditAccess(actor.id,reviewId);
 return listReviewMaterials(actor,contractId,reviewId);
}
