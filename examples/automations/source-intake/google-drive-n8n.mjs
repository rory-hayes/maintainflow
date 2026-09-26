/**
 * Generates the credential-free n8n 2.40.7 import artifact.
 * The same pure guards below are embedded verbatim in its Code nodes and exported
 * for controlled tests. Importing this module performs no I/O or network calls.
 */
export function createGuards() {
  const MAX_BYTES = 4 * 1024 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DRIVE_ID = /^[A-Za-z0-9_-]{2,128}$/;
  const FORMATS = {
    pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'],
    tif: ['image/tiff'], tiff: ['image/tiff'], txt: ['text/plain'], eml: ['message/rfc822'],
    csv: ['text/csv', 'application/csv', 'text/plain'],
    xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    html: ['text/html'], htm: ['text/html'],
  };
  function fail(code, message) { throw new Error(`${code}: ${message}`); }
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function configure(input, config) {
    if (!object(config) || config.origin !== 'https://maintainflow.io' || !UUID.test(config.parserId || '') || !DRIVE_ID.test(config.folderId || '') || config.folderId.startsWith('REPLACE_')) {
      fail('configuration_required', 'Set the existing MaintainFlow parser UUID and the same owned Drive folder ID in Configure import and both Drive triggers. The API origin must be https://maintainflow.io.');
    }
    if (!object(input) || !DRIVE_ID.test(input.id || '')) fail('source_id_invalid', 'The Drive trigger must supply one ordinary file ID.');
    if (input.parents && (!Array.isArray(input.parents) || !input.parents.includes(config.folderId))) fail('source_folder_mismatch', 'The triggered file is outside the configured folder. No upload was attempted.');
    return {config: {origin: config.origin, parserId: config.parserId.toLowerCase(), folderId: config.folderId}, fileId: input.id};
  }
  function responseBody(response, operation, acceptedStatuses = [200]) {
    if (!object(response) || !Number.isInteger(response.statusCode)) fail('response_invalid', `${operation} did not return an HTTP status. Stop and inspect this execution.`);
    if (!acceptedStatuses.includes(response.statusCode)) {
      const status = response.statusCode;
      const advice = status === 401 ? 'Select a valid stored credential; do not paste a token into the workflow.'
        : status === 403 ? 'Check the stored credential scopes, file permissions and parser workspace.'
        : status === 404 ? 'Check that the owned source file, parser or document still exists.'
        : status === 409 ? 'The source key conflicts with another upload. Inspect the prior document; do not invent a replacement key.'
        : status === 410 ? 'The previously imported document was deleted. Inspect MaintainFlow; do not bypass its retained idempotency record.'
        : status === 413 ? 'This recipe accepts files up to 4 MiB. Use the MaintainFlow upload screen for larger files.'
        : status === 429 && response.body?.message === 'Document decoding is busy. Retry shortly.' ? 'Document decoding is busy. Wait briefly, then retry only the same file bytes, source version and parser key.'
        : status === 429 ? 'Check the workspace quota or rate limit before retrying the same file bytes, source version and parser key.'
        : 'Inspect the failed step. For an uncertain upload outcome, retry only the same source file version and parser key.';
      fail('http_failure', `${operation} returned HTTP ${status}. ${advice}`);
    }
    if (!object(response.body)) fail('response_invalid', `${operation} returned an unexpected body. No success is claimed.`);
    return response.body;
  }
  function metadata(raw, state) {
    if (!object(raw) || raw.id !== state.fileId || !Array.isArray(raw.parents) || !raw.parents.includes(state.config.folderId)) fail('source_identity_mismatch', 'Drive metadata does not identify the configured file and folder. No upload was attempted.');
    if (raw.trashed !== false || raw.capabilities?.canDownload !== true) fail('source_not_downloadable', 'The file is trashed or cannot be downloaded with this credential.');
    if (typeof raw.version !== 'string' || !/^[1-9][0-9]{0,19}$/.test(raw.version)) fail('source_version_missing', 'Drive did not supply a usable version string. No upload was attempted.');
    if (typeof raw.size !== 'string' || !/^[1-9][0-9]*$/.test(raw.size) || BigInt(raw.size) > BigInt(MAX_BYTES)) fail('source_size_limit', 'This recipe accepts nonempty files up to 4 MiB. Use the MaintainFlow upload screen for larger files.');
    if (typeof raw.md5Checksum !== 'string' || !/^[0-9a-f]{32}$/i.test(raw.md5Checksum)) fail('source_checksum_missing', 'A binary Drive file checksum is required. Google Docs, Sheets, Slides, folders and shortcuts are outside this recipe.');
    if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(raw.name)) fail('source_name_invalid', 'Use a plain filename with a supported extension, without directory separators or control characters.');
    const extension = raw.name.split('.').pop().toLowerCase();
    const mediaTypes = FORMATS[extension];
    if (typeof raw.mimeType !== 'string' || !Array.isArray(mediaTypes) || !mediaTypes.includes(raw.mimeType)) fail('source_format_unsupported', 'This recipe accepts supported binary PDF, PNG, JPEG, TIFF, TXT, EML, CSV, XLSX, DOCX and HTML files. Google-native documents require a separate export workflow.');
    return {id: raw.id, name: raw.name, mimeType: raw.mimeType, version: raw.version, size: raw.size, md5Checksum: raw.md5Checksum.toLowerCase()};
  }
  function prepareSource(state, response) {
    const source = metadata(responseBody(response, 'Read Drive metadata'), state);
    const idempotencyKey = `gd:${state.config.parserId}:${source.id}:v${source.version}`;
    if (idempotencyKey.length > 198) fail('source_key_too_long', 'The source identity exceeds the API idempotency limit. No upload was attempted.');
    return {...state, source, idempotencyKey};
  }
  function verifyBytes(state, byteLength, downloadedMd5, binary) {
    if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_BYTES || String(byteLength) !== state.source.size) fail('download_size_mismatch', 'Downloaded bytes differ from the recorded source size. No upload was attempted; retry after the source stops changing.');
    if (typeof downloadedMd5 !== 'string' || downloadedMd5.toLowerCase() !== state.source.md5Checksum) fail('download_checksum_mismatch', 'Downloaded bytes do not match the recorded Drive checksum. No upload was attempted.');
    if (!object(binary) || binary.fileName !== state.source.name || binary.mimeType !== state.source.mimeType) fail('download_metadata_mismatch', 'The downloaded filename or media type changed. No upload was attempted.');
    return {...state, downloadedBytes: byteLength, downloadedMd5: downloadedMd5.toLowerCase()};
  }
  function verifyStableSource(state, response) {
    const after = metadata(responseBody(response, 'Recheck Drive metadata'), state);
    for (const key of ['id', 'name', 'mimeType', 'version', 'size', 'md5Checksum']) {
      if (after[key] !== state.source[key]) fail('source_version_drift', 'The Drive file changed during download. Nothing was uploaded. Retry this source from the start after it stops changing.');
    }
    if (state.downloadedMd5 !== after.md5Checksum || String(state.downloadedBytes) !== after.size) fail('download_unverified', 'The downloaded bytes have not passed their source identity checks.');
    return state;
  }
  function beginPolling(state, response, now) {
    const receipt = responseBody(response, 'Upload to MaintainFlow', [202]);
    if (!object(receipt.document) || !UUID.test(receipt.document.id || '') || receipt.document.parserId !== state.config.parserId || typeof receipt.duplicate !== 'boolean' || !(receipt.jobId === null || UUID.test(receipt.jobId || ''))) fail('upload_receipt_invalid', 'The upload response did not identify the expected parser and document. Inspect MaintainFlow before retrying this same source key.');
    if (!receipt.duplicate && receipt.jobId === null) fail('upload_job_missing', 'A new upload returned no processing job. Inspect the document; do not assume it completed.');
    if (!Number.isSafeInteger(now)) fail('clock_invalid', 'Cannot establish the polling deadline.');
    return {...state, documentId: receipt.document.id, uploadedJobId: receipt.jobId, duplicate: receipt.duplicate, polls: 0, startedAt: now, done: false};
  }
  function nextPoll(state, now) {
    if (!Number.isSafeInteger(now) || now < state.startedAt || !Number.isInteger(state.polls) || state.polls < 0) fail('poll_state_invalid', 'The polling state is invalid. Inspect the existing document before resuming.');
    if (state.polls >= 60 || now - state.startedAt >= 600000) fail('poll_timeout', `Stopped after bounded status checks for document ${state.documentId}. Processing may continue in MaintainFlow; inspect its status before retrying. This workflow does not cancel or reprocess it.`);
    return {...state, polls: state.polls + 1};
  }
  function inspectDocument(state, response) {
    const detail = responseBody(response, 'Read MaintainFlow document');
    const doc = detail.document;
    if (!object(doc) || doc.id !== state.documentId || doc.parserId !== state.config.parserId || !Array.isArray(detail.jobs) || !Array.isArray(detail.runs)) fail('document_identity_mismatch', 'The result did not match this upload and parser. No completion is claimed.');
    const allowedStates = ['queued', 'processing', 'completed', 'failed'];
    if (detail.jobs.some(job => !object(job) || !UUID.test(job.id || '') || !allowedStates.includes(job.state))) fail('job_state_invalid', 'The document contains an unknown processing state. Inspect it in MaintainFlow.');
    const active = detail.jobs.filter(job => job.state === 'queued' || job.state === 'processing');
    if (active.length > 1) fail('job_identity_ambiguous', 'More than one active job was returned. Inspect the document before continuing.');
    if (active.length === 1) {
      if (active[0].waitingForSchema) fail('schema_required', `Finish parser field setup for document ${state.documentId} in MaintainFlow. The existing queued job is waiting for its schema; do not upload again.`);
      return {...state, jobId: active[0].id, state: active[0].state, done: false};
    }
    if (doc.status === 'failed') fail('processing_failed', `Processing failed for document ${state.documentId}. Open it in MaintainFlow for the failure detail and any deliberate retry; this workflow will not reprocess it.`);
    if (!['needs_review', 'processed', 'exporting', 'exported'].includes(doc.status)) fail('processing_state_unresolved', `Document ${state.documentId} has no active job and is not ready for review. Inspect its status; older extraction runs are not proof of completion.`);
    if (!UUID.test(doc.latestRunId || '')) fail('latest_run_missing', 'The document has no current extraction result. No completion is claimed.');
    const run = detail.runs.find(item => item.id === doc.latestRunId);
    if (!run || run.documentId !== state.documentId || !UUID.test(run.jobId || '')) fail('latest_run_mismatch', 'The current extraction run does not match the uploaded document. No completion is claimed.');
    const completed = detail.jobs.find(job => job.id === run.jobId);
    if (completed?.state !== 'completed') fail('latest_job_unresolved', 'The current result does not have a completed processing job. Inspect MaintainFlow before proceeding.');
    return {...state, jobId: completed.id, runId: run.id, state: doc.status, done: true};
  }
  function result(state) {
    if (!state.done) fail('not_complete', 'The current document is not ready.');
    return {source: 'google-drive', sourceFileId: state.source.id, sourceVersion: state.source.version, sourceFilename: state.source.name, sourceBytes: state.downloadedBytes, sourceMd5: state.downloadedMd5, parserId: state.config.parserId, idempotencyKey: state.idempotencyKey, documentId: state.documentId, jobId: state.jobId, runId: state.runId, duplicate: state.duplicate, status: state.state, reviewUrl: `${state.config.origin}/app/documents/${state.documentId}`, approval: 'Manual review in MaintainFlow; this workflow never approves or exports results.'};
  }
  return {MAX_BYTES, configure, responseBody, prepareSource, verifyBytes, verifyStableSource, beginPolling, nextPoll, inspectDocument, result};
}

