export const LEARNING_SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS review_learning (
 id text PRIMARY KEY,contract_id text NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
 review_id text NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
 author_id text NOT NULL REFERENCES users(id),payload jsonb NOT NULL,
 before_sha256 text NOT NULL,after_sha256 text NOT NULL,
 preference_state text NOT NULL CHECK(preference_state IN ('none','pending','active','rejected','revoked')),
 sample_state text NOT NULL CHECK(sample_state IN ('none','pending','active','rejected','revoked')),
 revision integer NOT NULL DEFAULT 1,decisions jsonb NOT NULL DEFAULT '[]',created_at timestamptz NOT NULL DEFAULT now()
); CREATE INDEX IF NOT EXISTS review_learning_contract_idx ON review_learning(contract_id);
CREATE INDEX IF NOT EXISTS review_learning_sample_idx ON review_learning(sample_state);
`;
