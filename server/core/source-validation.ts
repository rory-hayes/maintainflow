/** Only proven input-validation failures belong here; operational failures retry. */
export const sourceValidationReasons = Object.freeze({
  empty: { message: 'The file is empty', statusCode: 400 },
  file_too_large: { message: 'Files must be 10 MB or smaller', statusCode: 413 },
  office_archive_invalid: { message: 'Invalid office archive', statusCode: 400 },
  office_archive_unsupported: { message: 'Split and ZIP64 office archives are not supported', statusCode: 400 },
  office_entry_limit: { message: 'Office archive contains too many entries', statusCode: 400 },
  office_directory_invalid: { message: 'Invalid office archive directory', statusCode: 400 },
  office_entry_invalid: { message: 'Unsupported or invalid office archive entry', statusCode: 400 },
  office_expansion_limit: { message: 'Expanded office file exceeds the 40 MB limit', statusCode: 400 },
  office_entry_encoding: { message: 'Office archive entry names must use UTF-8', statusCode: 400 },
  office_entry_path: { message: 'Invalid or duplicate office archive entry', statusCode: 400 },
  office_local_entry_invalid: { message: 'Invalid office archive local entry', statusCode: 400 },
  office_entry_mismatch: { message: 'Office archive entry metadata does not match', statusCode: 400 },
  office_directory_size: { message: 'Invalid office archive directory size', statusCode: 400 },
  office_format_unsupported: { message: 'The archive is not a supported unambiguous DOCX or XLSX document', statusCode: 400 },
  binary_format_unsupported: { message: 'This binary file type is not supported, regardless of its filename', statusCode: 400 },
  email_header_limit: { message: 'Email headers exceed the supported 64 KB limit', statusCode: 400 },
  text_encoding: { message: 'Text files must use UTF-8 encoding or a supported binary format', statusCode: 400 },
  text_binary_content: { message: 'Binary control content is not accepted as text', statusCode: 400 },
  format_unsupported: { message: 'Supported formats: PDF, PNG, JPG, TXT, EML, CSV, XLSX, DOCX and HTML', statusCode: 400 },
  pdf_invalid: { message: 'The file does not contain a valid PDF', statusCode: 400 },
  pdf_encrypted: { message: 'Encrypted PDFs are not supported', statusCode: 400 },
  pdf_page_limit: { message: 'PDFs must be 30 pages or fewer', statusCode: 413 },
  image_format_unsupported: { message: 'Only PNG and JPEG image content is supported', statusCode: 400 },
  xlsx_empty: { message: 'The XLSX file does not contain a worksheet', statusCode: 400 },
  xlsx_sheet_limit: { message: 'Spreadsheets must contain 30 sheets or fewer', statusCode: 400 },
  xlsx_dimensions: { message: 'Spreadsheet dimensions exceed the supported limit', statusCode: 400 },
} as const);

export type SourceValidationReason = keyof typeof sourceValidationReasons;

export function isSourceValidationReason(value: unknown): value is SourceValidationReason {
  return typeof value === 'string' && Object.hasOwn(sourceValidationReasons, value);
}

export class SourceValidationError extends Error {
  readonly code = 'source_validation_failed';
  readonly statusCode: number;
  constructor(readonly reason: SourceValidationReason) {
    if (!isSourceValidationReason(reason)) throw new TypeError('Unknown source validation reason');
    const definition = sourceValidationReasons[reason];
    super(definition.message);
    this.name = 'SourceValidationError';
    this.statusCode = definition.statusCode;
  }
}
