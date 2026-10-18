import {configureSchedulerPolicy,schedulerMetrics} from '../src/server/worker-scheduler';
import {closeDatabase} from '../src/server/db';
async function main(){
  try{
    if(process.argv.includes('--configure'))await configureSchedulerPolicy();
    console.log(JSON.stringify(await schedulerMetrics(),null,2));
  }finally{await closeDatabase();}
}
main().catch(()=>{console.error('Unable to read/update the scheduler; verify migration and configuration.');process.exitCode=1;});
