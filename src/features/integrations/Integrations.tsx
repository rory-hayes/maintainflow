import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Code2, Copy, ExternalLink, Mail, Plus, RotateCw, Table2, Trash2, Webhook } from 'lucide-react';
import { Button, Empty, ErrorState, Field, Loading, Modal, Notice, PageHeader, Status, Tabs, dateTime } from '../../components/ui';
import { api, patch, post, useAction, useData } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { Integration, ParserOption, ProviderStatus, ReceivingStatus } from './types';
import '../settings/settings.css';
import './integrations.css';

type Delivery = { id: string; name: string; status: string; attempts: number; responseStatus: number | null; error: string | null; createdAt: string; deliveredAt: string | null };
type EmailRoute = { id: string; parser_id: string; address: string | null; parse_body: boolean; parse_attachments: boolean; allowed_senders: string[]; enabled: boolean; last_received_at: string | null; status: string };

function ProviderEvents() {
  const query = useData<{ events: { id: string; provider: string; status: string; attempts: number; error: string | null; created_at: string }[] }>('/api/providers/events', true);
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return <section><div className="settings-section-heading"><div><h2>Provider events</h2><p>Inbound email and subscription events associated with this workspace.</p></div></div>
    {query.data.events.length ? <div className="table-wrap"><table className="delivery-table"><thead><tr><th>Provider</th><th>Event</th><th>Status</th><th>Attempts</th><th>Received</th></tr></thead><tbody>{query.data.events.map((event) => <tr key={event.id}><td>{event.provider}</td><td><code>{event.id.slice(0, 24)}…</code>{event.error ? <p className="delivery-error">{event.error}</p> : null}</td><td><Status value={event.status} /></td><td>{event.attempts} / 5</td><td>{dateTime(event.created_at)}</td></tr>)}</tbody></table></div> : <Empty title="No provider events yet." description="Workspace-associated email and Stripe test events appear here after the provider delivers them." />}
  </section>;
}

function DeliveryHistory({ canManage }: { canManage: boolean }) {
  const query = useData<{ deliveries: Delivery[] }>('/api/deliveries', true);
  const action = useAction();
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return <section><div className="settings-section-heading"><div><h2>Delivery history</h2><p>Signed webhooks and Google Sheets deliveries share a persistent event log.</p></div></div><Notice error={action.error} message={action.message} />
    {query.data.deliveries.length ? <div className="table-wrap"><table className="delivery-table"><thead><tr><th>Connection</th><th>Status</th><th>Attempts</th><th>Response</th><th>Created</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{query.data.deliveries.map((delivery) => <tr key={delivery.id}><td><strong>{delivery.name}</strong><code className="settings-key-prefix">{delivery.id.slice(0, 8)}</code>{delivery.error ? <p className="delivery-error">{delivery.error}</p> : null}</td><td><Status value={delivery.status} /></td><td>{delivery.attempts} / 5</td><td>{delivery.responseStatus ? `HTTP ${delivery.responseStatus}` : '—'}</td><td>{dateTime(delivery.createdAt)}</td><td>{canManage && ['failed', 'delivered'].includes(delivery.status) ? <Button variant="secondary" className="small" disabled={action.busy} onClick={() => void action.run(() => post(`/api/deliveries/${delivery.id}/replay`), 'Delivery queued for replay.')}><RotateCw size={15} /> Replay</Button> : null}</td></tr>)}</tbody></table></div> : <Empty title="No deliveries yet." description="Approve a document after enabling a connection to create a delivery event." />}
    <p className="small muted settings-bottom-note">Failed deliveries retry up to five attempts. Replays keep their delivery identity; receiving systems should deduplicate that ID.</p>
  </section>;
}

