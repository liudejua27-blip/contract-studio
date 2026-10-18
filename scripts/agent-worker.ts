import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {createDistributedWorker} from '../src/server/background-jobs';
import {closeDatabase} from '../src/server/db';

async function main(){
  const id=`${hostname()}:${process.pid}:${randomUUID()}`;
  let stopping=false;
  // Register before startup so an early termination still drains/releases safely.
  const startup=createDistributedWorker(id);
  const stop=()=>{if(stopping)return;stopping=true;void startup.then(worker=>worker.stop()).finally(()=>closeDatabase()).catch(()=>{process.exitCode=1;}).finally(()=>clearInterval(keepalive));};
  const keepalive=setInterval(()=>{},60000);
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{await startup;console.info(JSON.stringify({event:'worker_ready',worker:id}));}
  catch(error){clearInterval(keepalive);throw error;}
}
main().catch(async()=>{console.error(JSON.stringify({event:'worker_start_failed',hint:'Run db:init and verify database/storage configuration.'}));await closeDatabase();process.exitCode=1;});
