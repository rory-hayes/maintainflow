import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {Link,useLocation,useSearchParams} from 'react-router-dom';
import {useQuery} from '@tanstack/react-query';
import {ArrowRight,Mail,ShieldCheck} from 'lucide-react';
import {ApiError,api,useData} from '../../lib/api';
import {useSession} from '../../lib/session';
import {Button,Notice,dateTime} from '../../components/ui';

const requestMessage='If this email belongs to an account awaiting verification, a verification link will be sent shortly.';
const registrationMessage='If this address can be registered, a verification email will be sent shortly.';
const failedProof='We could not verify your email. Check your password, or request a new verification link.';
const unavailableMessage='Verification email is temporarily unavailable. Please try again later.';
type VerificationStatus={verified:boolean;verifiedAt:string|null;available:boolean};
type LinkLocation={location:{pathname:string;hash:string};history:{state:unknown;replaceState:(data:unknown,unused:string,url?:string|URL|null)=>void}};
let pendingVerificationToken='';
const verificationListeners=new Set<(token:string)=>void>();

/** This purpose has its own memory slot and exact route, separate from recovery. */
export function captureEmailVerificationLink(browser:LinkLocation=window){
  pendingVerificationToken='';
  if(browser.location.pathname!=='/verify-email/confirm')return;
  const fragment=browser.location.hash;
  try{browser.history.replaceState(browser.history.state,'','/verify-email/confirm');}catch{
    for(const receive of verificationListeners)receive('');return;
  }
  const tokens=new URLSearchParams(fragment.replace(/^#/, '')).getAll('token');
  if(tokens.length===1&&/^[A-Za-z0-9_-]{43}$/.test(tokens[0]))pendingVerificationToken=tokens[0];
  if(verificationListeners.size){const token=pendingVerificationToken;pendingVerificationToken='';for(const receive of verificationListeners)receive(token);}
}
export function verificationPasswordError(password:string){return password.length>=1&&password.length<=128?'': 'Enter your Folio password to verify your email.';}
function safeNext(value:string){return(value==='/invite'||value==='/app'||value.startsWith('/app/')||value.startsWith('/app?'))&&!value.includes('\\')?value:'/app';}
function useVerificationPost(){
  const pending=useRef<AbortController|null>(null),mounted=useRef(true);const [busy,setBusy]=useState(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;pending.current?.abort();};},[]);
  async function run(path:string,body:unknown){
    if(pending.current)return;
    const controller=new AbortController();pending.current=controller;setBusy(true);const timeout=setTimeout(()=>controller.abort(),20_000);
    try{await api(path,{method:'POST',body:JSON.stringify(body),signal:controller.signal});if(mounted.current&&pending.current===controller)return {ok:true as const,status:200};}
    catch(error){if(mounted.current&&pending.current===controller)return {ok:false as const,status:error instanceof ApiError?error.status:0};}
    finally{clearTimeout(timeout);if(pending.current===controller){pending.current=null;if(mounted.current)setBusy(false);}}
  }
  function cancel(){pending.current?.abort();pending.current=null;if(mounted.current)setBusy(false);}
  return {busy,run,cancel};
}
function useResendCooldown(initial=false){
  const [until,setUntil]=useState(()=>initial?Date.now()+60_000:0),[now,setNow]=useState(Date.now);
  useEffect(()=>{if(!until)return;const timer=setInterval(()=>{const current=Date.now();setNow(current);if(current>=until)clearInterval(timer);},1000);return()=>clearInterval(timer);},[until]);
  return {remaining:Math.max(0,Math.ceil((until-now)/1000)),start:()=>{const current=Date.now();setNow(current);setUntil(current+60_000);}};
}
function VerificationLayout({title,description,children}:{title:string;description:string;children:ReactNode}){
  return <div className="auth-page recovery-page verification-page"><meta name="referrer" content="no-referrer"/><header><Link to="/" className="wordmark">Folio</Link><Link className="link" to="/sign-in" rel="noreferrer">Back to sign in</Link></header><main className="recovery-main"><section className="auth-form" aria-labelledby="verification-title"><span className="recovery-icon" aria-hidden="true"><ShieldCheck size={26}/></span><h1 id="verification-title">{title}</h1><p>{description}</p>{children}</section></main></div>;
}

