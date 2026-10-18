import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {createUserAsAdmin} from '../src/server/auth';
import {pool,query,closeDatabase} from '../src/server/db';
async function main(){
 const email=process.env.CONTRACT_BOOTSTRAP_ADMIN_EMAIL,name=process.env.CONTRACT_BOOTSTRAP_ADMIN_NAME||'平台管理员';
 if(!email)throw new Error('CONTRACT_BOOTSTRAP_ADMIN_EMAIL required');
 const lock=await pool.connect();
 try{await lock.query("SELECT pg_advisory_lock(hashtext('contract-studio:admin-bootstrap'))");
 if((await query("SELECT 1 FROM users WHERE role='admin'")).rowCount)throw new Error('Administrator already exists; bootstrap refused');
 const password=randomBytes(24).toString('base64url');
 await mkdir('.data',{recursive:true,mode:0o700});
 // Reserve private output before creating the account. Credentials never go to stdout.
 await writeFile('.data/bootstrap-admin.json',JSON.stringify({email,password}),{mode:0o600,flag:'wx'});
 await createUserAsAdmin({name,email,password,role:'admin'});
 console.log('Initial credentials saved to .data/bootstrap-admin.json; first login requires password change.');
 }finally{await lock.query("SELECT pg_advisory_unlock(hashtext('contract-studio:admin-bootstrap'))").catch(()=>{});lock.release();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(closeDatabase);
