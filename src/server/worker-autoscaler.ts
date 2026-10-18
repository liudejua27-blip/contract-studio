import {desiredWorkers} from './worker-config';

export interface ManagedWorker {stop():Promise<void>}
export function createWorkerAutoscaler(deps:{
  metrics:()=>Promise<{ready:number;running:number;globalConcurrency:number;slotsPerWorker?:number}>;
  start:(onExit:()=>void)=>ManagedWorker;
  localConcurrency:number;min:number;max:number;cooldownMs:number;
  now?:()=>number;
  report?:(event:{event:string;workers:number;desired:number})=>void;
}) {
  const workers=new Map<number,{handle:ManagedWorker;draining:boolean}>();
  let sequence=0,stopped=false,scaling:Promise<void>|undefined,belowSince:number|undefined;
  const now=deps.now??Date.now;
  const activeCount=()=>[...workers.values()].filter(w=>!w.draining).length;
  async function run() {
    const metrics=await deps.metrics();if(stopped)return;
    const desired=desiredWorkers(metrics.ready,metrics.running,metrics.slotsPerWorker??deps.localConcurrency,metrics.globalConcurrency,deps.min,deps.max);
    if(desired>=activeCount())belowSince=undefined;
    // Count draining processes toward the maximum until they actually exit.
    while(activeCount()<desired&&workers.size<deps.max){
      const id=++sequence;const handle=deps.start(()=>workers.delete(id));
      workers.set(id,{handle,draining:false});
      deps.report?.({event:'worker_scale_up',workers:workers.size,desired});
    }
    if(desired<activeCount()){
      belowSince??=now();
      if(now()-belowSince>=deps.cooldownMs){
        const worker=[...workers.values()].reverse().find(w=>!w.draining)!;
        worker.draining=true;belowSince=now();
        // SIGTERM stops admission but lets the current model/file operations finish.
        void worker.handle.stop().catch(()=>{});
        deps.report?.({event:'worker_scale_down',workers:activeCount(),desired});
      }
    }
  }
  return {
    get size(){return workers.size;},
    get activeCount(){return activeCount();},
    tick(){if(stopped)return Promise.resolve();if(!scaling)scaling=run().finally(()=>{scaling=undefined;});return scaling;},
    async stop(){stopped=true;await scaling?.catch(()=>{});await Promise.allSettled([...workers.values()].map(w=>w.handle.stop()));},
  };
}
