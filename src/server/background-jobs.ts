import {randomUUID} from 'node:crypto';
import {workerConfig} from './worker-config';
import {claimBackgroundJobs,renewWorkerClaims,releaseWorkerClaim,initializeSchedulerPolicy,type WorkerClaim} from './worker-scheduler';
import {databaseConfigured,query} from './db';
import {workflowStore} from './contracts';
import {controlWorkflow} from './workflow';
import type {GenerationJob,User} from '../lib/types';
import type {AgentEventSink} from '../lib/agent-stream';

export interface SavedProgress {jobId:string;phase:GenerationJob['phase'];label:string;text:string;revision:string}

/** Coalesce token updates; persistence is serialized and fenced by the current lease. */
export function createProgressWriter(write:(value:SavedProgress,lease:string)=>Promise<void>,initial?:SavedProgress,intervalMs=200){
 let value=initial,lease='',dirty=false,timer:ReturnType<typeof setTimeout>|undefined,chain=Promise.resolve();
 const flush=()=>{clearTimeout(timer);timer=undefined;if(!dirty||!value)return chain;const snapshot={...value},owner=lease;dirty=false;
  chain=chain.then(()=>write(snapshot,owner)).catch(()=>{console.warn(JSON.stringify({event:'agent_progress_save_failed',job:snapshot.jobId}));});return chain;};
 const schedule=()=>{dirty=true;if(!timer)timer=setTimeout(()=>void flush(),intervalMs);};
 return {
  claim(job:GenerationJob){lease=job.lease!;value={jobId:job.id,phase:job.phase,label:'正在继续处理',text:value?.jobId===job.id&&['verify','export'].includes(job.phase)?value.text:'',revision:crypto.randomUUID()};schedule();},
  emit:((event)=>{if(!value)return;if(event.type==='activity')value.label=event.label;else if(event.type==='preview')value.text=event.text;else if(event.type==='preview_delta')value.text=event.replace?event.text:value.text+event.text;else return;value.revision=crypto.randomUUID();schedule();}) as AgentEventSink,
  flush,
 };
}

export async function executeBackgroundJob(actor:User,contractId:string,jobId:string,claim?:WorkerClaim){
 const progress=await query<{agent_progress:SavedProgress|null}>('SELECT agent_progress FROM contracts WHERE id=$1',[contractId]);
 const writer=createProgressWriter(async(value,lease)=>{
  await query(`UPDATE contracts SET agent_progress=$1::jsonb WHERE id=$2
   AND workflow->'job'->>'id'=$3 AND workflow->'job'->>'lease'=$4
   AND workflow->'job'->>'status' IN ('pending','running','completed')`,[JSON.stringify(value),contractId,jobId,lease]);
 },progress.rows[0]?.agent_progress||undefined);
 try{return await controlWorkflow({...workflowStore(actor,contractId,claim?.token),onClaim:writer.claim,onEvent:writer.emit},actor,jobId,'run');}
 finally{await writer.flush();}
}

/** Optimistic workflow revision claims the lease before any model call. Competing
 * Node processes may scan the same row, but only the successful claimant executes. */
export function createBackgroundLoop<Row extends {id:string;jobId:string;actor:User}>(deps:{scan:(capacity:number)=>Promise<Row[]>;execute:(actor:User,id:string,jobId:string,row:Row)=>Promise<unknown>;discard?:(row:Row)=>Promise<void>;concurrency?:number;pollMs?:number}){
 const active=new Map<string,Promise<void>>();let scanning:Promise<void>|undefined,stopped=false;
 const concurrency=deps.concurrency??2;
 const tick=():Promise<void>=>{
  if(stopped)return Promise.resolve();
  if(scanning)return scanning;
  scanning=Promise.resolve().then(async()=>{try{
   if(active.size>=concurrency)return;
   for(const row of await deps.scan(concurrency-active.size)){
    if(stopped||active.size>=concurrency||active.has(row.id)){await deps.discard?.(row);continue;}
    const task=Promise.resolve().then(()=>deps.execute(row.actor,row.id,row.jobId,row)).then(()=>{}).catch(e=>{
     if(e?.code!=='CONFLICT')console.error(JSON.stringify({event:'background_job_error',job:row.jobId,code:e?.code||'EXECUTION_FAILED'}));
    }).finally(()=>{active.delete(row.id);});active.set(row.id,task);
   }
  }catch{console.error(JSON.stringify({event:'background_scan_failed'}));}}).finally(()=>{scanning=undefined;});
  return scanning;
 };
 const timer=setInterval(()=>void tick(),deps.pollMs??1000);timer.unref();void tick();
 return {tick,get activeCount(){return active.size;},async stop(){stopped=true;clearInterval(timer);await scanning;await Promise.allSettled(active.values());}};
}

export async function createDistributedWorker(workerId=crypto.randomUUID(),options:{execute?:typeof executeBackgroundJob;concurrency?:number;pollMs?:number}={}){
 const config=workerConfig();await initializeSchedulerPolicy();
 const held=new Set<string>();let renewing=false;
 const heartbeat=setInterval(()=>{if(renewing||!held.size)return;renewing=true;
  void renewWorkerClaims([...held]).catch(()=>console.error(JSON.stringify({event:'worker_heartbeat_failed',worker:workerId}))).finally(()=>{renewing=false;});
 },config.leaseMs/3);heartbeat.unref();
 const release=async(row:WorkerClaim)=>{held.delete(row.token);await releaseWorkerClaim(row.token);};
 const loop=createBackgroundLoop({
  concurrency:options.concurrency??config.concurrency,pollMs:options.pollMs??config.pollMs,
  scan:async capacity=>{const rows=await claimBackgroundJobs(workerId,capacity,options.concurrency??config.concurrency);for(const row of rows)held.add(row.token);return rows;},
  discard:release,
  execute:async(actor,id,jobId,row)=>{try{return await (options.execute??executeBackgroundJob)(actor,id,jobId,row);}finally{await release(row);}},
 });
 return {tick:loop.tick,get activeCount(){return loop.activeCount;},async stop(){try{await loop.stop();}finally{clearInterval(heartbeat);}}};
}

const globals=globalThis as typeof globalThis&{contractBackground?:Promise<Awaited<ReturnType<typeof createDistributedWorker>>>};
export async function startBackgroundJobs(){
 if(!databaseConfigured()||process.env.CONTRACT_WORKER_MODE==='external')return;
 if(!globals.contractBackground)globals.contractBackground=createDistributedWorker('web-'+randomUUID()).catch(error=>{delete globals.contractBackground;throw error;});
 return globals.contractBackground;
}
