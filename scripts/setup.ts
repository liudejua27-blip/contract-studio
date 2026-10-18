import {LEARNING_SCHEMA_SQL} from '../src/server/learning-schema';
import {MATERIAL_SCHEMA_SQL} from '../src/server/material-schema';
import { PRODUCTION_SCHEMA_SQL } from '../src/server/production-schema';
import { WORKER_SCHEMA_SQL } from '../src/server/worker-schema';
import { initializeSchedulerPolicy } from '../src/server/worker-scheduler';
import { AUTH_RATE_LIMIT_SCHEMA_SQL } from '../src/server/rate-limit';
import { pool, databaseConfigured, closeDatabase } from '../src/server/db';

/**
 * Contract Studio keeps business rows normalized so review and version state can be
 * locked independently. File bytes remain behind the storage adapter and are addressed
 * by the immutable `file_key` stored on each version.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  email_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('client', 'lawyer', 'admin')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_active_idx
  ON sessions(user_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS contracts (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS workflow jsonb;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS agent_progress jsonb;
CREATE INDEX IF NOT EXISTS contracts_active_jobs_idx ON contracts(updated_at,id)
  WHERE workflow->'job'->>'status' IN ('pending','running');
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS workflow_revision integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS contracts_owner_updated_idx ON contracts(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  contract_id text NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS seq bigserial;
CREATE INDEX IF NOT EXISTS messages_contract_created_idx ON messages(contract_id, seq);

CREATE TABLE IF NOT EXISTS versions (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  kind text NOT NULL CHECK (kind IN ('draft', 'review')),
  review_id text,
  file_key text NOT NULL UNIQUE,
  content jsonb,
  source text NOT NULL CHECK (source IN ('ai', 'demo', 'lawyer')),
  sha256 text,
  text_content text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contract_id, number)
);
ALTER TABLE versions ADD COLUMN IF NOT EXISTS review_id text;
CREATE INDEX IF NOT EXISTS versions_contract_created_idx ON versions(contract_id, created_at, number);

ALTER TABLE versions ADD COLUMN IF NOT EXISTS text_content text;
CREATE TABLE IF NOT EXISTS reviews (
  id text PRIMARY KEY,
  contract_id text NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  submitted_version_id text NOT NULL REFERENCES versions(id),
  lawyer_id text REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('waiting', 'reviewing', 'need_info', 'completed')),
  stance text NOT NULL,
  concerns text NOT NULL,
  requirements text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  final_version_id text REFERENCES versions(id),
  delivery_note text,
  editing_version_id text REFERENCES versions(id),
  save_status text CHECK (save_status IN ('saved', 'pending', 'error'))
);
ALTER TABLE reviews ALTER COLUMN submitted_version_id DROP NOT NULL;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS handoff_version_id text REFERENCES versions(id);
CREATE INDEX IF NOT EXISTS reviews_contract_idx ON reviews(contract_id, submitted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_open_per_contract_idx
  ON reviews(contract_id)
  WHERE status IN ('waiting', 'reviewing', 'need_info');

UPDATE versions v
SET review_id = r.id
FROM reviews r
WHERE v.review_id IS NULL
  AND (v.id = r.editing_version_id OR v.id = r.final_version_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'versions_review_id_fkey' AND conrelid='versions'::regclass
  ) THEN
    ALTER TABLE versions
      ADD CONSTRAINT versions_review_id_fkey
      FOREIGN KEY (review_id) REFERENCES reviews(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS versions_review_idx ON versions(review_id);

CREATE TABLE IF NOT EXISTS editor_sessions (
  id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  base_version_id text NOT NULL REFERENCES versions(id),
  document_key text NOT NULL UNIQUE,
  scratch_file_key text NOT NULL UNIQUE,
  assigned_user_id text NOT NULL REFERENCES users(id),
  dirty_epoch bigint NOT NULL DEFAULT 0,
  saved_epoch bigint NOT NULL DEFAULT 0,
  save_nonce text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS editor_sessions_active_review_idx
  ON editor_sessions(review_id) WHERE active;
CREATE INDEX IF NOT EXISTS editor_sessions_user_idx ON editor_sessions(assigned_user_id, active);

CREATE TABLE IF NOT EXISTS review_messages (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  review_id text NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  author_id text NOT NULL REFERENCES users(id),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE review_messages ADD COLUMN IF NOT EXISTS seq bigserial;
CREATE INDEX IF NOT EXISTS review_messages_review_created_idx
  ON review_messages(review_id, seq);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
${MATERIAL_SCHEMA_SQL}
${LEARNING_SCHEMA_SQL}
`;

async function main(): Promise<void> {
  if (!databaseConfigured()) {
    throw new Error('DATABASE_URL is required to initialize Contract Studio.');
  }
  await pool.query(SCHEMA_SQL);
  await pool.query(PRODUCTION_SCHEMA_SQL);
  await pool.query(AUTH_RATE_LIMIT_SCHEMA_SQL);
  await pool.query(WORKER_SCHEMA_SQL);
  await initializeSchedulerPolicy();
  await closeDatabase();
}

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : 'Database setup failed.');
  await closeDatabase();
  process.exitCode = 1;
});
