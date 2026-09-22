/** Explicit local QA: fresh PostgreSQL schema, synthetic identities, in-memory files. */
import {Pool} from 'pg';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {contentFixture} from '../tests/fixtures';

async function main(){
 if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
 const schema='qa_recovery_'+Date.now(),admin=new Pool({connectionString:process.env.DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(process.env.DATABASE_URL);url.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=url.toString();
 let db:typeof import('../src/server/db')|undefined;const results:string[]=[];
 try{
  const child=spawn(process.execPath,['--import','tsx','scripts/setup.ts'],{env:process.env,stdio:['ignore','ignore','pipe']});let err='';child.stderr!.on('data',b=>err+=b);assert.equal((await once(child,'exit'))[0],0,err);
  db=await import('../src/server/db');const api=await import('../src/server/contracts');const {storage,renderContract}=await import('../src/server/documents');
  const files=new Map<string,Buffer>();storage.get=async k=>files.get(k)||null;storage.put=async(k,b)=>{files.set(k,b);};
  const owner={id:randomUUID(),name:'回归测试客户',email:'owner@qa.invalid',role:'client' as const},lawyer={id:randomUUID(),name:'回归测试律师',email:'lawyer@qa.invalid',role:'lawyer' as const};
  for(const u of [owner,lawyer])await db.query('INSERT INTO users(id,name,email,email_normalized,password_hash,role) VALUES($1,$2,$3,$3,$4,$5)',[u.id,u.name,u.email,'synthetic',u.role]);
  const content=contentFixture(),bytes=Buffer.from(await renderContract(content)),sha=createHash('sha256').update(bytes).digest('hex');
  async function seed(id:string){const v=randomUUID(),key=id+'/'+v+'.docx';await db!.query('INSERT INTO versions(id,contract_id,number,kind,file_key,content,source,sha256) VALUES($1,$2,1,$3,$4,$5::jsonb,$6,$7)',[v,id,'draft',key,JSON.stringify(content),'ai',sha]);await db!.query('UPDATE contracts SET workflow=$1::jsonb WHERE id=$2',[JSON.stringify({intake:content.confirmation}),id]);return {v,key};}
  const c=await api.createContract(owner,{title:'审核保护回归'}),{v,key}=await seed(c.id);
  const submit=()=>api.submitReview(owner,c.id,{versionId:v,lawyerId:lawyer.id,stance:'甲方'});
  await assert.rejects(submit(),(e:any)=>e.code==='FILE_NOT_FOUND');files.set(key,Buffer.from('truncated'));
  await assert.rejects(submit(),(e:any)=>e.code==='FILE_NOT_FOUND');files.set(key,bytes);
  await db.query(`UPDATE contracts SET workflow=jsonb_set(workflow,'{inputRevision}','1') WHERE id=$1`,[c.id]);
  await assert.rejects(submit(),(e:any)=>e.code==='VERSION_OUTDATED');
  await db.query(`UPDATE contracts SET workflow=jsonb_set(workflow,'{inputRevision}','0') WHERE id=$1`,[c.id]);
  const submitted=await submit(),r=submitted.reviews[0];assert.equal(r.submittedVersionId,v);results.push('missing/corrupt/stale Word rejected; current Word accepted');
  const supplemented=await api.addReviewMessage(owner,c.id,r.id,{content:'收货地址补充'});assert.equal(supplemented.reviews[0].status,'waiting');assert.equal(supplemented.reviews[0].messages.length,1);
  await assert.rejects(api.addReviewMessage(lawyer,c.id,r.id,{content:'未接收'}),(e:any)=>e.code==='REVIEW_NOT_STARTED');
  await api.startReview(lawyer,c.id,r.id);const uploaded=await api.uploadReviewVersion(lawyer,c.id,r.id,{name:'律师版.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes});
  const finalId=uploaded.reviews[0].editingVersionId!;await api.completeReview(lawyer,c.id,r.id,{versionId:finalId,deliveryNote:'测试交付'});
  await assert.rejects(api.chatContract(owner,c.id,{requestId:randomUUID(),message:'把金额改一下'}),(e:any)=>e.code==='LAWYER_REVISION_REQUIRED');
  const next=await api.submitReview(owner,c.id,{versionId:finalId,stance:'甲方',lawyerId:lawyer.id,concerns:'请在律师原稿上修改付款'});assert.equal(next.reviews.length,2);assert.equal(next.reviews[0].submittedVersionId,finalId);assert.equal(next.versions.at(-1)!.source,'lawyer');
  const list=await api.listContractPage(owner,{});assert.equal(list.items.find(x=>x.id===c.id)?.displayStatus,'待律师接收');assert.ok(!(await api.listContractPage(owner,{filter:'completed'})).items.some(x=>x.id===c.id));
  results.push('waiting clients can supplement; lawyer revision preserves the exact reviewed Word; newest review shown');
  const assist=await api.createContract(owner,{title:'未定约定协助'});await db.query("INSERT INTO messages(id,contract_id,role,content) VALUES($1,$2,'user',$3)",[randomUUID(),assist.id,'付款比例未定']);
  let assisted=await api.submitReview(owner,assist.id,{consultation:true,stance:'甲方',lawyerId:lawyer.id});const ar=assisted.reviews[0];assert.equal(ar.submittedVersionId,null);
  await api.startReview(lawyer,assist.id,ar.id);await api.addReviewMessage(lawyer,assist.id,ar.id,{content:'建议各付一半，需双方确认'});
  const jobId=randomUUID();assisted=await api.chatContract(owner,assist.id,{requestId:jobId,message:'我们同意各付一半'});assert.equal(assisted.workflow!.job!.status,'pending');await api.jobAction(owner,assist.id,jobId,'cancel');
  const drafted=await seed(assist.id);files.set(drafted.key,bytes);assisted=await api.submitReview(owner,assist.id,{versionId:drafted.v,stance:'甲方'});
  assert.equal(assisted.reviews.length,1);assert.equal(assisted.reviews[0].id,ar.id);assert.equal(assisted.reviews[0].messages.length,1);assert.equal(assisted.reviews[0].status,'waiting');results.push('assistance remains draftable; confirmed Word upgrades the same conversation to formal review');
  const a=await api.createContract(owner,{}),b=await api.createContract(owner,{});process.env.CONTRACT_AI_MAX_ACTIVE_PER_USER='1';process.env.CONTRACT_AI_REQUESTS_PER_HOUR='2';await db.query("DELETE FROM auth_rate_limits WHERE scope='contract_ai'");
  const requests=[a,b].map(()=>({requestId:randomUUID(),message:'测试新的交易需求'}));
  const admissions=await Promise.allSettled([api.chatContract(owner,a.id,requests[0]),api.chatContract(owner,b.id,requests[1])]);assert.equal(admissions.filter(x=>x.status==='fulfilled').length,1);const rejected=admissions.find(x=>x.status==='rejected') as PromiseRejectedResult;assert.equal(rejected.reason.code,'AI_CONCURRENCY_LIMIT');
  const winner=admissions.findIndex(x=>x.status==='fulfilled'),ids=[a.id,b.id];await api.chatContract(owner,ids[winner],requests[winner]);
  assert.equal((await db.query("SELECT attempts FROM auth_rate_limits WHERE scope='contract_ai'")).rows[0].attempts,1);
  const winnerContract=await api.getContractForRoute(owner,ids[winner]);assert.equal(winnerContract.messages.length,1);await api.jobAction(owner,ids[winner],requests[winner].requestId,'cancel');
  const second=await api.chatContract(owner,ids[1-winner],requests[1-winner]);await api.jobAction(owner,second.id,second.workflow!.job!.id,'cancel');
  await assert.rejects(api.chatContract(owner,a.id,{requestId:randomUUID(),message:'第三次'}),(e:any)=>e.code==='AI_RATE_LIMITED');assert.equal((await db.query("SELECT attempts FROM auth_rate_limits WHERE scope='contract_ai'")).rows[0].attempts,2);
  results.push('concurrent admission is atomic; idempotent replay is free; rejected quota rolls back');
  console.log(JSON.stringify({passed:results,synthetic:true,isolatedDatabase:true,modelCalls:0},null,2));
 }finally{if(db)await db.closeDatabase();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:'QA failed');process.exitCode=1;});
