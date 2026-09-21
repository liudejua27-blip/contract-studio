import {Miniflare} from 'miniflare';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {intakeFixture,contentFixture} from '../tests/fixtures.ts';
import {PLAYBOOKS} from '../src/lib/contract-library/playbooks.ts';
import {randomBytes} from 'node:crypto';
const i=intakeFixture('purchase'),document=contentFixture('purchase');
const live=process.env.CONTRACT_PI_LIVE==='1';
if(live&&!process.env.CONTRACT_AI_API_KEY)throw new Error('Live model is not configured');
let calls=0,held=false,release;
const mf=new Miniflare({workers:[{name:'contract',modules:true,scriptPath:'dist/server/index.js',compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],queueProducers:{AGENT_QUEUE:'contract-agent'},queueConsumers:{'contract-agent':{maxBatchSize:1,maxBatchTimeout:0,maxRetries:2}},bindings:{CONTRACT_AI_API_KEY:live?process.env.CONTRACT_AI_API_KEY:'fake',CONTRACT_AI_BASE_URL:live?process.env.CONTRACT_AI_BASE_URL:'https://model.test',CONTRACT_AI_MODEL:process.env.CONTRACT_AI_MODEL||'deepseek-v4-pro'},outboundService:async request=>{
 calls++;if(live){console.log(JSON.stringify({event:'live_provider_request',host:new URL(request.url).hostname}));const response=await fetch(request.url,{method:request.method,headers:{'content-type':'application/json',authorization:request.headers.get('authorization')||''},body:await request.text()});if(!response.ok)console.log(JSON.stringify({event:'live_provider_status',status:response.status}));return new Response(await response.arrayBuffer(),{status:response.status,headers:{'content-type':'application/json'}});}const body=await request.json();
 if(held)await new Promise(resolve=>{release=resolve});
 const prompt=body.messages[0].content;
 const tool=prompt.includes('CONTRACT_INTAKE_V2')?'update_contract_spec':prompt.includes('CONTRACT_VERIFY_V2')?'submit_consistency_check':'submit_contract_draft';
 const result=tool==='update_contract_spec'?{templateId:'purchase',facts:Object.entries(i.facts).map(([fieldId,f])=>({fieldId,...f})),conflicts:[]}:tool==='submit_consistency_check'?{verdict:'consistent',issues:[]}:document;
 return Response.json({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:crypto.randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify({result})}}]}}]});
}}]});
let cookie='';
async function req(path,body){const response=await mf.dispatchFetch('https://contract.test/api/'+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];const data=await response.json();assert.equal(response.status,body&&['auth/register','contracts'].includes(path)?201:200,JSON.stringify(data));return data.data;}
async function wait(id,predicate){for(let n=0;n<(live?2400:200);n++){const c=await req('contracts/'+id);if(predicate(c))return c;if(c.workflow?.job.status==='failed')throw new Error('job failed: '+c.workflow.job.code);await new Promise(r=>setTimeout(r,50));}throw new Error('background job did not finish');}
try{
 const db=await mf.getD1Database('DB');for(const f of(await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()){const sql=await readFile('drizzle/'+f,'utf8');await db.batch(sql.split('--> statement-breakpoint').filter(s=>s.trim()).map(s=>db.prepare(s)));}
 await req('auth/register',{name:'队列测试',email:'queue@example.test',password:randomBytes(20).toString('hex')});
 assert.equal((await req('capabilities')).backgroundJobs,true);
 let c=await req('contracts',{});const id=c.id;
 const input={requestId:crypto.randomUUID(),message:'我要起草普通商品采购合同，'+Object.entries(i.facts).map(([id,f])=>(PLAYBOOKS.purchase.fields.find(x=>x.id===id)?.label||id)+'：'+f.quote).join('；')};
 await req('contracts/'+id+'/chat',input);
 // No /jobs/run calls: the browser is only observing; queue drives every phase.
 c=await wait(id,c=>c.workflow?.job.status==='completed');assert.deepEqual(c.workflow.intake.missing,[]);assert.ok(c.workflow.intake.agentTrace.tools.includes('update_contract_spec'));
 const generation={requestId:crypto.randomUUID(),confirmId:c.workflow.intake.summaryId};
 await req('contracts/'+id+'/chat',generation);await req('contracts/'+id+'/chat',generation);
 c=await wait(id,c=>c.versions.length===1);assert.equal(c.workflow.job.status,'completed');
 const before=calls;await req('contracts/'+id+'/chat',generation);await new Promise(r=>setTimeout(r,100));assert.equal(calls,before);assert.equal((await req('contracts/'+id)).versions.length,1);
 const file=await mf.dispatchFetch('https://contract.test/api/files/'+c.versions[0].id,{headers:{cookie}});assert.equal(file.status,200);assert.ok((await file.arrayBuffer()).byteLength>1000);
 if(!live){held=true;await req('contracts/'+id+'/chat',{requestId:crypto.randomUUID(),message:'先不要改价格'});
 c=await wait(id,c=>c.workflow.job.status==='running');await req(`contracts/${id}/jobs/${c.workflow.job.id}/cancel`,{});held=false;release?.();await new Promise(r=>setTimeout(r,200));c=await req('contracts/'+id);assert.equal(c.workflow.job.status,'cancelled');assert.equal(c.versions.length,1);}
 await mkdir('.data',{recursive:true});await writeFile(live?'.data/pi-worker-live.json':'.data/pi-worker-smoke.json',JSON.stringify({passed:true,checks:['Pi native tool loop in workerd','queue execution without browser pumping','idempotent duplicate confirmation','AI draft download before review',...(live?[]:['cancelled task cannot commit'])],model:live?process.env.CONTRACT_AI_MODEL:'fixture',calls},null,2));console.log(JSON.stringify({result:'passed',runtime:'workerd',model:live?'live':'fixture',calls,versions:c.versions.length}));
}finally{release?.();await mf.dispose();}
