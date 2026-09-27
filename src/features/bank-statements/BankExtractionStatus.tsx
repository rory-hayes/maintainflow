export type BankExtractionJob={id:string;state:string;attempts?:number;maxAttempts?:number;error?:string|null};

// Exact existing worker/provider/storage messages only. Unknown exceptions must
// never become public copy or a recommendation to spend more pages blindly.
const setupFailures=new Set([
  'Bank statement extraction is unavailable because the AI provider is not configured. Ask your administrator to enable it, then retry the statement.',
  'AI extraction is not configured. Configure the server provider or choose text-anchor rules.',
  'OpenAI rejected the server credentials or model access. Check the configured project.',
  'OpenAI could not complete this extraction. Check the document and project configuration.',
  'Private storage requires a Supabase project HTTPS URL',
  'Private storage credentials are not configured',
  'Unknown private storage driver',
  'Configure the originals bucket as private with a 10 MB file limit before uploading',
  'This job uses an unsupported bank PDF input version. Reprocess with current saved settings.',
  'This job uses an unsupported bank statement workflow. Reprocess with current saved settings.',
  'This bank statement job has incompatible extraction settings. Reprocess with the bank statement workflow.',
]);
const sourceFailures=new Set([
  'The original bank PDF no longer matches its verified intake. Reprocess a verified source.',
  'The original bank PDF page count or source identity changed. Reprocess a verified source.',
  'The original PDF changed and its template regions could not be verified. Reprocess a verified source.',
  'The original PDF changed before its extraction result could be saved. Reprocess a verified source.',
  'The bank PDF layout does not match a valid source document.',
  'Original file is unavailable',
  'File exceeds the 10 MB limit',
  'The document exceeds AI input limits or has invalid page metadata.',
  'The document text or instructions exceed AI input limits. Split the document or shorten the instructions.',
  'OpenAI rejected the extraction request. Check the document and parser limits.',
  'OpenAI did not complete the extraction within its output limits. Reduce the schema or split the document.',
  'The OpenAI response exceeded the 1 MB response limit. Reduce the extraction schema.',
]);
const temporaryFailures=new Set([
  'Private storage is temporarily unavailable. Retry shortly.',
  'OpenAI is temporarily unavailable or rate limited. The worker will retry.',
  'OpenAI reported a temporary extraction failure. The worker will retry.',
  'OpenAI extraction was canceled or exceeded its time limit. Retry when ready.',
  'Extraction interrupted by worker shutdown; retry scheduled',
  'Extraction provider exceeded the 90-second timeout',
  'Worker lease expired; retry scheduled',
]);
function failureGuidance(error:string|null|undefined,canEdit:boolean){
  if(error==='The OpenAI project has no available API quota. Check project billing and limits.')return 'Statement processing is unavailable right now. Contact MaintainFlow support before starting another extraction.';
  if(error&&setupFailures.has(error))return 'Statement processing needs attention. Contact MaintainFlow support before starting another extraction.';
  if(error&&sourceFailures.has(error))return 'The original statement or processing limits need attention. Check the original file and supported limits, and contact support before starting another extraction.';
  if(error&&temporaryFailures.has(error))return canEdit?'A temporary service or processing interruption stopped this extraction. Wait a little before using Extract again; a new extraction uses pages from your allowance.':'A temporary service or processing interruption stopped this extraction. Ask a workspace editor to try again later if needed.';
  return 'Contact MaintainFlow support to check this failure before starting another extraction.';
}

/** Job exceptions are not public copy: describe lifecycle using fixed messages only. */
export default function BankExtractionStatus({documentStatus,documentError,latestJob,hasRun,canEdit}:{documentStatus:string;documentError?:string|null;latestJob?:BankExtractionJob;hasRun:boolean;canEdit:boolean}){
  const state=latestJob?.state??documentStatus;
  if(!['queued','processing','failed'].includes(state))return null;
  const attempts=latestJob?.attempts,max=latestJob?.maxAttempts;
  const validAttempts=typeof attempts==='number'&&Number.isSafeInteger(attempts)&&attempts>=0&&typeof max==='number'&&Number.isSafeInteger(max)&&max>0&&attempts<=max;
  const retry=state==='queued'&&validAttempts&&attempts>0&&attempts<max;
  const title=state==='failed'?'The latest extraction could not finish.':state==='processing'?'Extraction in progress.':retry?'Another extraction attempt is queued.':'Extraction queued.';
  const description=state==='failed'?failureGuidance(latestJob?latestJob.error:documentError,canEdit):state==='processing'?'This page updates automatically when the extraction finishes.':retry?'The last attempt did not finish. It will retry automatically; you do not need to upload the statement again.':'Waiting to start. This page updates automatically.';
  return <div className="bank-callout" role="status" aria-live="polite" aria-atomic="true"><strong>{title}</strong><p>{description}</p>{validAttempts&&attempts>0&&<p className="small">{state==='processing'?`Attempt ${attempts} of ${max}.`:`${attempts} of ${max} attempts used.`}</p>}{hasRun&&<p>The transactions below are from your selected earlier extraction. Your draft and existing approvals remain available. Approved downloads still use the saved approval.</p>}</div>;
}
