-- TIFF participates in the same parser policy, durable rejection and ZIP lineage contracts.
ALTER TABLE parsers DROP CONSTRAINT parsers_allowed_formats;
ALTER TABLE parsers ADD CONSTRAINT parsers_allowed_formats CHECK (
 allowed_formats IS NULL OR (cardinality(allowed_formats) BETWEEN 1 AND 10
  AND array_ndims(allowed_formats)=1 AND array_position(allowed_formats,NULL) IS NULL
  AND allowed_formats <@ ARRAY['pdf','png','jpeg','txt','eml','csv','xlsx','docx','html','tiff']::text[])
);

ALTER TABLE intake_events DROP CONSTRAINT intake_rejection_shape;
ALTER TABLE intake_events ADD CONSTRAINT intake_rejection_shape CHECK (
 (rejection_code IS NULL AND rejection_format IS NULL AND rejection_reason IS NULL
  AND rejection_sha256 IS NULL AND rejected_parser_id IS NULL)
 OR
 (document_id IS NULL AND rejection_code IS NOT NULL
  AND rejection_sha256 IS NOT NULL AND rejection_sha256 ~ '^[0-9a-f]{64}$'
  AND rejected_parser_id IS NOT NULL
  AND (
   (rejection_code='parser_format_not_allowed' AND rejection_reason IS NULL
    AND rejection_format IS NOT NULL AND rejection_format IN ('pdf','png','jpeg','txt','eml','csv','xlsx','docx','html','tiff'))
   OR
   (rejection_code='source_validation_failed' AND rejection_format IS NULL
    AND rejection_reason IS NOT NULL AND rejection_reason IN (
     'empty','file_too_large','office_archive_invalid','office_archive_unsupported',
     'office_entry_limit','office_directory_invalid','office_entry_invalid','office_expansion_limit',
     'office_entry_encoding','office_entry_path','office_local_entry_invalid','office_entry_mismatch',
     'office_directory_size','office_format_unsupported','binary_format_unsupported','email_header_limit',
     'text_encoding','text_binary_content','format_unsupported','pdf_invalid','pdf_encrypted','pdf_page_limit',
     'image_format_unsupported','xlsx_empty','xlsx_sheet_limit','xlsx_dimensions','tiff_invalid','tiff_unsupported','tiff_page_limit','tiff_pixel_limit','tiff_structure_limit','tiff_derived_limit','tiff_page_bounds'
    ))
  ))
);

ALTER TABLE pdf_splits DROP CONSTRAINT pdf_split_receipt_shape;
ALTER TABLE pdf_splits ADD CONSTRAINT pdf_split_receipt_shape CHECK(
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
     'invalid_spec','invalid_ranges','page_bounds','document_limit','pdf_required','child_size_limit','derived_size_limit','text_limit',
     'marker_no_text','marker_not_found','marker_plan_mismatch'))
    OR (rejection_code='source_validation_failed' AND rejection_reason IN (
     'empty','file_too_large','office_archive_invalid','office_archive_unsupported',
     'office_entry_limit','office_directory_invalid','office_entry_invalid','office_expansion_limit',
     'office_entry_encoding','office_entry_path','office_local_entry_invalid','office_entry_mismatch',
     'office_directory_size','office_format_unsupported','binary_format_unsupported','email_header_limit',
     'text_encoding','text_binary_content','format_unsupported','pdf_invalid','pdf_encrypted','pdf_page_limit',
     'image_format_unsupported','xlsx_empty','xlsx_sheet_limit','xlsx_dimensions','tiff_invalid','tiff_unsupported','tiff_page_limit','tiff_pixel_limit','tiff_structure_limit','tiff_derived_limit','tiff_page_bounds'))
   )));

ALTER TABLE archive_imports DROP CONSTRAINT archive_import_receipt_shape;
ALTER TABLE archive_imports ADD CONSTRAINT archive_import_receipt_shape CHECK(
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
    OR (rejection_code='source_validation_failed' AND rejection_reason IN ('empty','file_too_large','office_archive_invalid','office_archive_unsupported','office_entry_limit','office_directory_invalid','office_entry_invalid','office_expansion_limit','office_entry_encoding','office_entry_path','office_local_entry_invalid','office_entry_mismatch','office_directory_size','office_format_unsupported','binary_format_unsupported','email_header_limit','text_encoding','text_binary_content','format_unsupported','pdf_invalid','pdf_encrypted','pdf_page_limit','image_format_unsupported','xlsx_empty','xlsx_sheet_limit','xlsx_dimensions','tiff_invalid','tiff_unsupported','tiff_page_limit','tiff_pixel_limit','tiff_structure_limit','tiff_derived_limit','tiff_page_bounds'))
    OR (rejection_code='parser_format_not_allowed' AND rejection_reason IN ('pdf','png','jpeg','txt','eml','csv','xlsx','docx','html','tiff'))
   )));

ALTER TABLE archive_import_entries DROP CONSTRAINT archive_import_entries_format_check;
ALTER TABLE archive_import_entries ADD CONSTRAINT archive_import_entries_format_check CHECK(format IN ('pdf','png','jpeg','txt','eml','csv','xlsx','docx','html','tiff'));
