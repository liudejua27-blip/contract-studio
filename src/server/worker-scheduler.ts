import {randomUUID} from 'node:crypto';
import {query, withTransaction, AppError} from './db';
import {workerConfig} from './worker-config';
import type {User, GenerationJob} from '../lib/types';

export interface WorkerClaim {id: string; jobId: string; actor: User; token: string; phase: GenerationJob['phase']}
export interface SchedulerPolicy {global_concurrency: number; intake_reserve: number; max_queued: number; provider_paused_until?:Date}

export async function initializeSchedulerPolicy() {
  const config = workerConfig();
  await query(`INSERT INTO agent_scheduler_policy(id,global_concurrency,intake_reserve,max_queued)
    VALUES (1,$1,$2,$3) ON CONFLICT(id) DO NOTHING`, [config.globalConcurrency, config.intakeReserve, config.maxQueued]);
}

/** Explicit operator action; shared DB policy prevents replicas with different envs
 * from accidentally multiplying or disagreeing on the total provider budget. */
export async function configureSchedulerPolicy() {
  const config = workerConfig();
  await withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('contract-worker-capacity'))");
    await client.query(`INSERT INTO agent_scheduler_policy(id,global_concurrency,intake_reserve,max_queued) VALUES (1,$1,$2,$3)
      ON CONFLICT(id) DO UPDATE SET global_concurrency=$1,intake_reserve=$2,max_queued=$3`,
    [config.globalConcurrency, config.intakeReserve, config.maxQueued]);
  });
}

/** Reserve capacity and contracts atomically; neither model calls nor file I/O run
 * in this transaction. A short lease protects against dead executors. */
