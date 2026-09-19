ALTER TABLE invitations ADD COLUMN delivery text NOT NULL DEFAULT 'manual' CHECK(delivery IN ('manual','email'));
ALTER TABLE invitations ADD COLUMN issuer_id uuid REFERENCES users ON DELETE CASCADE;
ALTER TABLE invitations ADD CONSTRAINT invitations_workspace_identity UNIQUE(id,workspace_id);
CREATE INDEX invitations_pending_workspace ON invitations(workspace_id,expires_at) WHERE accepted_at IS NULL;

-- Invitation recipients may not have an account. This queue never manufactures users.
CREATE TABLE invitation_email_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 invitation_id uuid NOT NULL,
 workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 payload_ciphertext text CHECK(octet_length(payload_ciphertext)<=16384),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','accepted','cancelled','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 lease_owner uuid,
 lease_until timestamptz,
 failure_code text CHECK(failure_code IN ('unavailable','invalid_message','temporary_failure','permanent_failure','timeout','cancelled','invalid_response','expired','invalid_token','attempt_limit','revoked','accepted','superseded','issuer_unauthorized')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 FOREIGN KEY(invitation_id,workspace_id) REFERENCES invitations(id,workspace_id) ON DELETE CASCADE,
 CHECK((state='sending' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'sending' AND lease_owner IS NULL AND lease_until IS NULL)),
 CHECK((state IN ('pending','sending'))=(payload_ciphertext IS NOT NULL)),
 CHECK((state IN ('accepted','cancelled','failed'))=(finished_at IS NOT NULL))
);
CREATE INDEX invitation_email_outbox_ready ON invitation_email_outbox(available_at,created_at) WHERE state='pending';
CREATE INDEX invitation_email_outbox_lease ON invitation_email_outbox(lease_until) WHERE state='sending';
CREATE INDEX invitation_email_outbox_invitation ON invitation_email_outbox(invitation_id,created_at DESC);
CREATE TABLE invitation_email_limits (
 address_key text PRIMARY KEY CHECK(address_key ~ '^[0-9a-f]{64}$'),
 window_started_at timestamptz NOT NULL,
 grants integer NOT NULL CHECK(grants BETWEEN 1 AND 5),
 cooldown_until timestamptz NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE INDEX invitation_email_limits_expiry ON invitation_email_limits(expires_at);
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['invitation_email_outbox','invitation_email_limits'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC,folio_app',relation);
 END LOOP;
END $$;
