/** Real Flash/Pi + isolated Node/PostgreSQL review handoff. Synthetic businesses only.
 * File storage uses a local S3 protocol fixture; no public deployment or real lawyer contact. */
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import assert from 'node:assert/strict';
import {sseData} from '../src/lib/agent-stream';
import {extractDocxText} from '../src/server/documents';
import type {Contract} from '../src/lib/types';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const schema='qa_small_business_'+Date.now(),dir='.data/qa/'+schema,base='http://127.0.0.1:3238';await mkdir(dir,{recursive:true});console.log(dir);
 const admin=new Pool({connectionString:process.env.DATABASE_URL});await admin.query(`CREATE SCHEMA ${schema}`);
 const dbUrl=new URL(process.env.DATABASE_URL!);dbUrl.searchParams.set('options','-c search_path='+schema);const database=new Pool({connectionString:dbUrl.toString()});
 let app:ChildProcess|undefined,logs='';const files=new Map<string,Buffer>();
 const storage=createServer(async(req,res)=>{try{const key=req.url!.split('?')[0];if(req.method==='PUT'){const parts:Buffer[]=[];for await(const bytes of req)parts.push(Buffer.from(bytes));files.set(key,Buffer.concat(parts));res.end();return;}if(req.method==='GET'&&files.has(key)){res.setHeader('content-type','application/vnd.openxmlformats-officedocument.wordprocessingml.document');res.end(files.get(key));return;}res.writeHead(404);res.end();}catch{res.writeHead(500);res.end();}});
 await new Promise<void>(r=>storage.listen(0,'127.0.0.1',r));const address=storage.address() as {port:number};
 const env={...process.env,DATABASE_URL:dbUrl.toString(),CONTRACT_BUILD_DIR:'.next-build',APP_BASE_URL:base,NEXT_PUBLIC_APP_URL:base,CONTRACT_AI_MODEL:'deepseek-flash',CONTRACT_AI_THINKING:'enabled',CONTRACT_AI_REASONING_EFFORT:'high',CONTRACT_AI_TIMEOUT_MS:'180000',CONTRACT_PI_SESSION_DIR:dir+'/sessions',S3_BUCKET:'qa-files',S3_ENDPOINT:'http://127.0.0.1:'+address.port,S3_FORCE_PATH_STYLE:'true',S3_REGION:'us-east-1',AWS_ACCESS_KEY_ID:'local-test',AWS_SECRET_ACCESS_KEY:'local-test',AWS_SESSION_TOKEN:''};
 let cookie='';let contract:Contract|undefined;const report:any={localOnly:true,syntheticBusinesses:true,model:'deepseek-flash',thinking:'high',lawyerReviewed:false,transcript:[],events:[]};
 const request=async<T=any>(path:string,body?:unknown):Promise<T>=>{const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie')!.split(';')[0];const payload=await r.json();assert.ok(r.ok,JSON.stringify({path,status:r.status,error:payload.error}));return payload.data;};
 const settle=async(c:Contract)=>{
  const begin=Date.now();let next=c;
  while(['pending','running'].includes(next.workflow!.job!.status)&&Date.now()-begin<720000){
   const response=await fetch(base+'/api/contracts/'+c.id+'/jobs/'+c.workflow!.job!.id+'/events',{headers:{cookie}});assert.equal(response.status,200);
   for await(const frame of sseData(response.body!)){const event=JSON.parse(frame);if(event.type==='activity'&&report.events.at(-1)?.label!==event.label)report.events.push({label:event.label,at:Date.now()});if(event.type==='preview_delta'&&event.text){report.firstPreviewAt??=Date.now();report.previewChunks=(report.previewChunks||0)+1;}if(event.type==='result')next=event.contract;if(event.type==='error')throw new Error(event.message);}
  }
  contract=next;await writeFile(dir+'/contract.json',JSON.stringify(next,null,2));assert.equal(next.workflow!.job!.status,'completed',next.workflow!.job!.error||'Task did not finish');return next;
 };
 try{
  const setup=spawn(process.execPath,['--import','tsx','scripts/setup.ts'],{env,stdio:['ignore','ignore','pipe']});let setupError='';setup.stderr!.on('data',b=>setupError+=b);assert.equal((await once(setup,'exit'))[0],0,setupError);
  app=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3238'],{env,stdio:['ignore','pipe','pipe']});app.stdout!.on('data',b=>logs+=b);app.stderr!.on('data',b=>logs+=b);
  let ready=false;for(let n=0;n<150;n++){try{if((await fetch(base+'/api/capabilities')).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  const password=randomBytes(24).toString('hex');const lawyer=await request('auth/register',{name:'合成验收律师',email:schema+'-lawyer@example.test',password});const lawyerCookie=cookie;
  await database.query("UPDATE users SET role='lawyer' WHERE id=$1",[lawyer.id]);
  await request('auth/register',{name:'合成小店老板',email:schema+'-client@example.test',password});const clientCookie=cookie;
  let c=await request<Contract>('contracts',{title:'采购纸杯·真实Flash验收'});
  const message='我们测试禾木餐饮公司，跟测试晨光纸品公司买5000个纸杯，250毫升，印我们提供的logo。总共1800块含税，2026年10月10日前送到青岛测试路8号，卖家包运费。先付900，剩下的收货检查数量、图案和有没有漏水，没问题再付。帮我写合同，其他小事按常见方式处理。';
  const caseId=process.argv[2];
  const fixture=caseId?JSON.parse(await readFile('tests/evals/contracts.json','utf8')).find((item:any)=>item.id===caseId):undefined;
  assert.ok(!caseId||fixture,'Unknown evaluation case');report.caseId=caseId||'plain-purchase';
  report.startedAt=Date.now();
  for(const input of fixture?.turns||[message])c=await settle(await request('contracts/'+c.id+'/chat',{requestId:crypto.randomUUID(),message:input}));
  report.transcript.push(...c.messages);
  report.missing=c.workflow!.intake!.missing;report.conflicts=c.workflow!.intake!.conflicts;
  assert.deepEqual(report.missing,[],'Complete business description still blocked by questions');assert.deepEqual(report.conflicts,[]);
  c=await settle(await request('contracts/'+c.id+'/chat',{requestId:crypto.randomUUID(),confirmId:c.workflow!.intake!.summaryId}));report.transcript=c.messages;
  assert.equal(c.versions.length,1);let version=c.versions[0];
  const file=await fetch(base+'/api/files/'+version.id,{headers:{cookie}});assert.equal(file.status,200);let bytes=Buffer.from(await file.arrayBuffer());assert.equal(bytes.subarray(0,2).toString(),'PK');
  const wordText=extractDocxText(bytes);
  await writeFile(dir+'/purchase.docx',bytes);await writeFile(dir+'/purchase.txt',wordText);report.wordDownloaded=true;
  if(!caseId){
   assert.match(wordText,/5000/);assert.match(wordText,/250/);assert.match(wordText,/1[,]?800(?:\.00)?\s*元/);assert.match(wordText,/900(?:\.00)?\s*元/);
   assert.match(wordText,/数量/);assert.match(wordText,/图案/);assert.match(wordText,/漏水/);
   assert.doesNotMatch(wordText,/\d+\s*块(?:钱)?(?:[，,。；;\s（(]|$)/);
   assert.doesNotMatch(wordText,/(?:逾期|未.{0,12}(?:异议|回复|反馈)|沉默).{0,30}(?<!不)视为.{0,12}(?:验收|合格|通过|完成)/);
   report.wordFactsChecked=true;
  }
  if(process.env.CONTRACT_QA_REVISION==='1'){
   assert.ok(!caseId,'Revision fixture uses the default purchase');const original=structuredClone(version),originalBytes=Buffer.from(bytes);
   c=await settle(await request('contracts/'+c.id+'/chat',{requestId:crypto.randomUUID(),message:'价格改成2000元含税，先付1000元，剩下1000元还是收货检查数量、图案和漏水，没问题再付。其他约定不变。'}));
   assert.deepEqual(c.workflow!.intake!.missing,[]);assert.deepEqual(c.workflow!.intake!.conflicts,[]);
   c=await settle(await request('contracts/'+c.id+'/chat',{requestId:crypto.randomUUID(),confirmId:c.workflow!.intake!.summaryId}));
   assert.equal(c.versions.length,2);assert.deepEqual(c.versions[0],original);version=c.versions[1];
   const newFile=await fetch(base+'/api/files/'+version.id,{headers:{cookie}});assert.equal(newFile.status,200);bytes=Buffer.from(await newFile.arrayBuffer());
   const revised=extractDocxText(bytes);assert.match(revised,/2[,]?000(?:\.00)?\s*元/);assert.match(revised,/1[,]?000(?:\.00)?\s*元/);assert.doesNotMatch(revised,/1800|1,800|900/);assert.match(revised,/5000/);assert.match(revised,/250/);
   const untouched=original.content!.sections.filter(part=>!/(?:1800|1,800|900)/.test(JSON.stringify(part)));
   for(const part of untouched)assert.ok(version.content!.sections.some(next=>JSON.stringify(next)===JSON.stringify(part)),'Unrelated clause changed: '+part.title);
   const oldFile=await fetch(base+'/api/files/'+original.id,{headers:{cookie}});assert.deepEqual(Buffer.from(await oldFile.arrayBuffer()),originalBytes);
   report.revision={passed:true,unchangedSections:untouched.length,oldVersionId:original.id,newVersionId:version.id};report.transcript=c.messages;
   await writeFile(dir+'/purchase-v2.docx',bytes);await writeFile(dir+'/purchase-v2.txt',revised);
  }
  c=await request('contracts/'+c.id+'/reviews',{versionId:version.id,lawyerId:lawyer.id,stance:'采购方',concerns:'请重点核对交货、验收和尾款安排。'});assert.equal(c.reviews.at(-1)!.submittedVersionId,version.id);report.reviewSubmitted=true;
  cookie=lawyerCookie;const assigned=await request<Contract>('contracts/'+c.id);assert.equal(assigned.reviews.at(-1)!.lawyerId,lawyer.id);
  const lawyerFile=await fetch(base+'/api/files/'+version.id,{headers:{cookie}});assert.equal(lawyerFile.status,200);assert.deepEqual(Buffer.from(await lawyerFile.arrayBuffer()),bytes);report.lawyerCanReadSameWord=true;
  cookie=clientCookie;contract=c;report.passed=true;report.elapsedMs=Date.now()-report.startedAt;
 }catch(e){report.passed=false;report.error=e instanceof Error?e.message:String(e);process.exitCode=1;}
 finally{
  if(contract)await writeFile(dir+'/contract.json',JSON.stringify(contract,null,2));await writeFile(dir+'/result.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,error:report.error,wordDownloaded:report.wordDownloaded,reviewSubmitted:report.reviewSubmitted,lawyerCanReadSameWord:report.lawyerCanReadSameWord,elapsedMs:report.elapsedMs,dir}));
  if(app&&app.exitCode===null&&app.signalCode===null){app.kill('SIGTERM');await once(app,'exit');}storage.closeAllConnections();await new Promise<void>(r=>storage.close(()=>r()));await writeFile(dir+'/server.log',logs);await database.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
