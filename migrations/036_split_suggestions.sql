-- AI boundaries are private drafts. Source reservations and request tombstones
-- survive retries, source deletion, and cancellation without accepting pages.
CREATE TABLE split_suggestions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 parser_id uuid NOT NULL,
 requested_by uuid NOT NULL REFERENCES users(id),
 request_id uuid NOT NULL,
 auth_type text NOT NULL CHECK(auth_type IN ('session','api')),
 token_hash text NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 source_document_id uuid,
 original_source_key text,
 original_page_count integer CHECK(original_page_count BETWEEN 1 AND 30),
 source_name text NOT NULL CHECK(length(source_name) BETWEEN 1 AND 240),
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
 source_mime_type text NOT NULL CHECK(source_mime_type IN ('application/pdf','image/tiff')),
 expected_bytes integer NOT NULL CHECK(expected_bytes BETWEEN 1 AND 10485760),
 source_storage_key text UNIQUE,
 source_reserved_bytes integer NOT NULL CHECK(source_reserved_bytes BETWEEN 0 AND 10485760),
 source_released_at timestamptz,
 staging_storage_key text UNIQUE,
 staging_reserved_bytes integer NOT NULL DEFAULT 0 CHECK(staging_reserved_bytes IN (0,10485760)),
 staging_expires_at timestamptz,
 staging_released_at timestamptz,
 write_owner uuid,
 write_until timestamptz,
 config jsonb NOT NULL,
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','queued','processing','ready','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 max_attempts integer NOT NULL DEFAULT 3 CHECK(max_attempts=3),
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_owner uuid,
 lease_until timestamptz,
 page_count integer CHECK(page_count BETWEEN 1 AND 30),
 start_pages jsonb,
 model text CHECK(length(model) BETWEEN 1 AND 200),
 prompt_version text CHECK(length(prompt_version) BETWEEN 1 AND 200),
 token_usage jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(token_usage)='object' AND octet_length(token_usage::text)<=16000),
 cost_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK(cost_usd>=0 AND cost_usd<1000000),
 error text CHECK(length(error)<=500),
 completed_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 accepted_split_id uuid,
 confirmed_request_id uuid,
 confirmed_options jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workspace_id,request_id),
 FOREIGN KEY(parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE,
 CHECK((source_document_id IS NULL AND original_source_key IS NULL AND original_page_count IS NULL) OR
       (source_document_id IS NOT NULL AND original_source_key IS NOT NULL AND original_page_count IS NOT NULL)),
 CHECK((source_storage_key IS NULL AND source_reserved_bytes=0) OR
       (source_storage_key ~ ('^'||workspace_id::text||'/[0-9a-f-]{36}$') AND source_reserved_bytes=expected_bytes)),
 CHECK((staging_storage_key IS NULL AND staging_reserved_bytes=0) OR
       (staging_storage_key ~ ('^'||workspace_id::text||'/[0-9a-f-]{36}$') AND staging_reserved_bytes=10485760 AND staging_expires_at IS NOT NULL)),
 CHECK(source_storage_key IS DISTINCT FROM staging_storage_key OR source_storage_key IS NULL),
 CHECK((write_owner IS NULL)=(write_until IS NULL)),
 CHECK((state='processing' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL) OR
       (state<>'processing' AND lease_owner IS NULL AND lease_until IS NULL)),
 CHECK(start_pages IS NULL OR (jsonb_typeof(start_pages)='array' AND jsonb_array_length(start_pages) BETWEEN 1 AND 20)),
 CHECK(state<>'ready' OR (completed_at IS NOT NULL AND page_count IS NOT NULL AND start_pages IS NOT NULL AND model IS NOT NULL AND prompt_version IS NOT NULL AND error IS NULL)),
 CHECK((confirmed_request_id IS NULL)=(confirmed_options IS NULL)),
 CHECK(accepted_split_id IS NULL OR confirmed_request_id IS NOT NULL)
);
CREATE INDEX split_suggestions_claim ON split_suggestions(state,available_at,created_at);
CREATE INDEX split_suggestions_requester ON split_suggestions(workspace_id,requested_by,parser_id,created_at DESC);
CREATE INDEX split_suggestions_sources ON split_suggestions(expires_at) WHERE source_storage_key IS NOT NULL OR staging_storage_key IS NOT NULL;
CREATE INDEX split_suggestions_document ON split_suggestions(source_document_id) WHERE source_document_id IS NOT NULL;
ALTER TABLE split_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE split_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON split_suggestions
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON split_suggestions TO folio_app;

ALTER TABLE pdf_splits ADD COLUMN ai_suggestion jsonb CHECK(ai_suggestion IS NULL OR jsonb_typeof(ai_suggestion)='object');
