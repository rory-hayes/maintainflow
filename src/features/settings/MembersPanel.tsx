import { useState, type FormEvent } from 'react';
import { Copy, Plus, Trash2, UserPlus } from 'lucide-react';
import { Button, ErrorState, Field, Loading, Modal, Notice, Status, dateTime } from '../../components/ui';
import { api, patch, post, useAction, useData } from '../../lib/api';
import { useSession } from '../../lib/session';
import type { Role } from '../../../shared/types';

type Member = { id: string; name: string; email: string; role: Role; createdAt: string };
type Invitation = { id: string; email: string; role: Role; expiresAt: string; acceptedAt: string | null; createdAt: string };

export default function MembersPanel() {
  const query = useData<{ members: Member[]; invitations: Invitation[] }>('/api/workspace/members');
  const { data: session } = useSession();
  const action = useAction();
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [inviteUrl, setInviteUrl] = useState('');
  const [removing, setRemoving] = useState<Member | null>(null);
  const isOwner = session?.workspace.role === 'owner';
  const canManage = isOwner || session?.workspace.role === 'admin';

  async function invite(event: FormEvent) {
    event.preventDefault();
    const result = await action.run(() => post<{ inviteUrl: string }>('/api/workspace/members', { email, role }), 'Invitation link created. Email delivery is not configured.');
    if (result) {
      setInviteUrl(result.inviteUrl);
      setEmail('');
      setInviting(false);
    }
  }

  async function copyInvitation() {
    action.setError('');
    try { await navigator.clipboard.writeText(inviteUrl); action.setMessage('Invitation link copied.'); }
    catch { action.setError('Copy is unavailable in this browser. Select and copy the link below.'); }
  }

  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const pending = query.data.invitations.filter((invitation) => !invitation.acceptedAt);
  return (
    <section>
      <div className="settings-section-heading"><div><h2>Workspace members</h2><p>Share access with clear roles.</p></div>{canManage ? <Button onClick={() => setInviting(true)}><UserPlus size={17} /> Invite member</Button> : null}</div>
      <Notice error={action.error} message={action.message} />
      {inviteUrl ? <div className="settings-secret-reveal"><strong>Share this invitation with its intended recipient.</strong><p className="small">The link expires in seven days. It has not been emailed.</p><code className="key-reveal">{inviteUrl}</code><div className="actions"><Button variant="secondary" onClick={() => void copyInvitation()}><Copy size={16} /> Copy invitation link</Button><Button variant="ghost" onClick={() => setInviteUrl('')}>Dismiss</Button></div></div> : null}
      <div className="table-wrap"><table className="members-table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
        {query.data.members.map((member) => <tr key={member.id}><td><strong>{member.name}</strong>{member.id === session?.user.id ? <span className="small muted"> (you)</span> : null}</td><td>{member.email}</td><td>
          {isOwner && member.role !== 'owner' ? <select aria-label={`Role for ${member.name}`} value={member.role} disabled={action.busy} onChange={(event) => void action.run(() => patch(`/api/workspace/members/${member.id}`, { role: event.target.value }), 'Member role updated.')}><option value="admin">Admin</option><option value="editor">Editor</option><option value="viewer">Viewer</option></select> : <Status value={member.role} />}
        </td><td>{canManage && member.role !== 'owner' && (isOwner || member.role !== 'admin') ? <button className="icon-button" aria-label={`Remove ${member.name}`} disabled={action.busy} onClick={() => setRemoving(member)}><Trash2 size={17} /></button> : null}</td></tr>)}
      </tbody></table></div>
      <p className="small muted settings-bottom-note">Owners manage administrator roles. Editors work on documents and parsers. Viewers can read workspace data and download approved exports.</p>
      {canManage ? <div className="settings-subsection"><h3>Pending invitations</h3>{pending.length ? <div className="table-wrap"><table className="members-table"><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{pending.map((invitation) => <tr key={invitation.id}><td>{invitation.email}</td><td>{invitation.role}</td><td>{dateTime(invitation.expiresAt)}</td><td><Button variant="ghost" className="small" disabled={action.busy} onClick={() => void action.run(() => api(`/api/workspace/invitations/${invitation.id}`, { method: 'DELETE' }), 'Invitation revoked.')}>Revoke</Button></td></tr>)}</tbody></table></div> : <p className="muted">No pending invitations.</p>}</div> : null}
      <Modal title="Invite a workspace member" description="Create a link for this email address. This build does not send an invitation email." open={inviting} onOpenChange={setInviting}>
        <form onSubmit={(event) => void invite(event)}><Field label="Email address"><input autoFocus type="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></Field><Field label="Role"><select value={role} onChange={(event) => setRole(event.target.value)}>{isOwner ? <option value="admin">Admin</option> : null}<option value="editor">Editor</option><option value="viewer">Viewer</option></select></Field><Notice error={action.error} /><Button type="submit" disabled={action.busy}><Plus size={17} /> Create invitation link</Button></form>
      </Modal>
      <Modal title="Remove workspace member?" description={removing ? `${removing.name} will lose access to this workspace, and their workspace API keys will be revoked.` : ''} open={Boolean(removing)} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <Notice error={action.error} /><div className="actions"><Button variant="danger" disabled={action.busy} onClick={async () => { if (!removing) return; const result = await action.run(() => api(`/api/workspace/members/${removing.id}`, { method: 'DELETE' }), 'Member removed.'); if (result) setRemoving(null); }}>Remove member</Button><Button variant="secondary" onClick={() => setRemoving(null)}>Cancel</Button></div>
      </Modal>
    </section>
  );
}
