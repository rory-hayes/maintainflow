import {useState} from 'react';
import {Link,useNavigate,useSearchParams} from 'react-router-dom';
import {ArrowRight,FileText,Table2,Check} from 'lucide-react';
import {post,useAction,useData} from '../../lib/api';
import {useSession} from '../../lib/session';
import {Button,Field,Notice} from '../../components/ui';

type Runtime={preview:boolean;inviteRequired:boolean;hosted:boolean;passwordRecovery?:{available:boolean};emailVerification?:{available:boolean;requiredForSignup:boolean}};
export function registrationNeedsEmail(response:unknown):response is {accepted:true;message:string}{return Boolean(response&&typeof response==='object'&&'accepted' in response&&response.accepted===true);}
export default function Auth({signUp=false}:{signUp?:boolean}){
  const [name,setName]=useState(''),[workspaceName,setWorkspaceName]=useState(''),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[inviteCode,setInviteCode]=useState('');
  const runtime=useData<Runtime>('/api/config');
  const action=useAction(),session=useSession(),navigate=useNavigate();const [params]=useSearchParams();
  const requestedNext=params.get('next')||'';
  const next=(requestedNext==='/invite'||requestedNext==='/app'||requestedNext.startsWith('/app/')||requestedNext.startsWith('/app?'))&&!requestedNext.includes('\\')?requestedNext:'';
  const destination=next||(signUp?`/app/parsers/new${params.get('sample')?'?sample=invoice':''}`:'/app');
  const otherAuthRoute=(signUp?'/sign-in':'/sign-up')+(params.size?`?${params.toString()}`:'');
  const observedVerification=runtime.data?.emailVerification;
  const verification=observedVerification&&typeof observedVerification.available==='boolean'&&typeof observedVerification.requiredForSignup==='boolean'?observedVerification:undefined;
  const registrationUnknown=signUp&&(!runtime.isSuccess||!verification);
  const registrationUnavailable=signUp&&Boolean(verification?.requiredForSignup&&!verification.available);
  const blocked=registrationUnknown||registrationUnavailable;
  const signupPolicy=!verification?'Account setup could not be confirmed. Please check again.':verification.requiredForSignup?'Confirm your email before signing in.':'Email verification is optional on this installation. Addresses are verified only after confirmation.';
  return <div className="auth-page"><header><Link to="/" className="wordmark">MaintainFlow</Link><Link className="link" to={otherAuthRoute}>{signUp?'Already have an account? Sign in':'Create an account'}</Link></header><main className="auth-main"><div className="auth-story"><h1>A little less paperwork.<br/><span>A lot more possibility.</span></h1><p>Your documents, fields and workflows together in one workspace.</p><div className="auth-flow"><FileText/><span/><Table2/><span/><Check/></div><p className="script-note">Let’s make room for better work.</p><p className="small">{runtime.data?.preview?'Private test preview. Accounts and documents are saved securely for testing.':'Your accounts and documents are saved on this installation.'}</p></div><section className="auth-form"><h2>{signUp?'Start your workspace':'Welcome back.'}</h2><p>{signUp?'Create an account and extract your first document.':'Sign in to pick up where you left off.'}</p>
    {signUp&&runtime.isPending?<p role="status">Checking account setup…</p>:signUp&&(runtime.isError||runtime.isSuccess&&!verification)?<><Notice error="We couldn’t check account setup. Please try again."/><Button type="button" variant="secondary" disabled={runtime.isFetching} onClick={()=>void runtime.refetch()}>Check again</Button></>:registrationUnavailable?<Notice error="New signups are temporarily unavailable because verification email cannot be sent. Existing accounts can still sign in."/>:null}
    <form onSubmit={event=>{event.preventDefault();if(blocked)return;void action.run(async()=>{
      const result=await post(signUp?'/api/auth/register':'/api/auth/login',signUp?{name,workspaceName,email,password,inviteCode}:{email,password});
      if(signUp&&registrationNeedsEmail(result)){
        setPassword('');setInviteCode('');
        navigate('/verify-email?next='+encodeURIComponent(destination),{replace:true,state:{registrationAccepted:true}});
        return;
      }
      if(!result?.workspace?.id)throw new Error('We couldn’t confirm your sign-in. Please try signing in again.');
      sessionStorage.setItem('folio.workspace',result.workspace.id);await session.refresh();navigate(destination,{replace:true});
    },'');}}>
      <Notice error={action.error}/>
      {signUp?<><Field label="Your name"><input required autoComplete="name" value={name} onChange={event=>setName(event.target.value)} maxLength={100}/></Field><Field label="Workspace name"><input required value={workspaceName} onChange={event=>setWorkspaceName(event.target.value)} placeholder="Your company or team" maxLength={100}/></Field></>:null}
      {signUp&&runtime.data?.inviteRequired?<Field label="Preview invite code" hint="Use the private code provided by the workspace owner."><input required type="password" autoComplete="off" value={inviteCode} onChange={event=>setInviteCode(event.target.value)} maxLength={256}/></Field>:null}
      <Field label="Email address"><input required type="email" autoComplete="email" maxLength={254} value={email} onChange={event=>setEmail(event.target.value)}/></Field>
      <Field label="Password" hint={signUp?'Use at least 10 characters.':undefined}><input required type="password" autoComplete={signUp?'new-password':'current-password'} minLength={signUp?10:undefined} maxLength={128} value={password} onChange={event=>setPassword(event.target.value)}/></Field>
      {!signUp?<p className="auth-recovery-link"><Link className="link" to="/forgot-password">Forgot password?</Link></p>:null}
      <Button disabled={action.busy||blocked} type="submit">{action.busy?'Please wait…':signUp?'Create workspace':'Sign in'}<ArrowRight/></Button>
    </form>
    {next==='/invite'?<p className="small">Use the email address your workspace invitation was created for. If you need to verify a new account, reopen the invitation after verification.</p>:null}
    <p className="small auth-footer">{signUp?(runtime.isSuccess?signupPolicy:'Account setup is being checked.'):'Sign in with your MaintainFlow account.'}</p>
    {!signUp?<p className="small"><Link className="link" to="/verify-email">Need a verification email?</Link></p>:null}
  </section></main></div>;
}
