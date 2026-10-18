import {rm,readdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
/** Explicit offline maintenance; never automatically delete business records. */
import {pool,query,closeDatabase} from '../src/server/db';
import {storage} from '../src/server/storage';
import {purgeDueContracts,REFERENCED_KEYS_SQL} from '../src/server/lifecycle';
async function main(){
 if(!process.argv.includes('--offline'))throw new Error('Stop all web/worker/editor writers, back up, then supply --offline.');
 if((await query('SELECT 1 FROM agent_worker_leases WHERE expires_at>now()')).rowCount)throw new Error('Active worker leases remain.');
 if(!storage.list||!storage.delete)throw new Error('Storage does not support maintenance.');
 const lock=await pool.connect();
 try{if(!(await lock.query("SELECT pg_try_advisory_lock(hashtext('contract-studio:maintenance')) AS held")).rows[0].held)throw new Error('Backup or maintenance is active');
 const apply=process.argv.includes('--apply');
 if(apply)console.log(JSON.stringify({purgedContracts:await purgeDueContracts(()=>{process.exitCode=2})}));
 const keys=new Set((await query<{key:string}>(REFERENCED_KEYS_SQL)).rows.map(r=>r.key));let candidates=0,deleted=0;
 for await(const object of storage.list()){
  if(!object.key.startsWith('contracts/')||keys.has(object.key)||object.modified.getTime()>Date.now()-7*86400000)continue;
  candidates++;
  if(apply){await storage.delete(object.key);await query('DELETE FROM object_gc WHERE file_key=$1',[object.key]);deleted++;}
 }
 if(apply){
  const root=resolve(process.env.CONTRACT_PI_SESSION_DIR||'.data/pi-sessions');
  try{if((await lstat(root)).isSymbolicLink())throw new Error('Session root symlink refused');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  for(const row of (await query<{directory_hash:string}>('SELECT directory_hash FROM session_gc')).rows){if(!/^[a-f0-9]{64}$/.test(row.directory_hash))throw new Error('Invalid session path');await rm(join(root,row.directory_hash),{recursive:true,force:true});await query('DELETE FROM session_gc WHERE directory_hash=$1',[row.directory_hash]);}
  for(const item of await readdir(root,{withFileTypes:true}).catch(()=>[])){if(item.name.startsWith('run-')&&(await lstat(join(root,item.name))).mtimeMs<Date.now()-86400000)await rm(join(root,item.name),{recursive:true,force:true});}
  await query("DELETE FROM sessions WHERE expires_at<now()-interval '30 days'");
  await query("DELETE FROM password_reset_tokens WHERE expires_at<now()-interval '7 days'");
  await query("DELETE FROM email_actions WHERE expires_at<now()-interval '7 days'");
  await query("DELETE FROM notifications WHERE created_at<now()-interval '90 days'");
  await query("DELETE FROM auth_rate_limits WHERE updated_at<now()-interval '1 day'");
  await query("DELETE FROM model_calls WHERE created_at<now()-interval '90 days'");
  await query("DELETE FROM idempotency_keys WHERE created_at<now()-interval '90 days'");
  await query("DELETE FROM access_audit WHERE created_at<now()-interval '365 days'");
 }
 console.log(JSON.stringify({apply,orphanCandidates:candidates,deleted}));
 }finally{await lock.query("SELECT pg_advisory_unlock(hashtext('contract-studio:maintenance'))").catch(()=>{});lock.release();}
}
main().catch(()=>{console.error('Maintenance failed; check private database/storage configuration and offline prerequisites.');process.exitCode=1}).finally(closeDatabase);
