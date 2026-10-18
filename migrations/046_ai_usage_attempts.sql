-- Dispatch intent can outlive its source/job. No document content is retained.
CREATE TABLE ai_usage_attempts (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('extraction','schema_suggestion','split_suggestion')),
 operation_id uuid NOT NULL,
 attempt integer NOT NULL CHECK(attempt>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(created_at)),
 observed_at timestamptz CHECK(isfinite(observed_at)),
 provider text NOT NULL DEFAULT 'openai' CHECK(provider='openai'),
 outcome text NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','response_received','interrupted')),
 model text CHECK(model ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$'),
 request_id text CHECK(request_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$'),
 response_id text CHECK(response_id ~ '^resp_[a-zA-Z0-9_-]{1,195}$'),
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 response_status text CHECK(response_status IN ('completed','incomplete','failed','cancelled','queued','in_progress','unknown')),
 usage_state text NOT NULL DEFAULT 'unknown' CHECK(usage_state IN ('unknown','reported_unpriced','reported_priced')),
 input_tokens bigint CHECK(input_tokens BETWEEN 0 AND 1000000000),
 cached_input_tokens bigint CHECK(cached_input_tokens BETWEEN 0 AND input_tokens),
 output_tokens bigint CHECK(output_tokens BETWEEN 0 AND 1000000000),
 reasoning_tokens bigint CHECK(reasoning_tokens BETWEEN 0 AND output_tokens),
 cost_usd numeric(20,9) CHECK(cost_usd>=0 AND cost_usd<1000000),
 pricing_basis text CHECK(length(pricing_basis) BETWEEN 1 AND 120),
 UNIQUE(workspace_id,kind,operation_id,attempt),
 CHECK((outcome='response_received' AND observed_at IS NOT NULL AND http_status IS NOT NULL AND response_status IS NOT NULL) OR
       (outcome<>'response_received' AND observed_at IS NULL AND model IS NULL AND request_id IS NULL AND response_id IS NULL AND http_status IS NULL AND response_status IS NULL AND usage_state='unknown')),
 CHECK((usage_state='unknown' AND input_tokens IS NULL AND cached_input_tokens IS NULL AND output_tokens IS NULL AND reasoning_tokens IS NULL AND cost_usd IS NULL AND pricing_basis IS NULL) OR
       (usage_state<>'unknown' AND input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND reasoning_tokens IS NOT NULL AND
        ((usage_state='reported_unpriced' AND cost_usd IS NULL AND pricing_basis IS NULL) OR (usage_state='reported_priced' AND model IS NOT NULL AND cost_usd IS NOT NULL AND pricing_basis IS NOT NULL))))
);
CREATE INDEX ai_usage_attempts_workspace_month ON ai_usage_attempts(workspace_id,created_at,id);
CREATE FUNCTION preserve_ai_usage_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.workspace_id,NEW.kind,NEW.operation_id,NEW.attempt,NEW.created_at,NEW.provider)
    IS DISTINCT FROM (OLD.id,OLD.workspace_id,OLD.kind,OLD.operation_id,OLD.attempt,OLD.created_at,OLD.provider)
    OR OLD.outcome='response_received' AND NEW IS DISTINCT FROM OLD
    OR OLD.outcome='interrupted' AND NEW.outcome='pending' THEN
  RAISE EXCEPTION 'AI usage identity and observed response are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ai_usage_attempts_immutable BEFORE UPDATE ON ai_usage_attempts FOR EACH ROW EXECUTE FUNCTION preserve_ai_usage_attempt();
ALTER TABLE ai_usage_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON ai_usage_attempts
 USING(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid)
 WITH CHECK(workspace_id=nullif(current_setting('app.workspace_id',true),'')::uuid);
GRANT SELECT ON ai_usage_attempts TO folio_app;
REVOKE INSERT,UPDATE,DELETE ON ai_usage_attempts FROM folio_app;
