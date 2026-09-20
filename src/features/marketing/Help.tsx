import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Code2, FileText, Settings2 } from 'lucide-react';
import { MarketingFooter, MarketingHeader } from './MarketingShell';
import { useAiAvailability } from '../../lib/ai';
import { useData } from '../../lib/api';
import type { PublicInstallation } from '../../../shared/installation';
import './marketing.css';

type GuideLayoutProps = { title: string; introduction: string; children: ReactNode };

function GuideLayout({ title, introduction, children }: GuideLayoutProps) {
  return (
    <div className="marketing-page">
      <a className="marketing-skip-link" href="#guide-content">Skip to content</a>
      <MarketingHeader />
      <main className="marketing-guide marketing-container" id="guide-content">
        <Link to="/help" className="marketing-guide-back"><BookOpen size={17} /> Help & documentation</Link>
        <h1>{title}</h1>
        <p className="marketing-guide-introduction">{introduction}</p>
        <div className="marketing-guide-body">{children}</div>
      </main>
      <MarketingFooter />
    </div>
  );
}

function supportedFormats(configured: boolean | undefined) {
  const imageStatus = configured === true ? 'AI is configured; select AI mode in parser settings.' : configured === false ? 'AI is not configured in this installation.' : 'Check parser settings for current AI availability.';
  return [
    ['PDF', `Up to 30 pages. Readable text can use text-anchor extraction. Scanned pages need AI mode. ${imageStatus}`],
    ['TIFF', `Up to 30 pages, 40 megapixels per page and 300 megapixels total. Review and AI use resized page images; download the unchanged original at any time. Image extraction requires AI mode. ${imageStatus}`],
    ['PNG and JPEG', `One page per image; up to 40 megapixels. Image extraction requires AI mode. ${imageStatus}`],
    ['TXT, CSV, HTML and EML', 'UTF-8 text. EML upload extracts the email body; provider-based inbound attachments are a separate intake path.'],
    ['DOCX', 'Text is read as one extraction page. The original Word layout is not a page-coordinate model.'],
    ['XLSX', 'Each worksheet counts as one page, up to 30 worksheets, 10,000 rows and 200 columns per worksheet.'],
  ];
}

