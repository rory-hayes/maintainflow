-- A run retains its interpretation settings even after its originating job is removed.
-- Legacy runs remain NULL: today's parser settings cannot reconstruct their history.
ALTER TABLE extraction_runs ADD COLUMN normalization_context jsonb
 CHECK(normalization_context IS NULL OR (
  jsonb_typeof(normalization_context)='object'
  AND jsonb_typeof(normalization_context->'version')='string'
  AND normalization_context->>'version'='timestamp-v1'
  AND jsonb_typeof(normalization_context->'locale')='string'
  AND length(normalization_context->>'locale') BETWEEN 1 AND 35
  AND jsonb_typeof(normalization_context->'timezone') IN ('string','null')
  AND jsonb_typeof(normalization_context->'tzdbVersion') IN ('string','null')
  AND normalization_context ?& ARRAY['version','locale','timezone','tzdbVersion']
  AND normalization_context - ARRAY['version','locale','timezone','tzdbVersion']='{}'::jsonb
 ));
