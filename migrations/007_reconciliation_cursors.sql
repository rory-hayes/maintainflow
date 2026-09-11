-- Durable sweep positions ensure populated workspaces do not starve later originals.
CREATE TABLE reconciliation_cursors (
 workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 after_filename text NOT NULL DEFAULT '',
 after_intent_id uuid,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE reconciliation_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_cursors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON reconciliation_cursors
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON reconciliation_cursors TO folio_app;
