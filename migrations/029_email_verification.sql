-- Existing accounts retain access and have no invented verification timestamp.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN email_verification_required boolean NOT NULL DEFAULT false;

CREATE TABLE email_verification_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 credential_digest text NOT NULL CHECK(credential_digest ~ '^[0-9a-f]{64}$'),
 email_digest text NOT NULL CHECK(email_digest ~ '^[0-9a-f]{64}$'),
 purpose text NOT NULL DEFAULT 'email_verification' CHECK(purpose='email_verification'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX email_verification_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX email_verification_tokens_expiry ON email_verification_tokens(expires_at);
CREATE TABLE email_verification_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 address_key text NOT NULL CHECK(address_key ~ '^[0-9a-f]{64}$'),
 payload_ciphertext text NOT NULL CHECK(octet_length(payload_ciphertext)<=2048),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX email_verification_requests_expiry ON email_verification_requests(expires_at);
CREATE INDEX email_verification_requests_order ON email_verification_requests(created_at,id);
CREATE TABLE email_verification_limits (
 address_key text PRIMARY KEY CHECK(address_key ~ '^[0-9a-f]{64}$'),
 window_started_at timestamptz NOT NULL,
 grants integer NOT NULL CHECK(grants BETWEEN 1 AND 5),
 cooldown_until timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX email_verification_limits_expiry ON email_verification_limits(expires_at);
CREATE TABLE account_registration_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 address_key text NOT NULL CHECK(address_key ~ '^[0-9a-f]{64}$'),
 payload_ciphertext text NOT NULL CHECK(octet_length(payload_ciphertext)<=8192),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
);
CREATE INDEX account_registration_requests_expiry ON account_registration_requests(expires_at);
CREATE INDEX account_registration_requests_order ON account_registration_requests(created_at,id);
CREATE TABLE account_registration_limits (
 address_key text PRIMARY KEY CHECK(address_key ~ '^[0-9a-f]{64}$'),
 window_started_at timestamptz NOT NULL,
 grants integer NOT NULL CHECK(grants BETWEEN 1 AND 5),
 cooldown_until timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX account_registration_limits_expiry ON account_registration_limits(expires_at);

ALTER TABLE account_email_outbox ADD COLUMN verification_token_id uuid REFERENCES email_verification_tokens ON DELETE SET NULL;
CREATE INDEX account_email_outbox_verification_token ON account_email_outbox(verification_token_id);
ALTER TABLE account_email_outbox DROP CONSTRAINT account_email_outbox_kind_check;
ALTER TABLE account_email_outbox ADD CONSTRAINT account_email_outbox_kind_check CHECK(kind IN ('password_reset','password_changed','email_verification'));
-- Keep the existing reset-token purpose check. Terminal/accepted rows may have
-- NULL token references after token removal; ciphertext has already been erased.
ALTER TABLE account_email_outbox ADD CONSTRAINT account_email_outbox_verification_purpose CHECK(kind='email_verification' OR verification_token_id IS NULL);
ALTER TABLE account_security_events DROP CONSTRAINT account_security_events_action_check;
ALTER TABLE account_security_events ADD CONSTRAINT account_security_events_action_check CHECK(action IN ('password_reset_requested','password_reset_completed','password_changed','email_verification_requested','email_verified'));

DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['email_verification_tokens','email_verification_requests','email_verification_limits','account_registration_requests','account_registration_limits'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,folio_app',relation);
 END LOOP;
END $$;