export default function Help() {
  const ai = useAiAvailability();
  return (
    <GuideLayout title="Get your first document moving." introduction="A practical guide to capturing documents, checking the details and exporting clean data.">
      <nav className="marketing-guide-shortcuts" aria-label="Help topics">
        <a href="#first-document"><FileText size={21} /><span>Your first document</span><ArrowRight size={16} /></a>
        <a href="#integrations"><Settings2 size={21} /><span>Integrations & setup</span><ArrowRight size={16} /></a>
        <Link to="/help/api"><Code2 size={21} /><span>API documentation</span><ArrowRight size={16} /></Link>
      </nav>
      <section id="first-document">
        <h2>Your first document</h2>
        <ol>
          <li><strong>Create a workspace and parser.</strong> Choose invoices, receipts, purchase orders, lead emails or a custom schema. A parser keeps one document workflow and its field definitions together.</li>
          <li><strong>Choose your extraction mode.</strong> Text-anchor rules work with readable text and the included samples. They use field labels, anchors and saved templates. {ai.message}</li>
          <li><strong>Upload a document or use a sample.</strong> The file is saved before processing begins. You can leave the page and return while the worker continues.</li>
          <li><strong>Review the result.</strong> Compare values and source evidence, correct errors, and resolve validation issues. Check missing values and any configured defaults.</li>
          <li><strong>Approve and export.</strong> Download a CSV, XLSX or JSON snapshot of the approved revision. New extraction runs keep earlier approvals in the history.</li>
        </ol>
        <Link className="button primary marketing-cta" to="/sign-up?sample=invoice">Try the invoice sample</Link>
      </section>
      <section id="copy-parser">
        <h2>Reuse a parser</h2>
        <p>Choose Copy on the parser list or Copy parser inside a parser. Name the new parser to reuse its saved settings, current fields, text templates and saved export mappings. Source and copy can then be edited independently.</p>
        <p>The copy starts with no documents or processing history and uses one active parser slot. Finish initial field setup before copying. Set up its intake email address and parser-specific connections separately; existing workspace-wide integrations still apply.</p>
      </section>
      <section id="split-pdf">
        <h2>Split a PDF into documents</h2>
        <p>In Documents, choose the target parser and select Split a PDF. Choose Every N pages, Custom page ranges such as <code>1-2, 5, 7-9</code>, or Text marker. Each proposed range creates a separate document. The preview shows the source pages, proposed documents and page credits before you submit. Choose files continues to upload an unsplit document.</p>
        <p>Text marker starts a new document on each page containing your exact, case-sensitive text. Spaces and line breaks are treated alike. If the first match is after page 1, the preceding pages become a separate document. All pages are kept in order, including pages without searchable text. Check the matched pages and proposed boundaries before creating the documents. Scanned text is not searched; use custom ranges when the marker cannot be found.</p>
        <p>Custom ranges must stay in page order without overlaps and may omit pages. To adjust detected boundaries or omit pages, switch the proposed marker ranges to custom ranges.</p>
        <p>Owners, admins and editors can split into an active parser that accepts PDF and has finished initial field setup. Use one PDF up to 10 MB and 30 pages, producing at most 20 documents. Each result must fit the workspace file limit; the resulting PDFs together must fit 20 MB. The server checks these limits and the quota before accepting the batch.</p>
        <p>Preview applies image-size limits. If a page cannot be displayed, inspect the original file; ordinary upload remains available.</p>
        <p>Only selected pages use page credits, once for the accepted batch. The full original is not processed as an additional document. If an upload is interrupted, choose Resume PDF split and Check split result. After a reload, reselect the same PDF if transfer is incomplete. A retry keeps the saved request; starting a new split is a separate upload with new page credits.</p>
        <p>Open each received document to review, approve and export it. Review shows its original page range. Download this document gives you the selected child PDF; Download full original PDF includes all original pages. Omitted pages and pages from individually deleted documents remain in the full original while another document in that batch remains. Delete whole batch from review to remove all retained documents and queue deletion of the full source.</p>
        <Link className="marketing-text-link" to="/help/api#split-pdf-api">Use PDF splitting through the API <ArrowRight size={17} /></Link>
      </section>
      <section id="import-zip">
        <h2>Import selected files from a ZIP</h2>
        <p>In Documents, choose a parser and select Import ZIP. Choose one ZIP and select Preview ZIP to send it to the server for inspection. Preview creates no documents or page charges. All regular files are listed, including unavailable formats and macOS metadata with a reason. Supported files are selected initially; clear any you do not need.</p>
        <p>Check the selected file count and page credits before importing. Each selected file becomes a separate document, preserving its folder path and entry number. A PDF stays whole; DOCX and XLSX each stay one document. Nested ZIPs are unavailable. Use Split a PDF separately when you need page boundaries.</p>
        <p>Owners, admins and editors can import into an active parser with completed field setup. The ZIP can be up to 10 MB with at most 20 document files, including unavailable files. Metadata and directory entries are allowed within the total limit of 256 records. Choose which supported files to import; each must fit 10 MB and 30 pages. Expanded files together must fit 20 MB; Office packages share a 40 MB expansion allowance. Unsafe, encrypted, structurally malformed or oversized archives are rejected. The server checks the whole archive and accepts the selected documents together, with page credits charged once.</p>
        <p>The full original ZIP is retained while any imported document remains. Selection only changes which documents are imported: the original still includes every excluded, unsupported and metadata file, plus files from deleted documents. Download this document returns the unchanged selected file. Download original ZIP returns the full archive. Delete whole import from review removes all retained documents and queues deletion of the original.</p>
        <p>If transfer or confirmation is interrupted, choose Resume ZIP import and Check import result. After a reload, reselect the same ZIP and preview it if transfer was incomplete. Your saved request keeps its exact source and selection. Retrying that request uses no additional page credits; explicitly starting a new import can create another batch and charge again. Review and approve each received document before exporting.</p>
        <Link className="marketing-text-link" to="/help/api#import-zip-api">Use ZIP import through the API <ArrowRight size={17} /></Link>
      </section>
      <section id="formats">
        <h2>Formats and limits</h2>
        <p>Files must be 10 MB or smaller. A batch can contain up to 20 files. Your workspace may apply a smaller allowance. Unsupported, empty, malformed or encrypted files return an explicit error.</p>
        <div className="marketing-guide-table-wrap"><table><thead><tr><th scope="col">Format</th><th scope="col">Current behavior</th></tr></thead><tbody>{supportedFormats(ai.configured).map(([format, behavior]) => <tr key={format}><th scope="row">{format}</th><td>{behavior}</td></tr>)}</tbody></table></div>
      </section>
      <section id="review">
        <h2>Review, corrections and versions</h2>
        <p>Each extraction keeps its field definitions, settings and source evidence. Original extracted values, standardized values and your corrections remain separate. The parser’s locale controls how dates and numbers are read. Date fields keep the written calendar date; timestamp and timezone conversion are not supported. The review screen shows page and text evidence where it exists. AI-read image quotes are not independently verified; compare them with the original before approving.</p>
        <p>Resolve required-field and validation issues before approving. A later correction requires a new approval. Reprocessing creates another run and leaves the earlier approved output available.</p>
        <h3>Text-anchor templates</h3>
        <p>Use an exact text label that appears before the value you want, such as “Invoice number:”. A saved template can require matching text before its rules apply. Written extraction instructions guide AI mode; they do not change text-anchor results. Selecting a rectangular region on a scanned page is not supported.</p>
      </section>
      <section id="usage">
        <h2>Usage and duplicates</h2>
        <p>An accepted, unique ordinary upload records usage for its page count. Identical ordinary uploads sent to the same parser are detected as duplicates. PDF splits and ZIP imports use their saved request identity: retrying the same request reuses its batch, while explicitly starting a new split or import uses credits again, even for the same source file. Automatic worker retries use no additional page credits. Choosing Reprocess creates a new job and counts the document's pages again.</p>
        <p>Each test workspace has a clearly labeled allowance. Displayed prices are illustrative during the preview; changing a mock plan does not activate payments.</p>
      </section>
      <section id="integrations">
        <h2>Integrations and provider setup</h2>
        <dl className="marketing-help-connections">
          <div><dt>AI extraction</dt><dd>{ai.message} AI mode uses your field definitions and written instructions. Configuration does not establish accuracy on your documents; review each result.</dd></div>
          <div><dt>Inbound email</dt><dd>An intake address appears only after the email provider and receiving domain are configured. Uploading an EML file remains available separately.</dd></div>
          <div><dt>Webhooks</dt><dd>Connect a public HTTPS destination, store the signing secret securely, and check delivery history. Failed deliveries retry with the same delivery identity. A manual replay is available to workspace administrators.</dd></div>
          <div><dt>Automation tools</dt><dd>Zapier, Make, n8n and Power Automate can receive data through their webhook or HTTP steps. These are API/webhook recipes, not published Folio marketplace connectors.</dd></div>
          <div><dt>Google Sheets</dt><dd>Requires a configured Google provider and access to the destination spreadsheet. The connection panel reports the actual configuration state.</dd></div>
          <div><dt>Billing</dt><dd>The hosted preview uses mock billing. Plan changes are simulated and do not activate live charges.</dd></div>
        </dl>
        <Link className="marketing-text-link" to="/help/api">Read the API and webhook guide <ArrowRight size={17} /></Link>
      </section>
      <section id="troubleshooting">
        <h2>When something needs attention</h2>
        <ul>
          <li><strong>Queued for longer than expected:</strong> confirm the background worker is running, then check the job details and workspace concurrency allowance.</li>
          <li><strong>Image or scan cannot be read:</strong> Scans and images require AI mode. {ai.configured === true ? 'Check the parser’s extraction mode, review the reported error and confirm the image is readable.' : ai.message} Text-anchor rules need readable text.</li>
          <li><strong>A required value is missing:</strong> review the source and field definitions. Check labels, anchors and templates for text-anchor mode, or refine written instructions for AI mode. Correct the result or reprocess.</li>
          <li><strong>A webhook failed:</strong> open delivery history, inspect the response status, fix the receiving endpoint, then replay the delivery.</li>
          <li><strong>The quota is reached:</strong> open Usage for the current allowance and ledger. Retrying the same request does not bypass a quota.</li>
        </ul>
      </section>
    </GuideLayout>
  );
}

