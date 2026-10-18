/** Real-provider evaluation of three frozen synthetic tasks. Requires explicit --live. */
import {Document,Packer,Paragraph} from 'docx';
import {AsyncLocalStorage} from 'node:async_hooks';
import {mkdir,writeFile,readFile,appendFile,copyFile,readdir} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {complexCases,type ComplexCase} from './complex-agent-cases';
import {startWorkflow,controlWorkflow,type WorkflowStore} from '../src/server/workflow';
import {renderContract,validateDocxBuffer,extractDocxText} from '../src/server/documents';
import {extractMaterial} from '../src/server/material-parser';
import {reviewVersionProblem} from '../src/lib/review-policy';
import {documentBody} from '../src/lib/skill-audit';
import {digest} from '../src/lib/feedback-evaluation';
import {sseData} from '../src/lib/agent-stream';
import type {Contract,User} from '../src/lib/types';
import type {MaterialDocument} from '../src/lib/materials';
import type {ModelCall} from '../src/server/operations';

type WireCall={index:number;step:string;startedAt:string;requestBytes:number;messageCount:number;roleChars:Record<string,number>;toolSchemaBytes:number;precedingToolResults:string[];model:string;httpStatus?:number;responseModel?:string;usage?:any;finish?:string;tools:string[];durationMs?:number;error?:string};
type RunContext={id:string;step:string;dir:string;wire:WireCall[];pending:Promise<void>[]};
const context=new AsyncLocalStorage<RunContext>(),originalFetch=globalThis.fetch;
const save=(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2),{mode:0o600});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString();
const emit=(c:RunContext,event:unknown)=>{const line=JSON.stringify({at:now(),case:c.id,step:c.step,...event as object});console.log(line);return appendFile(join(c.dir,'events.jsonl'),line+'\n',{mode:0o600});};
function installMeter(){
 globalThis.fetch=async(url,init)=>{
  const c=context.getStore();if(!c||!String(url).endsWith('/chat/completions'))return originalFetch(url,init);
  const b=JSON.parse(String(init?.body)),messages=b.messages||[],start=Date.now();
  const call:WireCall={index:c.wire.length+1,step:c.step,startedAt:now(),requestBytes:Buffer.byteLength(String(init?.body)),messageCount:messages.length,roleChars:messages.reduce((sum:any,m:any)=>{sum[m.role]=(sum[m.role]||0)+JSON.stringify(m).length;return sum;},{}),toolSchemaBytes:Buffer.byteLength(JSON.stringify(b.tools||[])),precedingToolResults:messages.filter((m:any)=>m.role==='tool').slice(-3).map((m:any)=>String(m.content).slice(0,6000)),model:b.model,tools:[]};c.wire.push(call);
  try{
   const response=await originalFetch(url,init);call.httpStatus=response.status;const copy=response.clone();
   const inspection=(async()=>{try{
    const consume=(v:any)=>{if(v.usage)call.usage=v.usage;if(v.model)call.responseModel=v.model;const choice=v.choices?.[0];if(choice?.finish_reason)call.finish=choice.finish_reason;for(const t of choice?.delta?.tool_calls||choice?.message?.tool_calls||[])if(t.function?.name)call.tools.push(t.function.name);if(v.error)call.error=String(v.error.code||v.error.type||'provider_error');};
    if(copy.headers.get('content-type')?.includes('text/event-stream')&&copy.body){for await(const text of sseData(copy.body)){if(text==='[DONE]')break;consume(JSON.parse(text));}}else consume(await copy.json());
   }catch(e){call.error=(e as Error).name;}finally{call.durationMs=Date.now()-start;await save(join(c.dir,'wire-calls.json'),c.wire);}})();c.pending.push(inspection);return response;
  }catch(e){call.error=(e as Error).name;call.durationMs=Date.now()-start;await save(join(c.dir,'wire-calls.json'),c.wire);throw e;}
 };
}
function usageSummary(calls:WireCall[]){
 const totals={calls:calls.length,reportedCalls:0,unknownCalls:0,inputTokens:0,outputTokens:0,cacheHitTokens:0,cacheMissTokens:0,reasoningTokens:0,cacheUnknownCalls:0,estimatedCnyLow:0,estimatedCnyHigh:0};
 for(const call of calls){const u=call.usage;if(!Number.isFinite(u?.prompt_tokens)||!Number.isFinite(u?.completion_tokens)){totals.unknownCalls++;continue;}totals.reportedCalls++;totals.inputTokens+=u.prompt_tokens;totals.outputTokens+=u.completion_tokens;totals.reasoningTokens+=u.completion_tokens_details?.reasoning_tokens||0;
  const hit=u.prompt_cache_hit_tokens??u.prompt_tokens_details?.cached_tokens,known=Number.isFinite(hit);if(!known)totals.cacheUnknownCalls++;
  const miss=known?u.prompt_tokens-hit:u.prompt_tokens;totals.cacheHitTokens+=known?hit:0;totals.cacheMissTokens+=miss;
  const local=new Date(new Date(call.startedAt).getTime()+8*3600000),weekday=local.getUTCDay(),hours=local.getUTCHours()+local.getUTCMinutes()/60;
  // This run is on a Saturday. Weekday holiday adjustments are not inferred.
  const weekend=weekday===0||weekday===6,peak=!weekend&&((hours>=9&&hours<12)||(hours>=14&&hours<18));const multiplier=peak?2:1;
  totals.estimatedCnyLow+=((known?hit*.02+miss:u.prompt_tokens*.02)+u.completion_tokens*4)/1e6*multiplier;
  totals.estimatedCnyHigh+=((known?hit*.02+miss:u.prompt_tokens)+u.completion_tokens*4)/1e6*multiplier;
 }return {...totals,totalTokens:totals.inputTokens+totals.outputTokens,pricingSource:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',currency:'CNY',billingVerified:false,complete:totals.unknownCalls===0,pricing:'Flash off-peak per million: cache-hit 0.02, cache-miss 1, output 4; peak double. Missing usage excluded, not zero cost.'};
}
async function runCase(c:ComplexCase,root:string){
 const dir=join(root,c.id);await mkdir(dir,{mode:0o700});const tracking:RunContext={id:c.id,step:'setup',dir,wire:[],pending:[]};
 return context.run(tracking,async()=>{
  const started=Date.now(),user:User={id:randomUUID(),name:'合成评测客户',email:'complex@example.test',role:'client'};
  let contract:Contract={id:randomUUID(),ownerId:user.id,ownerName:user.name,title:c.name,createdAt:now(),updatedAt:now(),versions:[],messages:[],reviews:[]},revision=0,transcript:string|null=null;
  const reported:(ModelCall&{step:string;at:string})[]=[],steps:any[]=[],documents:any[]=[],materials:MaterialDocument[]=[];
  const resumeDir=process.env.COMPLEX_RESUME_FROM?join(resolve(process.env.COMPLEX_RESUME_FROM),c.id):undefined;
  let interruptedStep:string|undefined;
  if(resumeDir){
   const savedCase=JSON.parse(await readFile(join(resumeDir,'case.json'),'utf8'));
   if(digest(savedCase)!==digest(c))throw new Error('Resume case input changed');
   contract=JSON.parse(await readFile(join(resumeDir,'latest-contract.json'),'utf8'));user.id=contract.ownerId;user.name=contract.ownerName;
   materials.push(...JSON.parse(await readFile(join(resumeDir,'materials.json'),'utf8')));
   transcript=await readFile(join(resumeDir,'checkpoint.jsonl'),'utf8');
   const events=(await readFile(join(resumeDir,'events.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
   interruptedStep=events.findLast(e=>e.event==='step_start')?.step;
   const job=contract.workflow?.job;
   if(job&&['running','failed','pending'].includes(job.status)){
    // Only this isolated synthetic store: emulate lease recovery after the old test worker stopped.
    job.status='pending';job.recoveryCount=(job.recoveryCount||0)+1;delete job.lease;delete job.leaseUntil;delete job.nextAttemptAt;
   }
   for(const name of await readdir(resumeDir))if(/^v\d+\.docx(?:\.txt)?$/.test(name)){
    await copyFile(join(resumeDir,name),join(dir,name));if(name.endsWith('.docx')){const bytes=await readFile(join(dir,name));documents.push({name,sha256:hash(bytes),bytes:bytes.length,reused:true});}
   }
   await emit(tracking,{event:'resumed',from:resumeDir,interruptedStep,jobId:job?.id});
  }
  for(const [n,m] of (resumeDir?[]:c.materials||[]).entries()){
   const bytes=m.format==='docx'?Buffer.from(await Packer.toBuffer(new Document({sections:[{children:[new Paragraph(m.text)]}]}))):Buffer.from(m.text);await writeFile(join(dir,m.name),bytes,{mode:0o600});const extracted=await extractMaterial(m.name,bytes);
   materials.push({id:randomUUID(),name:m.name,sha256:hash(bytes),purpose:m.purpose,size:bytes.length,createdAt:now(),chunkCount:extracted.chunks.length,...extracted});
  }
  await save(join(dir,'case.json'),c);await save(join(dir,'materials.json'),materials);
  const store:WorkflowStore={background:true,agentSessions:true,environment:{...process.env,CONTRACT_PI_SESSION_DIR:join(dir,'sessions')},loadMaterials:async()=>materials,loadPreferences:async()=>[],limit:async()=>{},load:async()=>({contract:structuredClone(contract),revision}),save:async(next,expected)=>{if(expected!==revision)throw new Error('Optimistic conflict');contract=structuredClone(next);revision++;await save(join(dir,'latest-contract.json'),contract);return structuredClone(contract);},sessionCheckpoint:()=>({load:async()=>transcript,save:async v=>{transcript=v;await writeFile(join(dir,'checkpoint.jsonl'),v,{mode:0o600});}}),onModelCall:async call=>{reported.push({...call,step:tracking.step,at:now()});await save(join(dir,'model-calls.json'),reported);await emit(tracking,{event:'model_call',...call});},onEvent:event=>{if(event.type==='activity')void emit(tracking,{event:'activity',label:event.label});},put:async(key,content)=>{const bytes=await renderContract(content);validateDocxBuffer(bytes);const name='v'+(contract.versions.length+1)+'.docx';await writeFile(join(dir,name),bytes,{mode:0o600});await writeFile(join(dir,name+'.txt'),extractDocxText(bytes),{mode:0o600});documents.push({name,sha256:hash(bytes),bytes:bytes.length});return hash(bytes);}};
  const drain=async()=>{let advances=0;while(advances++<20){const j=contract.workflow!.job!;if(j.status==='completed')return;if(j.status==='failed')throw new Error(j.code+': '+j.error);if(j.nextAttemptAt&&Date.parse(j.nextAttemptAt)>Date.now())await new Promise(r=>setTimeout(r,Date.parse(j.nextAttemptAt!)-Date.now()+20));await controlWorkflow(store,user,j.id,'run');}throw new Error('Phase limit');};
  const step=async(label:string,operation:()=>Promise<void>)=>{
   if(resumeDir){try{const saved=await readFile(join(resumeDir,label+'.json'),'utf8');await writeFile(join(dir,label+'.json'),saved,{mode:0o600});steps.push({label,status:'reused',from:resumeDir});return;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
   tracking.step=label;const begin=Date.now(),from=tracking.wire.length;await emit(tracking,{event:'step_start'});try{if(resumeDir&&interruptedStep===label){interruptedStep=undefined;await drain();}else await operation();steps.push({label,status:'completed',durationMs:Date.now()-begin,modelCalls:tracking.wire.length-from,intake:contract.workflow?.intake,lastReply:contract.messages.filter(m=>m.role==='assistant').at(-1)?.content,job:contract.workflow?.job});await save(join(dir,label+'.json'),contract);await emit(tracking,{event:'step_completed',durationMs:Date.now()-begin,versions:contract.versions.length,missing:contract.workflow?.intake?.missing,conflicts:contract.workflow?.intake?.conflicts});}catch(e){steps.push({label,status:'failed',durationMs:Date.now()-begin,error:(e as Error).message,job:contract.workflow?.job});throw e;}};
  const chat=async(message:string)=>{await startWorkflow(store,user,{requestId:randomUUID(),message});await drain();};
  const confirm=async()=>{const id=contract.workflow?.intake?.summaryId;if(!id)throw new Error('NO_INTAKE');await startWorkflow(store,user,{requestId:randomUUID(),confirmId:id});await drain();if(reviewVersionProblem(contract,contract.versions.at(-1)))throw new Error('WORD_NOT_SUBMITTABLE');};
  const automatic:any[]=[];let status='completed',error:string|undefined;
  try{
   for(const [n,message] of c.messages.entries())await step('intake-'+(n+1),()=>chat(message));
   await step('initial-draft',confirm);automatic.push({check:'初稿Word可读取并可送律师',passed:documents.length>0});
   await step('read-only-question',async()=>{const before=digest([contract.workflow!.intake,contract.versions]);await chat(c.question);automatic.push({check:'只读问题保持确认和版本',passed:before===digest([contract.workflow!.intake,contract.versions])});});
   for(const [n,message] of c.revisions.entries()){await step('revision-'+(n+1)+'-intake',()=>chat(message));await step('revision-'+(n+1)+'-draft',confirm);}
   automatic.push({check:'最终版可送律师',passed:!reviewVersionProblem(contract,contract.versions.at(-1))},{check:'主体名称仍留空',passed:contract.versions.at(-1)!.content!.parties.every(p=>!p.name)});
  }catch(e){status='failed';error=(e as Error).message;await emit(tracking,{event:'case_failed',error});}
  finally{await Promise.allSettled(tracking.pending);}
  const final=contract.versions.at(-1)?.content;if(final)await writeFile(join(dir,'final-contract.txt'),documentBody(final),{mode:0o600});
  const metered=reported.map((call,n)=>tracking.wire[n]||{index:n+1,step:call.step,startedAt:new Date(Date.parse(call.at)-call.durationMs).toISOString(),requestBytes:0,messageCount:0,roleChars:{},toolSchemaBytes:0,precedingToolResults:[],model:call.model,tools:[],usage:call.inputTokens===null||call.outputTokens===null?undefined:{prompt_tokens:call.inputTokens,completion_tokens:call.outputTokens},durationMs:call.durationMs});
  const result={id:c.id,name:c.name,status,error,durationMs:Date.now()-started,steps,automatic,documents,versions:contract.versions.length,usage:usageSummary(metered),modelCallRecords:reported,caseHash:digest(c),artifactHash:digest(contract),contract};await save(join(dir,'result.json'),result);await emit(tracking,{event:'case_completed',status,versions:result.versions,usage:result.usage});return result;
 });
}
async function main(){
 if(process.argv[2]!=='--live')throw new Error('Requires --live; this script uses paid model calls for exactly three synthetic cases.');
 const base=process.env.CONTRACT_AI_BASE_URL||process.env.OPENAI_BASE_URL||'https://api.deepseek.com',model=process.env.CONTRACT_AI_MODEL||process.env.OPENAI_MODEL||'deepseek-flash';if(new URL(base).hostname!=='api.deepseek.com'||model!=='deepseek-flash')throw new Error('Pricing is defined only for the currently checked DeepSeek Flash configuration.');
 const root=resolve(process.argv[3]||'.data/qa/complex-agent-'+Date.now());await mkdir(dirname(root),{recursive:true,mode:0o700});await mkdir(root,{mode:0o700});
 await save(join(root,'manifest.json'),{startedAt:now(),resumedFrom:process.env.COMPLEX_RESUME_FROM||null,scope:'Real model, actual Pi SDK/workflow/material parser/Word renderer; isolated local persistence, no browser/server/load/lawyer acceptance',model,providerOrigin:new URL(base).origin,thinking:process.env.CONTRACT_AI_THINKING||'enabled',effort:process.env.CONTRACT_AI_REASONING_EFFORT||'high',legalConfigured:!!(process.env.CONTRACT_LEGAL_SEARCH_API_KEY||process.env.TAVILY_API_KEY),cases:complexCases,sourceHashes:await Promise.all(['src/server/ai.ts','src/server/workflow.ts','src/server/agent/runtime.ts','src/server/agent/transport.ts','src/server/agent/legal-skills.generated.json','src/lib/transaction-update.ts','src/lib/task-budget.ts','scripts/complex-agent-cases.ts','scripts/eval-complex-agent.ts'].map(async file=>({file,sha256:hash(await readFile(file))}))),pricing:{source:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',checkedAt:now(),offPeak:{inputHit:.02,inputMiss:1,output:4},peak:{inputHit:.04,inputMiss:2,output:8},unit:'CNY per million tokens'}});
 installMeter();try{const selected=process.env.COMPLEX_CASES?.split(',');const cases=complexCases.filter(c=>!selected||selected.includes(c.id));if(!cases.length||selected?.some(id=>!complexCases.some(c=>c.id===id)))throw new Error('Unknown case');const outcomes=await Promise.allSettled(cases.map(c=>runCase(c,root)));const results=outcomes.map((r,n)=>r.status==='fulfilled'?r.value:{id:cases[n].id,status:'harness_failed',error:String(r.reason),versions:0,durationMs:0,usage:null});await save(join(root,'results.json'),results);console.log(JSON.stringify({event:'all_completed',output:root,cases:results.map(r=>({id:r.id,status:r.status,error:r.error,versions:r.versions,durationMs:r.durationMs,usage:r.usage}))}));if(results.some(r=>r.status!=='completed'))process.exitCode=1;}finally{globalThis.fetch=originalFetch;}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
