import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Mail, Plus, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import { Button, ErrorState, Field, Loading, Modal, Notice, Status, dateTime } from '../../components/ui';
import { ApiError, api, patch, post, useAction, workspaceId } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { Role } from '../../../shared/types';

type Member = { id: string; name: string; email: string; role: Role; createdAt: string };
type Delivery = 'manual' | 'email';
type Invitation = { id: string; email: string; role: Role; expiresAt: string; acceptedAt: string | null; createdAt: string; delivery: Delivery; emailStatus: null | 'pending' | 'sending' | 'accepted' | 'failed' | 'cancelled'; retryAt: string | null };
type Members = { members: Member[]; invitations: Invitation[]; invitationEmail?: { available: boolean } };
type InvitationResult = { invitation: Invitation; delivery: Delivery; inviteUrl?: string; message: string };
const membersPath = '/api/workspace/members';
const uncertainMessage = 'We couldn’t confirm whether the invitation was created. Refresh pending invitations before creating another. If a manual link was created, email it from the list or revoke it and create a new link.';
const mailLabels = { pending: 'Queued', sending: 'Sending', accepted: 'Accepted by email provider', failed: 'Email failed', cancelled: 'Email cancelled' };

function invitationStatus(invitation: Invitation, now: number) {
  if (new Date(invitation.expiresAt).getTime() <= now) return 'Expired';
  if (invitation.delivery === 'manual') return 'Manual link';
  return invitation.emailStatus ? mailLabels[invitation.emailStatus] : 'Email status unavailable';
}

