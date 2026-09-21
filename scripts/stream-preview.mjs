// Isolated local QA: temporary database, synthetic contracts, streamed fixture model.
import {Miniflare} from 'miniflare';
import {readFile,readdir} from 'node:fs/promises';
import {contentFixture,intakeFixture} from '../tests/fixtures.ts';
const i=intakeFixture('purchase'),doc=contentFixture('purchase');
const mf=new Miniflare({name:'contract',port:3217,modules:true,scriptPath:'dist/server/index.js',assets:{workerName:'contract',directory:'dist/client',binding:'ASSETS',assetConfig:{html_handling:'none'},routerConfig:{invoke_user_worker_ahead_of_assets:true,has_user_worker:true}},compatibilityDate:'2026-08-01',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{CONTRACT_AI_API_KEY:'fixture',CONTRACT_AI_BASE_URL:'https://model.test'},outboundService:async request=>{
 const body=await request.json(),prompt=body.messages[0].content;
 const name=prompt.includes('CONTRACT_INTAKE_V2')?'update_contract_spec':prompt.includes('CONTRACT_VERIFY_V2')?'submit_consistency_check':'submit_contract_draft';
 if(name==='submit_consistency_check')await new Promise(r=>setTimeout(r,2000));
 const user=body.messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
 const result=name==='update_contract_spec'?{templateId:'purchase',reply:'已收到你的采购需求，我正在整理商品、交货和付款安排。',facts:Object.entries(i.facts).filter(([,f])=>user.includes(f.quote)).map(([fieldId,f])=>({fieldId,...f}))}:name==='submit_consistency_check'?{verdict:'consistent',issues:[]}:doc;
 const args=JSON.stringify({result}),encoder=new TextEncoder();let stopped=false;
 return new Response(new ReadableStream({async start(c){try{for(let n=0;n<args.length;n+=80){if(stopped)return;c.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,...(n===0?{id:'test',type:'function'}:{}),function:{...(n===0?{name}:{}),arguments:args.slice(n,n+80)}}]},finish_reason:null}]})+'\n\n'));await new Promise(r=>setTimeout(r,150));}if(!stopped){c.enqueue(encoder.encode('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n'));c.close();}}catch{if(!stopped)c.close();}},cancel(){stopped=true;}}),{headers:{'content-type':'text/event-stream'}});
}});
const db=await mf.getD1Database('DB');for(const f of(await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()){const sql=await readFile('drizzle/'+f,'utf8');await db.batch(sql.split('--> statement-breakpoint').filter(s=>s.trim()).map(s=>db.prepare(s)));}
await mf.dispatchFetch('http://localhost/api/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'本地流式测试',email:'stream@example.test',password:'Local-QA-only-2026!'})});
console.log('Isolated fixture preview ready at '+await mf.ready);
process.on('SIGTERM',async()=>{await mf.dispose();process.exit(0)});
