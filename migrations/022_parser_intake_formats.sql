-- NULL retains the existing behavior for every parser and future supported format.
ALTER TABLE parsers ADD COLUMN allowed_formats text[] DEFAULT NULL;
ALTER TABLE parsers ADD CONSTRAINT parsers_allowed_formats CHECK (
 allowed_formats IS NULL OR (
  cardinality(allowed_formats) BETWEEN 1 AND 9
  AND array_ndims(allowed_formats)=1
  AND array_position(allowed_formats,NULL) IS NULL
  AND allowed_formats <@ ARRAY['pdf','png','jpeg','txt','eml','csv','xlsx','docx','html']::text[]
 )
);

-- A rejected intake is a durable decision, distinct from a deleted accepted document.
-- Binding it to the parser and bytes prevents an idempotency key being reused for
-- a different file. These receipts retain no filename or document contents.
ALTER TABLE intake_events
 ADD COLUMN rejection_code text,
 ADD COLUMN rejection_format text,
 ADD COLUMN rejection_sha256 text,
 ADD COLUMN rejected_parser_id uuid;
ALTER TABLE intake_events ADD CONSTRAINT intake_rejected_parser
 FOREIGN KEY(rejected_parser_id,workspace_id) REFERENCES parsers(id,workspace_id) ON DELETE CASCADE;
ALTER TABLE intake_events ADD CONSTRAINT intake_rejection_shape CHECK (
 (rejection_code IS NULL AND rejection_format IS NULL AND rejection_sha256 IS NULL AND rejected_parser_id IS NULL)
 OR
 (document_id IS NULL AND rejection_code IS NOT NULL AND rejection_code='parser_format_not_allowed'
  AND rejection_format IS NOT NULL AND rejection_format IN ('pdf','png','jpeg','txt','eml','csv','xlsx','docx','html')
  AND rejection_sha256 IS NOT NULL AND rejection_sha256 ~ '^[0-9a-f]{64}$'
  AND rejected_parser_id IS NOT NULL)
);
