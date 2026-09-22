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

export async function executeBackgroundJob(actor:User,contractId:string,jobId:string){
 const progress=await query<{agent_progress:SavedProgress|null}>('SELECT agent_progress FROM contracts WHERE id=$1',[contractId]);
 const writer=createProgressWriter(async(value,lease)=>{
  await query(`UPDATE contracts SET agent_progress=$1::jsonb WHERE id=$2
   AND workflow->'job'->>'id'=$3 AND workflow->'job'->>'lease'=$4
   AND workflow->'job'->>'status' IN ('pending','running','completed')`,[JSON.stringify(value),contractId,jobId,lease]);
 },progress.rows[0]?.agent_progress||undefined);
 try{return await controlWorkflow({...workflowStore(actor,contractId),onClaim:writer.claim,onEvent:writer.emit},actor,jobId,'run');}
 finally{await writer.flush();}
}

/** Optimistic workflow revision claims the lease before any model call. Competing
 * Node processes may scan the same row, but only the successful claimant executes. */
export function createBackgroundLoop(deps:{scan:()=>Promise<{id:string;jobId:string;actor:User}[]>;execute:(actor:User,id:string,jobId:string)=>Promise<unknown>;concurrency?:number;pollMs?:number}){
 const active=new Map<string,Promise<void>>();let scanning=false,stopped=false;
 const tick=async()=>{if(stopped||scanning)return;scanning=true;try{
  if(active.size>=(deps.concurrency||2))return;
  for(const row of await deps.scan()){
   if(stopped||active.size>=(deps.concurrency||2))break;if(active.has(row.id))continue;
   const task=Promise.resolve().then(()=>deps.execute(row.actor,row.id,row.jobId)).then(()=>{}).catch(e=>{
    if(e?.code!=='CONFLICT')console.error(JSON.stringify({event:'background_job_error',job:row.jobId,code:e?.code||'EXECUTION_FAILED'}));
   }).finally(()=>{active.delete(row.id);});active.set(row.id,task);
  }
 }catch{console.error(JSON.stringify({event:'background_scan_failed'}));}finally{scanning=false;}};
 const timer=setInterval(()=>void tick(),deps.pollMs||1000);timer.unref();void tick();
 return {tick,async stop(){stopped=true;clearInterval(timer);await Promise.allSettled(active.values());}};
}

const globals=globalThis as typeof globalThis&{contractBackground?:ReturnType<typeof createBackgroundLoop>};
export function startBackgroundJobs(){
 if(!databaseConfigured()||globals.contractBackground)return;
 globals.contractBackground=createBackgroundLoop({
  scan:async()=>{
   const rows=await query<{id:string;job_id:string;actor:User}>(`SELECT c.id,c.workflow->'job'->>'id' AS job_id,
    json_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role) AS actor
    FROM contracts c JOIN users u ON u.id=c.owner_id
    WHERE NOT u.disabled AND u.role='client' AND c.workflow->'job'->>'status' IN ('pending','running') AND (
     (c.workflow->'job'->>'status'='pending' AND COALESCE(c.workflow->'job'->>'nextAttemptAt','') <= $1)
     OR (c.workflow->'job'->>'status'='running' AND COALESCE(c.workflow->'job'->>'leaseUntil','') <= $1))
    ORDER BY c.updated_at,c.id LIMIT 20`,[new Date().toISOString()]);
   return rows.rows.map(r=>({id:r.id,jobId:r.job_id,actor:r.actor}));
  },execute:executeBackgroundJob,
 });
}
