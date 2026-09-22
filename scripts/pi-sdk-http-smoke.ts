/** Exercises the built Node HTTP app with an isolated fixture provider. Local DB only. */
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {intakeFixture,contentFixture} from '../tests/fixtures';
import {sseData} from '../src/lib/agent-stream';
async function main(){
 const base='http://127.0.0.1:3218',dir='.data/qa/pi-sdk-http-'+Date.now();await mkdir(dir,{recursive:true});
 const i=intakeFixture('purchase'),doc=contentFixture('purchase');let modelCalls=0;
 const provider=createServer(async(req,res)=>{try{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);modelCalls++;
 const prompt=body.messages[0].content,tool=prompt.includes('CONTRACT_INTAKE_V2')?'update_contract_spec':prompt.includes('CONTRACT_VERIFY_V2')?'submit_consistency_check':'submit_contract_draft';
 const result=tool==='update_contract_spec'?{templateId:'purchase',facts:Object.entries(i.facts).map(([fieldId,f])=>({fieldId,...f}))}:tool==='submit_consistency_check'?{verdict:'consistent',issues:[]}:doc;
 res.setHeader('content-type','text/event-stream');const args=JSON.stringify({result});for(let n=0;n<args.length;n+=120){res.write('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,...(n===0?{id:'fixture-'+modelCalls,type:'function'}:{}),function:{...(n===0?{name:tool}:{}),arguments:args.slice(n,n+120)}}]}}]})+'\n\n');}
 res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n');}catch{res.statusCode=500;res.end();}});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');const address=provider.address() as {port:number};
 const app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3218'],{env:{...process.env,CONTRACT_BUILD_DIR:'.next-build',APP_BASE_URL:base,NEXT_PUBLIC_APP_URL:base,CONTRACT_AI_BASE_URL:'http://127.0.0.1:'+address.port,CONTRACT_AI_API_KEY:'local-fixture',CONTRACT_PI_SESSION_DIR:dir+'/sessions'},stdio:['ignore','pipe','pipe']});let logs='';app.stdout.on('data',b=>logs+=b);app.stderr.on('data',b=>logs+=b);
 let cookie='';const request=async(path:string,body?:unknown)=>{const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];const payload=await r.json();assert.ok(r.ok,JSON.stringify({path,status:r.status,error:payload.error}));return payload.data;};
 try{
  let ready=false;for(let n=0;n<100;n++){try{if((await fetch(base+'/api/capabilities')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready,'Node app did not start');
  assert.equal((await request('capabilities')).agentRuntime,'pi-sdk');
  await request('auth/register',{name:'SDK 本地集成验收',email:'sdk-'+Date.now()+'@example.test',password:randomBytes(24).toString('hex')});
  let c=await request('contracts',{title:'完整 Pi SDK · 本地合成采购验收'});
  c=await request('contracts/'+c.id+'/chat',{requestId:crypto.randomUUID(),message:Object.values(i.facts).map(f=>f.quote).join('。')});
  let previews=0,activities=0;
  const run=async()=>{const r=await fetch(base+'/api/contracts/'+c.id+'/jobs/'+c.workflow.job.id+'/run',{method:'POST',headers:{origin:base,cookie,accept:'text/event-stream'}});assert.equal(r.status,200);let result:any;for await(const frame of sseData(r.body!)){const e=JSON.parse(frame);if(e.type==='preview')previews++;if(e.type==='activity')activities++;if(e.type==='result')result=e.contract;assert.notEqual(e.type,'error');}assert.ok(result);assert.notEqual(result.workflow.job.status,'failed',result.workflow.job.error);return result;};
  c=await run();assert.equal(c.workflow.intake.agentTrace.runtime,'pi-sdk');assert.deepEqual(c.workflow.intake.missing,[]);
  c=await request('contracts/'+c.id+'/chat',{requestId:crypto.randomUUID(),confirmId:c.workflow.intake.summaryId});
  for(let n=0;n<5&&c.workflow.job.status!=='completed';n++)c=await run();await writeFile(dir+'/contract.json',JSON.stringify(c,null,2));assert.ok(c.versions[0]?.content.skillAudit?.receipts.some((r:any)=>r.stage==='draft'));assert.ok(c.versions[0]?.content.skillAudit?.consistency);assert.equal(c.versions.length,1);assert.equal(c.workflow.job.status,'completed');
  const file=await fetch(base+'/api/files/'+c.versions[0].id,{headers:{cookie}});assert.equal(file.status,200);const bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');await writeFile(dir+'/purchase.docx',bytes);
  assert.equal((await readdir(dir+'/sessions')).length,1);assert.ok(previews>0);assert.ok(activities>0);assert.ok(!JSON.stringify(c).includes('contract_run'));
  const report={passed:true,runtime:'pi-sdk',model:'fixture',modelCalls,previews,activities,wordDownloaded:true,localOnly:true};await writeFile(dir+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{if(app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');await once(app,'exit');}await new Promise<void>(r=>provider.close(()=>r()));await writeFile(dir+'/server.log',logs);}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
