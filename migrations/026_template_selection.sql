-- New workers record their pinned method-selection decision. Old runs remain null.
ALTER TABLE extraction_runs ADD COLUMN selection jsonb;
ALTER TABLE extraction_runs ADD CONSTRAINT extraction_selection_object
 CHECK(selection IS NULL OR (jsonb_typeof(selection)='object' AND octet_length(selection::text)<=8192));
