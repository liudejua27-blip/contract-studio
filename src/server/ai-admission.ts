import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {AppError} from './db';
const bounded=(raw:string|undefined,fallback:number,max:number)=>Math.min(max,Math.max(1,Number(raw)||fallback));
/** Reserve and persist a user request in the same transaction as its job. Automatic
 * phase transitions and idempotent replays never consume another request. */
export async function admitAIJob(client:PoolClient,ownerId:string,contractId:string){
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',['contract-ai:'+ownerId]);
 const running=await client.query<{n:string}>(`SELECT count(*) AS n FROM contracts WHERE owner_id=$1 AND id<>$2 AND workflow->'job'->>'status' IN ('pending','running')`,[ownerId,contractId]);
 if(Number(running.rows[0].n)>=bounded(process.env.CONTRACT_AI_MAX_ACTIVE_PER_USER,1,10))throw new AppError(429,'你还有合同正在处理。完成或停止后，可以继续这份合同；输入内容已保留。','AI_CONCURRENCY_LIMIT');
 const limit=bounded(process.env.CONTRACT_AI_REQUESTS_PER_HOUR,40,1000);
 const counter=await client.query<{attempts:number}>(`INSERT INTO auth_rate_limits(scope,key_hash,window_started_at,attempts) VALUES ('contract_ai',$1,now(),1)
 ON CONFLICT(scope,key_hash) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.window_started_at<=now()-interval '1 hour' THEN 1 ELSE auth_rate_limits.attempts+1 END,
 window_started_at=CASE WHEN auth_rate_limits.window_started_at<=now()-interval '1 hour' THEN now() ELSE auth_rate_limits.window_started_at END,updated_at=now() RETURNING attempts`,[createHash('sha256').update(ownerId).digest('hex')]);
 if(counter.rows[0].attempts>limit)throw new AppError(429,'本小时起草请求较多，请稍后继续。已有合同和输入内容已保留。','AI_RATE_LIMITED');
}
