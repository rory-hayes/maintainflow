import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bell, Clock3, ShieldCheck } from 'lucide-react';
import { Button, ErrorState, Field, Loading, Notice, PageHeader, Tabs, dateTime } from '../../components/ui';
import { patch, post, useAction, useData } from '../../lib/api';
import { useSession } from '../../lib/session';
import MembersPanel from './MembersPanel';
import ApiKeysPanel from './ApiKeysPanel';
import BillingPanel from './BillingPanel';
import './settings.css';

type WorkspaceSettings = {
  workspace: { id: string; name: string; settings: { retentionDays?: number; notifications?: boolean } };
  role: string;
  limits: { maxBytes: number; maxPages: number };
  authentication: { provider: string; emailVerification: boolean; passwordResetEmail: boolean };
};

function GeneralPanel({ data, canManage }: { data: WorkspaceSettings; canManage: boolean }) {
  const action = useAction();
  const [name, setName] = useState(data.workspace.name);
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(() => patch('/api/workspace/settings', { name }), 'Workspace settings saved.');
  }
  return (
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <h2>General</h2>
      <div className="setting-row"><div><strong>Workspace name</strong><p>The name people see in this workspace.</p></div><input aria-label="Workspace name" required maxLength={100} value={name} disabled={!canManage} onChange={(event) => setName(event.target.value)} /></div>
      <div className="setting-row"><div><strong>Locale and timezone</strong><p>Each parser’s locale controls how dates and numbers are read.</p></div><div><p>Date fields keep the written calendar date. Timezone is saved with the parser; timestamp and timezone conversion are not supported.</p><Link className="link" to="/app/parsers">Manage parsers</Link></div></div>
      <div className="setting-row"><div><strong>Upload limits</strong><p>Validated before a document enters the queue.</p></div><p>{Math.floor(data.limits.maxBytes / 1024 / 1024)} MB per file · {data.limits.maxPages} pages per PDF</p></div>
      <div className="setting-row"><div><strong>Authentication</strong><p>Your account uses the local application sign-in.</p></div><p>Local password authentication. Email verification and password-reset email are not configured.</p></div>
      <Notice error={action.error} message={action.message} />
      {canManage ? <div className="actions"><Button type="submit" disabled={action.busy || !name.trim()}>Save changes</Button></div> : <p className="small muted settings-bottom-note">A workspace owner or administrator can change these settings.</p>}
      <div className="settings-callout settings-inline-link"><div><strong>Billing connection</strong><p>View provider setup and the configurable test-mode plans.</p></div><Link className="button secondary" to="/app/settings?tab=billing">View plans</Link></div>
    </form>
  );
}

function RetentionPanel({ data, canManage }: { data: WorkspaceSettings; canManage: boolean }) {
  const action = useAction();
  const [days, setDays] = useState(String(data.workspace.settings.retentionDays ?? 90));
  const numericDays = Number(days);
  async function save(event: FormEvent) {
    event.preventDefault();
    await action.run(() => patch('/api/workspace/settings', { retentionDays: numericDays }), 'Retention period saved.');
  }
  return (
    <form className="settings-form" onSubmit={(event) => void save(event)}>
      <div className="settings-section-heading"><div><h2>Document retention</h2><p>Choose how long source documents stay in this workspace.</p></div><Clock3 size={25} strokeWidth={1.6} /></div>
      <div className="setting-row"><div><strong>Retention period</strong><p>Between 1 and 3,650 days, measured from receipt.</p></div><div className="settings-input-unit"><input aria-label="Retention days" type="number" min={1} max={3650} step={1} required disabled={!canManage} value={days} onChange={(event) => setDays(event.target.value)} /><span>days</span></div></div>
      <div className="settings-callout">The worker deletes eligible documents and linked processing records after this period. Lowering it can make older documents eligible at the next sweep. Local export snapshots containing a deleted document are removed too. Copies already downloaded or delivered to other services remain outside this installation.</div>
      <Notice error={action.error} message={action.message} />
      {canManage ? <div className="actions"><Button type="submit" disabled={action.busy || !days.trim() || !Number.isInteger(numericDays) || numericDays < 1 || numericDays > 3650}>Save retention period</Button></div> : <p className="small muted">A workspace administrator can change retention.</p>}
    </form>
  );
}