const uploadExample = [
  'curl "$FOLIO_URL/api/parsers/$PARSER_ID/documents" \\',
  '  -H "Authorization: Bearer $FOLIO_API_KEY" \\',
  '  -H "Idempotency-Key: invoice-upload-001" \\',
  '  -F "file=@invoice.pdf"',
].join('\n');

const resultExample = [
  'curl "$FOLIO_URL/api/jobs/$JOB_ID" \\',
  '  -H "Authorization: Bearer $FOLIO_API_KEY"',
  '',
  'curl "$FOLIO_URL/api/documents/$DOCUMENT_ID" \\',
  '  -H "Authorization: Bearer $FOLIO_API_KEY"',
  '',
  'curl "$FOLIO_URL/api/runs/$RUN_ID" \\',
  '  -H "Authorization: Bearer $FOLIO_API_KEY"',
].join('\n');

const splitExample = [
  'curl "$FOLIO_URL/api/parsers/$PARSER_ID/pdf-splits" \\',
  '  -H "Authorization: Bearer $FOLIO_API_KEY" \\',
  '  -F "requestId=$SPLIT_REQUEST_ID" \\',
  '  -F \'options={"mode":"ranges","ranges":[{"start":1,"end":2},{"start":5,"end":5}]}\' \\',
  '  -F "file=@bundle.pdf"',
  '',
  'curl "$FOLIO_URL/api/parsers/$PARSER_ID/pdf-splits/requests/$SPLIT_REQUEST_ID" \\',
  '  -H "Authorization: Bearer $FOLIO_API_KEY"',
].join('\n');