export default function MembersPanel() {
  const query = useQuery<Members>({
    queryKey: [workspaceId(), membersPath],
    queryFn: ({ signal }) => api<Members>(membersPath, { signal }),
    refetchInterval: (current) => current.state.status === 'success' && current.state.data?.invitations.some(invitation => !invitation.acceptedAt && new Date(invitation.expiresAt).getTime() > Date.now() && ['pending', 'sending'].includes(invitation.emailStatus || '')) ? 1800 : false,
    refetchOnWindowFocus: 'always',
  });
  const { data: session } = useSession();
  const action = useAction();
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [delivery, setDelivery] = useState<Delivery>('manual');
  const [revealed, setRevealed] = useState<{ id: string; url: string; email: string; expiresAt: string } | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [uncertainEmail, setUncertainEmail] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [now, setNow] = useState(Date.now);
  const isOwner = session?.workspace.role === 'owner';
  const canManage = isOwner || session?.workspace.role === 'admin';
  // Cached success must not enable sending after a failed availability refresh.
  const statusKnown = query.isSuccess && !query.isFetching && typeof query.data?.invitationEmail?.available === 'boolean';
  const emailAvailable = statusKnown && query.data?.invitationEmail?.available === true;
  const pending = query.data?.invitations.filter(invitation => !invitation.acceptedAt) || [];
  const hasPending = pending.length > 0;
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasPending]);

  async function refresh() {
    const result = await query.refetch();
    if (result.isSuccess) { setUncertain(false); setUncertainEmail(null); setNow(Date.now()); }
  }

  async function openInvitation() {
    if (action.busy || uncertain) return;
    action.setError(''); action.setMessage(''); setRevealed(null);
    setRole('editor'); setDelivery('manual'); setInviting(true);
    const result = await query.refetch();
    setDelivery(result.isSuccess && result.data?.invitationEmail?.available === true ? 'email' : 'manual');
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    if (action.busy || query.isFetching || uncertain || delivery === 'email' && !emailAvailable) return;
    const result = await action.run(async () => {
      try {
        const created = await post<InvitationResult>(membersPath, { email: email.trim(), role, delivery });
        if (created.delivery !== delivery || !created.invitation?.id || delivery === 'manual' && !created.inviteUrl) throw new Error('Unconfirmed invitation response');
        return created;
      } catch (error) {
        if (error instanceof ApiError && error.status === 503) { void query.refetch(); throw error; }
        if (!(error instanceof ApiError) || error.status >= 500) {
          setUncertain(true); setInviting(false);
          throw new Error(uncertainMessage);
        }
        throw error;
      }
    }, delivery === 'email' ? 'Invitation email queued.' : 'Invitation link created. Share it with its intended recipient.');
    if (result) {
      setRevealed(result.delivery === 'manual' ? { id: result.invitation.id, url: result.inviteUrl!, email: result.invitation.email, expiresAt: result.invitation.expiresAt } : null);
      setEmail(''); setInviting(false);
    }
  }

  async function resend(invitation: Invitation) {
    if (action.busy || !emailAvailable || uncertainEmail === invitation.id || !isOwner && invitation.role === 'admin' || invitation.retryAt && new Date(invitation.retryAt).getTime() > Date.now()) return;
    setRevealed(current => current?.id === invitation.id ? null : current);
    await action.run(async () => {
      try { return await post(`/api/workspace/invitations/${invitation.id}/resend`); }
      catch (error) {
        if (error instanceof ApiError && error.status === 503) { void query.refetch(); throw error; }
        if (!(error instanceof ApiError) || error.status >= 500) {
          setUncertainEmail(invitation.id);
          throw new Error('We couldn’t confirm whether the email was queued. Refresh its status before trying again. The previous link may have been replaced.');
        }
        throw error;
      }
    }, 'Invitation email queued. The previous invitation link no longer works.');
  }

  async function copyInvitation() {
    if (!revealed) return;
    action.setError('');
    try { await navigator.clipboard.writeText(revealed.url); action.setMessage('Invitation link copied.'); }
    catch { action.setError('Copy is unavailable in this browser. Select and copy the link below.'); }
  }

  if (query.isPending) return <Loading />;
  if (!query.data) return <ErrorState error={new Error('Workspace members could not be loaded. Please try again.')} retry={() => void query.refetch()} />;
  return (
    <section>
      <div className="settings-section-heading"><div><h2>Workspace members</h2><p>Share access with clear roles.</p></div>{canManage ? <Button disabled={action.busy || uncertain} onClick={() => void openInvitation()}><UserPlus size={17} /> Invite member</Button> : null}</div>
      {!inviting && !removing ? <Notice error={action.error} message={action.message} /> : null}
      {query.isError ? <Notice error="We couldn’t refresh workspace members. The list may be out of date. Refresh status before sending an invitation email." /> : null}
      {revealed ? <div className="settings-secret-reveal"><strong>Share this invitation with {revealed.email}.</strong><p className="small">This link has not been emailed. It expires {dateTime(revealed.expiresAt)} and is shown only now. Copy it before dismissing.</p><code className="key-reveal">{revealed.url}</code><div className="actions"><Button variant="secondary" onClick={() => void copyInvitation()}><Copy size={16} /> Copy invitation link</Button><Button variant="ghost" onClick={() => setRevealed(null)}>Dismiss</Button></div></div> : null}
      <div className="table-wrap members-table-wrap"><table className="members-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {query.data.members.map(member => <tr key={member.id}><td><strong>{member.name}</strong>{member.id === session?.user.id ? <span className="small muted"> (you)</span> : null}</td><td>{member.email}</td><td>
          {isOwner && member.role !== 'owner' ? <select aria-label={`Role for ${member.name}`} value={member.role} disabled={action.busy} onChange={event => void action.run(() => patch(`/api/workspace/members/${member.id}`, { role: event.target.value }), 'Member role updated.')}><option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select> : <Status value={member.role} />}
        </td><td>{canManage && member.role !== 'owner' && (isOwner || member.role !== 'admin') ? <button className="icon-button" aria-label={`Remove ${member.name}`} disabled={action.busy} onClick={() => setRemoving(member)}><Trash2 size={17} /></button> : null}</td></tr>)}
      </tbody></table></div>
      <p className="small muted settings-bottom-note">Owners manage administrator roles. Editors work on documents and parsers. Viewers can read workspace data and download approved exports.</p>
      {canManage ? <div className="settings-subsection">
        <div className="invitation-list-heading"><h3>Pending invitations</h3><Button variant="secondary" className="small" disabled={query.isFetching || action.busy} onClick={() => void refresh()}><RefreshCw size={15} />{query.isFetching ? 'Refreshing…' : 'Refresh status'}</Button></div>
        <p className="small muted">Email provider acceptance does not confirm inbox delivery. Emailing an invitation again replaces its previous link.</p>
        {!statusKnown && !query.isFetching ? <Notice error="Invitation email availability could not be confirmed. Refresh status to check. Manual sharing remains available." /> : statusKnown && !emailAvailable ? <p className="small muted">Invitation email is unavailable. You can create a link to share manually.</p> : null}
        {pending.length ? <ul className="invitation-list" aria-label="Pending invitations">{pending.map(invitation => {
          const retryIn = invitation.retryAt ? Math.max(0, Math.ceil((new Date(invitation.retryAt).getTime() - now) / 1000)) : 0;
          const resendAllowed = isOwner || invitation.role !== 'admin';
          return <li key={invitation.id} className="invitation-row">
            <div className="invitation-recipient"><strong>{invitation.email}</strong><span className="small muted">{invitation.role} · Expires {dateTime(invitation.expiresAt)}</span><span className="invitation-delivery" role="status">{invitationStatus(invitation, now)}</span></div>
            <div className="invitation-row-actions">
              {resendAllowed ? <Button variant="secondary" className="small" disabled={action.busy || !emailAvailable || retryIn > 0 || uncertainEmail === invitation.id} onClick={() => void resend(invitation)}><Mail size={15} />{retryIn > 0 ? `Email again in ${retryIn}s` : invitation.delivery === 'manual' ? 'Email invitation' : 'Email again'}</Button> : <span className="small muted">Only the owner can email this admin invitation.</span>}
              <Button variant="ghost" className="small" disabled={action.busy} aria-label={`Revoke invitation for ${invitation.email}`} onClick={() => void action.run(async () => { const result = await api(`/api/workspace/invitations/${invitation.id}`, { method: 'DELETE' }); setRevealed(current => current?.id === invitation.id ? null : current); return result; }, 'Invitation revoked.')}>Revoke</Button>
            </div>
          </li>;
        })}</ul> : <p className="muted">No pending invitations.</p>}
      </div> : null}
      <Modal title="Invite a workspace member" description="Choose a role and how to share the invitation. Only the invited email address can join." open={inviting} onOpenChange={open => { if (!action.busy) setInviting(open); }}>
        <form onSubmit={event => void invite(event)} aria-busy={action.busy}>
          <Field label="Email address"><input autoFocus type="email" required maxLength={254} disabled={action.busy} value={email} onChange={event => setEmail(event.target.value)} /></Field>
          <Field label="Role"><select disabled={action.busy} value={role} onChange={event => setRole(event.target.value)}>{isOwner ? <option value="admin">Admin</option> : null}<option value="editor">Editor</option><option value="viewer">Viewer</option></select></Field>
          <Field label="Invitation delivery" hint={delivery === 'email' ? 'We’ll queue an invitation email. Track its status in pending invitations.' : 'The link is displayed once for you to copy. No email will be sent.'}><select disabled={action.busy || query.isFetching} value={delivery} onChange={event => setDelivery(event.target.value as Delivery)}><option value="email" disabled={!emailAvailable}>Email invitation</option><option value="manual">Create a link to share manually</option></select></Field>
          {!emailAvailable ? <p className="small muted">{query.isFetching ? 'Checking invitation email availability…' : statusKnown ? 'Invitation email is currently unavailable. Choose manual sharing, or check again.' : 'Email availability could not be confirmed. Choose manual sharing, or check again.'} <Button type="button" variant="ghost" className="small" disabled={query.isFetching || action.busy} onClick={() => void refresh()}>Check again</Button></p> : null}
          <Notice error={action.error} />
          <Button type="submit" disabled={action.busy || query.isFetching || uncertain || delivery === 'email' && !emailAvailable}><Plus size={17} />{action.busy ? 'Please wait…' : delivery === 'email' ? 'Queue invitation email' : 'Create invitation link'}</Button>
        </form>
      </Modal>
      <Modal title="Remove workspace member?" description={removing ? `${removing.name} will lose access to this workspace, and their workspace API keys will be revoked.` : ''} open={Boolean(removing)} onOpenChange={open => { if (!open && !action.busy) setRemoving(null); }}>
        <Notice error={action.error} /><div className="actions"><Button variant="danger" disabled={action.busy} onClick={async () => { if (!removing) return; const result = await action.run(() => api(`/api/workspace/members/${removing.id}`, { method: 'DELETE' }), 'Member removed.'); if (result) setRemoving(null); }}>Remove member</Button><Button variant="secondary" disabled={action.busy} onClick={() => setRemoving(null)}>Cancel</Button></div>
      </Modal>
    </section>
  );
}
