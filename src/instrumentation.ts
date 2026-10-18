/** Runs with the long-lived Node server, including after a process restart. */
export async function register(){
 if(process.env.NEXT_RUNTIME==='nodejs'&&process.env.NEXT_PHASE!=='phase-production-build'){
  const {startBackgroundJobs}=await import('./server/background-jobs');
  await startBackgroundJobs();
 }
}
