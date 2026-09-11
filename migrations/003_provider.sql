-- Provider inbox is global and accessible only by the server administrator pool.
REVOKE ALL ON provider_events FROM folio_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON export_snapshots,export_mappings,integrations,webhook_deliveries,subscriptions TO folio_app;

CREATE TABLE email_routes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL, address text UNIQUE NOT NULL,
 provider_domain_id text NOT NULL, parse_body boolean NOT NULL DEFAULT true,
 parse_attachments boolean NOT NULL DEFAULT true, allowed_senders jsonb NOT NULL DEFAULT '[]',
 enabled boolean NOT NULL DEFAULT true, created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 domain_verified_at timestamptz NOT NULL, last_received_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE,
 CHECK (parse_body OR parse_attachments)
);
CREATE TABLE oauth_states (
 state_hash text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
 verifier_ciphertext text NOT NULL, expires_at timestamptz NOT NULL,
 consumed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires_at);
CREATE TABLE sheet_cursors (
 integration_id uuid PRIMARY KEY REFERENCES integrations(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 next_row integer NOT NULL DEFAULT 2 CHECK(next_row>=2)
);
CREATE TABLE sheet_writes (
 integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 event_key text NOT NULL, spreadsheet_id text NOT NULL, header_range text NOT NULL,
 data_range text NOT NULL, headers jsonb NOT NULL, cells jsonb NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK(status IN ('reserved','delivered')),
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 PRIMARY KEY(integration_id,event_key)
);
CREATE TABLE billing_checkouts (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id uuid NOT NULL DEFAULT gen_random_uuid(), session_id text,
 plan_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE provider_event_workspaces (
 event_id text NOT NULL REFERENCES provider_events(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 PRIMARY KEY(event_id,workspace_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['email_routes','oauth_states','sheet_cursors','sheet_writes','billing_checkouts','provider_event_workspaces'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO folio_app',t);
 END LOOP;
END $$;