const signedSplitExample = JSON.stringify({
  filename:'bundle.pdf',size:12345,sha256:'REPLACE_WITH_SHA256_OF_THE_EXACT_FILE_BYTES',
  pdfSplit:{requestId:'REUSE_YOUR_SPLIT_REQUEST_UUID',options:{mode:'every',pagesPerDocument:2}},
},null,2);

const endpoints = [
  ['GET', '/api/parsers', 'parsers:read', 'List parsers in the key’s workspace.'],
  ['POST', '/api/parsers/:id/copy', 'parsers:read, parsers:write, results:read', 'Copy saved configuration into a new active parser; returns 201.'],
  ['POST', '/api/parsers/:id/documents', 'documents:write', 'Upload multipart files; returns 202 with document and job IDs.'],
  ['POST', '/api/parsers/:id/pdf-splits', 'documents:write', 'Split one multipart PDF; returns 202 with an ordered batch receipt.'],
  ['GET', '/api/parsers/:id/pdf-splits/requests/:requestId', 'documents:read', 'Recover a split receipt, including availability of deleted results.'],
  ['POST', '/api/parsers/:id/archive-imports/preview', 'documents:write', 'Inspect a ZIP and list every regular file; returns 200 without page charges.'],
  ['POST', '/api/parsers/:id/archive-imports', 'documents:write', 'Import selected ready files atomically; returns 202.'],
  ['GET', '/api/parsers/:id/archive-imports/requests/:requestId', 'documents:read', 'Recover an import receipt and document availability.'],
  ['DELETE', '/api/archive-imports/:id', 'documents:write', 'Delete all retained children and queue original ZIP deletion.'],
  ['DELETE', '/api/pdf-splits/:id', 'documents:write', 'Delete all retained documents in a batch and queue source-file deletion.'],
  ['GET', '/api/documents', 'documents:read', 'List documents with page, pageSize, search, status and parserId filters.'],
  ['GET', '/api/documents/:id', 'documents:read', 'Read the document, extraction runs and job history.'],
  ['GET', '/api/documents/:id/bundle-original-url', 'documents:read', 'Get an authorized full-source download URL through a retained split document.'],
  ['GET', '/api/jobs/:id', 'documents:read', 'Read the durable job state and retry details.'],
  ['GET', '/api/runs/:id', 'results:read', 'Read extracted values, evidence, corrections and approvals.'],
  ['POST', '/api/exports', 'results:read', 'Create an export from approved document revisions.'],
  ['GET', '/api/exports/:id/download', 'results:read', 'Download the saved CSV, XLSX or JSON file.'],
];

