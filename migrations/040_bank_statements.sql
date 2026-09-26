-- Preserve a signed bank upload's selected interpretation until finalization.
ALTER TABLE direct_uploads ADD COLUMN bank_locale text
 CHECK(bank_locale IS NULL OR bank_locale IN ('en-IE','en-US','de-DE'));
ALTER TABLE direct_uploads ADD CONSTRAINT bank_locale_single_document
 CHECK(bank_locale IS NULL OR (pdf_split_request_id IS NULL AND archive_request_id IS NULL));

-- Bank values are additive immutable run/approval snapshots. Legacy runs stay NULL.
ALTER TABLE extraction_runs ADD COLUMN bank_statement_context jsonb
 CHECK(bank_statement_context IS NULL OR COALESCE(
  jsonb_typeof(bank_statement_context)='object'
  AND bank_statement_context->'version'='1'::jsonb
  AND jsonb_typeof(bank_statement_context->'locale')='string'
  AND bank_statement_context->>'locale' IN ('en-IE','en-US','de-DE')
  AND jsonb_typeof(bank_statement_context->'accounts')='object'
  AND jsonb_typeof(bank_statement_context->'transactions')='object'
  AND bank_statement_context ?& ARRAY['version','locale','accounts','transactions']
  AND bank_statement_context - ARRAY['version','locale','accounts','transactions']='{}'::jsonb
  AND octet_length(bank_statement_context::text)<=8388608,false));

ALTER TABLE approvals ADD COLUMN bank_review jsonb
 CHECK(bank_review IS NULL OR COALESCE(
  jsonb_typeof(bank_review)='object' AND bank_review->'version'='1'::jsonb
  AND jsonb_typeof(bank_review->'revision')='string'
  AND bank_review->>'revision' ~ '^(run|correction):[0-9a-f-]{36}$'
  AND jsonb_typeof(bank_review->'token')='string' AND bank_review->>'token' ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(bank_review->'warningsAcknowledged')='boolean'
  AND jsonb_typeof(bank_review->'issues')='array'
  AND bank_review ?& ARRAY['version','revision','token','warningsAcknowledged','issues']
  AND bank_review - ARRAY['version','revision','token','warningsAcknowledged','issues']='{}'::jsonb
  AND octet_length(bank_review::text)<=8388608,false));

-- Only the latest run's effective included rows are indexed. These tables store
-- matching keys, not raw account identifiers or descriptions. They are replaced
-- atomically under the same workspace lock as corrections and approvals.
ALTER TABLE extraction_runs ADD CONSTRAINT bank_run_document_identity UNIQUE(id,document_id,workspace_id);
CREATE TABLE bank_statement_accounts (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 document_id uuid NOT NULL,
 run_id uuid NOT NULL,
 revision text NOT NULL CHECK(revision ~ '^(run|correction):[0-9a-f-]{36}$'),
 account_id uuid NOT NULL,
 account_key text CHECK(account_key ~ '^[0-9a-f]{64}$'),
 currency text CHECK(currency ~ '^[A-Z]{3}$'),
 statement_start date,
 statement_end date,
 PRIMARY KEY(workspace_id,document_id,account_id),
 FOREIGN KEY(document_id,workspace_id) REFERENCES documents(id,workspace_id) ON DELETE CASCADE,
 FOREIGN KEY(run_id,document_id,workspace_id) REFERENCES extraction_runs(id,document_id,workspace_id) ON DELETE CASCADE
);
CREATE INDEX bank_statement_account_lookup ON bank_statement_accounts(workspace_id,account_key,currency,statement_start,statement_end) WHERE account_key IS NOT NULL;
CREATE TABLE bank_statement_transactions (
 workspace_id uuid NOT NULL,
 document_id uuid NOT NULL,
 account_id uuid NOT NULL,
 transaction_id uuid NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(workspace_id,document_id,transaction_id),
 FOREIGN KEY(workspace_id,document_id,account_id) REFERENCES bank_statement_accounts(workspace_id,document_id,account_id) ON DELETE CASCADE
);
CREATE INDEX bank_statement_transaction_lookup ON bank_statement_transactions(workspace_id,fingerprint,document_id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bank_statement_accounts','bank_statement_transactions'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON %I USING(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid) WITH CHECK(workspace_id=nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO folio_app',t);
 END LOOP;
END $$;
