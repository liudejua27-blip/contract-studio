import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createWorkerAutoscaler} from '../src/server/worker-autoscaler';
import {workerConfig,autoscaleConfig,integerSetting} from '../src/server/worker-config';
import {schedulerMetrics,initializeSchedulerPolicy} from '../src/server/worker-scheduler';
import {closeDatabase} from '../src/server/db';

async function main(){
  const local=workerConfig(),scale=autoscaleConfig();
  await initializeSchedulerPolicy();
  const shutdownMs=integerSetting(process.env,'CONTRACT_WORKER_SHUTDOWN_MS',660000,1000,900000);
  const workerPath=fileURLToPath(new URL('./agent-worker.mjs',import.meta.url));
  const controller=createWorkerAutoscaler({
    localConcurrency:local.concurrency,min:scale.minWorkers,max:scale.maxWorkers,cooldownMs:scale.cooldownMs,
    metrics:async()=>{const m=await schedulerMetrics();return {ready:m.ready,running:Math.max(m.running,m.active),globalConcurrency:m.policy.global_concurrency,slotsPerWorker:local.concurrency-Math.min(local.concurrency-1,Math.ceil(local.concurrency*m.policy.intake_reserve/m.policy.global_concurrency))};},
    report:event=>console.info(JSON.stringify(event)),
    start:onExit=>{
      const child=spawn(process.execPath,[workerPath],{env:process.env,stdio:'inherit'});
      let exited=false,stopPromise:Promise<void>|undefined,finish!:()=>void;
      const done=new Promise<void>(resolve=>{finish=resolve;});
      const close=()=>{if(exited)return;exited=true;finish();onExit();};
      child.once('exit',close);child.once('error',close);
      return {stop(){if(!stopPromise)stopPromise=(async()=>{
        if(exited)return;
        child.kill('SIGTERM');
        const timer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},shutdownMs);
        try{await done;}finally{clearTimeout(timer);}
      })();return stopPromise;}};
    },
  });
  let stopping=false;
  const tick=()=>void controller.tick().catch(()=>console.error(JSON.stringify({event:'autoscale_metrics_failed'})));
  const timer=setInterval(tick,scale.intervalMs);
  const stop=()=>{if(stopping)return;stopping=true;clearInterval(timer);void controller.stop().finally(()=>closeDatabase()).catch(()=>{process.exitCode=1;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);tick();
}
main().catch(async()=>{console.error(JSON.stringify({event:'autoscaler_start_failed'}));await closeDatabase();process.exitCode=1;});
