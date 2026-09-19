-- Independent archive batches retain source bytes and selected central-record identities.
CREATE TABLE archive_imports (
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
 total_pages integer,
 child_count integer,
 source_storage_key text UNIQUE,
 source_name text CHECK(length(source_name) BETWEEN 1 AND 240),
 source_released_at timestamptz,
 created_by uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_id),
 UNIQUE(id,workspace_id,parser_id),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE,
 CHECK(source_storage_key IS NULL OR source_storage_key=workspace_id::text||'/'||id::text),
 CONSTRAINT archive_import_receipt_shape CHECK(
  (state='accepted' AND rejection_code IS NULL AND rejection_reason IS NULL
   AND source_byte_size BETWEEN 1 AND 10485760
   AND total_pages IS NOT NULL AND total_pages BETWEEN 1 AND 600
   AND child_count IS NOT NULL AND child_count BETWEEN 1 AND 20 AND child_count<=total_pages
   AND ((source_storage_key IS NOT NULL AND source_name IS NOT NULL AND source_released_at IS NULL)
    OR (source_storage_key IS NULL AND source_name IS NULL AND source_released_at IS NOT NULL)))
  OR
  (state='rejected' AND source_storage_key IS NULL AND source_name IS NULL AND source_released_at IS NULL
   AND total_pages IS NULL AND child_count IS NULL AND rejection_code IS NOT NULL AND rejection_reason IS NOT NULL AND (
    (rejection_code='archive_import_validation_failed' AND rejection_reason IN ('invalid_spec','source_mismatch','selection_mismatch','zip_required','invalid_archive','unsupported_archive','unsafe_path','unsupported_entry','path_encoding','record_limit','document_limit','file_size_limit','expansion_limit','office_expansion_limit','text_limit','office_package'))
    OR (rejection_code='source_validation_failed' AND rejection_reason IN ('empty','file_too_large','office_archive_invalid','office_archive_unsupported','office_entry_limit','office_directory_invalid','office_entry_invalid','office_expansion_limit','office_entry_encoding','office_entry_path','office_local_entry_invalid','office_entry_mismatch','office_directory_size','office_format_unsupported','binary_format_unsupported','email_header_limit','text_encoding','text_binary_content','format_unsupported','pdf_invalid','pdf_encrypted','pdf_page_limit','image_format_unsupported','xlsx_empty','xlsx_sheet_limit','xlsx_dimensions'))
    OR (rejection_code='parser_format_not_allowed' AND rejection_reason IN ('pdf','png','jpeg','txt','eml','csv','xlsx','docx','html'))
   )))
);
CREATE INDEX archive_imports_workspace ON archive_imports(workspace_id,created_at DESC);
CREATE TABLE archive_import_entries (
 archive_id uuid NOT NULL,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL,
 entry_index integer NOT NULL CHECK(entry_index BETWEEN 1 AND 256),
 document_id uuid NOT NULL UNIQUE,
 job_id uuid NOT NULL UNIQUE,
 page_count integer NOT NULL CHECK(page_count BETWEEN 1 AND 30),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
 format text NOT NULL CHECK(format IN ('pdf','png','jpeg','txt','eml','csv','xlsx','docx','html')),
 entry_path text CHECK(octet_length(entry_path) BETWEEN 1 AND 1024),
 document_name text CHECK(length(document_name) BETWEEN 1 AND 240),
 PRIMARY KEY(archive_id,entry_index),
 UNIQUE(document_id,workspace_id,parser_id,archive_id,entry_index),
 FOREIGN KEY(archive_id,workspace_id,parser_id) REFERENCES archive_imports(id,workspace_id,parser_id) ON DELETE CASCADE,
 CHECK((entry_path IS NULL)=(document_name IS NULL))
);
ALTER TABLE documents ADD COLUMN archive_import_id uuid, ADD COLUMN archive_entry_index integer;
ALTER TABLE documents ADD CONSTRAINT document_archive_import_pair CHECK(
 (archive_import_id IS NULL AND archive_entry_index IS NULL)
 OR (archive_import_id IS NOT NULL AND archive_entry_index IS NOT NULL AND pdf_split_id IS NULL));
ALTER TABLE documents ADD CONSTRAINT document_archive_import_manifest
 FOREIGN KEY(id,workspace_id,parser_id,archive_import_id,archive_entry_index)
 REFERENCES archive_import_entries(document_id,workspace_id,parser_id,archive_id,entry_index) ON DELETE CASCADE;
DROP INDEX documents_ordinary_content;
CREATE UNIQUE INDEX documents_ordinary_content ON documents(parser_id,sha256) WHERE pdf_split_id IS NULL AND archive_import_id IS NULL;
CREATE UNIQUE INDEX documents_archive_identity ON documents(archive_import_id,archive_entry_index) WHERE archive_import_id IS NOT NULL;

ALTER TABLE intake_files ADD COLUMN archive_attempt_id uuid;
ALTER TABLE intake_files ADD CONSTRAINT intake_one_batch_attempt CHECK(split_attempt_id IS NULL OR archive_attempt_id IS NULL);
CREATE INDEX intake_files_archive_attempt ON intake_files(workspace_id,archive_attempt_id) WHERE archive_attempt_id IS NOT NULL;
ALTER TABLE direct_uploads ADD COLUMN archive_spec jsonb, ADD COLUMN archive_request_id uuid, ADD COLUMN archive_import_id uuid;
ALTER TABLE direct_uploads ADD CONSTRAINT direct_upload_archive_request CHECK(
 (archive_request_id IS NULL AND archive_spec IS NULL AND archive_import_id IS NULL)
 OR (archive_request_id IS NOT NULL AND pdf_split_request_id IS NULL
  AND (archive_spec IS NULL OR (jsonb_typeof(archive_spec)='object' AND octet_length(archive_spec::text)<=4096))));
ALTER TABLE direct_uploads ADD CONSTRAINT direct_upload_archive_result CHECK(
 archive_import_id IS NULL OR (archive_spec IS NOT NULL AND document_id IS NULL AND job_id IS NULL AND state IN ('complete','cleaned')));
ALTER TABLE direct_uploads ADD CONSTRAINT direct_upload_archive_owner
 FOREIGN KEY(archive_import_id,workspace_id,parser_id) REFERENCES archive_imports(id,workspace_id,parser_id);
CREATE INDEX direct_uploads_archive_request ON direct_uploads(workspace_id,archive_request_id) WHERE archive_request_id IS NOT NULL;

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['archive_imports','archive_import_entries'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO folio_app',t);
 END LOOP;
END $$;
