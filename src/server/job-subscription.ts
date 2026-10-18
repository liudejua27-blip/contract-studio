import {getProgressSnapshot} from './progress-batcher';
import {getContractForRoute} from './contracts';
import {AppError} from './db';
import {agentStreamResponse} from './agent/http-stream';
import type {GenerationJob,User,Contract} from '../lib/types';
import type {SavedProgress} from './background-jobs';

export function publicJob(job:GenerationJob):GenerationJob{
 const {content,repairFeedback,lease,continuation,...publicFields}=job;void content;void repairFeedback;void lease;void continuation;return publicFields;
}
/** A durable latest snapshot is enough to recover the visible document. No raw model
 * reasoning is stored here. Reconnection replaces the preview, so no tokens duplicate. */
export async function jobSubscription(actor:User,contractId:string,jobId:string){
 const initial=await getContractForRoute(actor,contractId);
 if(actor.role!=='client'||initial.ownerId!==actor.id)throw new AppError(403,'仅合同所有者可查看起草进度。','FORBIDDEN');
 if(initial.workflow?.job?.id!==jobId)throw new AppError(404,'任务不存在。','JOB_NOT_FOUND');
 return observeJob(()=>getContractForRoute(actor,contractId),async()=>undefined,jobId,1000,25000,()=>getProgressSnapshot(actor,contractId));
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
    if(snapshot.phase===job.phase&&job.status==='running')emit({type:'activity',label:snapshot.label});
    emit({type:'preview',text:snapshot.text});
   }
   const stateKey=job.phase+':'+job.status;
   if(phase!==stateKey){phase=stateKey;if(job.status==='pending')emit({type:'activity',label:job.nextAttemptAt?'遇到临时连接问题，稍后自动继续':'任务已保存，正在排队处理；离开页面也会继续'});else if(snapshot?.phase!==job.phase)emit({type:'activity',label:({understand:'正在理解交易',generate:'正在起草条款',verify:'正在核对约定',export:'正在保存 Word'})[job.phase]});}
   if(!['pending','running'].includes(job.status)||Date.now()>=end)return contract||await load();
   await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,intervalMs);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();});
  }
 });
}
