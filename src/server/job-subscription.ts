import {getContractForRoute} from './contracts';
import {AppError,query} from './db';
import {agentStreamResponse} from './agent/http-stream';
import type {GenerationJob,User,Contract} from '../lib/types';
import type {SavedProgress} from './background-jobs';

export function publicJob(job:GenerationJob):GenerationJob{
 const {content,repairFeedback,lease,...publicFields}=job;void content;void repairFeedback;void lease;return publicFields;
}
/** A durable latest snapshot is enough to recover the visible document. No raw model
 * reasoning is stored here. Reconnection replaces the preview, so no tokens duplicate. */
export async function jobSubscription(actor:User,contractId:string,jobId:string){
 const initial=await getContractForRoute(actor,contractId);
 if(actor.role!=='client'||initial.ownerId!==actor.id)throw new AppError(403,'仅合同所有者可查看起草进度。','FORBIDDEN');
 if(initial.workflow?.job?.id!==jobId)throw new AppError(404,'任务不存在。','JOB_NOT_FOUND');
 return observeJob(()=>getContractForRoute(actor,contractId),async()=>{
  const result=await query<{agent_progress:SavedProgress|null}>(`SELECT c.agent_progress FROM contracts c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND u.id=$2 AND NOT u.disabled AND u.role='client'`,[contractId,actor.id]);if(!result.rows.length)throw new AppError(403,'当前账号无法继续访问起草进度。','FORBIDDEN');return result.rows[0].agent_progress||undefined;
 },jobId,500,25000,async()=>{
  const result=await query<{job:GenerationJob;agent_progress:SavedProgress|null}>(`SELECT (c.workflow->'job')-'content'-'repairFeedback'-'lease' AS job,c.agent_progress FROM contracts c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND u.id=$2 AND NOT u.disabled AND u.role='client'`,[contractId,actor.id]);
  if(!result.rows.length)throw new AppError(403,'当前账号无法继续访问起草进度。','FORBIDDEN');
  return {job:result.rows[0].job,snapshot:result.rows[0].agent_progress||undefined};
 });
}
export function observeJob(load:()=>Promise<Contract>,progress:()=>Promise<SavedProgress|undefined>,jobId:string,intervalMs=500,maxMs=25000,peek?:()=>Promise<{job?:GenerationJob;snapshot?:SavedProgress}>){
 return agentStreamResponse(async(emit,signal)=>{
  const end=Date.now()+maxMs;let revision='',phase='';
  while(true){
   const contract=peek?undefined:await load(),state=peek?await peek():undefined,job=state?.job||contract?.workflow?.job;
   if(signal.aborted||job?.id!==jobId)return contract||await load();
   const snapshot=state?state.snapshot:await progress();
   emit({type:'job',job:publicJob(job)});
   if(snapshot?.jobId===jobId&&snapshot.revision!==revision){
    revision=snapshot.revision;
    if(snapshot.phase===job.phase)emit({type:'activity',label:snapshot.label});
    emit({type:'preview',text:snapshot.text});
   }
   if(phase!==job.phase){phase=job.phase;if(snapshot?.phase!==job.phase)emit({type:'activity',label:({understand:'正在理解交易',generate:'正在起草条款',verify:'正在核对约定',export:'正在保存 Word'})[job.phase]});}
   if(!['pending','running'].includes(job.status)||Date.now()>=end)return contract||await load();
   await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,intervalMs);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
  }
 });
}