function PublicVerificationRequest({registrationAccepted=false}:{registrationAccepted?:boolean}){
  const runtime=useData<{emailVerification?:{available:boolean;requiredForSignup:boolean}}>('/api/config');
  const [params]=useSearchParams();const signIn='/sign-in?next='+encodeURIComponent(safeNext(params.get('next')||''));
  const [email,setEmail]=useState(''),[accepted,setAccepted]=useState(registrationAccepted),[error,setError]=useState(''),[unavailable,setUnavailable]=useState(false);
  const feedback=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null);const action=useVerificationPost(),cooldown=useResendCooldown(registrationAccepted);
  const availability=runtime.isSuccess&&typeof runtime.data.emailVerification?.available==='boolean'?runtime.data.emailVerification.available:undefined;
  const ready=availability===true&&!unavailable;
  useEffect(()=>{if(ready&&!accepted)input.current?.focus();},[ready,accepted]);
  useEffect(()=>{if(error||accepted||unavailable)feedback.current?.focus();},[error,accepted,unavailable]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(!ready||action.busy||cooldown.remaining)return;setError('');
    const result=await action.run('/api/auth/email-verification/request',{email:email.trim()});if(!result)return;
    if(result.ok){setAccepted(true);cooldown.start();return;}
    if(result.status===503){setUnavailable(true);return;}
    setError(result.status===400?'Enter a valid email address.':result.status===429?'Too many attempts. Please wait a few minutes and try again.':'We couldn’t confirm your email request. Please try again later.');
  }
  return <VerificationLayout title={accepted?'Check your email':'Verify your email address'} description={accepted?'Open the verification link and enter your Folio password to confirm your address.':'Enter your account email to request a verification link.'}>
    <div ref={feedback} className="recovery-feedback" tabIndex={-1}><Notice error={error||((unavailable||availability===false)?unavailableMessage:'')} message={accepted?(registrationAccepted?registrationMessage:requestMessage):undefined}/></div>
    {accepted?<p className="small">Links expire after 24 hours. Check your spam folder. You can sign in once your account is verified.</p>:null}
    {runtime.isPending?<p role="status">Checking verification availability…</p>:runtime.isError||runtime.isSuccess&&availability===undefined?<><Notice error="We couldn’t check email verification availability."/><Button type="button" variant="secondary" disabled={runtime.isFetching} onClick={()=>void runtime.refetch()}>Check again</Button></>:null}
    <form onSubmit={submit} aria-busy={action.busy}>
      <label className="field"><span>Email address</span><input ref={input} required type="email" autoComplete="email" maxLength={254} value={email} disabled={!ready||action.busy} onChange={event=>{setEmail(event.target.value);setError('');}}/></label>
      <Button type="submit" disabled={!ready||action.busy||cooldown.remaining>0}>{action.busy?'Requesting email…':cooldown.remaining?`Send again in ${cooldown.remaining}s`:accepted?'Resend verification email':'Send verification email'}<Mail size={18}/></Button>
    </form>
    <p className="small recovery-disclosure">Requesting another email does not change your password or sign you in.</p>
    <p className="recovery-return"><Link className="link" to={signIn} rel="noreferrer">Sign in</Link></p>
  </VerificationLayout>;
}

export function EmailVerificationStatus(){
  const session=useSession(),user=session.data?.user;
  const status=useQuery<VerificationStatus>({queryKey:['email-verification',user?.id],queryFn:({signal})=>api('/api/auth/email-verification',{signal}),enabled:Boolean(user),retry:false,staleTime:0});
  const action=useVerificationPost(),cooldown=useResendCooldown();
  const [message,setMessage]=useState(''),[error,setError]=useState(''),[unavailable,setUnavailable]=useState(false);const feedback=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(message||error||unavailable)feedback.current?.focus();},[message,error,unavailable]);
  if(!user)return <p><Link className="link" to="/sign-in">Sign in to check your email verification status.</Link></p>;
  async function request(){
    if(!user||!status.isSuccess||!status.data.available||status.data.verified||action.busy||cooldown.remaining)return;
    setError('');setMessage('');const result=await action.run('/api/auth/email-verification/request',{email:user.email});if(!result)return;
    if(result.ok){setMessage(requestMessage);cooldown.start();return;}
    if(result.status===503){setUnavailable(true);return;}
    setError(result.status===429?'Too many attempts. Please wait a few minutes and try again.':'We couldn’t confirm your email request. Check your status or try again later.');
  }
  return <section className="verification-status" aria-labelledby="account-email-heading"><h2 id="account-email-heading">Your email address</h2><p className="verification-address">{user.email}</p>
    {status.isPending?<p role="status">Checking verification status…</p>:status.isError?<Notice error="We couldn’t check your email verification status."/>:status.data.verified?<><Notice message="Your email address is verified."/>{status.data.verifiedAt?<p className="small">Verified {dateTime(status.data.verifiedAt)}</p>:null}</>:<><p>Your email address has not been verified. Your existing workspace access is unchanged.</p>{!status.data.available||unavailable?<Notice error={unavailableMessage}/>:null}<Button type="button" disabled={!status.data.available||unavailable||action.busy||cooldown.remaining>0} onClick={()=>void request()}>{action.busy?'Requesting email…':cooldown.remaining?`Send again in ${cooldown.remaining}s`:'Send verification email'}<Mail size={18}/></Button></>}
    <div ref={feedback} className="recovery-feedback" tabIndex={-1}><Notice error={error} message={message}/></div>
    <Button type="button" variant="secondary" aria-label="Check verification status" disabled={status.isFetching||action.busy} onClick={()=>{setMessage('');setError('');setUnavailable(false);void status.refetch().then(()=>session.refresh());}}>{status.isFetching?'Checking…':'Check verification status'}</Button>
  </section>;
}
export function EmailVerificationPrompt(){const {data}=useSession();if(!data||data.user.emailVerifiedAt!==null)return null;return <aside className="verification-banner" role="note"><span>Your email address has not been verified.</span><Link className="link" to="/verify-email">Verify email</Link></aside>;}

