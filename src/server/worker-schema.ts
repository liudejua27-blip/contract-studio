/** Applied by db:init before web/worker startup. No DDL privileges needed at runtime. */
export const WORKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_scheduler_policy (
  id integer PRIMARY KEY CHECK (id=1),
  global_concurrency integer NOT NULL CHECK (global_concurrency>0),
  intake_reserve integer NOT NULL CHECK (intake_reserve>=0 AND intake_reserve<global_concurrency),
  max_queued integer NOT NULL CHECK (max_queued>0)
);
ALTER TABLE agent_scheduler_policy ADD COLUMN IF NOT EXISTS provider_paused_until timestamptz;
CREATE TABLE IF NOT EXISTS agent_worker_leases (
  contract_id text PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
  job_id text NOT NULL,
  token text NOT NULL UNIQUE,
  worker_id text NOT NULL,
  phase text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_worker_leases_expiry_idx ON agent_worker_leases(expires_at);
CREATE TABLE IF NOT EXISTS agent_session_checkpoints (
  contract_id text PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transcript text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