function EmailRouting({ canManage, provider, parsers }: { canManage: boolean; provider: ProviderStatus['resend']; parsers: ParserOption[] }) {
  const query = useData<{ receiving: ReceivingStatus; routes: EmailRoute[] }>('/api/providers/email-routes');
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const [parserId, setParserId] = useState('');
  const [parseBody, setParseBody] = useState(true);
  const [parseAttachments, setParseAttachments] = useState(true);
  const [senders, setSenders] = useState('');
  const receiving = query.data?.receiving ?? provider;
  async function create(event: FormEvent) {
    event.preventDefault();
    const allowedSenders = senders.split(/[,\n]/).map((sender) => sender.trim()).filter(Boolean);
    const result = await action.run(() => post('/api/providers/email-routes', { parserId, parseBody, parseAttachments, allowedSenders }), 'Inbound address provisioned. Verify delivery with a test email.');
    if (result) setCreating(false);
  }
  async function copyAddress(address: string) {
    action.setError('');
    try { await navigator.clipboard.writeText(address); action.setMessage('Inbound address copied.'); }
    catch { action.setError('Copy is unavailable. Select and copy the address below.'); }
  }
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return <section>
    <div className="settings-section-heading"><div><h2>Email intake</h2><p>Route received email bodies and attachments into a parser.</p></div>{canManage ? <Button disabled={!receiving.verified || !parsers.length} onClick={() => setCreating(true)}><Plus size={17} /> Create inbound address</Button> : null}</div>
    <div className="settings-information"><Status value={receiving.verified ? 'configured' : 'setup_required'} /><p>{receiving.verified ? receiving.verification === 'managed-probe' ? 'The Resend-managed inbox passed its probe check. Send a test email to a parser address to verify webhook delivery and intake.' : 'The custom receiving domain has a verified MX record. Send a test email to a parser address to verify webhook delivery and intake.' : receiving.mode === 'managed' ? 'The Resend-managed inbox needs a successful probe check before a parser address can be created.' : 'Email intake requires a configured receiving provider and verified receiving domain. No unprovisioned address is shown as live.'}</p></div>
    {!receiving.verified && canManage ? <details className="integration-setup-details"><summary>Configuration details</summary><p>{receiving.reason}</p></details> : null}
    <Notice error={action.error} message={action.message} />
    {query.data.routes.length ? <div className="table-wrap"><table className="email-routes-table"><thead><tr><th>Address</th><th>Parser</th><th>Capture</th><th>Last received</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{query.data.routes.map((route) => <tr key={route.id}><td>{route.address ? <div className="email-address"><code>{route.address}</code><button className="icon-button" aria-label="Copy inbound email address" onClick={() => void copyAddress(route.address!)}><Copy size={15} /></button></div> : <span className="muted">{route.enabled ? 'Address unavailable until receiving is verified' : 'Disabled address'}</span>}</td><td>{parsers.find((parser) => parser.id === route.parser_id)?.name || 'Archived parser'}</td><td>{[route.parse_body ? 'Body' : '', route.parse_attachments ? 'Attachments' : ''].filter(Boolean).join(' + ')}</td><td>{route.last_received_at ? dateTime(route.last_received_at) : 'No email received'}</td><td>{canManage && route.enabled ? <Button variant="ghost" className="small" disabled={action.busy} onClick={() => void action.run(() => api(`/api/providers/email-routes/${route.id}`, { method: 'DELETE' }), 'Inbound route disabled.')}>Disable</Button> : null}</td></tr>)}</tbody></table></div> : <Empty title="No inbound addresses yet." description={receiving.verified ? 'Create an address for an active parser, then send a test email.' : 'You can upload EML files while receiving-domain setup is pending.'}><Link className="button secondary" to="/app">Upload an email file</Link></Empty>}
    <Modal title="Create an inbound address" description="Choose how received email should become documents. Folio checks receiving availability again before creating the address." open={creating} onOpenChange={setCreating}>
      <form onSubmit={(event) => void create(event)}><Field label="Parser"><select required value={parserId} onChange={(event) => setParserId(event.target.value)}><option value="">Choose a parser</option>{parsers.map((parser) => <option value={parser.id} key={parser.id}>{parser.name}</option>)}</select></Field>
        <label className="integration-check"><input type="checkbox" checked={parseBody} onChange={(event) => setParseBody(event.target.checked)} /> Extract the email body</label>
        <label className="integration-check"><input type="checkbox" checked={parseAttachments} onChange={(event) => setParseAttachments(event.target.checked)} /> Extract file attachments</label>
        <Field label="Allowed senders (optional)" hint="One email address per line or separated by commas. Empty allows any sender."><textarea rows={3} value={senders} onChange={(event) => setSenders(event.target.value)} placeholder="sender@example.com" /></Field>
        <Notice error={action.error} /><Button type="submit" disabled={action.busy || !parserId || (!parseBody && !parseAttachments)}>Create inbound address</Button>
      </form>
    </Modal>
  </section>;
}

