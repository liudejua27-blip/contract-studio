import type {AgentStreamEvent} from './agent-stream';
import type {GenerationJob} from './types';

export type AgentView={jobId:string;phase:GenerationJob['phase'];status:GenerationJob['status'];label:string;text:string;activities:string[];createdAt:string;error?:string};
export const phaseLabels={understand:'正在理解交易',generate:'正在起草条款',verify:'正在核对约定',export:'正在保存 Word'};

/** Per-workspace transient projection. Only subscribers to this contract receive token updates. */
export function createAgentViewStore(){
 const views=new Map<string,AgentView>(),listeners=new Map<string,Set<()=>void>>(),tokens=new Map<string,number>();
 let sequence=0;
 const publish=(id:string,value:AgentView)=>{views.set(id,value);listeners.get(id)?.forEach(f=>f());};
 return {
  get:(id:string)=>views.get(id),
  subscribe(id:string,fn:()=>void){const set=listeners.get(id)||new Set();set.add(fn);listeners.set(id,set);return()=>{set.delete(fn);if(!set.size)listeners.delete(id);};},
  begin(id:string,job:GenerationJob){
   const old=views.get(id),same=old?.jobId===job.id;
   const label=phaseLabels[job.phase];const token=++sequence;tokens.set(id,token);
   publish(id,{jobId:job.id,phase:job.phase,status:'running',label,text:same?old.text:'',activities:same?[...old.activities.filter(x=>x!==label),label].slice(-8):[label],createdAt:job.createdAt});return token;
  },
  event(id:string,token:number,event:AgentStreamEvent){
   const old=views.get(id);if(!old||tokens.get(id)!==token||old.status!=='running')return;
   if(event.type==='job'&&event.job.id===old.jobId)publish(id,{...old,phase:event.job.phase,error:event.job.error});
   if(event.type==='activity')publish(id,{...old,label:event.label,activities:[...old.activities.filter(x=>x!==event.label),event.label].slice(-8)});
   // An empty reset begins a new candidate, but keeps the old preview until new content arrives.
   if(event.type==='preview'&&event.text)publish(id,{...old,text:event.text});
   if(event.type==='preview_delta'&&event.text)publish(id,{...old,text:event.replace?event.text:old.text+event.text});
  },
  settle(id:string,job:GenerationJob){
   const old=views.get(id);if(!old||old.jobId!==job.id)return;
   if(old.status==='cancelled'&&job.status!=='cancelled')return;
   if(['completed','failed','cancelled'].includes(job.status))tokens.delete(id);
   publish(id,{...old,phase:job.phase,status:job.status,error:job.error});
  },
  interrupted(id:string,token:number,error:string){const old=views.get(id);if(old&&tokens.get(id)===token)publish(id,{...old,status:'failed',error});},
  clear(){tokens.clear();views.clear();listeners.forEach(set=>set.forEach(f=>f()));},
 };
}
export type AgentViewStore=ReturnType<typeof createAgentViewStore>;
