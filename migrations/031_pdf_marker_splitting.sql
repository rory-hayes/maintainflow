-- Add fixed native-text marker rejection reasons without changing existing receipts.
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
     'image_format_unsupported','xlsx_empty','xlsx_sheet_limit','xlsx_dimensions'))
   )));
