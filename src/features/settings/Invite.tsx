import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Notice, PageHeader } from '../../components/ui';
import { post, useAction } from '../../lib/api';
import { useSession } from '../../lib/session';

export default function Invite() {
  const [params] = useSearchParams();
  const action = useAction();
  const session = useSession();
  const navigate = useNavigate();
  const token = params.get('token');
  return <section className="settings-password-form"><PageHeader title="Join a workspace" description="Accept an invitation using the account it was created for." /><p>Signed in as <strong>{session.data?.user.email}</strong>. Invitation links expire after seven days and can be used once.</p>{!token ? <Notice error="This invitation link is missing its token." /> : null}<Notice error={action.error} message={action.message} /><Button disabled={!token || action.busy} onClick={async () => { await action.run(async () => { const result = await post<{ workspaceId: string }>('/api/workspace/invitations/accept', { token }); await session.select(result.workspaceId); navigate('/app', { replace: true }); }, 'Invitation accepted.'); }}>Join workspace</Button></section>;
}
