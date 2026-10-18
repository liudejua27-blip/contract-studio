import {createHash} from 'node:crypto';
import type {User} from '../lib/types';
import {AppError,withTransaction,query} from './db';
export async function deletionRequest(actor:User,contractId:string,cancel=false){
 return withTransaction(async client=>{
  const c=(await client.query('SELECT owner_id,workflow FROM contracts WHERE id=$1 FOR UPDATE',[contractId])).rows[0];
  if(!c || actor.role!=='admin'&&actor.id!==c.owner_id)throw new AppError(404,'合同不存在。','CONTRACT_NOT_FOUND');
  if(cancel){await client.query('DELETE FROM deletion_requests WHERE contract_id=$1',[contractId]);return {scheduled:false};}
  if(['running','pending'].includes(c.workflow?.job?.status))throw new AppError(409,'请先停止正在进行的生成任务。','CONFLICT');
  if((await client.query("SELECT 1 FROM reviews WHERE contract_id=$1 AND status<>'completed'",[contractId])).rowCount)throw new AppError(409,'请先完成审核或与平台处理审核任务。','CONFLICT');
  const result=await client.query(`INSERT INTO deletion_requests(contract_id,requested_by) VALUES($1,$2) ON CONFLICT(contract_id) DO UPDATE SET requested_by=EXCLUDED.requested_by RETURNING GREATEST(delete_after,(SELECT updated_at FROM contracts WHERE id=$1)+interval '30 days') AS delete_after`,[contractId,actor.id]);
  await client.query("INSERT INTO access_audit(actor_id,action,resource_id,outcome) VALUES($1,'contract.delete.request',$2,200)",[actor.id,contractId]);
  return {scheduled:true,deleteAfter:result.rows[0].delete_after};
 });
}
export async function deletionState(actor:User,contractId:string){
 return (await query(`SELECT GREATEST(d.delete_after,c.updated_at+interval '30 days') AS delete_after FROM deletion_requests d JOIN contracts c ON c.id=d.contract_id WHERE c.id=$1 AND (c.owner_id=$2 OR $3='admin')`,[contractId,actor.id,actor.role])).rows[0]??null;
}
/** Maintenance command only: all web/worker/editor writers must be stopped. */
export async function purgeDueContracts(onFailure?:(contractId:string)=>void){
 const eligible=`GREATEST(d.delete_after,c.updated_at+interval '30 days')<=now()
  AND COALESCE(c.workflow->'job'->>'status','') NOT IN ('running','pending')
  AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.contract_id=c.id AND r.status<>'completed')`;
 const due=await query(`SELECT c.id FROM contracts c JOIN deletion_requests d ON d.contract_id=c.id WHERE ${eligible}`);
 let purged=0;
 for(const candidate of due.rows){
  try{purged+=await withTransaction(async client=>{
   const locked=await client.query(`SELECT c.id,c.owner_id FROM contracts c JOIN deletion_requests d ON d.contract_id=c.id WHERE c.id=$1 AND ${eligible} FOR UPDATE OF c`,[candidate.id]);
   if(!locked.rowCount)return 0;
   const {id,owner_id}=locked.rows[0];
   await client.query('INSERT INTO session_gc(directory_hash) VALUES($1) ON CONFLICT DO NOTHING',[createHash('sha256').update(JSON.stringify([owner_id,id])).digest('hex')]);
   await client.query(`INSERT INTO object_gc(file_key) SELECT file_key FROM contract_materials WHERE contract_id=$1 UNION SELECT file_key FROM versions WHERE contract_id=$1 UNION SELECT scratch_file_key FROM editor_sessions WHERE review_id IN(SELECT id FROM reviews WHERE contract_id=$1) ON CONFLICT DO NOTHING`,[id]);
   // Editor sessions reference versions; remove dependent records before the
   // contract cascades to versions. Each contract commits independently.
   await client.query('DELETE FROM editor_sessions WHERE review_id IN(SELECT id FROM reviews WHERE contract_id=$1)',[id]);
   await client.query('DELETE FROM reviews WHERE contract_id=$1',[id]);
   await client.query('DELETE FROM contracts WHERE id=$1',[id]);
   await client.query("INSERT INTO access_audit(actor_id,action,resource_id,outcome) VALUES('maintenance','contract.purge',$1,200)",[id]);
   return 1;
  });}catch{onFailure?.(candidate.id);console.error(JSON.stringify({event:'contract_purge_failed',contractId:candidate.id}));}
 }
 return purged;
}
export const REFERENCED_KEYS_SQL=`SELECT file_key AS key FROM versions UNION SELECT file_key AS key FROM contract_materials UNION SELECT scratch_file_key AS key FROM editor_sessions`;
