-- Upload capabilities can remain usable for two hours. Retain their exact object
-- reservations beyond that window, including finalized/failed uploads, for cleanup.
CREATE TABLE direct_uploads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES users(id),
 storage_key text NOT NULL UNIQUE,
 filename text NOT NULL,
 expected_bytes integer NOT NULL CHECK(expected_bytes BETWEEN 1 AND 10485760),
 expected_sha256 text NOT NULL CHECK(expected_sha256 ~ '^[0-9a-f]{64}$'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','finalizing','complete','failed','cleaned')),
 document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
 job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
 duplicate boolean NOT NULL DEFAULT false,
 finalize_owner uuid,
 finalize_lease_until timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 cleanup_after timestamptz NOT NULL DEFAULT now()+interval '2 hours 10 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE,
 CHECK(storage_key=workspace_id::text||'/'||id::text)
);
CREATE INDEX direct_uploads_cleanup ON direct_uploads(cleanup_after) WHERE state<>'cleaned';
CREATE INDEX direct_uploads_workspace ON direct_uploads(workspace_id,created_at);
ALTER TABLE direct_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_uploads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON direct_uploads
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON direct_uploads TO folio_app;