export function ApiDocs() {
  return (
    <GuideLayout title="Connect your document workflow." introduction="Use a scoped API key to upload documents, follow processing and retrieve approved output.">
      <section>
        <h2>Authentication</h2>
        <p>Create a revocable key in Workspace settings → API keys. Keep it in your server or automation secret store, and send it in the Authorization header as a bearer token. The key is scoped to one workspace and remains limited by its owner's role.</p>
        <p>Choose an expiry of 7, 30 or 90 days, one year, or no expiry. New keys default to 30 days in Settings. Existing keys retain their original expiry. Expired keys stop authenticating automatically; create a replacement and update your connection before that time. A key’s expiry cannot be extended after creation.</p>
        <p>Use the origin of your own running Folio instance as <code>FOLIO_URL</code>. The examples below use environment variables for your Folio API key and resource IDs. They do not contain a real credential.</p>
      </section>
      <section>
        <h2>Upload a document</h2>
        <p>Select the parser ID from your workspace. Send a multipart file with an idempotency key; reusing the same upload key avoids creating another intake event.</p>
        <pre className="marketing-code-block"><code>{uploadExample}</code></pre>
        <p>A successful intake returns HTTP 202. Keep the returned <code>document.id</code> and <code>jobId</code>. A duplicate may return the existing document with <code>duplicate: true</code> and no new job.</p>
      </section>
      <section>
        <h2>Follow processing and read results</h2>
        <pre className="marketing-code-block"><code>{resultExample}</code></pre>
        <p>The document can move through queued, processing, needs review, processed, exporting, exported or failed. Read the job state and error for diagnostics. A completed run returns raw, normalized and effective values separately.</p>
      </section>
      <section>
        <h2>Endpoints</h2>
        <div className="marketing-guide-table-wrap"><table className="marketing-endpoints-table"><thead><tr><th scope="col">Method</th><th scope="col">Path</th><th scope="col">Scope</th><th scope="col">Purpose</th></tr></thead><tbody>{endpoints.map(([method, path, scope, purpose]) => <tr key={path}><td><strong>{method}</strong></td><td><code>{path}</code></td><td><code>{scope}</code></td><td>{purpose}</td></tr>)}</tbody></table></div>
        <p>Export requests accept <code>documentIds</code>, <code>format</code> (csv, xlsx or json), optional <code>columns</code> mappings and an optional <code>lineItems</code> field key. Every selected document needs an approved revision.</p>
      </section>
      <section id="copy-parser-api">
        <h2>Copy a parser</h2>
        <p>Send <code>POST /api/parsers/:id/copy</code> with an optional <code>name</code> (1–100 characters). The source must belong to the workspace and have completed field setup. Owners, admins and editors can copy; API keys need all three scopes listed above because the response includes saved export mappings.</p>
        <p>A successful response returns HTTP 201 with <code>parser</code>, schema version 1, <code>templates</code> and <code>mappings</code>, all with fresh IDs. Settings and template priority are preserved. No documents, processing history, email routes or provider connections are copied. An archived source produces an active copy.</p>
        <p>Each request creates a new parser. This endpoint has no idempotency key: if the response is lost, check the parser list before retrying. The copy requires an available parser slot and accepts at most 100 templates, 100 export mappings and 2 MiB of saved configuration. Incomplete setup or invalid/oversized saved configuration returns 409; active-parser capacity returns 429.</p>
      </section>
      <section id="split-pdf-api">
        <h2>Split a PDF</h2>
        <p>Use an active, PDF-accepting parser with completed field setup. Owners, admins and editors can create, finalize or delete a split with <code>documents:write</code>. Receipt recovery and original-file access require <code>documents:read</code>. A batch accepts one PDF up to 10 MB and 30 source pages, at most 20 child documents, and at most 20 MB of combined child PDFs; each child also respects the workspace file limit. Initial AI-assisted parser setup, TIFF and splitting existing documents are not supported by this endpoint.</p>
        <h3>Multipart upload</h3>
        <p>Generate <code>SPLIT_REQUEST_ID</code> as a UUID once, then save it for retries. Send exactly one file, <code>requestId</code> and a JSON <code>options</code> field. Custom ranges are inclusive and one-based; keep them ordered without overlaps. Every-N splitting uses <code>{'{"mode":"every","pagesPerDocument":2}'}</code>. One resulting document is allowed. Custom ranges may omit pages.</p>
        <pre className="marketing-code-block"><code>{splitExample}</code></pre>
        <h3>Text-marker boundaries</h3>
        <p>Marker options include the literal <code>marker</code> and the ranges you have confirmed, for example <code>{'{"mode":"marker","marker":"Invoice number:","ranges":[{"start":1,"end":2},{"start":3,"end":4}]}'}</code> for a four-page PDF. The marker must contain 1–200 characters. Matching is case-sensitive; consecutive whitespace is collapsed and leading or trailing whitespace is removed. Matching stays within each page and uses searchable PDF text, without OCR or regular expressions.</p>
        <p>Each matching page starts a document and belongs to that document. Page 1 always starts the first document, so pages before a later first match are retained. Marker ranges must cover every page exactly once. The server recomputes boundaries from the PDF and rejects a mismatch, missing marker or PDF without searchable text before accepting documents or charging pages. Use the application preview to check boundaries; switch to custom ranges for deliberate adjustments. Keep the marker and confirmed ranges with the saved request for retries.</p>
        <h3>Direct signed upload</h3>
        <p>Read <code>GET /api/uploads/config</code> to choose the installation’s upload strategy. For <code>signed</code>, send <code>POST /api/parsers/:id/uploads</code> with the exact byte size and lowercase SHA-256 digest, plus the persisted split request and options:</p>
        <pre className="marketing-code-block"><code>{signedSplitExample}</code></pre>
        <p>PUT the unchanged PDF bytes to the returned <code>uploadUrl</code> with the returned headers, then send an empty JSON object to <code>POST /api/uploads/:uploadId/finalize</code>. Finalize reads the saved split options and returns the same batch receipt. Keep the reservation ID for recovery. Treat signed URLs as temporary credentials and keep them out of logs.</p>
        <h3>Results and safe retries</h3>
        <p>HTTP 202 returns <code>split</code>, an ordered <code>documents</code> array and <code>replayed</code>. Each document includes its ID, job ID, original page range and <code>available</code> flag. Only selected pages use credits; the original source is not queued separately. Processing, approval and export follow the normal document workflow.</p>
        <p>After a lost response, use the receipt GET above. A 404 means no receipt was found yet; retry with the same request ID, parser, exact source bytes and options. If direct transfer was incomplete, a fresh staging reservation can reuse that same split request ID. Changing the binding returns 409. Explicitly choosing a new request ID creates a new charged split, even for identical bytes. Permanent input rejections retain their safe error on replay; transient failures can be retried with the same request.</p>
        <p>A receipt remains readable when children are deleted: <code>available: false</code> does not recreate a document or charge again. Document detail includes <code>split</code> lineage. Existing <code>/api/documents/:id/original</code> downloads the child PDF; <code>/bundle-original</code> or <code>/bundle-original-url</code> accesses the full original through a live child. The full original includes omitted pages and pages from deleted children until the last child is removed. <code>DELETE /api/pdf-splits/:id</code> deletes the retained batch and queues file deletion; queued deletion does not mean the storage object has already been removed.</p>
      </section>
      <section id="import-zip-api">
        <h2>Import a ZIP</h2>
        <p>ZIP import uses an active parser with completed field setup. Owners, admins and editors need <code>documents:write</code> to preview, import, confirm or delete. Receipt and source reads need <code>documents:read</code>. The ZIP limit is 10 MB, 20 non-metadata document files (including unavailable files), and 256 records including metadata and directories. Select 1–20 ready entries, with at most 30 pages per file and 20 MB of combined expanded file bytes. Office packages share a 40 MB expansion allowance. Parser format policy still applies to every selected file.</p>
        <h3>Preview and choose entries</h3>
        <p>Generate and persist a UUID <code>requestId</code>. Send one <code>file</code> and that <code>requestId</code> as multipart fields to <code>POST /api/parsers/:id/archive-imports/preview</code>. HTTP 200 returns <code>requestId</code>, <code>parserId</code>, <code>sourceSha256</code>, <code>sourceByteSize</code>, <code>entries</code> and <code>totalPages</code>. Preview creates no documents or page charges.</p>
        <p>Each entry has a stable original <code>index</code>, relative <code>path</code>, <code>byteSize</code>, <code>sha256</code>, <code>format</code>, <code>pageCount</code>, <code>status</code> and <code>reason</code>. Show all regular entries, including <code>unsupported</code> and <code>metadata</code>. Only <code>ready</code> entries may be selected. Directory records are not importable files; indices can have gaps. Never use a filename or a selected-list position as the entry identity.</p>
        <h3>Confirm the selected files</h3>
        <p>Persist strict options with the returned source digest and sorted, unique selected entry indices: <code>{'{"mode":"zip","version":1,"sourceSha256":"LOWERCASE_SHA256_FROM_PREVIEW","entries":[1,3]}'}</code>. Send the unchanged <code>file</code>, same <code>requestId</code> and JSON <code>options</code> to <code>POST /api/parsers/:id/archive-imports</code>. The server recomputes the source and manifest and accepts all selected documents atomically. The ZIP itself consumes no extra page credits.</p>
        <h3>Direct signed upload</h3>
        <p>Read <code>GET /api/uploads/config</code>. For <code>signed</code>, reserve through <code>POST /api/parsers/:id/uploads</code> with <code>filename</code>, exact <code>size</code>, lowercase <code>sha256</code> and <code>{'{"archiveImport":{"requestId":"YOUR_SAVED_UUID"}}'}</code>. Omit selection options for the initial preview. PUT unchanged bytes to the returned private upload URL using the returned headers, then POST an empty JSON object to <code>/api/uploads/:uploadId/archive-preview</code>.</p>
        <p>After selection, POST <code>{'{"options":{...}}'}</code> to <code>/api/uploads/:uploadId/archive-confirm</code>, then POST an empty JSON object to <code>/api/uploads/:uploadId/finalize</code>. Confirmation freezes the selection; exact confirmation replay is allowed. Save the reservation ID. Restaging an incomplete transfer may reuse the saved request with its confirmed options; changing the saved source or selection requires a new request. Signed URLs are temporary credentials and should stay out of logs.</p>
        <h3>Receipt, recovery and original files</h3>
        <p>HTTP 202 returns <code>archive</code>, <code>documents</code> and <code>replayed</code>. Each document has its ID, job ID, original entry index/path, page count and availability. These files are received for processing; they still need review and approval. Recover through <code>GET /api/parsers/:id/archive-imports/requests/:requestId</code>. If no receipt exists yet, retry the same source, parser, request and selection. A different binding returns 409. A new request is a new import, even for identical bytes.</p>
        <p>Document detail includes <code>archive</code> lineage. <code>/api/documents/:id/original</code> returns unchanged child bytes; <code>/archive-original</code> or <code>/archive-original-url</code> accesses the full ZIP through a live child. The ZIP includes excluded, unsupported and metadata files, and files from deleted children while a sibling remains. <code>DELETE /api/archive-imports/:id</code> removes the retained import and queues source deletion. Deleted receipt entries stay unavailable and are never recreated on replay.</p>
      </section>
      <section id="webhooks">
        <h2>Signed webhook deliveries</h2>
        <p>Approval events can be delivered to a public HTTPS endpoint. The request includes <code>X-Folio-Delivery</code>, <code>X-Folio-Timestamp</code>, <code>X-Folio-Signature</code> and <code>Idempotency-Key</code>.</p>
        <p>Verify the signature as an HMAC-SHA256 of the timestamp, a period, and the unchanged request body, using your connection's signing secret. The signature header has the form <code>v1=hex-digest</code>. Reject old timestamps and process each delivery ID only once. Return a 2xx response after accepting the event.</p>
        <p>Automatic failures retry up to five attempts. Manual replay retains the delivery identity so a receiver can continue to deduplicate the event. Redirects and private-network destinations are rejected.</p>
        <h3>Automation recipes</h3>
        <p>For Zapier, use a webhook catch step; for Make, use a custom webhook; for n8n, use a Webhook trigger; for Power Automate, use an HTTP request trigger. Map the event's <code>values</code> object to the next action. If the tool cannot verify Folio's signature, put a verification endpoint you control in front of it.</p>
        <p>External delivery and provider-specific configuration still need to be tested against your chosen account. These instructions describe generic webhook bridges.</p>
      </section>
      <section>
        <h2>Errors and limits</h2>
        <p>Expect 400 for invalid input, 401 for a missing, expired or revoked key, 403 for insufficient role or scope, 404 for unavailable resources, 413 for file/page limits, 422 for approval validation and 429 for quota limits. Replace an expired or revoked key before retrying. For transient failures, retry with the same intake idempotency key; show actionable errors to the person managing the workflow.</p>
      </section>
    </GuideLayout>
  );
}

