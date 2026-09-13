import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Copy, KeyRound, Plus } from 'lucide-react';
import { Button, Empty, ErrorState, Field, Loading, Modal, Notice, Status, dateTime } from '../../components/ui';
import { api, post, useAction, useData } from '../../lib/api';

type ApiKey = { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; expiresAt: string | null; status: 'active' | 'expired' | 'revoked' };

export default function ApiKeysPanel() {
  const query = useData<{ apiKeys: ApiKey[]; scopes: string[] }>('/api/workspace/api-keys', 30_000);
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const createTrigger = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['documents:read', 'results:read']);
  const [expiryDays, setExpiryDays] = useState('30');
  const [token, setToken] = useState('');
  const [createdExpiry, setCreatedExpiry] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault();
    const expiresAt = expiryDays === 'never' ? null : new Date(Date.now() + Number(expiryDays) * 86_400_000).toISOString();
    const result = await action.run(() => post<{ token: string; apiKey: ApiKey }>('/api/workspace/api-keys', { name, scopes, expiresAt }), 'API key created. Store it securely now.');
    if (result) { setToken(result.token); setCreatedExpiry(result.apiKey.expiresAt); setName(''); setExpiryDays('30'); setCreating(false); }
  }
  async function copyKey() {
    action.setError('');
    try { await navigator.clipboard.writeText(token); action.setMessage('API key copied.'); }
    catch { action.setError('Copy is unavailable. Select and copy the displayed key.'); }
  }
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return (
    <section>
      <div className="settings-section-heading"><div><h2>API keys</h2><p>Give each connection only the access it needs.</p></div><Button onClick={(event) => { createTrigger.current = event.currentTarget; setCreating(true); }}><Plus size={17} /> Create API key</Button></div>
      <Notice error={action.error} message={action.message} />
      {token ? <div className="settings-secret-reveal"><strong>This key is shown once.</strong><p className="small">Store it in your server or automation secret store. Do not place it in public client code.</p><p className="small">{createdExpiry ? `Expires ${dateTime(createdExpiry)}. Replace it in your connection before then.` : 'No automatic expiry. Revoke it when this connection no longer needs access.'}</p><code className="key-reveal">{token}</code><div className="actions"><Button variant="secondary" onClick={() => void copyKey()}><Copy size={16} /> Copy API key</Button><Button variant="ghost" onClick={() => setToken('')}>I have saved it</Button></div></div> : null}
      {query.data.apiKeys.length ? <div className="table-wrap api-keys-scroll"><table className="api-keys-table"><thead><tr><th>Name</th><th>Access</th><th>Last used</th><th>Expires</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{query.data.apiKeys.map((key) => <tr key={key.id}><td><strong>{key.name}</strong><code className="settings-key-prefix">{key.prefix}…</code></td><td><div className="settings-scope-list">{key.scopes.map((scope) => <code key={scope}>{scope}</code>)}</div></td><td>{key.lastUsedAt ? dateTime(key.lastUsedAt) : 'Never'}</td><td>{key.expiresAt ? <time dateTime={key.expiresAt}>{dateTime(key.expiresAt)}</time> : 'No expiry'}</td><td><Status value={key.status} /></td><td>{!key.revokedAt ? <Button variant="ghost" className="small" aria-label={`Revoke ${key.name}`} onClick={() => setRevoking(key)}>Revoke</Button> : null}</td></tr>)}</tbody></table></div> : <Empty title="No API keys yet." description="Create a scoped key to connect an upload script or automation." />}
      <Link className="link settings-bottom-link" to="/help/api">Read the API documentation</Link>
      <Modal title="Create an API key" description="Choose a name and the minimum scopes this connection requires." open={creating} onOpenChange={setCreating} onCloseAutoFocus={(event) => { event.preventDefault(); createTrigger.current?.focus(); }}>
        <form onSubmit={(event) => void create(event)}><Field label="Key name"><input required autoFocus maxLength={100} placeholder="Invoice upload automation" value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Expiry" hint="Access stops automatically at the expiry time. Create a replacement before then to keep your connection running."><select value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="never">No expiry</option></select></Field><fieldset className="settings-scope-picker"><legend>Allowed scopes</legend>{query.data.scopes.map((scope) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} /><span>{scope}</span></label>)}</fieldset><Notice error={action.error} /><Button type="submit" disabled={action.busy || !scopes.length}><KeyRound size={17} /> Create key</Button></form>
      </Modal>
      <Modal title="Revoke this API key?" description="Connections using this key will immediately lose API access. You can create a new key later." open={Boolean(revoking)} onOpenChange={(open) => { if (!open) setRevoking(null); }}><Notice error={action.error} /><div className="actions"><Button variant="danger" disabled={action.busy} onClick={async () => { if (!revoking) return; const result = await action.run(() => api(`/api/workspace/api-keys/${revoking.id}`, { method: 'DELETE' }), 'API key revoked.'); if (result) setRevoking(null); }}>Revoke key</Button><Button variant="secondary" onClick={() => setRevoking(null)}>Cancel</Button></div></Modal>
    </section>
  );
}
