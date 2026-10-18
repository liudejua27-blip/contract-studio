export const PRODUCTION_SCHEMA_SQL = `
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS client_response text CHECK (client_response IN ('received','changes_requested'));
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS client_responded_at timestamptz;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS client_feedback text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='users' AND column_name='must_change_password') THEN
  ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
  UPDATE users SET must_change_password=true WHERE role='admin';
 END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
CREATE TABLE IF NOT EXISTS email_actions (
 token_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(purpose IN ('verify','reset')),expires_at timestamptz NOT NULL,used_at timestamptz
);
CREATE INDEX IF NOT EXISTS email_actions_user_idx ON email_actions(user_id);
CREATE TABLE IF NOT EXISTS notifications (
 id bigserial PRIMARY KEY,user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 contract_id text NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,message text NOT NULL,
 read_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id,created_at DESC);
CREATE OR REPLACE FUNCTION notify_review_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.lawyer_id IS NOT DISTINCT FROM OLD.lawyer_id THEN RETURN NEW; END IF;
 END IF;
 IF NEW.status IN ('need_info','completed') THEN
  INSERT INTO notifications(user_id,contract_id,message) SELECT owner_id,NEW.contract_id,
  CASE WHEN NEW.status='completed' THEN '律师已交付审阅版本，请打开合同查看。' ELSE '律师需要补充信息，请打开合同回复。' END FROM contracts WHERE id=NEW.contract_id;
 ELSIF NEW.lawyer_id IS NOT NULL THEN
  INSERT INTO notifications(user_id,contract_id,message) VALUES(NEW.lawyer_id,NEW.contract_id,'审核任务有更新，请打开合同处理。');
 ELSE
  INSERT INTO notifications(user_id,contract_id,message) SELECT id,NEW.contract_id,'有审核任务等待分配。' FROM users WHERE role='admin' AND NOT disabled;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS review_notifications ON reviews;
CREATE TRIGGER review_notifications AFTER INSERT OR UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION notify_review_state();
CREATE TABLE IF NOT EXISTS password_reset_tokens (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 issued_by text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
 used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_tokens(user_id);
CREATE TABLE IF NOT EXISTS access_audit (
 id bigserial PRIMARY KEY, actor_id text, action text NOT NULL, resource_id text,
 outcome integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS access_audit_time_idx ON access_audit(created_at);
CREATE TABLE IF NOT EXISTS model_calls (
 id bigserial PRIMARY KEY, model text NOT NULL, stage text NOT NULL, status text NOT NULL,
 duration_ms integer NOT NULL, input_tokens bigint, output_tokens bigint,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_calls_time_idx ON model_calls(created_at);
CREATE TABLE IF NOT EXISTS deletion_requests (
 contract_id text PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
 requested_by text NOT NULL REFERENCES users(id), requested_at timestamptz NOT NULL DEFAULT now(),
 delete_after timestamptz NOT NULL DEFAULT now()+interval '30 days'
);
CREATE TABLE IF NOT EXISTS session_gc (directory_hash text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS object_gc (
 file_key text PRIMARY KEY, eligible_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
`;
