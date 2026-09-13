-- Suggestions are a separate durable operation. They never replace document
-- extraction runs or change an active parser schema without an explicit save.
ALTER TABLE documents ADD CONSTRAINT documents_parser_tenant UNIQUE(id,parser_id,workspace_id);
ALTER TABLE schema_versions ADD CONSTRAINT schema_versions_parser_tenant UNIQUE(id,parser_id,workspace_id);
CREATE TABLE schema_suggestions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL,
 document_id uuid NOT NULL,
 base_schema_id uuid NOT NULL,
 requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
 request_id uuid NOT NULL,
 document_sha256 text NOT NULL CHECK(document_sha256 ~ '^[0-9a-f]{64}$'),
 config jsonb NOT NULL,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','processing','ready','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts=3),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner uuid,
 lease_until timestamptz,
 proposed_schema jsonb,
 model text,
 prompt_version text,
 token_usage jsonb NOT NULL DEFAULT '{}',
 cost_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK(cost_usd>=0 AND cost_usd<'Infinity'::numeric),
 error text CHECK(length(error)<=500),
 applied_schema_id uuid,
 completed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_id),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(document_id,parser_id,workspace_id) REFERENCES documents(id,parser_id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(base_schema_id,parser_id,workspace_id) REFERENCES schema_versions(id,parser_id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(applied_schema_id,parser_id,workspace_id) REFERENCES schema_versions(id,parser_id,workspace_id),
 CHECK((state='processing' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR (state<>'processing' AND lease_owner IS NULL AND lease_until IS NULL)),
 CONSTRAINT schema_suggestions_result_shape CHECK((state='ready' AND completed_at IS NOT NULL AND proposed_schema IS NOT NULL AND model IS NOT NULL AND prompt_version IS NOT NULL AND error IS NULL)
    OR (state<>'ready' AND completed_at IS NULL AND proposed_schema IS NULL AND model IS NULL AND prompt_version IS NULL AND applied_schema_id IS NULL))
);
CREATE INDEX schema_suggestions_claim ON schema_suggestions(state,available_at,created_at);
CREATE INDEX schema_suggestions_workspace ON schema_suggestions(workspace_id,created_at DESC);
CREATE INDEX schema_suggestions_parser ON schema_suggestions(parser_id,created_at DESC);
ALTER TABLE schema_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON schema_suggestions
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON schema_suggestions TO folio_app;
