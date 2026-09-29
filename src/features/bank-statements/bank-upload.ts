// Signed uploads currently return per-file error messages without status/reason codes.
// Match only the fixed input-validation catalogue; unknown or operational failures
// remain retryable. Keep this bank-only list aligned by the focused contract test.
const correctedFileMessages=new Set([
  'The file is empty',
  'Files must be 10 MB or smaller',
  'Invalid office archive',
  'Split and ZIP64 office archives are not supported',
  'Office archive contains too many entries',
  'Invalid office archive directory',
  'Unsupported or invalid office archive entry',
  'Expanded office file exceeds the 40 MB limit',
  'Office archive entry names must use UTF-8',
  'Invalid or duplicate office archive entry',
  'Invalid office archive local entry',
  'Office archive entry metadata does not match',
  'Invalid office archive directory size',
  'The archive is not a supported unambiguous DOCX, XLSX or ODT document',
  'This binary file type is not supported, regardless of its filename',
  'Email headers exceed the supported 64 KB limit',
  'Text files must use UTF-8 encoding or a supported binary format',
  'Binary control content is not accepted as text',
  'Supported formats: PDF, PNG, JPG, TIFF, TXT, EML, CSV, XLSX, DOCX, ODT and HTML',
  'The file does not contain a valid PDF',
  'Encrypted PDFs are not supported',
  'PDFs must be 30 pages or fewer',
  'The file does not contain a valid TIFF document',
  'This TIFF encoding is not supported. Export a standard image or PDF and try again.',
  'TIFF documents must be 30 pages or fewer',
  'The TIFF document exceeds the supported pixel or decoded image size limit',
  'The TIFF document exceeds the supported directory or image block limit',
  'The TIFF document is too detailed for the supported preview and AI conversion size. Export a smaller PDF and try again.',
  'The requested TIFF page does not exist',
  'Only PNG and JPEG image content is supported',
  'The file does not contain a valid OpenDocument Text package',
  'This ODT structure or version is not supported. Export a text-based PDF or DOCX and try again.',
  'Encrypted ODT documents are not supported. Upload an unencrypted copy.',
  'The ODT document exceeds the supported package, table or XML structure limits',
  'The ODT text exceeds the supported 2 MiB limit',
  'The ODT document has no readable body text. Export a text-based PDF or DOCX and try again.',
  'The XLSX file does not contain a worksheet',
  'Spreadsheets must contain 30 sheets or fewer',
  'Spreadsheet dimensions exceed the supported limit',
  'Choose a non-empty file of 10 MB or less.',
  'Each file must contain data and be 10 MB or smaller.',
  'File exceeds 10 MB limit',
  'Document exceeds the workspace file limit',
]);

export type BankUploadFailure={error:string;retryable:boolean};
export function bankUploadFailure(error:unknown):BankUploadFailure {
  const message=error instanceof Error?error.message:'Upload failed. Please retry.';
  // An available temporary HTTP status takes precedence over message matching.
  const status=error instanceof Error&&'status' in error?error.status:undefined;
  const temporary=typeof status==='number'&&(status===408||status===429||status>=500);
  return {error:message,retryable:temporary||!correctedFileMessages.has(message)};
}

/** Receipt is a transport fact; processing comes only from a current document. */
export function bankUploadProgress(item:{state:'waiting'|'uploading'|'received'|'failed';duplicate?:boolean;error?:string},documentStatus?:string){
  if(item.state==='waiting')return 'Waiting to upload';
  if(item.state==='uploading')return 'Uploading and checking file…';
  if(item.state==='failed')return item.error||'Upload failed. Please retry.';
  const labels:Record<string,string>={received:'waiting for extraction',queued:'extraction queued',processing:'extracting transactions…',needs_review:'ready for review',processed:'approved · ready to export',exporting:'preparing export',exported:'exported',failed:'extraction could not finish; open for details'};
  const progress=documentStatus&&Object.hasOwn(labels,documentStatus)?labels[documentStatus]:'open for current status';
  return `${item.duplicate?'Already uploaded':'Received'} · ${progress}`;
}
