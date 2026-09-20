-- Admission identity survives failed attempts and deletion of the original.
-- Source/root IDs intentionally have no document FK: they are immutable lineage,
-- never authority to retrieve a deleted object or cascade into another batch.
CREATE TABLE stored_pdf_split_requests (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 request_id uuid NOT NULL,
 parser_id uuid NOT NULL,
 source_document_id uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 canonical_spec jsonb NOT NULL CHECK(jsonb_typeof(canonical_spec)='object' AND octet_length(canonical_spec::text)<=4096),
 spec_hash text NOT NULL CHECK(spec_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,request_id),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE
);
ALTER TABLE stored_pdf_split_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE stored_pdf_split_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON stored_pdf_split_requests
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON stored_pdf_split_requests TO folio_app;

ALTER TABLE pdf_splits ADD COLUMN source_document_id uuid,
 ADD COLUMN root_kind text,
 ADD COLUMN root_id uuid,
 ADD COLUMN root_sha256 text,
 ADD COLUMN root_page_count integer,
 ADD COLUMN root_page_start integer,
 ADD COLUMN undone_at timestamptz;
ALTER TABLE pdf_splits ADD CONSTRAINT stored_pdf_split_lineage CHECK (
 (source_document_id IS NULL AND root_kind IS NULL AND root_id IS NULL AND root_sha256 IS NULL
  AND root_page_count IS NULL AND root_page_start IS NULL AND undone_at IS NULL)
 OR (source_document_id IS NOT NULL AND root_kind IS NOT NULL AND root_kind IN ('document','pdf-split')
  AND root_id IS NOT NULL AND root_sha256 IS NOT NULL AND root_sha256 ~ '^[0-9a-f]{64}$'
  AND root_page_count IS NOT NULL AND root_page_count BETWEEN 1 AND 30
  AND root_page_start IS NOT NULL AND root_page_start BETWEEN 1 AND root_page_count
  AND (state='rejected' OR root_page_start+source_page_count-1<=root_page_count)
  AND (undone_at IS NULL OR (state='accepted' AND source_storage_key IS NULL)))
);
CREATE INDEX pdf_splits_stored_source ON pdf_splits(workspace_id,source_document_id,created_at DESC,id DESC)
 WHERE source_document_id IS NOT NULL;
