-- Original write intents commit before filesystem writes and expire after a crashed uploader.
CREATE TABLE intake_files (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 storage_key text NOT NULL UNIQUE,
 lease_expires_at timestamptz NOT NULL DEFAULT now()+interval '5 minutes',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_files_expiry ON intake_files(lease_expires_at);
ALTER TABLE intake_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON intake_files
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON intake_files TO folio_app;
