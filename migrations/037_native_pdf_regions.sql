-- Existing template rows and pinned job JSON retain their text-v1 definition.
ALTER TABLE templates ADD COLUMN kind text NOT NULL DEFAULT 'text-v1'
 CHECK(kind IN ('text-v1','native-pdf-region-v1'));
ALTER TABLE templates ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 2147483647);
ALTER TABLE templates ADD CONSTRAINT native_template_rules_bound
 CHECK(kind<>'native-pdf-region-v1' OR (jsonb_typeof(rules)='array' AND jsonb_array_length(rules)<=100 AND octet_length(rules::text)<=73728));

-- Request identities survive template deletion. They contain no sample bytes,
-- object keys or credentials. An explicit closed nonce fences a late save.
CREATE TABLE template_mutations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('accepted','closed')),
 operation text CHECK(operation IN ('create','update','delete')),
 template_id uuid,
 request_hash text CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 base_schema_id uuid,
 base_revision integer CHECK(base_revision BETWEEN 1 AND 2147483647),
 accepted_revision integer CHECK(accepted_revision BETWEEN 1 AND 2147483647),
 accepted_template jsonb CHECK(accepted_template IS NULL OR (jsonb_typeof(accepted_template)='object' AND octet_length(accepted_template::text)<=CASE WHEN accepted_template->>'kind'='text-v1' THEN 532480 ELSE 73728 END)),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_id),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE,
 CHECK((state='closed' AND operation IS NULL AND template_id IS NULL AND request_hash IS NULL AND base_schema_id IS NULL AND base_revision IS NULL AND accepted_revision IS NULL AND accepted_template IS NULL)
    OR (state='accepted' AND operation IS NOT NULL AND template_id IS NOT NULL AND request_hash IS NOT NULL AND accepted_revision IS NOT NULL
      AND ((operation='delete' AND accepted_template IS NULL) OR (operation IN ('create','update') AND accepted_template IS NOT NULL))))
);
CREATE INDEX template_mutations_requester ON template_mutations(workspace_id,parser_id,requested_by,created_at DESC);
ALTER TABLE template_mutations ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_mutations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON template_mutations
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON template_mutations TO folio_app;

-- Selected immutable definitions outlive current template and job changes.
-- Keep compact selection's existing 8 KiB cap unchanged.
ALTER TABLE extraction_runs ADD COLUMN template_snapshot jsonb
 CHECK(template_snapshot IS NULL OR (jsonb_typeof(template_snapshot)='object' AND octet_length(template_snapshot::text)<=CASE WHEN template_snapshot#>>'{template,kind}'='text-v1' THEN 532480 ELSE 73728 END));