export async function claimBackgroundJobs(workerId: string, capacity: number, localConcurrency=workerConfig().concurrency): Promise<WorkerClaim[]> {
  if (capacity <= 0) return [];
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('contract-worker-capacity'))");
    const policy = (await client.query<SchedulerPolicy>('SELECT * FROM agent_scheduler_policy WHERE id=1')).rows[0];
    if (!policy) throw new AppError(503, '后台任务尚未初始化。', 'WORKER_NOT_CONFIGURED');
    await client.query('DELETE FROM agent_worker_leases WHERE expires_at<=now()');
    const counts = (await client.query<{total:number;bulk:number}>(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE phase<>'understand')::int AS bulk FROM agent_worker_leases`)).rows[0];
    let slots = Math.min(capacity, policy.global_concurrency - counts.total);
    const localBulk=(await client.query<{n:number}>("SELECT count(*)::int AS n FROM agent_worker_leases WHERE worker_id=$1 AND phase<>'understand'",[workerId])).rows[0].n;
    const localReserve=Math.min(localConcurrency-1,Math.ceil(localConcurrency*policy.intake_reserve/policy.global_concurrency));
    let bulkSlots = Math.max(0, Math.min(policy.global_concurrency - policy.intake_reserve - counts.bulk,localConcurrency-localReserve-localBulk));
    if (slots <= 0) return [];
    const result: WorkerClaim[] = [];
    // Fixed capacity for long work leaves room for interactive questions. FIFO
    // within each lane prevents a constant stream of questions starving drafts.
    for (const lane of ['bulk', 'understand'] as const) {
      const limit = lane === 'understand' ? slots : Math.min(slots, bulkSlots);
      if (!limit) continue;
      const rows = await client.query<{id:string;job_id:string;phase:GenerationJob['phase'];actor:User}>(`SELECT c.id,
        c.workflow->'job'->>'id' AS job_id,c.workflow->'job'->>'phase' AS phase,
        json_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role) AS actor
        FROM contracts c JOIN users u ON u.id=c.owner_id
        WHERE NOT u.disabled AND u.role='client'
        AND c.workflow->'job'->>'status' IN ('pending','running')
        AND (c.workflow->'job'->>'phase'='understand')=$1
        AND ($4::timestamptz IS NULL OR $4<=now() OR c.workflow->'job'->>'phase'='export')
        AND NOT EXISTS(SELECT 1 FROM agent_worker_leases l WHERE l.contract_id=c.id)
        AND ((c.workflow->'job'->>'status'='pending' AND COALESCE(c.workflow->'job'->>'nextAttemptAt','') <= $2)
          OR (c.workflow->'job'->>'status'='running' AND COALESCE(c.workflow->'job'->>'leaseUntil','') <= $2))
        ORDER BY c.updated_at,c.id LIMIT $3 FOR UPDATE OF c SKIP LOCKED`,
      [lane === 'understand', new Date().toISOString(), limit, policy.provider_paused_until??null]);
      for (const row of rows.rows) {
        const token = randomUUID();
        await client.query(`INSERT INTO agent_worker_leases(contract_id,job_id,token,worker_id,phase,expires_at)
          VALUES($1,$2,$3,$4,$5,now()+interval '30 seconds')`, [row.id,row.job_id,token,workerId,row.phase]);
        result.push({id:row.id,jobId:row.job_id,actor:row.actor,token,phase:row.phase});
        slots--;
        if (lane === 'bulk') bulkSlots--;
      }
    }
    return result;
  });
}

export async function renewWorkerClaims(tokens: string[]): Promise<Set<string>> {
  if (!tokens.length) return new Set();
  const rows = await query<{token:string}>(`UPDATE agent_worker_leases SET expires_at=now()+interval '30 seconds'
    WHERE token=ANY($1::text[]) AND expires_at>now() RETURNING token`, [tokens]);
  return new Set(rows.rows.map(r=>r.token));
}
export async function releaseWorkerClaim(token: string) {
  await query('DELETE FROM agent_worker_leases WHERE token=$1', [token]);
}
export async function workerClaimCurrent(token: string): Promise<boolean> {
  return (await query('SELECT 1 FROM agent_worker_leases WHERE token=$1 AND expires_at>now()', [token])).rowCount === 1;
}

export async function schedulerMetrics() {
  const result = await query<{pending:number;ready:number;running:number;failed:number;oldest_wait_seconds:number}>(`SELECT
    count(*) FILTER (WHERE workflow->'job'->>'status'='pending')::int AS pending,
    count(*) FILTER (WHERE (workflow->'job'->>'status'='pending' AND COALESCE(workflow->'job'->>'nextAttemptAt','')<=$1)
      OR (workflow->'job'->>'status'='running' AND COALESCE(workflow->'job'->>'leaseUntil','')<=$1))::int AS ready,
    count(*) FILTER (WHERE workflow->'job'->>'status'='running')::int AS running,
    count(*) FILTER (WHERE workflow->'job'->>'status'='failed')::int AS failed,
    COALESCE(EXTRACT(epoch FROM now()-min(c.updated_at) FILTER (WHERE workflow->'job'->>'status'='pending')),0)::float AS oldest_wait_seconds
    FROM contracts c JOIN users u ON u.id=c.owner_id WHERE NOT u.disabled AND u.role='client'`, [new Date().toISOString()]);
  const leases = (await query<{active:number;workers:number}>(`SELECT count(*)::int AS active,count(DISTINCT worker_id)::int AS workers
    FROM agent_worker_leases WHERE expires_at>now()`)).rows[0];
  const policy = (await query<SchedulerPolicy>('SELECT * FROM agent_scheduler_policy WHERE id=1')).rows[0];
  if (!policy) throw new AppError(503,'后台任务尚未初始化。','WORKER_NOT_CONFIGURED');
  return {...result.rows[0], ...leases, policy};
}

export async function pauseModelAdmission(retryAfterMs:number) {
  const duration=Math.min(600000,Math.max(1000,retryAfterMs));
  await query(`UPDATE agent_scheduler_policy SET provider_paused_until=GREATEST(COALESCE(provider_paused_until,now()),now()+$1*interval '1 millisecond') WHERE id=1`,[duration]);
}