function ConfirmEmail(){
  const session=useSession(),token=useRef(pendingVerificationToken),input=useRef<HTMLInputElement>(null),feedback=useRef<HTMLDivElement>(null);
  const [password,setPassword]=useState(''),[error,setError]=useState(''),[state,setState]=useState<'ready'|'missing'|'complete'|'uncertain'>(()=>pendingVerificationToken?'ready':'missing');const action=useVerificationPost();
  useEffect(()=>{
    pendingVerificationToken='';input.current?.focus();
    const receive=(value:string)=>{action.cancel();token.current=value;setPassword('');setError('');setState(value?'ready':'missing');};verificationListeners.add(receive);return()=>{verificationListeners.delete(receive);};
  },[]);
  useEffect(()=>{if(error||state!=='ready')feedback.current?.focus();},[error,state]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(action.busy||state!=='ready')return;const invalid=verificationPasswordError(password);if(invalid){setError(invalid);return;}
    setError('');const submittedToken=token.current,result=await action.run('/api/auth/email-verification/complete',{token:submittedToken,password});if(!result||submittedToken!==token.current)return;setPassword('');
    if(result.ok){token.current='';setState('complete');void session.refresh().catch(()=>{});return;}
    if(result.status===400){setError(failedProof);return;}
    if(result.status===429){setError('Too many attempts. Please wait a few minutes and try again.');return;}
    if(result.status===403){setError('This request could not be completed. Reopen the original verification email and try again.');return;}
    token.current='';setState('uncertain');
  }
  return <VerificationLayout title={state==='complete'?'Email verified':state==='missing'?'Open a verification link':'Confirm your email address'} description={state==='complete'?'You can now sign in with your Folio password.':state==='missing'?'Use the link from your verification email to continue.':'Enter the password for the account that received this verification email.'}>
    {state==='complete'?<><div ref={feedback} className="recovery-feedback" tabIndex={-1}><Notice message="Your email address is verified. Browser sessions for that account have been signed out."/></div><p className="small">Your password is unchanged. API keys remain separately revocable in Settings.</p><Link className="button primary" to="/sign-in" rel="noreferrer">Sign in<ArrowRight size={18}/></Link></>:state==='missing'?<><div ref={feedback} className="recovery-feedback" tabIndex={-1}><Notice error="This page needs the link from your verification email. If you refreshed or left this page, reopen the original email link."/></div><Link className="button primary" to="/verify-email" rel="noreferrer">Request a verification email</Link></>:state==='uncertain'?<><div ref={feedback} className="recovery-feedback" tabIndex={-1}><Notice error="We couldn’t confirm whether verification finished. Try signing in. If you still cannot sign in, reopen the original email or request a new verification link."/></div><Link className="button primary" to="/sign-in" rel="noreferrer">Try signing in</Link><p className="recovery-return"><Link className="link" to="/verify-email" rel="noreferrer">Check status or request an email</Link></p></>:<form onSubmit={submit} noValidate aria-busy={action.busy}>
      <div ref={feedback} className="recovery-feedback" tabIndex={-1}><Notice error={error}/></div>
      <label className="field"><span>Your Folio password</span><input ref={input} type="password" autoComplete="current-password" required maxLength={128} value={password} disabled={action.busy} onChange={event=>{setPassword(event.target.value);setError('');}} aria-describedby="verification-password-hint"/><small id="verification-password-hint">Use your existing password. Confirming this link will not switch your signed-in account.</small></label>
      <Button type="submit" disabled={action.busy}>{action.busy?'Verifying…':'Verify email'}<ShieldCheck size={18}/></Button>
      <p className="small recovery-disclosure">Verification signs out browser sessions for the account being verified.</p>
      <p className="recovery-return"><Link className="link" to="/forgot-password" rel="noreferrer">Forgot password?</Link></p><p className="recovery-return"><Link className="link" to="/verify-email" rel="noreferrer">Request a new verification link</Link></p>
    </form>}
  </VerificationLayout>;
}
export default function EmailVerification({confirm=false}:{confirm?:boolean}){const session=useSession(),location=useLocation();if(confirm)return <ConfirmEmail/>;if(location.state?.registrationAccepted===true)return <PublicVerificationRequest registrationAccepted/>;if(session.loading)return <VerificationLayout title="Email verification" description="Checking your account…"><p role="status">Please wait…</p></VerificationLayout>;return session.data?<VerificationLayout title="Email verification" description="Check and confirm the email address for your current account."><EmailVerificationStatus/><p className="recovery-return"><Link className="link" to="/app">Back to your workspace</Link></p></VerificationLayout>:<PublicVerificationRequest/>;}
