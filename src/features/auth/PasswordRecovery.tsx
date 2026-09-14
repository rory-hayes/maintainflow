import {useEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {Link} from 'react-router-dom';
import {ArrowRight,KeyRound,Mail} from 'lucide-react';
import {ApiError,api,useData} from '../../lib/api';
import {Button,Notice} from '../../components/ui';

const acceptedMessage='If an account uses this email, a password reset link will be sent shortly.';
const unavailableMessage='Password recovery is temporarily unavailable. Please try again later.';
const invalidLinkMessage='This reset link is invalid or has expired. Request a new link to continue.';
let pendingResetToken='';
const resetLinkListeners=new Set<(token:string)=>void>();
type ResetLocation={location:{pathname:string;hash:string};history:{state:unknown;replaceState:(data:unknown,unused:string,url?:string|URL|null)=>void}};

/** Run before the router starts so it never retains a token-bearing location. */
export function capturePasswordResetLink(browser:ResetLocation=window){
  pendingResetToken='';
  if(browser.location.pathname!=='/reset-password')return;
  const fragment=browser.location.hash;
  // Drop query parameters too: recovery has no redirect or query-token contract.
  try{browser.history.replaceState(browser.history.state,'','/reset-password');}catch{
    for(const receive of resetLinkListeners)receive('');
    return;
  }
  const parameters=new URLSearchParams(fragment.replace(/^#/,''));
  const tokens=parameters.getAll('token');
  if(tokens.length===1&&/^[A-Za-z0-9_-]{43}$/.test(tokens[0]))pendingResetToken=tokens[0];
  if(resetLinkListeners.size){
    const token=pendingResetToken;pendingResetToken='';
    for(const receive of resetLinkListeners)receive(token);
  }
}

export function recoveryPasswordError(password:string,confirmation:string){
  if(password.length<10)return 'Use at least 10 characters for your new password.';
  if(password.length>128)return 'Use no more than 128 characters for your new password.';
  if(password!==confirmation)return 'The passwords do not match. Enter the same password in both fields.';
  return '';
}

function useRecoveryPost(){
  const pending=useRef<AbortController|null>(null),mounted=useRef(true);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;pending.current?.abort();};},[]);
  async function run(path:string,body:unknown){
    if(pending.current)return;
    const controller=new AbortController();pending.current=controller;setBusy(true);
    const timeout=setTimeout(()=>controller.abort(),20_000);
    try{
      await api(path,{method:'POST',body:JSON.stringify(body),signal:controller.signal});
      if(mounted.current&&pending.current===controller)return {ok:true as const,status:200};
    }catch(error){
      if(mounted.current&&pending.current===controller)return {ok:false as const,status:error instanceof ApiError?error.status:0};
    }finally{
      clearTimeout(timeout);if(pending.current===controller){pending.current=null;if(mounted.current)setBusy(false);}
    }
  }
  function cancel(){pending.current?.abort();pending.current=null;if(mounted.current)setBusy(false);}
  return {busy,run,cancel};
}

function RecoveryLayout({title,description,children}:{title:string;description:string;children:ReactNode}){
  return <div className="auth-page recovery-page"><meta name="referrer" content="no-referrer"/><header><Link to="/" className="wordmark">Folio</Link><Link className="link" to="/sign-in" rel="noreferrer">Back to sign in</Link></header><main className="recovery-main"><section className="auth-form" aria-labelledby="recovery-title"><span className="recovery-icon" aria-hidden="true"><KeyRound size={26}/></span><h1 id="recovery-title">{title}</h1><p>{description}</p>{children}</section></main></div>;
}

function RequestPasswordReset(){
  const runtime=useData<{passwordRecovery?:{available:boolean}}>('/api/config');
  const [email,setEmail]=useState(''),[error,setError]=useState(''),[accepted,setAccepted]=useState(false),[senderUnavailable,setSenderUnavailable]=useState(false);
  const emailInput=useRef<HTMLInputElement>(null),feedback=useRef<HTMLDivElement>(null),availabilityFeedback=useRef<HTMLDivElement>(null);
  const request=useRecoveryPost();
  const ready=runtime.isSuccess&&runtime.data.passwordRecovery?.available===true&&!senderUnavailable;
  useEffect(()=>{if(ready&&!accepted)emailInput.current?.focus();},[ready,accepted]);
  useEffect(()=>{if(senderUnavailable)availabilityFeedback.current?.focus();else if(error||accepted)feedback.current?.focus();},[error,accepted,senderUnavailable]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(request.busy||!ready)return;setError('');
    const result=await request.run('/api/auth/password-reset/request',{email:email.trim()});
    if(!result)return;
    if(result.ok){setEmail('');setAccepted(true);return;}
    if(result.status===503){setSenderUnavailable(true);return;}
    setError(result.status===400?'Enter a valid email address.':result.status===429?'Too many attempts. Please wait a few minutes and try again.':'We couldn’t request a reset link. Please try again.');
  }
  return <RecoveryLayout title={accepted?'Check your email':'Forgot your password?'} description={accepted?'Follow the link in the email to choose a new password.':'Enter the email address you use for Folio.'}>
    {accepted?<><div ref={feedback} tabIndex={-1} className="recovery-feedback"><Notice message={acceptedMessage}/></div><p className="small">The link expires after 30 minutes. Check your spam folder if it does not arrive.</p><p className="small">If you entered a different address, you can <button type="button" className="recovery-text-button" onClick={()=>setAccepted(false)}>try another email</button>.</p></>:<>
      {runtime.isPending?<p role="status">Checking password recovery…</p>:runtime.isError?<div className="recovery-feedback"><Notice error="We couldn’t check password recovery availability."/><Button variant="secondary" type="button" disabled={runtime.isFetching} onClick={()=>{void runtime.refetch();}}>{runtime.isFetching?'Checking…':'Try again'}</Button></div>:!ready?<div ref={availabilityFeedback} tabIndex={-1} className="recovery-feedback"><Notice error={unavailableMessage}/></div>:null}
      <form onSubmit={submit} aria-busy={request.busy}>
        <div ref={feedback} tabIndex={-1} className="recovery-feedback"><Notice error={error}/></div>
        <label className="field"><span>Email address</span><input ref={emailInput} type="email" required autoComplete="email" maxLength={254} value={email} onChange={event=>{setEmail(event.target.value);setError('');}} disabled={!ready||request.busy}/></label>
        <Button type="submit" disabled={!ready||request.busy}>{request.busy?'Requesting link…':'Send reset link'}<Mail size={18}/></Button>
      </form>
    </>}
    <p className="recovery-return"><Link className="link" to="/sign-in" rel="noreferrer">Back to sign in</Link></p>
  </RecoveryLayout>;
}