function ConnectionForms({ provider, parsers, canManage }: { provider: ProviderStatus; parsers: ParserOption[]; canManage: boolean }) {
  const query = useData<{ integrations: Integration[] }>('/api/integrations');
  const action = useAction();
  const [modal, setModal] = useState<'webhook' | 'sheets' | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [parserId, setParserId] = useState('');
  const [spreadsheet, setSpreadsheet] = useState('');
  const [sheetName, setSheetName] = useState('Sheet1');
  const [mapping, setMapping] = useState('');
  const [lineItems, setLineItems] = useState('');
  const [secret, setSecret] = useState('');
  const [removing, setRemoving] = useState<Integration | null>(null);
  function openForm(type: 'webhook' | 'sheets') {
    setName(type === 'webhook' ? 'Approved document webhook' : 'Google Sheets');
    setParserId('');
    action.setError('');
    action.setMessage('');
    setModal(type);
  }
  async function createWebhook(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(() => post<{ secret: string }>('/api/integrations/webhooks', { name, url, ...(parserId ? { parserId } : {}) }), 'Webhook configured. Approve a document to create its first delivery.');
    if (result) { setSecret(result.secret); setModal(null); }
  }
  async function startGoogle(event?: FormEvent, integrationId?: string) {
    event?.preventDefault();
    const spreadsheetId = spreadsheet.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] || spreadsheet.trim();
    let columns: { source: string; label: string }[] | undefined;
    if (!integrationId && mapping.trim()) {
      const lines = mapping.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.some((line) => line.indexOf('=') < 1 || !line.slice(line.indexOf('=') + 1).trim())) { action.setError('Use one mapping per line in the form field_key=Column label.'); return; }
      columns = lines.map((line) => ({ source: line.slice(0, line.indexOf('=')).trim(), label: line.slice(line.indexOf('=') + 1).trim() }));
    }
    const body = integrationId ? { integrationId } : { name, parserId, spreadsheetId, sheetName, ...(columns ? { columns } : {}), ...(lineItems ? { lineItems } : {}) };
    const result = await action.run(() => post<{ authorizationUrl: string }>('/api/google/start', body), 'Opening Google authorization…');
    if (result?.authorizationUrl) window.location.assign(result.authorizationUrl);
  }
  async function copySecret() {
    action.setError('');
    try { await navigator.clipboard.writeText(secret); action.setMessage('Signing secret copied.'); }
    catch { action.setError('Copy is unavailable. Select and copy the signing secret below.'); }
  }
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return <section>
    <div className="integration-row"><span className="integration-icon"><Webhook size={23} strokeWidth={1.6} /></span><div className="integration-copy"><h3>Signed webhooks</h3><p>Send approved values to a public HTTPS endpoint. Inspect delivery status, retries and replays.</p></div>{canManage ? <Button variant="secondary" onClick={() => openForm('webhook')}><Plus size={16} /> Add webhook</Button> : null}</div>
    <div className="integration-row"><span className="integration-icon"><Table2 size={23} strokeWidth={1.6} /></span><div className="integration-copy"><h3>Google Sheets</h3><p>{provider.googleSheets.configured ? 'Connect a Google account and choose a destination worksheet. Configuring OAuth alone does not verify a delivered row.' : 'Requires server-side Google OAuth setup before a workspace account can connect.'}</p><span className="integration-inline-status"><Status value={provider.googleSheets.configured ? 'ready_to_connect' : 'setup_required'} /></span></div>{canManage ? <Button variant="secondary" disabled={!provider.googleSheets.configured || !parsers.length} onClick={() => openForm('sheets')}>Connect Google Sheets</Button> : null}</div>
    <div className="integration-row"><span className="integration-icon"><Code2 size={23} strokeWidth={1.6} /></span><div className="integration-copy"><h3>API & automation recipes</h3><p>Use scoped API keys and webhook recipes for Zapier, Make, n8n or Power Automate. These are bridges, not native marketplace connectors.</p></div><Link className="button secondary" to="/help/api">Read the guide</Link></div>
    <Notice error={action.error} message={action.message} />
    {secret ? <div className="settings-secret-reveal"><strong>Save this webhook signing secret.</strong><p className="small">It is shown only now. Your receiver uses it to verify Folio deliveries.</p><code className="key-reveal">{secret}</code><div className="actions"><Button variant="secondary" onClick={() => void copySecret()}><Copy size={16} /> Copy secret</Button><Button variant="ghost" onClick={() => setSecret('')}>I have saved it</Button></div></div> : null}
    <div className="settings-subsection"><h2>Your connections</h2>{query.data.integrations.length ? <div className="integrations-saved-list">{query.data.integrations.map((integration) => <div className="integration-row" key={integration.id}><span className="integration-icon">{integration.kind === 'google_sheets' ? <Table2 size={22} /> : <Webhook size={22} />}</span><div className="integration-copy"><h3>{integration.name}</h3><p className="integration-destination">{integration.kind === 'google_sheets' ? `${integration.config.sheetName} · ${integration.config.spreadsheetId}` : integration.config.url}</p><span className="integration-inline-status"><Status value={integration.enabled ? 'active' : 'inactive'} /></span><p className="small">Parser: {integration.parserId ? parsers.find((parser) => parser.id === integration.parserId)?.name || 'Archived parser' : 'All parsers'}</p></div>{canManage ? <div className="actions integration-row-actions">
      {integration.kind === 'google_sheets' ? integration.enabled ? <Button variant="secondary" className="small" disabled={action.busy} onClick={() => void action.run(() => post(`/api/google/${integration.id}/disconnect`), 'Google Sheets disconnected locally. Check your Google account if provider revocation did not complete.')}>Disconnect</Button> : <Button variant="secondary" className="small" disabled={action.busy || !provider.googleSheets.configured} onClick={() => void startGoogle(undefined, integration.id)}>Reconnect</Button> : <Button variant="secondary" className="small" disabled={action.busy} onClick={() => void action.run(() => patch(`/api/integrations/${integration.id}`, { enabled: !integration.enabled }), integration.enabled ? 'Webhook paused.' : 'Webhook enabled.')}>{integration.enabled ? 'Pause' : 'Enable'}</Button>}
      <button className="icon-button" aria-label={`Remove ${integration.name}`} onClick={() => setRemoving(integration)} disabled={action.busy}><Trash2 size={17} /></button>
    </div> : null}</div>)}</div> : <Empty title="No saved connections yet." description="Start with a webhook, or use a CSV, XLSX or JSON download after approving a document." />}</div>
    <Modal title="Add a signed webhook" description="Connect a destination that you control and can verify with the signing secret." open={modal === 'webhook'} onOpenChange={(open) => { if (!open) setModal(null); }}>
      <form onSubmit={(event) => void createWebhook(event)}><Field label="Connection name"><input autoFocus required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Destination URL" hint="Public HTTPS endpoints only. Redirects and private-network addresses are blocked."><input type="url" required placeholder="https://example.com/folio-events" value={url} onChange={(event) => setUrl(event.target.value)} /></Field><Field label="Parser"><select value={parserId} onChange={(event) => setParserId(event.target.value)}><option value="">All parsers</option>{parsers.map((parser) => <option key={parser.id} value={parser.id}>{parser.name}</option>)}</select></Field><Notice error={action.error} /><Button type="submit" disabled={action.busy}>Create webhook</Button></form>
    </Modal>
    <Modal title="Connect Google Sheets" description="Choose the destination, then authorize your Google account." open={modal === 'sheets'} onOpenChange={(open) => { if (!open) setModal(null); }}>
      <form onSubmit={(event) => void startGoogle(event)}><Field label="Connection name"><input autoFocus required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Parser"><select required value={parserId} onChange={(event) => setParserId(event.target.value)}><option value="">Choose a parser</option>{parsers.map((parser) => <option key={parser.id} value={parser.id}>{parser.name}</option>)}</select></Field><Field label="Spreadsheet ID or URL"><input required value={spreadsheet} onChange={(event) => setSpreadsheet(event.target.value)} placeholder="Paste the destination spreadsheet URL" /></Field><Field label="Worksheet name"><input required maxLength={80} value={sheetName} onChange={(event) => setSheetName(event.target.value)} /></Field>
        <div className="settings-callout">Choose an existing, empty worksheet. Folio writes column headers to row 1 and begins document data at row 2.</div>
        <Field label="Column mapping (optional)" hint="One field_key=Column label per line. Empty uses all schema fields."><textarea rows={3} value={mapping} onChange={(event) => setMapping(event.target.value)} placeholder={'supplier=Supplier\ninvoice_number=Invoice number'} /></Field><Field label="Line-item table (optional)" hint="Use the schema field key to write one row per line item."><input value={lineItems} onChange={(event) => setLineItems(event.target.value)} placeholder="line_items" /></Field><Notice error={action.error} /><Button type="submit" disabled={action.busy || !parserId}><ExternalLink size={16} /> Continue to Google</Button>
      </form>
    </Modal>
    <Modal title="Remove this connection?" description="Future approved results will no longer be sent through this connection. You can add a new connection later." open={Boolean(removing)} onOpenChange={(open) => { if (!open) setRemoving(null); }}><Notice error={action.error} /><div className="actions"><Button variant="danger" disabled={action.busy} onClick={async () => { if (!removing) return; const result = await action.run(() => api(`/api/integrations/${removing.id}`, { method: 'DELETE' }), 'Connection removed.'); if (result) setRemoving(null); }}>Remove connection</Button><Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button></div></Modal>
  </section>;
}

