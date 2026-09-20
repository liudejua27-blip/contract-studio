/** Local-only development bootstrap. Passwords are saved in a private ignored file, never printed. */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createUserAsAdmin } from '../src/server/auth';
import { query, closeDatabase } from '../src/server/db';
const output=resolve('.data/local-accounts.json');
async function main(){
 if(process.env.NODE_ENV==='production')throw new Error('Local bootstrap is disabled in production.');
 await mkdir(resolve('.data'),{recursive:true,mode:0o700});
 try{await readFile(output);console.log('Local account file already exists; no accounts changed.');return}catch{}
 const specs=[{name:'体验用户',email:'client@contract.local',role:'client'},{name:'审阅律师',email:'lawyer@contract.local',role:'lawyer'},{name:'平台管理员',email:'admin@contract.local',role:'admin'}] as const;
 const accounts=[];
 for(const spec of specs){const existing=await query('SELECT id FROM users WHERE email_normalized=$1',[spec.email]);if(existing.rows.length)throw new Error('An account already exists; refusing to reset its credential.');const password=randomBytes(24).toString('base64url');const user=await createUserAsAdmin({...spec,password});accounts.push({...user,password})}
 await writeFile(output,JSON.stringify(accounts,null,2),{mode:0o600});await chmod(output,0o600);console.log('Local test accounts created. Private credentials are in .data/local-accounts.json.');
}
main().catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>closeDatabase());
