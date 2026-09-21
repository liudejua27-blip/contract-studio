import type {Env} from './runtime';
import type {Contract,User} from '../src/lib/types';
import {jobAction,load} from './contracts';
export type AgentJobMessage={contractId:string;jobId:string};

/** The persisted contract job is the outbox. Scheduled reconciliation repairs
 * the save/send gap; queue messages are only wakeups, never authoritative state. */
export async function wakeAgent(env:Env,c:Contract){
 const j=c.workflow?.job;
 if(!env.AGENT_QUEUE||!j||j.status!=='pending')return;
 try{await env.AGENT_QUEUE.send({contractId:c.id,jobId:j.id});}
 catch{console.warn(JSON.stringify({event:'agent_queue_deferred',jobId:j.id}));}
}
export async function consumeAgentJob(env:Env,input:AgentJobMessage){
 const row=await env.DB.prepare('SELECT owner_id FROM contracts WHERE id=?').bind(input.contractId).first<{owner_id:string}>();
 if(!row)return;
 const actor=await env.DB.prepare("SELECT id,name,email,role FROM users WHERE id=? AND disabled=0 AND role='client'").bind(row.owner_id).first<User>();
 if(!actor)return;
 let {contract:c}=await load(env,input.contractId,actor);
 let j=c.workflow?.job;
 if(!j||j.id!==input.jobId||!['pending','running'].includes(j.status))return;
 if(j.status==='running'){
  if(Date.parse(j.leaseUntil||'')>Date.now())return;
  c=await jobAction(env,actor,c.id,j.id,'run');j=c.workflow!.job!;
  if(j.code!=='JOB_INTERRUPTED'||j.attempt>=10)return;
  c=await jobAction(env,actor,c.id,j.id,'retry');
 }
 c=await jobAction(env,actor,c.id,input.jobId,'run');
 await wakeAgent(env,c);
}
export async function reconcileAgentJobs(env:Env){
 if(!env.AGENT_QUEUE)return;
 const rows=await env.DB.prepare("SELECT id,state FROM contracts WHERE json_extract(state,'$.workflow.job.status')='pending' OR (json_extract(state,'$.workflow.job.status')='running' AND json_extract(state,'$.workflow.job.leaseUntil')<=?) ORDER BY updated_at ASC LIMIT 100").bind(new Date().toISOString()).all<{id:string;state:string}>();
 for(const row of rows.results){const c=JSON.parse(row.state) as Contract;try{await env.AGENT_QUEUE.send({contractId:row.id,jobId:c.workflow!.job!.id})}catch{console.warn(JSON.stringify({event:'agent_queue_reconcile_failed',contractId:row.id}));}}
}