export default function Integrations() {
  const providers = useData<ProviderStatus>('/api/providers/status');
  const parsersQuery = useData<{ parsers: ParserOption[] }>('/api/parsers');
  const { data: session } = useSession();
  const [params, setParams] = useSearchParams();
  const canManage = ['owner', 'admin'].includes(session?.workspace.role || '');
  const tabs = ['Connections', 'Email intake', 'Delivery history', ...(canManage ? ['Provider events'] : [])];
  const active = tabs.find((tab) => tab.toLowerCase().replaceAll(' ', '-') === params.get('tab')) || 'Connections';
  if (providers.isPending || parsersQuery.isPending) return <Loading />;
  if (providers.error || parsersQuery.error || !providers.data || !parsersQuery.data) return <ErrorState error={providers.error || parsersQuery.error} retry={() => { void providers.refetch(); void parsersQuery.refetch(); }} />;
  const parsers = parsersQuery.data.parsers.filter((parser) => !parser.archived);
  return <div className="workspace-integrations"><PageHeader title="Integrations" description="Move approved data into your next step, with clear connection status." />
    {params.has('google') ? <div className="settings-callout">{params.get('google') === 'denied' ? 'Google authorization was not completed. Your connection remains inactive.' : 'Google authorization returned. Review the saved connection state and verify a delivery below.'}</div> : null}
    {!canManage ? <p className="small muted">Owners and administrators manage connections. You can inspect the current setup and delivery history.</p> : null}
    <Tabs items={tabs} value={active} onChange={(tab) => setParams({ tab: tab.toLowerCase().replaceAll(' ', '-') })} />
    {active === 'Connections' ? <ConnectionForms provider={providers.data} parsers={parsers} canManage={canManage} /> : null}
    {active === 'Email intake' ? <EmailRouting canManage={canManage} provider={providers.data.resend} parsers={parsers} /> : null}
    {active === 'Delivery history' ? <DeliveryHistory canManage={canManage} /> : null}
    {active === 'Provider events' ? <ProviderEvents /> : null}
  </div>;
}
