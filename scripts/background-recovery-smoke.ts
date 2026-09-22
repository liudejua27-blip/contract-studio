/** Isolated PostgreSQL schema + real Node/Pi/HTTP/Word, synthetic model only. */
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,rm} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import assert from 'node:assert/strict';
import {intakeFixture,contentFixture} from '../tests/fixtures';
import {sseData} from '../src/lib/agent-stream';
import type {Contract} from '../src/lib/types';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const schema='qa_background_'+Date.now(),dir='.data/qa/'+schema,base='http://127.0.0.1:3228';await mkdir(dir,{recursive:true});
 const admin=new Pool({connectionString:process.env.DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const dbUrl=new URL(process.env.DATABASE_URL!);dbUrl.searchParams.set('options','-c search_path='+schema);
 const database=new Pool({connectionString:dbUrl.toString()});
 const intake=intakeFixture('purchase'),document=contentFixture('purchase');let calls=0,failOnce=true,app:ChildProcess|undefined,logs='';
 const files=new Map<string,Buffer>();
 const provider=createServer(async(req,res)=>{try{if(req.url?.startsWith('/contracts-qa/')){const key=req.url.split('?')[0];if(req.method==='PUT'){const parts:Buffer[]=[];for await(const bytes of req)parts.push(Buffer.from(bytes));files.set(key,Buffer.concat(parts));res.end();return;}if(req.method==='GET'){const bytes=files.get(key);if(!bytes){res.writeHead(404);res.end();return;}res.setHeader('content-type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');res.end(bytes);return;}}let raw='';for await(const bytes of req)raw+=bytes;const body=JSON.parse(raw);calls++;
  // A real HTTP 503 exercises the SDK transport's bounded recovery.
  if(failOnce){failOnce=false;res.writeHead(503);res.end('{}');return;}
  const prompt=body.messages[0].content,tool=prompt.includes('CONTRACT_INTAKE_V2')?'update_contract_spec':prompt.includes('CONTRACT_VERIFY_V2')?'submit_consistency_check':'submit_contract_draft';
  const result=tool==='update_contract_spec'?{templateId:'purchase',facts:Object.entries(intake.facts).map(([fieldId,f])=>({fieldId,...f})),reply:'交易信息已整理，请确认后生成合同。'}:tool==='submit_consistency_check'?{verdict:'consistent',issues:[]}:document;
  res.setHeader('content-type','text/event-stream');const args=JSON.stringify({result});
  for(let n=0;n<args.length;n+=100){if(res.destroyed)return;res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,...(n===0?{id:'fixture-'+calls,type:'function'}:{}),function:{...(n===0?{name:tool}:{}),arguments:args.slice(n,n+100)}}]}}]})+'\n\n');await delay(40);}
  res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
 }catch{res.statusCode=500;res.end();}});
 await new Promise<void>(r=>provider.listen(0,'127.0.0.1',r));const address=provider.address() as {port:number};
 const env={...process.env,DATABASE_URL:dbUrl.toString(),CONTRACT_BUILD_DIR:'.next-build',APP_BASE_URL:base,NEXT_PUBLIC_APP_URL:base,CONTRACT_AI_BASE_URL:'http://127.0.0.1:'+address.port,CONTRACT_AI_API_KEY:'local-fixture',CONTRACT_AI_TIMEOUT_MS:'10000',CONTRACT_PI_SESSION_DIR:dir+'/sessions',CONTRACT_PRIVATE_STORAGE_DIR:dir+'/files',CONTRACT_STORAGE_DRIVER:'s3',S3_BUCKET:'contracts-qa',S3_ENDPOINT:'http://127.0.0.1:'+address.port,S3_FORCE_PATH_STYLE:'true',S3_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'local-test',AWS_SECRET_ACCESS_KEY:'local-test',AWS_SESSION_TOKEN:''};
 const stop=async()=>{if(app&&app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');await once(app,'exit');}};
 const start=async()=>{app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3228'],{env,stdio:['ignore','pipe','pipe']});app.stdout!.on('data',b=>logs+=b);app.stderr!.on('data',b=>logs+=b);
  for(let n=0;n<150;n++){try{if((await fetch(base+'/api/capabilities')).ok)return;}catch{}if(app.exitCode!==null)throw new Error('Node exited');await delay(100);}throw new Error('Node did not start');};
 let cookie='';const request=async<T=any>(path:string,body?:unknown):Promise<T>=>{const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];const payload=await r.json();assert.ok(r.ok,JSON.stringify({path,status:r.status,error:payload.error}));return payload.data;};
 const until=async(id:string,test:(c:Contract)=>boolean)=>{for(let n=0;n<180;n++){const c=await request<Contract>('contracts/'+id);assert.notEqual(c.workflow?.job?.status,'failed',c.workflow?.job?.error);if(test(c))return c;await delay(500);}throw new Error('Task timeout');};
 try{
  const setup=spawn(process.execPath,['--import','tsx','scripts/setup.ts'],{env,stdio:['ignore','ignore','pipe']});let err='';setup.stderr!.on('data',b=>err+=b);assert.equal((await once(setup,'exit'))[0],0,err);
  await start();const user=await request('auth/register',{name:'后台恢复合成验收',email:schema+'@example.test',password:randomBytes(24).toString('hex')});
  let c=await request<Contract>('contracts',{title:'后台恢复测试'});
  c=await request('contracts/'+c.id+'/chat',{requestId:crypto.randomUUID(),message:Object.values(intake.facts).map(f=>f.quote).join('。')});
  // No /run or stream connection: only read the durable result.
  c=await until(c.id,c=>c.workflow?.job?.status==='completed');assert.equal(c.workflow!.intake!.agentTrace!.runtime,'pi-sdk');assert.deepEqual(c.workflow!.intake!.missing,[]);
  const confirmation={requestId:crypto.randomUUID(),confirmId:c.workflow!.intake!.summaryId};
  c=await request('contracts/'+c.id+'/chat',confirmation);await request('contracts/'+c.id+'/chat',confirmation);
  const stream=await fetch(base+'/api/contracts/'+c.id+'/jobs/'+c.workflow!.job!.id+'/events',{headers:{cookie}});assert.equal(stream.status,200);
  let preview='';const frames=sseData(stream.body!);for await(const frame of frames){const e=JSON.parse(frame);if(e.type==='preview_delta'&&e.text){preview=e.text;break;}}assert.ok(preview,'real persisted preview received');
  // Leaving the page cancels just the subscription. The background still delivers Word.
  c=await until(c.id,c=>c.workflow?.job?.status==='completed');assert.equal(c.versions.length,1);
  const file=await fetch(base+'/api/files/'+c.versions[0].id,{headers:{cookie}});assert.equal(file.status,200);const bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');await writeFile(dir+'/purchase.docx',bytes);
  const outsider=await fetch(base+'/api/contracts/'+c.id+'/jobs/'+c.workflow!.job!.id+'/events');assert.equal(outsider.status,401);
  // Restart with an expired export lease, retaining its content checkpoint.
  await stop();const restartId=crypto.randomUUID(),versionId=crypto.randomUUID();const j={...c.workflow!.job!,id:restartId,versionId,status:'running',phase:'export',content:c.versions[0].content,lease:'dead-process',leaseUntil:new Date(0).toISOString(),recoveryCount:0};
  await database.query('UPDATE contracts SET workflow=jsonb_set(workflow,\'{job}\',$1::jsonb),workflow_revision=workflow_revision+1 WHERE id=$2',[JSON.stringify(j),c.id]);const callsBeforeRestart=calls;
  await start();c=await until(c.id,c=>c.workflow?.job?.status==='completed');assert.equal(c.versions.length,2);assert.equal(calls,callsBeforeRestart,'export restart must not call model');assert.equal(c.workflow!.job!.recoveryCount,1);
  const rows=await database.query('SELECT COUNT(*)::int AS n FROM versions WHERE contract_id=$1 AND id=$2',[c.id,versionId]);assert.equal(rows.rows[0].n,1);
  // Kill an actual draft process. Restart immediately; it must wait for the real
  // lease to expire, reclaim it, recover the Pi checkpoint, then finish one Word.
  let interrupted=await request<Contract>('contracts',{title:'进程强制退出恢复'});
  await database.query('UPDATE contracts SET workflow=$1::jsonb WHERE id=$2',[JSON.stringify({intake:c.workflow!.intake,inputRevision:c.workflow!.inputRevision}),interrupted.id]);
  interrupted=await request('contracts/'+interrupted.id+'/chat',{requestId:crypto.randomUUID(),confirmId:c.workflow!.intake!.summaryId});
  const activeStream=await fetch(base+'/api/contracts/'+interrupted.id+'/jobs/'+interrupted.workflow!.job!.id+'/events',{headers:{cookie}});
  for await(const frame of sseData(activeStream.body!)){const event=JSON.parse(frame);if(event.type==='preview_delta'&&event.text)break;}
  const beforeKill=await request<Contract>('contracts/'+interrupted.id);assert.equal(beforeKill.workflow!.job!.status,'running');assert.equal(beforeKill.workflow!.job!.phase,'generate');
  const dead=app!;dead.kill('SIGKILL');await once(dead,'exit');await start();
  interrupted=await until(interrupted.id,item=>item.workflow?.job?.status==='completed');assert.equal(interrupted.versions.length,1);assert.equal(interrupted.workflow!.job!.recoveryCount,1);
  const report={passed:true,model:'synthetic HTTP provider',runtime:'full Pi SDK',noBrowserRequired:true,disconnectKeepsWorking:true,previewRestored:true,provider503Recovered:true,restartResumesExport:true,killedDraftResumesAfterLease:true,duplicateSubmissionSingleVersion:true,wordDownloaded:true,modelCalls:calls,localOnly:true};await writeFile(dir+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify({...report,artifact:dir}));
  if(process.argv.includes('--browser')){await writeFile(dir+'/browser.json',JSON.stringify({base,contractId:c.id,cookie,userId:user.id}));console.log('Browser QA ready: '+dir+'/browser.json');await delay(240000);}
 }finally{await stop();provider.closeAllConnections();await new Promise<void>(r=>provider.close(()=>r()));await writeFile(dir+'/server.log',logs);await database.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(dir+'/browser.json',{force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
