-- Source validation rejects complete input bytes before any original is stored.
-- Only finite application-owned reasons cross the decoder and receipt boundary.
ALTER TABLE intake_events ADD COLUMN rejection_reason text;
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
    AND rejection_format IS NOT NULL AND rejection_format IN ('pdf','png','jpeg','txt','eml','csv','xlsx','docx','html'))
   OR
   (rejection_code='source_validation_failed' AND rejection_format IS NULL
    AND rejection_reason IS NOT NULL AND rejection_reason IN (
     'empty','file_too_large','office_archive_invalid','office_archive_unsupported',
     'office_entry_limit','office_directory_invalid','office_entry_invalid','office_expansion_limit',
     'office_entry_encoding','office_entry_path','office_local_entry_invalid','office_entry_mismatch',
     'office_directory_size','office_format_unsupported','binary_format_unsupported','email_header_limit',
     'text_encoding','text_binary_content','format_unsupported','pdf_invalid','pdf_encrypted','pdf_page_limit',
     'image_format_unsupported','xlsx_empty','xlsx_sheet_limit','xlsx_dimensions'
    ))
  ))
);
