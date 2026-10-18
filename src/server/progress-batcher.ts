import {query, AppError} from './db';
import type {GenerationJob, User} from '../lib/types';
import type {SavedProgress} from './background-jobs';
export interface ProgressRow {id:string;owner_id:string;job?:GenerationJob;agent_progress?:SavedProgress}

/** Concurrent subscriptions share one bounded query; every result still checks
 * the current database owner and disabled state, including after reconnect. */
export function createProgressBatcher(read:(ids:string[])=>Promise<ProgressRow[]>,delayMs=25) {
  let waiting:Array<{id:string;actor:User;resolve:(value:{job?:GenerationJob;snapshot?:SavedProgress})=>void;reject:(error:unknown)=>void}>=[];
  let timer:ReturnType<typeof setTimeout>|undefined;
  const flush=async()=>{
    timer=undefined;const batch=waiting;waiting=[];
    try{
      const rows=new Map((await read([...new Set(batch.map(r=>r.id))])).map(r=>[r.id,r]));
      for(const request of batch){
        const row=rows.get(request.id);
        if(!row||request.actor.role!=='client'||row.owner_id!==request.actor.id)request.reject(new AppError(403,'当前账号无法继续访问起草进度。','FORBIDDEN'));
        else request.resolve({job:row.job,snapshot:row.agent_progress});
      }
    }catch(error){for(const request of batch)request.reject(error);}
  };
  return (actor:User,id:string)=>new Promise<{job?:GenerationJob;snapshot?:SavedProgress}>((resolve,reject)=>{
    waiting.push({actor,id,resolve,reject});
    if(!timer)timer=setTimeout(()=>void flush(),delayMs);
  });
}

export const getProgressSnapshot=createProgressBatcher(async ids=>{
  const result=await query<ProgressRow>(`SELECT c.id,c.owner_id,
    (c.workflow->'job')-'content'-'repairFeedback'-'lease'-'continuation' AS job,c.agent_progress
    FROM contracts c JOIN users u ON u.id=c.owner_id WHERE c.id=ANY($1::text[]) AND NOT u.disabled AND u.role='client'`,[ids]);
  return result.rows;
});
