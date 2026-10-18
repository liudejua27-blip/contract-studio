/** One local fixture; creates and drops its own two databases. No model/network provider calls. */
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile,rm,utimes} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {contentFixture} from '../tests/fixtures';
async function main(){
 const suffix=randomUUID().replaceAll('-',''),source='qa_backup_'+suffix,target='qa_restore_'+suffix;
 const admin=new Pool({connectionString:process.env.DATABASE_URL});
 const root=resolve('.data/qa/'+source);await mkdir(root,{recursive:true,mode:0o700});
 const url=(name:string)=>{const value=new URL(process.env.DATABASE_URL!);value.pathname='/'+name;value.searchParams.delete('options');return value.toString();};
 const envFor=(name:string):NodeJS.ProcessEnv=>({...process.env,NODE_ENV:'test',DATABASE_URL:url(name),S3_BUCKET:'',CONTRACT_PI_SESSION_DIR:join(root,name,'sessions'),CONTRACT_PRIVATE_STORAGE_DIR:join(root,name,'files'),CONTRACT_WORKER_MODE:'external'});
 const run=async(name:string,script:string,args:string[]=[])=>{const child=spawn(process.execPath,['--import','tsx',script,...args],{env:envFor(name),stdio:['ignore','pipe','pipe']});let output='';child.stdout!.on('data',b=>output+=b);child.stderr!.on('data',b=>output+=b);const [code]=await once(child,'exit');assert.equal(code,0,output);};
 let src:Pool|undefined,dst:Pool|undefined;
 try{
  await admin.query(`CREATE DATABASE ${source}`);await admin.query(`CREATE DATABASE ${target}`);
  await run(source,'scripts/setup.ts');src=new Pool({connectionString:url(source)});dst=new Pool({connectionString:url(target)});
  const uid=randomUUID(),cid=randomUUID(),vid=randomUUID(),rid=randomUUID(),sid=randomUUID();
  const {renderContract}=await import('../src/server/documents');const bytes=await renderContract(contentFixture('purchase'));
  const key=`contracts/${cid}/original.docx`,scratch=`contracts/${cid}/scratch.docx`,hash=createHash('sha256').update(bytes).digest('hex');
  const folder=join(root,source,'files','contracts',cid);await mkdir(folder,{recursive:true,mode:0o700});await writeFile(join(folder,'original.docx'),bytes);await writeFile(join(folder,'scratch.docx'),'uncommitted-editor-write');
  await src.query("INSERT INTO users(id,name,email,email_normalized,password_hash,role) VALUES($1,'fixture','fixture@test','fixture@test','fixture','client')",[uid]);
  await src.query("INSERT INTO contracts(id,owner_id,title) VALUES($1,$2,'fixture')",[cid,uid]);
  const materialKey=`contracts/${cid}/source.txt`,materialBytes=Buffer.from('private material fixture'),materialId=randomUUID();await writeFile(join(root,source,'files',materialKey),materialBytes);
  await src.query("INSERT INTO contract_materials(id,contract_id,name,purpose,file_key,sha256,size,status,warnings,chunks) VALUES($1,$2,'source.txt','transaction',$3,$4,$5,'ready','[]','[]')",[materialId,cid,materialKey,createHash('sha256').update(materialBytes).digest('hex'),materialBytes.length]);
  await src.query("INSERT INTO versions(id,contract_id,number,kind,file_key,source,sha256) VALUES($1,$2,1,'draft',$3,'ai',$4)",[vid,cid,key,hash]);
  await src.query("INSERT INTO reviews(id,contract_id,submitted_version_id,status,stance,concerns,requirements) VALUES($1,$2,$3,'reviewing','A','','')",[rid,cid,vid]);
  await src.query("INSERT INTO review_learning(id,contract_id,review_id,author_id,payload,before_sha256,after_sha256,preference_state,sample_state) VALUES($1,$2,$3,$4,'{}',$5,$5,'pending','none')",[randomUUID(),cid,rid,uid,hash]);
  await src.query('INSERT INTO editor_sessions(id,review_id,base_version_id,document_key,scratch_file_key,assigned_user_id) VALUES($1,$2,$3,$1,$4,$5)',[sid,rid,vid,scratch,uid]);
  await src.query("INSERT INTO agent_session_checkpoints(contract_id,owner_id,transcript) VALUES($1,$2,'private-pi-fixture')",[cid,uid]);
  await src.query("INSERT INTO sessions(id,user_id,token_hash,expires_at) VALUES($1,$2,'fixture',now()+interval '1 day')",[randomUUID(),uid]);
  await run(source,'scripts/backup.ts',['create',join(root,'backup')]);
  await run(source,'scripts/backup.ts',['verify',join(root,'backup')]);
  await run(target,'scripts/backup.ts',['restore',join(root,'backup'),'--offline']);
  assert.equal((await dst.query('SELECT transcript FROM agent_session_checkpoints')).rows[0].transcript,'private-pi-fixture');
  assert.equal((await dst.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n,0);
  assert.deepEqual(await readFile(join(root,target,'files',materialKey)),materialBytes);assert.equal((await dst.query('SELECT count(*)::int AS n FROM contract_materials')).rows[0].n,1);assert.equal((await dst.query('SELECT count(*)::int AS n FROM review_learning')).rows[0].n,1);
  assert.deepEqual(await readFile(join(root,target,'files',key)),bytes);
  assert.deepEqual(await readFile(join(root,target,'files',scratch)),bytes,'editor scratch must match saved snapshot, not an uncommitted write');
  // A due deletion removes rows/checkpoint/legacy session, while the orphan grace protects files.
  await dst.query("UPDATE reviews SET status='completed',completed_at=now() WHERE id=$1",[rid]);
  await dst.query("INSERT INTO deletion_requests(contract_id,requested_by,requested_at,delete_after) VALUES($1,$2,now(),now()-interval '1 second')",[cid,uid]);
  const legacy=createHash('sha256').update(JSON.stringify([uid,cid])).digest('hex');await mkdir(join(root,target,'sessions',legacy),{recursive:true});await writeFile(join(root,target,'sessions',legacy,'session.jsonl'),'private legacy');
  await run(target,'scripts/maintenance.ts',['--offline','--apply']);
  assert.equal((await dst.query('SELECT count(*)::int AS n FROM contracts')).rows[0].n,0);assert.equal((await dst.query('SELECT count(*)::int AS n FROM review_learning')).rows[0].n,0);assert.equal((await dst.query('SELECT count(*)::int AS n FROM contract_materials')).rows[0].n,0);assert.ok((await dst.query('SELECT 1 FROM object_gc WHERE file_key=$1',[materialKey])).rowCount);
  assert.equal((await dst.query('SELECT count(*)::int AS n FROM agent_session_checkpoints')).rows[0].n,0);
  await assert.rejects(readFile(join(root,target,'sessions',legacy,'session.jsonl')));
  const past=new Date(Date.now()-8*86400000);await utimes(join(root,target,'files',key),past,past);await utimes(join(root,target,'files',scratch),past,past);await utimes(join(root,target,'files',materialKey),past,past);
  await run(target,'scripts/maintenance.ts',['--offline','--apply']);await assert.rejects(readFile(join(root,target,'files',key)));await assert.rejects(readFile(join(root,target,'files',materialKey)));
  console.log(JSON.stringify({passed:true,checks:['consistent database/Word/material/learning/Pi backup and empty-target restore','scratch restored from immutable saved version','sessions revoked on restore','due deletion cascades plus legacy session and orphan file cleanup'],fixtureOnly:true}));
 }finally{await src?.end();await dst?.end();for(const name of [source,target])await admin.query(`DROP DATABASE IF EXISTS ${name} WITH(FORCE)`);await admin.end();await rm(root,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
