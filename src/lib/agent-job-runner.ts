import type {Contract} from './types';
import type {AgentEventSink} from './agent-stream';
import type {AgentViewStore} from './agent-view-store';

/** One subscription per contract. Server jobs run independently; the browser subscribes to saved progress. */
export function createAgentJobRunner(deps:{store:AgentViewStore;load:(id:string)=>Promise<Contract>;stream:(path:string,emit:AgentEventSink,signal:AbortSignal)=>Promise<Contract>;update:(c:Contract)=>void;error:(id:string,message:string)=>void}){
 const active=new Map<string,AbortController>();
 const eligible=(c:Contract)=>{const j=c.workflow?.job;return j&&(j.status==='pending'||j.status==='running');};
 return {
  isRunning:(id:string)=>active.has(id),
  async run(initial:Contract){
   if(active.has(initial.id)||!eligible(initial))return;
   const id=initial.id,jobId=initial.workflow!.job!.id,controller=new AbortController();active.set(id,controller);
   let current=initial,token=0;
   try{
    // Existing server repair budget bounds normal phase advancement. Polling remains recovery only.
    for(let n=0;eligible(current)&&current.workflow?.job?.id===jobId;n++){
     if(controller.signal.aborted)return;
     token=deps.store.begin(id,current.workflow!.job!);
     const saved=await deps.stream(`contracts/${id}/jobs/${jobId}/events`,event=>deps.store.event(id,token,event),controller.signal);
     if(controller.signal.aborted)return;
     const cancelled=deps.store.get(id)?.jobId===jobId&&deps.store.get(id)?.status==='cancelled';
     if(cancelled)return;
     if(saved.workflow?.job)deps.store.settle(id,saved.workflow.job);
     deps.update(saved);current=saved;
    }
   }catch(e){
    if(controller.signal.aborted)return;
    try{const saved=await deps.load(id);if(controller.signal.aborted)return;deps.update(saved);const job=saved.workflow?.job;if(job){deps.store.settle(id,job);if(job.execution==='background'&&['pending','running'].includes(job.status)){const viewToken=deps.store.begin(id,job);deps.store.event(id,viewToken,{type:'activity',label:'正在恢复连接，后台会继续处理'});return;}if(['completed','failed','cancelled','pending'].includes(job.status))return;}}catch{}
    if(controller.signal.aborted)return;
    if(initial.workflow?.job?.execution==='background'){const reconnectToken=deps.store.begin(id,current.workflow!.job!);deps.store.event(id,reconnectToken,{type:'activity',label:'正在恢复连接，后台会继续处理'});return;}
    const message=e instanceof Error?e.message:'连接已中断，正在恢复已保存的进度。';
    deps.store.interrupted(id,token,message);deps.error(id,message);
   }finally{if(active.get(id)===controller)active.delete(id);}
  },
  disconnect(id:string){active.get(id)?.abort();active.delete(id);},
  disconnectAll(){active.forEach(c=>c.abort());active.clear();},
 };
}
