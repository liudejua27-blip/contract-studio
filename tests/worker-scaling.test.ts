import test from 'node:test';
import assert from 'node:assert/strict';
import {workerConfig,desiredWorkers} from '../src/server/worker-config';
import {createWorkerAutoscaler} from '../src/server/worker-autoscaler';
import {createProgressBatcher} from '../src/server/progress-batcher';
import {createBackgroundLoop} from '../src/server/background-jobs';
import {observeJob} from '../src/server/job-subscription';
import type {Contract,User} from '../src/lib/types';

test('invalid concurrency is rejected and replica demand respects the global budget',()=>{
  assert.throws(()=>workerConfig({CONTRACT_WORKER_CONCURRENCY:'NaN'}));
  assert.throws(()=>workerConfig({CONTRACT_AI_GLOBAL_CONCURRENCY:'2',CONTRACT_AI_INTAKE_RESERVE:'2'}));
  assert.equal(desiredWorkers(100,0,10,40,1,8),4);
  assert.equal(desiredWorkers(0,0,10,40,1,8),1);
  assert.equal(desiredWorkers(0,20,10,40,1,8),2);
});

test('autoscaler grows on backlog, replaces crashes and drains only after cooldown',async()=>{
  let ready=100,running=0,clock=0,starts=0,stops=0;
  const exits:Array<()=>void>=[];
  const scaler=createWorkerAutoscaler({localConcurrency:10,min:1,max:4,cooldownMs:1000,now:()=>clock,
    metrics:async()=>({ready,running,globalConcurrency:40}),
    start:onExit=>{starts++;exits.push(onExit);return {stop:async()=>{stops++;onExit();}};},
  });
  try{
    await Promise.all([scaler.tick(),scaler.tick()]);assert.equal(starts,4);
    exits[0]();await scaler.tick();assert.equal(starts,5);assert.equal(scaler.size,4);
    ready=0;running=30;await scaler.tick();assert.equal(stops,0);
    clock=500;await scaler.tick();assert.equal(stops,0);
    ready=100;clock=1100;await scaler.tick();assert.equal(stops,0,'load recovery cancels the downscale timer');
    ready=0;running=0;await scaler.tick();clock=2101;await scaler.tick();assert.equal(stops,1);
    assert.equal(scaler.size,3);
  }finally{await scaler.stop();}
  assert.equal(scaler.size,0);
});

test('shutdown releases claims acquired by a scan that was still in flight',async()=>{
  let scanned!:()=>void,finish!:()=>void,released=0,executed=0;
  const ready=new Promise<void>(r=>scanned=r),gate=new Promise<void>(r=>finish=r);
  const loop=createBackgroundLoop({scan:async()=>{scanned();await gate;return[{id:'c',jobId:'j',actor:{id:'u',name:'',email:'',role:'client' as const}}];},
    execute:async()=>{executed++;},discard:async()=>{released++;}});
  await ready;const stopping=loop.stop();finish();await stopping;
  assert.equal(released,1);assert.equal(executed,0);
});

test('100 concurrent progress subscriptions use one query and still isolate accounts',async()=>{
  let reads=0;
  const actor:User={id:'owner',name:'',email:'',role:'client'};
  const batch=createProgressBatcher(async ids=>{reads++;return ids.filter(id=>id!=='disabled').map(id=>({id,owner_id:'owner'}));},1);
  await Promise.all(Array.from({length:100},(_,i)=>batch(actor,'contract-'+i)));
  assert.equal(reads,1);
  await assert.rejects(batch({...actor,id:'outsider'},'contract-1'),(e:any)=>e.code==='FORBIDDEN');
  await assert.rejects(batch(actor,'disabled'),(e:any)=>e.code==='FORBIDDEN');
});

test('pending jobs disclose queueing rather than falsely claiming model execution',async()=>{
  const contract:Contract={id:'c',ownerId:'u',ownerName:'',title:'',messages:[],versions:[],reviews:[],createdAt:'',updatedAt:'',workflow:{job:{id:'j',messageId:'m',versionId:'v',phase:'generate',status:'pending',attempt:0,createdAt:'',updatedAt:'',execution:'background'}}};
  const response=observeJob(async()=>contract,async()=>undefined,'j',1,1);
  assert.match(await response.text(),/正在排队处理/);
});

test('a saturated worker resumes scanning after its active stage completes',async()=>{
 let finish!:()=>void,entered!:()=>void,executions=0;
 const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>finish=r);
 const row={id:'c',jobId:'j',actor:{id:'u',name:'',email:'',role:'client' as const}};
 const loop=createBackgroundLoop({concurrency:1,pollMs:10000,scan:async()=>executions<2?[row]:[],execute:async()=>{executions++;entered();await gate;}});
 try{await ready;await loop.tick();finish();for(let n=0;n<20&&loop.activeCount;n++)await new Promise(r=>setTimeout(r,1));await loop.tick();for(let n=0;n<20&&executions<2;n++)await new Promise(r=>setTimeout(r,1));assert.equal(executions,2);}finally{finish();await loop.stop();}
});
