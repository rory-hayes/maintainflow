-- One durable batch receipt and retained source; child identities survive purge.
CREATE TABLE pdf_splits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL,
 request_id uuid NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 canonical_spec jsonb NOT NULL CHECK(jsonb_typeof(canonical_spec)='object' AND octet_length(canonical_spec::text)<=4096),
 spec_hash text NOT NULL CHECK(spec_hash ~ '^[0-9a-f]{64}$'),
 state text NOT NULL CHECK(state IN ('accepted','rejected')),
 rejection_code text,
 rejection_reason text,
 source_byte_size bigint NOT NULL CHECK(source_byte_size>=0),
 source_page_count integer,
 selected_pages integer,
 child_count integer,
 source_storage_key text UNIQUE,
 source_name text CHECK(length(source_name) BETWEEN 1 AND 300),
 source_released_at timestamptz,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_id),
 UNIQUE(id,workspace_id,parser_id),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE,
 CHECK(source_storage_key IS NULL OR source_storage_key=workspace_id::text||'/'||id::text),
 CONSTRAINT pdf_split_receipt_shape CHECK(
  (state='accepted' AND rejection_code IS NULL AND rejection_reason IS NULL
   AND source_byte_size BETWEEN 1 AND 10485760
   AND source_page_count IS NOT NULL AND source_page_count BETWEEN 1 AND 30
   AND selected_pages IS NOT NULL AND selected_pages BETWEEN 1 AND source_page_count
   AND child_count IS NOT NULL AND child_count BETWEEN 1 AND 20 AND child_count<=selected_pages
   AND ((source_storage_key IS NOT NULL AND source_name IS NOT NULL AND source_released_at IS NULL)
     OR (source_storage_key IS NULL AND source_name IS NULL AND source_released_at IS NOT NULL)))
  OR
  (state='rejected' AND source_storage_key IS NULL AND source_name IS NULL AND source_released_at IS NULL
   AND source_page_count IS NULL AND selected_pages IS NULL AND child_count IS NULL
   AND rejection_code IS NOT NULL AND rejection_reason IS NOT NULL AND (
    (rejection_code='parser_format_not_allowed' AND rejection_reason='pdf')
    OR (rejection_code='pdf_split_validation_failed' AND rejection_reason IN (
     'invalid_spec','invalid_ranges','page_bounds','document_limit','pdf_required','child_size_limit','derived_size_limit','text_limit'))
    OR (rejection_code='source_validation_failed' AND rejection_reason IN (
     'empty','file_too_large','office_archive_invalid','office_archive_unsupported',
     'office_entry_limit','office_directory_invalid','office_entry_invalid','office_expansion_limit',
     'office_entry_encoding','office_entry_path','office_local_entry_invalid','office_entry_mismatch',
     'office_directory_size','office_format_unsupported','binary_format_unsupported','email_header_limit',
     'text_encoding','text_binary_content','format_unsupported','pdf_invalid','pdf_encrypted','pdf_page_limit',
     'image_format_unsupported','xlsx_empty','xlsx_sheet_limit','xlsx_dimensions'))
   )))
);
CREATE INDEX pdf_splits_workspace ON pdf_splits(workspace_id,created_at DESC);
CREATE TABLE pdf_split_children (
 split_id uuid NOT NULL,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL,
 child_index integer NOT NULL CHECK(child_index BETWEEN 1 AND 20),
 document_id uuid NOT NULL UNIQUE,
 job_id uuid NOT NULL UNIQUE,
 start_page integer NOT NULL CHECK(start_page BETWEEN 1 AND 30),
 end_page integer NOT NULL CHECK(end_page BETWEEN start_page AND 30),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
 document_name text CHECK(length(document_name) BETWEEN 1 AND 300),
 PRIMARY KEY(split_id,child_index),
 UNIQUE(document_id,workspace_id,parser_id,split_id,child_index),
 FOREIGN KEY(split_id,workspace_id,parser_id) REFERENCES pdf_splits(id,workspace_id,parser_id) ON DELETE CASCADE
);
-- The manifest is the parent of a live document, not a reference to be erased
-- on deletion. This leaves stable document/job IDs for truthful replay.
ALTER TABLE documents ADD COLUMN pdf_split_id uuid, ADD COLUMN pdf_split_index integer;
ALTER TABLE documents ADD CONSTRAINT document_pdf_split_pair CHECK(
 (pdf_split_id IS NULL AND pdf_split_index IS NULL) OR (pdf_split_id IS NOT NULL AND pdf_split_index IS NOT NULL));
ALTER TABLE documents ADD CONSTRAINT document_pdf_split_manifest
 FOREIGN KEY(id,workspace_id,parser_id,pdf_split_id,pdf_split_index)
 REFERENCES pdf_split_children(document_id,workspace_id,parser_id,split_id,child_index) ON DELETE CASCADE;
ALTER TABLE documents DROP CONSTRAINT documents_parser_id_sha256_key;
CREATE UNIQUE INDEX documents_ordinary_content ON documents(parser_id,sha256) WHERE pdf_split_id IS NULL;
CREATE UNIQUE INDEX documents_split_identity ON documents(pdf_split_id,pdf_split_index) WHERE pdf_split_id IS NOT NULL;

ALTER TABLE intake_files ADD COLUMN split_attempt_id uuid,
 ADD COLUMN reserved_bytes bigint NOT NULL DEFAULT 0 CHECK(reserved_bytes BETWEEN 0 AND 10485760);
CREATE INDEX intake_files_split_attempt ON intake_files(workspace_id,split_attempt_id) WHERE split_attempt_id IS NOT NULL;
ALTER TABLE direct_uploads ADD COLUMN pdf_split_spec jsonb,
 ADD COLUMN pdf_split_request_id uuid, ADD COLUMN pdf_split_id uuid;
ALTER TABLE direct_uploads ADD CONSTRAINT direct_upload_pdf_split_request CHECK(
 (pdf_split_spec IS NULL AND pdf_split_request_id IS NULL AND pdf_split_id IS NULL)
 OR (pdf_split_spec IS NOT NULL AND jsonb_typeof(pdf_split_spec)='object'
  AND octet_length(pdf_split_spec::text)<=4096 AND pdf_split_request_id IS NOT NULL));
ALTER TABLE direct_uploads ADD CONSTRAINT direct_upload_pdf_split_result CHECK(
 pdf_split_id IS NULL OR (document_id IS NULL AND job_id IS NULL AND state IN ('complete','cleaned')));
ALTER TABLE direct_uploads ADD CONSTRAINT direct_upload_pdf_split_owner
 FOREIGN KEY(pdf_split_id,workspace_id,parser_id) REFERENCES pdf_splits(id,workspace_id,parser_id);
CREATE INDEX direct_uploads_pdf_split_request ON direct_uploads(workspace_id,pdf_split_request_id)
 WHERE pdf_split_request_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['pdf_splits','pdf_split_children'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO folio_app',t);
 END LOOP;
END $$;
