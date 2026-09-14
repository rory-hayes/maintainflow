-- Global account recovery state is available only to the backend runtime.
-- The private-schema wrapper supplies its restricted administrator RLS policy.
ALTER TABLE users ADD COLUMN password_changed_at timestamptz;
CREATE TABLE account_recovery_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 address_key text NOT NULL CHECK(address_key ~ '^[0-9a-f]{64}$'),
 payload_ciphertext text NOT NULL CHECK(octet_length(payload_ciphertext)<=2048),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX account_recovery_requests_expiry ON account_recovery_requests(expires_at);
CREATE INDEX account_recovery_requests_order ON account_recovery_requests(created_at,id);
CREATE TABLE account_recovery_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 credential_digest text NOT NULL CHECK(credential_digest ~ '^[0-9a-f]{64}$'),
 purpose text NOT NULL DEFAULT 'password_reset' CHECK(purpose='password_reset'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX account_recovery_tokens_user ON account_recovery_tokens(user_id);
CREATE INDEX account_recovery_tokens_expiry ON account_recovery_tokens(expires_at);
CREATE TABLE account_email_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 token_id uuid REFERENCES account_recovery_tokens ON DELETE SET NULL,
 kind text NOT NULL CHECK(kind IN ('password_reset','password_changed')),
 payload_ciphertext text CHECK(octet_length(payload_ciphertext)<=16384),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','cancelled','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 lease_owner uuid,
 lease_until timestamptz,
 failure_code text CHECK(failure_code IN ('unavailable','invalid_message','temporary_failure','permanent_failure','timeout','cancelled','invalid_response','expired','invalid_token','attempt_limit')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 CHECK((state='sending' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'sending' AND lease_owner IS NULL AND lease_until IS NULL)),
 CHECK((state IN ('pending','sending'))=(payload_ciphertext IS NOT NULL)),
 CHECK((state IN ('accepted','cancelled','failed'))=(finished_at IS NOT NULL)),
 CHECK(kind='password_reset' OR token_id IS NULL)
);
CREATE INDEX account_email_outbox_ready ON account_email_outbox(available_at,created_at) WHERE state='pending';
CREATE INDEX account_email_outbox_lease ON account_email_outbox(lease_until) WHERE state='sending';
CREATE INDEX account_email_outbox_user ON account_email_outbox(user_id);
CREATE INDEX account_email_outbox_token ON account_email_outbox(token_id);
CREATE TABLE account_recovery_limits (
 address_key text PRIMARY KEY CHECK(address_key ~ '^[0-9a-f]{64}$'),
 window_started_at timestamptz NOT NULL,
 grants integer NOT NULL CHECK(grants BETWEEN 1 AND 5),
 cooldown_until timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX account_recovery_limits_expiry ON account_recovery_limits(expires_at);
CREATE TABLE account_security_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 action text NOT NULL CHECK(action IN ('password_reset_requested','password_reset_completed','password_changed')),
 sessions_revoked integer NOT NULL DEFAULT 0 CHECK(sessions_revoked>=0),
 tokens_invalidated integer NOT NULL DEFAULT 0 CHECK(tokens_invalidated>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_security_events_retention ON account_security_events(created_at);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['account_recovery_requests','account_recovery_tokens','account_email_outbox','account_recovery_limits','account_security_events'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,folio_app',relation);
 END LOOP;
END $$;
