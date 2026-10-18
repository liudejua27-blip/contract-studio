import {query, withTransaction, AppError} from './db';
import type {AgentSessionCheckpoint} from './agent/types';

/** Server-created capability: no raw Pi transcript is returned through public APIs. */
export function sessionCheckpoint(ownerId:string,contractId:string,jobId:string,lease:string,workerToken?:string):AgentSessionCheckpoint {
  return {
    async load() {
      const result = await query<{transcript:string}>(`SELECT transcript FROM agent_session_checkpoints
        WHERE contract_id=$1 AND owner_id=$2`,[contractId,ownerId]);
      return result.rows[0]?.transcript ?? null;
    },
    async save(transcript) {
      await withTransaction(async client=>{
        // Lock the same row as workflow publication, so a superseded worker cannot
        // overwrite a newer checkpoint between the ownership check and the write.
        const current=await client.query(`SELECT c.id FROM contracts c JOIN users u ON u.id=c.owner_id
          WHERE c.id=$1 AND c.owner_id=$2 AND NOT u.disabled AND u.role='client'
          AND workflow->'job'->>'id'=$3 AND workflow->'job'->>'lease'=$4
          AND workflow->'job'->>'status'='running' AND ($5::text IS NULL OR EXISTS(SELECT 1 FROM agent_worker_leases WHERE contract_id=c.id AND token=$5 AND expires_at>now())) FOR UPDATE OF c`,[contractId,ownerId,jobId,lease,workerToken??null]);
        if(!current.rowCount)throw new AppError(409,'任务已停止或由其他执行实例接管。','CONFLICT');
        await client.query(`INSERT INTO agent_session_checkpoints(contract_id,owner_id,transcript) VALUES($1,$2,$3)
          ON CONFLICT(contract_id) DO UPDATE SET transcript=excluded.transcript,updated_at=now()
          WHERE agent_session_checkpoints.owner_id=excluded.owner_id`,[contractId,ownerId,transcript]);
      });
    },
  };
}