function NotificationsPanel({ data, canManage }: { data: WorkspaceSettings; canManage: boolean }) {
  const action = useAction();
  const [requested, setRequested] = useState(data.workspace.settings.notifications ?? true);
  return (
    <form className="settings-form" onSubmit={(event) => { event.preventDefault(); void action.run(() => patch('/api/workspace/settings', { notifications: requested }), 'In-app notification preference saved.'); }}>
      <div className="settings-section-heading"><div><h2>Notification preferences</h2><p>Use the bell in the workspace header to review processing outcomes.</p></div><Bell size={25} strokeWidth={1.6} /></div>
      <div className="settings-callout">The in-app inbox shows the latest 50 completed or failed jobs, with a link to each document. Read status is personal to each member. No notification emails are sent.</div>
      <label className="settings-checkbox-row"><input type="checkbox" checked={requested} disabled={!canManage} onChange={(event) => setRequested(event.target.checked)} /><span><strong>Show in-app processing notifications</strong><small>Applies to this workspace. Turning it off hides the inbox; existing document status and saved read status remain available when it is enabled again.</small></span></label>
      <Notice error={action.error} message={action.message} />
      {canManage ? <div className="actions"><Button type="submit" disabled={action.busy}>Save preference</Button></div> : null}
    </form>
  );
}

function PasswordPanel() {
  const action = useAction();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmation) { action.setError('The new passwords do not match.'); return; }
    const result = await action.run(() => post('/api/auth/password', { currentPassword, newPassword }), 'Password updated. Other sessions have been signed out.');
    if (result) { setCurrentPassword(''); setNewPassword(''); setConfirmation(''); }
  }
  return (
    <form className="settings-password-form" onSubmit={(event) => void save(event)}>
      <div className="settings-section-heading"><div><h2>Change your password</h2><p>Your current session stays signed in.</p></div><ShieldCheck size={25} strokeWidth={1.6} /></div>
      <Field label="Current password"><input type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></Field>
      <Field label="New password" hint="Use between 10 and 128 characters."><input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} /></Field>
      <Field label="Confirm new password"><input type="password" autoComplete="new-password" required minLength={10} maxLength={128} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
      <Notice error={action.error} message={action.message} /><Button type="submit" disabled={action.busy}>Update password</Button>
    </form>
  );
}

function ActivityPanel() {
  const query = useData<{ events: { id: string; action: string; entityId: string | null; createdAt: string; metadata?: unknown }[] }>('/api/workspace/audit');
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return <section><h2>Workspace activity</h2><p>Recent operational events, without document contents or credentials.</p>{query.data.events.length ? <div className="table-wrap"><table><thead><tr><th>Action</th><th>Resource</th><th>Time</th></tr></thead><tbody>{query.data.events.map((event) => {
    const reason = event.action === 'email.rejected' && event.metadata && typeof event.metadata === 'object' && 'reason' in event.metadata && typeof event.metadata.reason === 'string' ? event.metadata.reason.slice(0, 300).trim() : '';
    return <tr key={event.id}><td>{event.action === 'email.rejected' ? 'Email rejected' : event.action.replaceAll('.', ' · ').replaceAll('_', ' ')}{reason ? <small className="muted" style={{ display: 'block', marginTop: 6, maxWidth: 440, overflowWrap: 'anywhere' }}>{reason}</small> : null}</td><td><code>{event.entityId ? event.entityId.slice(0, 8) : 'Workspace'}</code></td><td>{dateTime(event.createdAt)}</td></tr>;
  })}</tbody></table></div> : <p>No activity recorded yet.</p>}</section>;
}

const settingTabs = [
  { id: 'general', label: 'General' }, { id: 'members', label: 'Members' }, { id: 'keys', label: 'API keys', admin: true },
  { id: 'retention', label: 'Retention' }, { id: 'notifications', label: 'Notifications' },
  { id: 'billing', label: 'Billing' }, { id: 'password', label: 'Password' }, { id: 'activity', label: 'Activity', admin: true },
];

export default function Settings() {
  const query = useData<WorkspaceSettings>('/api/workspace/settings');
  const { data: session } = useSession();
  const [params, setParams] = useSearchParams();
  const canManage = ['owner', 'admin'].includes(session?.workspace.role || '');
  const tabs = settingTabs.filter((tab) => !tab.admin || canManage);
  const active = tabs.find((tab) => tab.id === params.get('tab')) || tabs[0];
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  return (
    <div className="workspace-settings">
      <PageHeader title="Workspace settings" description="Manage the people and preferences behind your work." />
      <Tabs items={tabs.map((tab) => tab.label)} value={active.label} onChange={(label) => setParams({ tab: tabs.find((tab) => tab.label === label)!.id })} />
      <div className="settings-tab-content" key={`${query.data.workspace.id}:${active.id}`}>
        {active.id === 'general' ? <GeneralPanel data={query.data} canManage={canManage} /> : null}
        {active.id === 'members' ? <MembersPanel /> : null}
        {active.id === 'keys' ? <ApiKeysPanel /> : null}
        {active.id === 'retention' ? <RetentionPanel data={query.data} canManage={canManage} /> : null}
        {active.id === 'notifications' ? <NotificationsPanel data={query.data} canManage={canManage} /> : null}
        {active.id === 'billing' ? <BillingPanel /> : null}
        {active.id === 'password' ? <PasswordPanel /> : null}
        {active.id === 'activity' ? <ActivityPanel /> : null}
      </div>
    </div>
  );
}
