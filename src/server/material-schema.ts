export const MATERIAL_SCHEMA_SQL=`CREATE TABLE IF NOT EXISTS contract_materials (
 id text PRIMARY KEY,contract_id text NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
 name text NOT NULL,purpose text NOT NULL CHECK(purpose IN ('transaction','reference')),
 file_key text NOT NULL,sha256 text NOT NULL,size integer NOT NULL,
 status text NOT NULL CHECK(status IN ('ready','partial','needs_ocr')),warnings jsonb NOT NULL,chunks jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),withdrawn_at timestamptz
); CREATE INDEX IF NOT EXISTS contract_materials_contract_idx ON contract_materials(contract_id);
ALTER TABLE contract_materials ADD COLUMN IF NOT EXISTS review_id text REFERENCES reviews(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS contract_materials_review_idx ON contract_materials(review_id);
ALTER TABLE review_messages ADD COLUMN IF NOT EXISTS request_id text;
ALTER TABLE review_messages ADD COLUMN IF NOT EXISTS request_info boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS review_message_request_idx ON review_messages(review_id,author_id,request_id) WHERE request_id IS NOT NULL;
`;
