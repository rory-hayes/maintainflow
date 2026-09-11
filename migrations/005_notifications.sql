-- Notifications derive from durable job outcomes; only per-user read state is copied.
ALTER TABLE jobs ADD CONSTRAINT jobs_id_workspace_unique UNIQUE(id,workspace_id);
CREATE TABLE notification_reads (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 job_id uuid NOT NULL,
 user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 state text NOT NULL CHECK(state IN ('completed','failed')),
 read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,user_id),
 FOREIGN KEY(job_id,workspace_id) REFERENCES jobs(id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX jobs_notification_outcomes ON jobs(workspace_id,updated_at DESC) WHERE state IN ('completed','failed');
CREATE INDEX notification_reads_workspace_user ON notification_reads(workspace_id,user_id);
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON notification_reads
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON notification_reads TO folio_app;
