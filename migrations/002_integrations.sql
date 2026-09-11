CREATE TABLE IF NOT EXISTS export_snapshots (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id), format text NOT NULL CHECK (format IN ('csv','xlsx','json')),
  document_ids uuid[] NOT NULL, run_ids uuid[] NOT NULL, records jsonb NOT NULL, options jsonb NOT NULL,
  mime_type text NOT NULL, bytes bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS export_mappings (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parser_id uuid NOT NULL REFERENCES parsers(id) ON DELETE CASCADE, name text NOT NULL,
  columns jsonb NOT NULL DEFAULT '[]', line_items text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parser_id uuid REFERENCES parsers(id) ON DELETE CASCADE, name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('webhook','google_sheets')), config jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext text, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  event_key text NOT NULL, payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz, lease_token uuid, response_status integer, error text,
  created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
  UNIQUE(integration_id,event_key)
);
CREATE TABLE IF NOT EXISTS provider_events (
  id text PRIMARY KEY, provider text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
  lease_token uuid, error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS subscriptions (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_id text UNIQUE, subscription_id text UNIQUE, status text NOT NULL DEFAULT 'inactive',
  price_id text, event_created bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS export_snapshots_workspace_idx ON export_snapshots(workspace_id,created_at DESC);
CREATE INDEX IF NOT EXISTS export_mappings_parser_idx ON export_mappings(workspace_id,parser_id);
CREATE INDEX IF NOT EXISTS integrations_workspace_idx ON integrations(workspace_id,parser_id);
CREATE INDEX IF NOT EXISTS webhook_pending_idx ON webhook_deliveries(next_attempt_at) WHERE status IN ('queued','retry','delivering');
CREATE INDEX IF NOT EXISTS provider_pending_idx ON provider_events(next_attempt_at) WHERE status IN ('queued','retry','processing');
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['export_snapshots','export_mappings','integrations','webhook_deliveries','subscriptions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',table_name);
  END LOOP;
END $$;