export function OperatorDetails({details,pending=false,unavailable=false}:{details?:PublicInstallation;pending?:boolean;unavailable?:boolean}) {
  return <section aria-label="Service operator and policies">
    <h2>Service operator and policies</h2>
    {pending ? <p>Checking this installation’s operator details…</p> : unavailable ? <p>Operator details could not be loaded. Try again before submitting sensitive documents.</p> : <>
      {details?.operatorName ? <p><strong>Operator:</strong> {details.operatorName}</p> : <p>The operator’s identity has not been configured for this installation.</p>}
      {details?.supportEmail ? <p><strong>Support:</strong> <a href={`mailto:${encodeURIComponent(details.supportEmail)}`}>{details.supportEmail}</a></p> : <p>A support contact has not been provided.</p>}
      {details?.privacyEmail ? <p><strong>Privacy requests:</strong> <a href={`mailto:${encodeURIComponent(details.privacyEmail)}`}>{details.privacyEmail}</a></p> : <p>A privacy-request contact has not been provided.</p>}
      {details?.privacyUrl ? <p><a href={details.privacyUrl} rel="noopener noreferrer">Read the operator’s privacy notice</a></p> : <p>The operator’s full privacy notice has not been provided.</p>}
      {details?.termsUrl ? <p><a href={details.termsUrl} rel="noopener noreferrer">Read the operator’s service terms</a></p> : <p>The operator’s service terms have not been provided.</p>}
      {details?.subprocessorsUrl ? <p><a href={details.subprocessorsUrl} rel="noopener noreferrer">Review the operator’s subprocessors</a></p> : null}
    </>}
  </section>;
}

