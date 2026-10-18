import {createReadStream} from 'node:fs';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {pool,query,closeDatabase} from '../src/server/db';
import {storage,normalizeStorageKey} from '../src/server/storage';
import {REFERENCED_KEYS_SQL} from '../src/server/lifecycle';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
async function fileHash(path:string){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
type Entry={key:string;blob:string;sha256:string;kind:'object'|'session'};
type Manifest={format:1;createdAt:string;schema:string;databaseSha256:string;entries:Entry[]};
async function pg(command:string,args:string[]){
 const url=new URL(process.env.DATABASE_URL!);
 const tls=Object.fromEntries(['sslmode','sslrootcert','sslcert','sslkey'].filter(k=>url.searchParams.has(k)).map(k=>['PG'+k.toUpperCase(),url.searchParams.get(k)!]));
 const env={...process.env,...tls,PGHOST:url.hostname,PGPORT:url.port||'5432',...(url.username?{PGUSER:decodeURIComponent(url.username)}:{}),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1)),PGOPTIONS:url.searchParams.get('options')||'',...(url.searchParams.has('sslmode')?{PGSSLMODE:url.searchParams.get('sslmode')!}:{})};
 await new Promise<void>((ok,bad)=>{const child=spawn(process.env.CONTRACT_PG_BIN_DIR?join(process.env.CONTRACT_PG_BIN_DIR,command):command,args,{env,stdio:['ignore','ignore','pipe']});let diagnostic='';child.stderr!.on('data',b=>{if(diagnostic.length<8192)diagnostic+=b.toString()});child.on('error',()=>bad(new Error(command+' unavailable')));child.on('exit',code=>code===0?ok():bad(new Error(command+' failed'+(/schema.*already exists/.test(diagnostic)?': target schema already exists':/version mismatch/.test(diagnostic)?': PostgreSQL client/server version mismatch':/password authentication/.test(diagnostic)?': authentication failed':''))));});
}
async function* sessionFiles(root:string,sub=''):AsyncIterable<string>{
 let items;try{items=await readdir(join(root,sub),{withFileTypes:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
 for(const item of items){if(item.isSymbolicLink())throw new Error('Session symlink refused');const key=sub?sub+'/'+item.name:item.name;if(item.isDirectory()&&!item.name.startsWith('run-')&&!item.name.endsWith('.lock'))yield* sessionFiles(root,key);else if(item.isFile())yield key;}
}
async function verify(dir:string):Promise<Manifest>{
 const m=JSON.parse(await readFile(join(dir,'manifest.json'),'utf8')) as Manifest;
 if(m.format!==1||!Array.isArray(m.entries)||!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(m.schema))throw new Error('Invalid manifest');
 if(await fileHash(join(dir,'database.dump'))!==m.databaseSha256)throw new Error('Database checksum mismatch');
 for(const e of m.entries){normalizeStorageKey(e.key);if(!['object','session'].includes(e.kind)||!/^\d+\.bin$/.test(e.blob))throw new Error('Invalid entry');if(hash(await readFile(join(dir,'blobs',e.blob)))!==e.sha256)throw new Error('Object checksum mismatch');}
 return m;
}
async function main(){
 const [mode,target,...flags]=process.argv.slice(2);
 if(!target||!['create','verify','restore'].includes(mode))throw new Error('Usage: backup create|verify|restore /private/path --offline');
 const dir=resolve(target),sessionRoot=resolve(process.env.CONTRACT_PI_SESSION_DIR||'.data/pi-sessions');
 if(mode==='verify'){const m=await verify(dir);console.log(JSON.stringify({verified:true,entries:m.entries.length}));return;}
 if(mode==='restore'&&!flags.includes('--offline'))throw new Error('Stop all writers before restoring with --offline.');
 const lock=await pool.connect();
 try{
  if(!(await lock.query("SELECT pg_try_advisory_lock(hashtext('contract-studio:maintenance')) AS held")).rows[0].held)throw new Error('Maintenance already running');
  if(mode==='create'){
   await mkdir(dir,{mode:0o700});await mkdir(join(dir,'blobs'),{mode:0o700});
   await lock.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const schema=(await lock.query('SELECT current_schema() AS name')).rows[0].name as string;
   const snapshot=(await lock.query('SELECT pg_export_snapshot() AS id')).rows[0].id as string;
   await pg('pg_dump',['--format=custom','--no-owner','--no-acl','--schema='+schema,'--snapshot='+snapshot,'--file='+join(dir,'database.dump')]);
   const entries:Entry[]=[];
   const save=async(kind:Entry['kind'],key:string,bytes:Buffer)=>{const blob=entries.length+'.bin';await writeFile(join(dir,'blobs',blob),bytes,{mode:0o600,flag:'wx'});entries.push({kind,key,blob,sha256:hash(bytes)});};
   // Match the same snapshot as pg_dump. Reconstruct active mutable editor scratch
   // from its immutable saved version, never from a concurrently changing object.
   const refs=await lock.query<{key:string;source:string;sha256:string|null}>(`SELECT file_key AS key,file_key AS source,sha256 FROM versions
     UNION SELECT file_key AS key,file_key AS source,sha256 FROM contract_materials
    UNION ALL SELECT e.scratch_file_key,CASE WHEN e.active THEN v.file_key ELSE e.scratch_file_key END,
    CASE WHEN e.active THEN v.sha256 ELSE NULL END FROM editor_sessions e JOIN reviews r ON r.id=e.review_id
    JOIN versions v ON v.id=COALESCE(r.editing_version_id,e.base_version_id)`);
   for(const {key,source,sha256} of refs.rows){const bytes=await storage.get(source);if(!bytes||sha256&&hash(bytes)!==sha256)throw new Error('Referenced object missing or checksum mismatch');await save('object',key,bytes);}

   try{if((await lstat(sessionRoot)).isSymbolicLink())throw new Error('Session root symlink refused');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
   for await(const key of sessionFiles(sessionRoot))await save('session',key,await readFile(join(sessionRoot,key)));
   await writeFile(join(dir,'manifest.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),schema,databaseSha256:await fileHash(join(dir,'database.dump')),entries} satisfies Manifest,null,2),{mode:0o600,flag:'wx'});
   await lock.query('COMMIT');await verify(dir);console.log(JSON.stringify({created:true,entries:entries.length}));
  }else{
   const manifest=await verify(dir);
   if((await query("SELECT 1 FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') LIMIT 1")).rowCount)throw new Error('Restore requires an empty target database');
   if(!storage.list)throw new Error('Storage inventory unavailable');for await(const _ of storage.list())throw new Error('Restore requires an empty private storage namespace');
   for await(const _ of sessionFiles(sessionRoot))throw new Error('Restore requires an empty session directory');
   // RESTRICT refuses to remove a schema containing any pre-existing object.
   await lock.query(`DROP SCHEMA IF EXISTS "${manifest.schema}" RESTRICT`);
   for(const e of manifest.entries){const bytes=await readFile(join(dir,'blobs',e.blob));if(e.kind==='object')await storage.put(e.key,bytes);else{const path=join(sessionRoot,e.key);await mkdir(resolve(path,'..'),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600,flag:'wx'});}}
   await pg('pg_restore',['--no-owner','--no-acl','--exit-on-error','--single-transaction','--dbname='+decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1)),join(dir,'database.dump')]);
   // Backups must never resurrect authenticated sessions or live reset links.
   if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(manifest.schema))throw new Error('Invalid schema');
   await lock.query(`UPDATE "${manifest.schema}".sessions SET revoked_at=now(); UPDATE "${manifest.schema}".password_reset_tokens SET used_at=now(); UPDATE "${manifest.schema}".email_actions SET used_at=now(); DELETE FROM "${manifest.schema}".agent_worker_leases;`);
   for(const e of manifest.entries.filter(e=>e.kind==='object')){const bytes=await storage.get(e.key);if(!bytes||hash(bytes)!==e.sha256)throw new Error('Restored object mismatch');}
   console.log(JSON.stringify({restored:true,entries:manifest.entries.length,sessionsRevoked:true}));
  }
 }finally{await lock.query('ROLLBACK').catch(()=>{});await lock.query("SELECT pg_advisory_unlock(hashtext('contract-studio:maintenance'))").catch(()=>{});lock.release();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'Backup operation failed');process.exitCode=1}).finally(closeDatabase);
