/** Offline reconciliation: never calls a provider; callback records cover missing wire meters. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
const sources=[['three-party-delivery','.data/qa/complex-agent-20260926'],['material-rights-conflict','.data/qa/complex-agent-20260926-material'],['four-party-revenue','.data/qa/complex-agent-20260926']];
async function main(){
 const cases:any[]=[];
 for(const [id,root] of sources){
  const dir=join(root,id),result=JSON.parse(await readFile(join(dir,'result.json'),'utf8')),reported=JSON.parse(await readFile(join(dir,'model-calls.json'),'utf8'));
  let wire:any[]=[];try{wire=JSON.parse(await readFile(join(dir,'wire-calls.json'),'utf8'));}catch{}
  let low=0,high=0,input=0,output=0,unknown=0,cacheUnknown=0,hitTotal=0,reasoningKnown=0;
  const breakdown=reported.map((call:any,n:number)=>{
   const full=wire[n]?.usage,u=full||{prompt_tokens:call.inputTokens,completion_tokens:call.outputTokens};
   if(!Number.isFinite(u.prompt_tokens)||!Number.isFinite(u.completion_tokens)){unknown++;return {index:n+1,...call,cost:null};}
   const hit=full?.prompt_cache_hit_tokens??full?.prompt_tokens_details?.cached_tokens,cacheKnown=Number.isFinite(hit);if(!cacheKnown)cacheUnknown++;
   input+=u.prompt_tokens;output+=u.completion_tokens;hitTotal+=cacheKnown?hit:0;reasoningKnown+=full?.completion_tokens_details?.reasoning_tokens||0;
   const local=new Date(Date.parse(call.at)+8*3600000);if(![0,6].includes(local.getUTCDay()))throw new Error('This snapshot only implements the verified weekend price; check current schedule before reuse.');
   const min=((cacheKnown?hit*.02+(u.prompt_tokens-hit):u.prompt_tokens*.02)+u.completion_tokens*4)/1e6,max=((cacheKnown?hit*.02+(u.prompt_tokens-hit):u.prompt_tokens)+u.completion_tokens*4)/1e6;low+=min;high+=max;
   return {index:n+1,...call,providerUsage:full||null,estimatedCnyLow:min,estimatedCnyHigh:max};
  });
  const transcript=await readFile(join(dir,'checkpoint.jsonl'),'utf8');const tools:any[]=[],errors:any[]=[];
  for(const line of transcript.split('\n').filter(Boolean)){const entry=JSON.parse(line),m=entry.message;if(m?.role==='toolResult'){const item={name:m.toolName,error:!!m.isError,at:entry.timestamp,text:m.content?.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n')};tools.push({name:item.name,error:item.error});if(item.error)errors.push(item);}}
  const trunc=breakdown.filter((x:any)=>x.status==='AI_OUTPUT_TRUNCATED');const stageMap:any={};for(const call of breakdown){const s=stageMap[call.step]??={calls:0,inputTokens:0,outputTokens:0,modelMs:0};s.calls++;s.inputTokens+=call.inputTokens||0;s.outputTokens+=call.outputTokens||0;s.modelMs+=call.durationMs;}
  const item={id,name:result.name,status:result.status,error:result.error,durationMs:result.durationMs,versions:result.versions,calls:reported.length,inputTokens:input,outputTokens:output,totalTokens:input+output,unknownUsageCalls:unknown,cacheUnknownCalls:cacheUnknown,knownCacheHitTokens:hitTotal,knownReasoningTokens:reasoningKnown,estimatedCnyLow:low,estimatedCnyHigh:high,truncatedCalls:trunc.length,truncatedOutputTokens:trunc.reduce((a:number,x:any)=>a+(x.outputTokens||0),0),truncatedCostLow:trunc.reduce((a:number,x:any)=>a+(x.estimatedCnyLow||0),0),truncatedCostHigh:trunc.reduce((a:number,x:any)=>a+(x.estimatedCnyHigh||0),0),steps:result.steps.map((s:any)=>({label:s.label,status:s.status,durationMs:s.durationMs,error:s.error,missing:s.intake?.missing,conflicts:s.intake?.conflicts})),stages:stageMap,toolCounts:Object.fromEntries([...new Set(tools.map(t=>t.name))].map(name=>[name,tools.filter(t=>t.name===name).length])),toolValidationErrors:errors,breakdown,artifacts:resolve(dir),meterScope:wire.length?'provider cache details captured':'callback totals captured; input cache mix unknown; raw result.usage was superseded by this reconciliation'};
  await writeFile(join(dir,'reconciled-metrics.json'),JSON.stringify(item,null,2),{mode:0o600});cases.push(item);
 }
 const sums=['calls','inputTokens','outputTokens','totalTokens','estimatedCnyLow','estimatedCnyHigh','truncatedCalls','truncatedOutputTokens','truncatedCostLow','truncatedCostHigh'] as const;
 const totals=Object.fromEntries(sums.map(k=>[k,cases.reduce((n,c)=>n+c[k],0)]));const summary={createdAt:new Date().toISOString(),pricing:{currency:'CNY',unit:'per million tokens',cacheHit:.02,cacheMiss:1,output:4,period:'Saturday off-peak',source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',billingVerified:false},scope:'Frozen synthetic cases, real model/Pi/workflow, isolated local persistence; no server/lawyer/load acceptance. Three examples cannot estimate general success rate.',totals,cases};
 await mkdir('.data/qa/complex-agent-20260926-report',{recursive:true,mode:0o700});await writeFile('.data/qa/complex-agent-20260926-report/metrics.json',JSON.stringify(summary,null,2),{mode:0o600});console.log(JSON.stringify({totals,cases:cases.map(({id,status,error,durationMs,calls,totalTokens,estimatedCnyLow,estimatedCnyHigh,truncatedCalls,versions})=>({id,status,error,durationMs,calls,totalTokens,estimatedCnyLow,estimatedCnyHigh,truncatedCalls,versions}))},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