export function Privacy() {
  const ai = useAiAvailability();
  const installation=useData<{publicService:PublicInstallation}>('/api/config');
  const details=installation.data?.publicService;
  return (
    <GuideLayout title="Privacy & data handling." introduction="How the application handles documents, with contacts and policies supplied by this installation’s operator.">
      <OperatorDetails details={details} pending={installation.isPending} unavailable={!!installation.error}/>
      <section>
        <h2>About this page</h2>
        <p>These notes describe application behavior. The operator’s privacy notice explains the legal basis for processing, who receives data and how to exercise your rights. Configured contacts and links do not by themselves verify those arrangements.</p>
      </section>
      <section>
        <h2>Data in your workspace</h2>
        <p>The application stores account information, workspace membership, parser schemas, uploaded documents, processing results, corrections, approvals, exports, integration configuration, usage and audit events. Records use PostgreSQL; original files use the installation’s configured private storage. The operator’s notice identifies the actual hosting arrangements.</p>
        <p>Passwords are stored as password hashes. Session tokens and API keys are stored as token hashes. Integration secrets use the server's secret-storage configuration. Workspace roles control access to documents and settings.</p>
      </section>
      <section>
        <h2>Provider processing</h2>
        <p>{ai.configured === true ? 'AI is configured in this installation.' : ai.configured === false ? 'AI is not currently configured in this installation.' : 'Current AI configuration could not yet be confirmed.'} When a parser uses AI mode, document content, field definitions and extraction instructions are sent to the configured AI provider for processing. Connected email, spreadsheet, webhook and billing providers receive the data necessary for the configured action. Their own terms and data practices also apply.</p>
        <p>The application does not add a separate cross-workspace training process using customer corrections. This does not make a claim about a third-party provider's data retention or training policy.</p>
      </section>
      <section>
        <h2>Retention and deletion</h2>
        <p>Workspace administrators can choose a document-retention period in Settings. Deletion removes document records and queues removal of private files; an interrupted deletion is retried. Downloaded exports and copies already delivered to another service are outside those controls.</p>
        <p>Retained original PDF, TIFF and ZIP bundles can contain pages or files excluded from an import, or files from a deleted child, while another child still needs that original. Use the batch deletion controls to remove the retained batch.</p>
        <p>{details?.retentionNotice||'The operator has not yet published a retention notice covering backups, audit records and provider copies. Confirm those periods before submitting sensitive production data.'}</p>
      </section>
      <section>
        <h2>Data location</h2>
        <p>{details?.dataLocationNotice||'The operator has not yet published the data locations and transfer arrangements for this installation. A storage provider’s name alone does not establish where every copy is processed or retained.'}</p>
      </section>
    </GuideLayout>
  );
}

