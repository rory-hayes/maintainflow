-- Object removal remains retryable even after the document metadata is deleted.
CREATE TABLE file_deletions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 storage_key text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','failed')),
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 available_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_deletions_pending ON file_deletions(available_at) WHERE status='pending';
ALTER TABLE file_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_deletions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON file_deletions
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON file_deletions TO folio_app;
-- Timestamp events when inserted after acquiring their locks, not at transaction start.
ALTER TABLE corrections ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE approvals ALTER COLUMN created_at SET DEFAULT clock_timestamp();