function ResetPassword(){
  const token=useRef(pendingResetToken),passwordInput=useRef<HTMLInputElement>(null),feedback=useRef<HTMLDivElement>(null);
  const [password,setPassword]=useState(''),[confirmation,setConfirmation]=useState(''),[error,setError]=useState('');
  const [state,setState]=useState<'ready'|'missing'|'invalid'|'uncertain'|'complete'>(()=>pendingResetToken?'ready':'missing');
  const request=useRecoveryPost();
  // Clearing after mount keeps React Strict Mode's two initial renders safe.
  useEffect(()=>{
    pendingResetToken='';passwordInput.current?.focus();
    const receive=(nextToken:string)=>{
      request.cancel();token.current=nextToken;setPassword('');setConfirmation('');setError('');setState(nextToken?'ready':'missing');
    };
    resetLinkListeners.add(receive);
    return()=>{resetLinkListeners.delete(receive);};
  },[]);
  useEffect(()=>{if(error||state!=='ready')feedback.current?.focus();},[error,state]);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(request.busy||state!=='ready')return;
    const validation=recoveryPasswordError(password,confirmation);
    if(validation){setError(validation);return;}
    setError('');
    const submittedToken=token.current;
    const result=await request.run('/api/auth/password-reset/complete',{token:submittedToken,newPassword:password});
    if(!result||token.current!==submittedToken)return;
    if(result.ok){token.current='';setPassword('');setConfirmation('');setState('complete');return;}
    if(result.status===400){token.current='';setPassword('');setConfirmation('');setState('invalid');return;}
    if(result.status===429){setError('Too many attempts. Please wait a few minutes and try again.');return;}
    if(result.status===403){setError('This request could not be completed. Open the original reset link and try again.');return;}
    token.current='';setPassword('');setConfirmation('');setState('uncertain');
  }
  return <RecoveryLayout title={state==='complete'?'Password changed':state==='missing'||state==='invalid'?'Open a reset link':'Choose a new password'} description={state==='complete'?'You can now sign in with your new password.':state==='missing'||state==='invalid'?'Use the link from your password reset email to continue.':'Use a password you do not use for any other account.'}>
    {state==='complete'?<><div ref={feedback} tabIndex={-1} className="recovery-feedback"><Notice message="Your password has been changed. All browser sessions have been signed out."/></div><p className="small">API keys remain active. You can revoke them separately in Settings after signing in.</p><Link className="button primary" to="/sign-in" rel="noreferrer">Sign in<ArrowRight size={18}/></Link></>:state==='missing'||state==='invalid'?<><div ref={feedback} tabIndex={-1} className="recovery-feedback"><Notice error={state==='invalid'?invalidLinkMessage:'This page needs the link from your reset email. If you refreshed or left this page, reopen the original email link.'}/></div><Link className="button primary" to="/forgot-password" rel="noreferrer">Request a new link</Link></>:state==='uncertain'?<><div ref={feedback} tabIndex={-1} className="recovery-feedback"><Notice error="We couldn’t confirm whether your password changed. Try signing in with your new password, or request a new reset link."/></div><Link className="button primary" to="/sign-in" rel="noreferrer">Try signing in</Link><p className="recovery-return"><Link className="link" to="/forgot-password" rel="noreferrer">Request a new link</Link></p></>:<form onSubmit={submit} noValidate aria-busy={request.busy}>
      <div ref={feedback} tabIndex={-1} className="recovery-feedback"><Notice error={error}/></div>
      <label className="field"><span>New password</span><input ref={passwordInput} type="password" required autoComplete="new-password" minLength={10} maxLength={128} value={password} onChange={event=>{setPassword(event.target.value);setError('');}} disabled={request.busy} aria-describedby="reset-password-guidance"/><small id="reset-password-guidance">Use 10–128 characters. Spaces are allowed.</small></label>
      <label className="field"><span>Confirm new password</span><input type="password" required autoComplete="new-password" minLength={10} maxLength={128} value={confirmation} onChange={event=>{setConfirmation(event.target.value);setError('');}} disabled={request.busy}/></label>
      <Button type="submit" disabled={request.busy}>{request.busy?'Changing password…':'Change password'}<ArrowRight size={18}/></Button>
      <p className="small recovery-disclosure">Changing your password signs out all browser sessions. API keys remain separately revocable in Settings.</p>
    </form>}
  </RecoveryLayout>;
}

export default function PasswordRecovery({reset=false}:{reset?:boolean}){return reset?<ResetPassword/>:<RequestPasswordReset/>;}