export function Terms() {
  const installation=useData<{publicService:PublicInstallation}>('/api/config');
  const details=installation.data?.publicService;
  return (
    <GuideLayout title="Service terms & usage." introduction="Review the operator’s service terms and the workflow limits before using this installation.">
      <OperatorDetails details={details} pending={installation.isPending} unavailable={!!installation.error}/>
      <section>
        <h2>Use suitable documents</h2>
        <p>The synthetic samples are provided to explore the workflow. Only upload documents you are entitled to process, and review the result before relying on it or sending it to another system.</p>
      </section>
      <section>
        <h2>Extraction and review</h2>
        <p>Document extraction can omit or misread information. The workflow includes source review, corrections and approval so you can check values. These application notes make no numerical accuracy guarantee or assurance of suitability for a regulated decision.</p>
      </section>
      <section>
        <h2>Pricing and providers</h2>
        <p>No subscription is activated by viewing a plan. Billing settings identify mock, test or live mode before you open Checkout. Review the displayed price and the operator’s payment and cancellation terms before confirming a live subscription. External services require their own configuration and account permissions.</p>
      </section>
      <section>
        <h2>Operator terms apply separately</h2>
        <p>{details?.termsUrl?'Use the linked operator terms for the applicable service, payment, cancellation and legal arrangements. These workflow notes do not replace that document.':'Service, payment, cancellation and legal arrangements have not been supplied for this installation. These workflow notes are not a substitute for completed operator terms.'}</p>
      </section>
      <Link className="marketing-text-link" to="/privacy">Read the current data-handling notes <ArrowRight size={17} /></Link>
    </GuideLayout>
  );
}
