-- Add a new pinned interpretation policy without rewriting any stored run.
-- Old jobs still record timestamp-v1; only new general-parser jobs use regional-v2.
ALTER TABLE extraction_runs DROP CONSTRAINT extraction_runs_normalization_context_check;
ALTER TABLE extraction_runs ADD CONSTRAINT extraction_runs_normalization_context_check
 CHECK(normalization_context IS NULL OR (
  jsonb_typeof(normalization_context)='object'
  AND jsonb_typeof(normalization_context->'version')='string'
  AND normalization_context->>'version' IN ('timestamp-v1','regional-v2')
  AND jsonb_typeof(normalization_context->'locale')='string'
  AND length(normalization_context->>'locale') BETWEEN 1 AND 35
  AND jsonb_typeof(normalization_context->'timezone') IN ('string','null')
  AND jsonb_typeof(normalization_context->'tzdbVersion') IN ('string','null')
  AND normalization_context ?& ARRAY['version','locale','timezone','tzdbVersion']
  AND normalization_context - ARRAY['version','locale','timezone','tzdbVersion']='{}'::jsonb
 ));