export const guards = createGuards();
export const {configure, responseBody, prepareSource, verifyBytes, verifyStableSource, beginPolling, nextPoll, inspectDocument, result} = guards;
export const reviewedN8nVersion = '2.40.7';
export const officialSources = [
  'https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googledrive/file-operations/',
  'https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/',
  'https://developers.google.com/workspace/drive/api/reference/rest/v3/files',
  'https://developers.google.com/workspace/drive/api/guides/manage-downloads',
  'https://github.com/n8n-io/n8n/blob/n8n%402.40.7/packages/nodes-base/nodes/Google/Drive/GoogleDriveTrigger.node.ts',
  'https://github.com/n8n-io/n8n/blob/n8n%402.40.7/packages/nodes-base/nodes/Google/Drive/v2/actions/file/download.operation.ts',
  'https://github.com/n8n-io/n8n/blob/n8n%402.40.7/packages/nodes-base/nodes/Crypto/v2/CryptoV2.node.ts',
];

export function codeSource(body) {
  return `// Generated from source-intake/google-drive-n8n.mjs. No credentials or network calls in this Code node.\nconst g = (${createGuards.toString()})();\nif ($input.all().length !== 1) throw new Error('one_file_required: Keep Loop over files batch size at 1.');\n${body}`;
}

export function buildWorkflow() {
  const nodes = [];
  let sequence = 0;
  function node(name, type, typeVersion, parameters, position, extra = {}) {
    const id = `c015ec08-2026-4000-8000-${String(++sequence).padStart(12, '0')}`;
    const n = {id, name, type: `n8n-nodes-base.${type}`, typeVersion, position, parameters, ...extra};
    nodes.push(n); return n;
  }
  function code(name, body, x, y = 180) { return node(name, 'code', 2, {mode: 'runOnceForAllItems', jsCode: codeSource(body)}, [x, y]); }
  const httpOptions = {timeout: 30000, redirect: {redirect: {followRedirects: false}}, response: {response: {fullResponse: true, neverError: true, responseFormat: 'json'}}};
  const googleAuth = {authentication: 'predefinedCredentialType', nodeCredentialType: 'googleDriveOAuth2Api'};
  const maintainflowAuth = {authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth'};
  const credentialNote = 'Select the existing stored credential after import. No credential is embedded. Keep node retries disabled.';
  const fields = 'id,name,mimeType,version,size,md5Checksum,trashed,parents,capabilities(canDownload)';
  for (const [name, event, y] of [['Drive file created', 'fileCreated', 60], ['Drive file updated', 'fileUpdated', 300]]) {
    node(name, 'googleDriveTrigger', 1, {authentication: 'oAuth2', pollTimes: {item: [{mode: 'everyMinute'}]}, triggerOn: 'specificFolder', folderToWatch: {__rl: true, value: 'REPLACE_WITH_DRIVE_FOLDER_ID', mode: 'id'}, event, options: {}}, [0, y], {notes: `${credentialNote} Set the same folder in both triggers and Configure import. Direct children only; no historical backfill.`, notesInFlow: true});
  }
  node('Loop over files', 'splitInBatches', 3, {batchSize: 1, options: {}}, [240, 180]);
  code('Configure import', "const config = {origin: 'https://maintainflow.io', parserId: 'REPLACE_WITH_EXISTING_PARSER_UUID', folderId: 'REPLACE_WITH_DRIVE_FOLDER_ID'};\nreturn [{json: g.configure($input.first().json, config), pairedItem: {item: 0}}];", 480);
  function googleMetadata(name, x) {
    return node(name, 'httpRequest', 4.2, {method: 'GET', url: '=https://www.googleapis.com/drive/v3/files/{{ $json.fileId }}', ...googleAuth, sendQuery: true, queryParameters: {parameters: [{name: 'fields', value: fields}, {name: 'supportsAllDrives', value: 'true'}]}, options: structuredClone(httpOptions)}, [x, 180], {retryOnFail: false, notes: credentialNote});
  }
  googleMetadata('Read Drive metadata', 720);
  code('Check source metadata', "return [{json: g.prepareSource($('Configure import').item.json, $input.first().json), pairedItem: {item: 0}}];", 960);
  node('Download Drive bytes', 'googleDrive', 3, {authentication: 'oAuth2', resource: 'file', operation: 'download', fileId: {__rl: true, value: '={{ $json.fileId }}', mode: 'id'}, options: {binaryPropertyName: 'data', fileName: '={{ $json.source.name }}'}}, [1200, 180], {retryOnFail: false, notes: `${credentialNote} Only the metadata-checked binary file reaches this node. Google-native export is not used.`});
  node('Hash downloaded bytes', 'crypto', 2, {action: 'hash', type: 'MD5', binaryData: true, binaryPropertyName: 'data', dataPropertyName: 'downloadedMd5', encoding: 'hex'}, [1440, 180]);
  // Crypto intentionally removes the binary it hashes; recover the linked native
  // download, never a base64 field or another item from the trigger batch.
  code('Restore downloaded file', "const hashed = $input.first();\nconst downloaded = $('Download Drive bytes').item;\nreturn [{json: {...downloaded.json, downloadedMd5: hashed.json.downloadedMd5}, binary: downloaded.binary, pairedItem: {item: 0}}];", 1560, 400);
  code('Check downloaded bytes', "const item = $input.first();\nconst bytes = await this.helpers.getBinaryDataBuffer(0, 'data');\nreturn [{json: g.verifyBytes(item.json, bytes.length, item.json.downloadedMd5, item.binary?.data), binary: item.binary, pairedItem: {item: 0}}];", 1680);
  googleMetadata('Recheck Drive metadata', 1920);
  code('Refuse changed source', "const downloaded = $('Check downloaded bytes').item;\nreturn [{json: g.verifyStableSource(downloaded.json, $input.first().json), binary: downloaded.binary, pairedItem: {item: 0}}];", 2160);
  node('Upload to MaintainFlow', 'httpRequest', 4.2, {method: 'POST', url: '={{ $json.config.origin + "/api/parsers/" + $json.config.parserId + "/documents" }}', ...maintainflowAuth, sendHeaders: true, headerParameters: {parameters: [{name: 'Idempotency-Key', value: '={{ $json.idempotencyKey }}'}]}, sendBody: true, contentType: 'multipart-form-data', bodyParameters: {parameters: [{parameterType: 'formBinaryData', name: 'file', inputDataFieldName: 'data'}]}, options: structuredClone(httpOptions)}, [2400, 180], {retryOnFail: false, notes: `${credentialNote} Header Auth name Authorization; value Bearer followed by the existing scoped API key. This recipe stops above 4 MiB. On uncertain response, inspect MaintainFlow and retry only this same source version and key.`, notesInFlow: true});
  code('Start status checks', "return [{json: g.beginPolling($('Refuse changed source').item.json, $input.first().json, Date.now()), pairedItem: {item: 0}}];", 2640);
  code('Bound status checks', "return [{json: g.nextPoll($input.first().json, Date.now()), pairedItem: {item: 0}}];", 2880);
  node('Read document and jobs', 'httpRequest', 4.2, {method: 'GET', url: '={{ $json.config.origin + "/api/documents/" + $json.documentId }}', ...maintainflowAuth, options: structuredClone(httpOptions)}, [3120, 180], {retryOnFail: false, notes: `${credentialNote} Uses documents:read. A duplicate upload with jobId null still needs this read; old extraction runs alone never establish completion.`});
  code('Check current processing', "return [{json: g.inspectDocument($('Bound status checks').item.json, $input.first().json), pairedItem: {item: 0}}];", 3360);
  node('Ready for review', 'if', 2.2, {conditions: {options: {caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2}, conditions: [{id: 'finished', leftValue: '={{ $json.done }}', rightValue: true, operator: {type: 'boolean', operation: 'true', singleValue: true}}], combinator: 'and'}, options: {}}, [3600, 180]);
  node('Wait before next check', 'wait', 1.1, {resume: 'timeInterval', amount: 5, unit: 'seconds'}, [3600, 460], {webhookId: 'c015ec08-2026-4000-8000-000000000060'});
  code('Review receipt', "return [{json: g.result($input.first().json), pairedItem: {item: 0}}];", 3840, 60);
  node('Import batch finished', 'noOp', 1, {}, [480, -100]);
  node('Read before enabling', 'stickyNote', 1, {width: 700, height: 440, content: '## Google Drive → MaintainFlow (n8n 2.40.7)\nInactive and credential-free on import.\n\n1. Set one owned folder in BOTH triggers and Configure import; set an EXISTING parser UUID.\n2. Select the same Google Drive credential in both triggers, both metadata reads and Download Drive bytes.\n3. Select one stored Header Auth credential in both MaintainFlow HTTP nodes: Authorization = Bearer <existing key>. Scopes: documents:write, documents:read.\n4. Review docs/SOURCE-INTAKE-RECIPES.md before enabling.\n\n**4 MiB maximum per file** for this multipart recipe. Larger files: use the app upload screen. Supported ordinary binary files only; no Google Docs conversion, subfolders or backfill.\n\nVersion + checksum + byte-count checks precede the upload. Bounded polling does not cancel processing. Approval stays manual. On a failed batch, inspect the failed source and unprocessed later files; trigger polling is not a durable import queue.\n\nNo automatic approval, original deletion or reprocessing. No credential values belong in this JSON.'}, [720, -400]);
  const connections = {};
  function connect(from, to, output = 0) {
    connections[from] ??= {main: []};
    while (connections[from].main.length <= output) connections[from].main.push([]);
    connections[from].main[output].push({node: to, type: 'main', index: 0});
  }
  connect('Drive file created', 'Loop over files'); connect('Drive file updated', 'Loop over files');
  connect('Loop over files', 'Import batch finished', 0); connect('Loop over files', 'Configure import', 1);
  const path = ['Configure import', 'Read Drive metadata', 'Check source metadata', 'Download Drive bytes', 'Hash downloaded bytes', 'Restore downloaded file', 'Check downloaded bytes', 'Recheck Drive metadata', 'Refuse changed source', 'Upload to MaintainFlow', 'Start status checks', 'Bound status checks', 'Read document and jobs', 'Check current processing', 'Ready for review'];
  for (let i = 1; i < path.length; i++) connect(path[i - 1], path[i]);
  connect('Ready for review', 'Review receipt', 0); connect('Review receipt', 'Loop over files');
  connect('Ready for review', 'Wait before next check', 1); connect('Wait before next check', 'Bound status checks');
  return {name: 'MaintainFlow — Google Drive file intake (4 MiB)', active: false, nodes, connections, pinData: {}, settings: {executionOrder: 'v1'}, tags: []};
}

// Explicit local generation only; import is side-effect free.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const {writeFile} = await import('node:fs/promises');
  const destination = new URL('../google-drive-n8n.workflow.json', import.meta.url);
  await writeFile(destination, `${JSON.stringify(buildWorkflow(), null, 2)}\n`);
  process.stdout.write('Generated credential-free google-drive-n8n.workflow.json\n');
}
