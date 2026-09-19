import {useEffect,useRef,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {ArrowRight,UserPlus} from 'lucide-react';
import {Button,Notice,dateTime} from '../../components/ui';
import {ApiError,api,post} from '../../lib/api';
import {useSession} from '../../lib/session';
import {discardInvitationLink,useInvitationLink} from './invitation-link';

type Details={workspaceId:string;workspaceName:string;role:string;expiresAt:string;alreadyMember:boolean};
type State='loading'|'ready'|'invalid'|'wrong-account'|'unavailable'|'uncertain';
const signIn='/sign-in?next=%2Finvite',signUp='/sign-up?next=%2Finvite';
export default function Invite(){
  const link=useInvitationLink(),session=useSession(),navigate=useNavigate();
  const userId=session.data?.user.id;
  const [details,setDetails]=useState<Details|null>(null),[state,setState]=useState<State>('loading');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[joined,setJoined]=useState<(Details&{userId:string|undefined;linkVersion:number})|null>(null),[reload,setReload]=useState(0);
  const transition=useRef<symbol|null>(null),mounted=useRef(true);
  const active=useRef<AbortController|null>(null),feedback=useRef<HTMLDivElement>(null);
  const identity=useRef({version:link.version,userId});identity.current={version:link.version,userId};
  const confirmed=joined&&joined.userId===userId&&joined.linkVersion+1===link.version?joined:null;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;active.current?.abort();transition.current=null;};},[]);
  useEffect(()=>{
    active.current?.abort();active.current=null;transition.current=null;setBusy(false);setError('');setDetails(null);
    if(!link.token||!userId)return;
    setJoined(null);setState('loading');
    const controller=new AbortController(),version=link.version;active.current=controller;
    const timer=setTimeout(()=>controller.abort(),20_000);
    const current=()=>mounted.current&&active.current===controller&&identity.current.version===version&&identity.current.userId===userId;
    void api<Details>('/api/workspace/invitations/inspect',{method:'POST',body:JSON.stringify({token:link.token}),signal:controller.signal}).then(result=>{
      if(current()){setDetails(result);setState('ready');}
    }).catch(failure=>{
      if(!current())return;
      setState(failure instanceof ApiError&&failure.status===400?'invalid':failure instanceof ApiError&&failure.status===403?'wrong-account':'unavailable');
    }).finally(()=>{clearTimeout(timer);if(active.current===controller)active.current=null;});
    return()=>{controller.abort();if(active.current===controller)active.current=null;};
  },[link.version,userId,reload]);
  useEffect(()=>{if(error||joined||state!=='loading')feedback.current?.focus();},[error,joined,state]);
  async function join(){
    if(active.current||busy||!details||state!=='ready'||!link.token)return;
    const controller=new AbortController(),version=link.version,submittedUser=userId;active.current=controller;setBusy(true);setError('');
    const timer=setTimeout(()=>controller.abort(),20_000);
    const current=()=>mounted.current&&active.current===controller&&identity.current.version===version&&identity.current.userId===submittedUser;
    try{
      const result=await api<{workspaceId:string}>('/api/workspace/invitations/accept',{method:'POST',body:JSON.stringify({token:link.token}),signal:controller.signal});
      if(!current())return;
      if(result.workspaceId!==details.workspaceId){setState('uncertain');return;}
      setJoined({...details,userId:submittedUser,linkVersion:version});discardInvitationLink(version);void session.refresh().catch(()=>{});
    }catch(failure){
      if(!current())return;
      if(failure instanceof ApiError&&failure.status===400)setState('invalid');
      else if(failure instanceof ApiError&&failure.status===403)setState('wrong-account');
      else if(failure instanceof ApiError&&failure.status===429)setError('Too many attempts. Please wait a few minutes and try again.');
      else setState('uncertain');
    }finally{clearTimeout(timer);if(active.current===controller){active.current=null;setBusy(false);}}
  }
  async function openWorkspace(target:Details){
    if(busy||transition.current)return;
    const marker=Symbol(),version=link.version,operationUser=userId;transition.current=marker;setBusy(true);setError('');
    const current=()=>mounted.current&&transition.current===marker&&identity.current.version===version&&identity.current.userId===operationUser;
    try{await session.select(target.workspaceId);if(current()){discardInvitationLink(version);navigate('/app',{replace:true});}}
    catch{if(current())setError('We couldn’t open this workspace. Check your connection and try again. If you have not joined, reopen the original invitation.');}
    finally{if(current()){transition.current=null;setBusy(false);}}
  }
  async function switchAccount(){
    if(busy||transition.current)return;
    const marker=Symbol(),version=link.version,operationUser=userId;transition.current=marker;setBusy(true);setError('');
    const current=()=>mounted.current&&transition.current===marker&&identity.current.version===version&&identity.current.userId===operationUser;
    try{try{await post('/api/auth/logout');}catch(failure){if(!(failure instanceof ApiError&&failure.status===401))throw failure;}await session.refresh();if(mounted.current&&identity.current.version===version&&(!identity.current.userId||identity.current.userId===operationUser))navigate(signIn);}
    catch{if(current())setError('We couldn’t sign you out. Please try again.');}
    finally{if(current()){transition.current=null;setBusy(false);}}
  }
  return <div className="auth-page recovery-page invitation-page"><meta name="referrer" content="no-referrer"/><header><Link to="/" className="wordmark">Folio</Link><Link className="link" to={session.data?'/app':signIn}>Back to {session.data?'your workspace':'sign in'}</Link></header><main className="recovery-main"><section className="auth-form" aria-labelledby="invitation-title"><span className="recovery-icon" aria-hidden="true"><UserPlus size={26}/></span><h1 id="invitation-title">{confirmed?'Invitation accepted':'Join a workspace'}</h1>
    <div ref={feedback} className="recovery-feedback" tabIndex={-1}><Notice error={error}/></div>
    {confirmed?<><Notice message={`You have access to ${confirmed.workspaceName}.`}/><Button disabled={busy} onClick={()=>void openWorkspace(confirmed)}>Open workspace<ArrowRight size={18}/></Button></>:!link.token?<><Notice error="This page needs your invitation link. If you refreshed or left this tab, reopen the original invitation."/><p className="small">Invitations expire after seven days. Ask the workspace owner for a new link if yours has expired or been replaced.</p></>:session.loading?<p role="status">Checking your account…</p>:!session.data?<><p>Sign in with the email address that received this invitation.</p><Link className="button primary" to={signIn}>Sign in to continue<ArrowRight size={18}/></Link><p className="recovery-return"><Link className="link" to={signUp}>Create a Folio account</Link></p><p className="small recovery-disclosure">New accounts may need email verification. After verifying, reopen this invitation to join. Your invitation stays in memory while you sign in in this tab.</p></>:<>
      <p className="small">Signed in as <strong className="verification-address">{session.data.user.email}</strong>.</p>
      {state==='loading'?<p role="status">Checking your invitation…</p>:state==='invalid'?<Notice error="This invitation is invalid, expired, already used or replaced. Ask the workspace owner for a new invitation."/>:state==='wrong-account'?<Notice error="Sign in with the email address this invitation was created for."/>:state==='unavailable'?<><Notice error="We couldn’t check this invitation. Please try again."/><Button variant="secondary" onClick={()=>setReload(value=>value+1)}>Check invitation again</Button></>:state==='uncertain'?<><Notice error="We couldn’t confirm whether you joined. Check your workspace access before trying the invitation again."/>{details?<Button disabled={busy} onClick={()=>void openWorkspace(details)}>Check workspace access</Button>:null}</>:details?<><p>You’re invited to <strong>{details.workspaceName}</strong>.</p><dl className="invitation-details"><div><dt>Your role</dt><dd>{details.role}</dd></div><div><dt>Link expires</dt><dd>{dateTime(details.expiresAt)}</dd></div></dl>{details.alreadyMember?<p className="small">You already belong to this workspace. Accepting keeps your current role.</p>:<p className="small">Joining adds this workspace to your account. Your other workspaces stay available.</p>}<Button disabled={busy} onClick={()=>void join()}>{busy?'Joining…':'Join workspace'}<UserPlus size={18}/></Button></>:null}
      <p className="recovery-return"><button type="button" className="recovery-text-button" disabled={busy} onClick={()=>void switchAccount()}>Use a different account</button></p>
    </>}
  </section></main></div>;
}
