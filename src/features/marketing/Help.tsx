import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, Code2, FileText, Settings2 } from 'lucide-react';
import { MarketingFooter, MarketingHeader } from './MarketingShell';
import { useAiAvailability } from '../../lib/ai';
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
        <p>An accepted, unique upload records one usage event for its page count. Identical files sent to the same parser are detected as duplicates. Automatic worker retries reuse the same event. Choosing Reprocess creates a new job and counts the document's pages again.</p>
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

const endpoints = [
  ['GET', '/api/parsers', 'parsers:read', 'List parsers in the key’s workspace.'],
  ['POST', '/api/parsers/:id/documents', 'documents:write', 'Upload multipart files; returns 202 with document and job IDs.'],
  ['GET', '/api/documents', 'documents:read', 'List documents with page, pageSize, search, status and parserId filters.'],
  ['GET', '/api/documents/:id', 'documents:read', 'Read the document, extraction runs and job history.'],
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
        <p>Expect 400 for invalid input, 401 for a missing or revoked key, 403 for insufficient role or scope, 404 for unavailable resources, 413 for file/page limits, 422 for approval validation and 429 for quota limits. Retry transient failures with the same intake idempotency key; show actionable errors to the person managing the workflow.</p>
      </section>
    </GuideLayout>
  );
}

export function Privacy() {
  const ai = useAiAvailability();
  return (
    <GuideLayout title="Privacy & data handling." introduction="What the development preview stores, and what needs to be settled before the production service launches.">
      <section>
        <h2>Current status</h2>
        <p>Folio is currently a development preview for testing. This page describes the preview; a final privacy notice will accompany the production release.</p>
      </section>
      <section>
        <h2>Data in your workspace</h2>
        <p>The application stores account information, workspace membership, parser schemas, uploaded documents, processing results, corrections, approvals, exports, integration configuration, usage and audit events. The hosted preview stores records in a separate PostgreSQL schema and original files in private Supabase storage. Local installations use their own database and private file directory.</p>
        <p>Passwords are stored as password hashes. Session tokens and API keys are stored as token hashes. Integration secrets use the server's secret-storage configuration. Workspace roles control access to documents and settings.</p>
      </section>
      <section>
        <h2>Provider processing</h2>
        <p>{ai.configured === true ? 'AI is configured in this installation.' : ai.configured === false ? 'AI is not currently configured in this installation.' : 'Current AI configuration could not yet be confirmed.'} When a parser uses AI mode, document content, field definitions and extraction instructions are sent to the configured AI provider for processing. Connected email, spreadsheet, webhook and billing providers receive the data necessary for the configured action. Their own terms and data practices also apply.</p>
        <p>The application does not add a separate cross-workspace training process using customer corrections. This does not make a claim about a third-party provider's data retention or training policy.</p>
      </section>
      <section>
        <h2>Retention and deletion</h2>
        <p>Use workspace controls to delete documents and configure supported retention behavior. Operational audit records and independent downloaded exports may have different lifecycles. Before storing sensitive production data, verify deletion and backup behavior for the actual deployment.</p>
      </section>
      <section>
        <h2>Before public availability</h2>
        <p>A public launch requires the operator's identity and contact details, applicable lawful bases, subprocessors, retention periods, data-location decisions and rights-request process to be documented. Those details will be documented before the production release.</p>
      </section>
    </GuideLayout>
  );
}

export function Terms() {
  return (
    <GuideLayout title="Development preview terms." introduction="The current application is a test preview. Public subscription terms have not been activated.">
      <section>
        <h2>Use the preview with suitable documents</h2>
        <p>The synthetic samples are provided to explore the workflow. Only upload documents you are entitled to process, and review the result before relying on it or sending it to another system.</p>
      </section>
      <section>
        <h2>Extraction and review</h2>
        <p>Document extraction can omit or misread information. The workflow includes source review, corrections and approval so you can check values. No numerical accuracy guarantee or suitability for a regulated decision is represented by the preview.</p>
      </section>
      <section>
        <h2>Pricing and providers</h2>
        <p>The public pricing page contains configurable launch assumptions. No subscription is activated by viewing a plan. Billing integration, where configured, is limited to test mode in this build. External services require their own configuration and account permissions.</p>
      </section>
      <section>
        <h2>Before a public launch</h2>
        <p>Final service terms, an identified operator, support and cancellation arrangements, payment terms and the applicable legal framework must be settled before making this a public paid service. This development page is not a substitute for those launch requirements.</p>
      </section>
      <Link className="marketing-text-link" to="/privacy">Read the current data-handling notes <ArrowRight size={17} /></Link>
    </GuideLayout>
  );
}
