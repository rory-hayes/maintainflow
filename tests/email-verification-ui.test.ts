import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import Auth,{registrationNeedsEmail} from '../src/features/auth/Auth';
import EmailVerification,{EmailVerificationStatus,EmailVerificationPrompt,captureEmailVerificationLink,verificationPasswordError} from '../src/features/auth/EmailVerification';
import PasswordRecovery,{capturePasswordResetLink} from '../src/features/auth/PasswordRecovery';
import {SessionProvider} from '../src/lib/session';
import {registerHooks} from 'node:module';
// Node renders markup here; the browser acceptance validates the actual stylesheet.
const cssUrl=new URL('../src/features/settings/settings.css',import.meta.url).href;
const hooks=registerHooks({load(url,context,next){return url===cssUrl?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const Settings=await import('../src/features/settings/Settings').then(module=>module.default).finally(()=>hooks.deregister());

const syntheticToken='v'.repeat(43),workspace='verification-ui',userId='verification-viewer';
type Options={surface?:'signup'|'signin'|'request'|'confirm'|'status'|'prompt'|'settings'|'recovery';signedIn?:boolean;verified?:boolean;required?:boolean;available?:boolean;configuration?:'loading'|'error'|'missing'|'malformed';statusError?:boolean;registrationAccepted?:boolean};
function render({surface='request',signedIn=false,verified=false,required=true,available=true,configuration,statusError=false,registrationAccepted=false}:Options={}){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),previousFetch=globalThis.fetch;let calls=0;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>workspace,setItem:()=>{throw new Error('This static fixture cannot persist credentials');}}});
  globalThis.fetch=(async()=>{calls++;throw new Error('Network is forbidden in this component fixture');}) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  const configKey=[workspace,'/api/config'];
  if(configuration!=='loading')client.setQueryData(configKey,{preview:true,inviteRequired:false,passwordRecovery:{available},emailVerification:configuration==='missing'?undefined:configuration==='malformed'?{available:'yes'}:{available,requiredForSignup:required}});
  if(configuration==='error')client.getQueryCache().find({queryKey:configKey,exact:true})!.setState({status:'error',error:new Error('PRIVATE synthetic sender detail'),fetchStatus:'idle'});
  const verifiedAt=verified?'2026-09-14T08:30:00.000Z':null;
  client.setQueryData(['session',workspace],signedIn?{user:{id:userId,name:'Existing viewer',email:'viewer@example.test',emailVerifiedAt:verifiedAt,emailVerificationRequired:false},workspace:{id:workspace,name:'Existing workspace',role:'viewer'},workspaces:[]}:null);
  if(signedIn){const key=['email-verification',userId];client.setQueryData(key,{verified,verifiedAt,available});if(statusError)client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:'error',error:new Error('PRIVATE synthetic status detail'),fetchStatus:'idle'});}
  client.setQueryData([workspace,'/api/workspace/settings'],{workspace:{id:workspace,name:'Existing workspace',settings:{}},role:'viewer',limits:{maxBytes:10*1024*1024,maxPages:30},authentication:{provider:'local-scrypt',emailVerification:available,emailVerificationRequiredForSignup:required,passwordResetEmail:available}});
  const component=surface==='signup'||surface==='signin'?createElement(Auth,{signUp:surface==='signup'}):surface==='status'?createElement(EmailVerificationStatus):surface==='prompt'?createElement(EmailVerificationPrompt):surface==='settings'?createElement(Settings):surface==='recovery'?createElement(PasswordRecovery,{reset:true}):createElement(EmailVerification,{confirm:surface==='confirm'});
  const pathname=surface==='settings'?'/app/settings':surface==='confirm'?'/verify-email/confirm':surface==='signup'?'/sign-up':surface==='signin'?'/sign-in':'/verify-email';
  try{
    const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,{initialEntries:[{pathname,search:surface==='settings'?'?tab=password':'',state:registrationAccepted?{registrationAccepted:true}:null}]},createElement(SessionProvider,null,component))));assert.equal(calls,0);return html;
  }finally{client.clear();globalThis.fetch=previousFetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}
function capture(fragment:string,pathname='/verify-email/confirm',fail=false){const urls:unknown[]=[];captureEmailVerificationLink({location:{pathname,hash:fragment},history:{state:{idx:0},replaceState(_state,_title,url){if(fail)throw new Error('Synthetic history failure');urls.push(url);}}});return urls;}
function submit(html:string,label:string){const tag=html.match(new RegExp(`<button\\b([^>]*)>${label}`));assert.ok(tag);return tag[1];}

test('required signup distinguishes pending acceptance from sessions and blocks unavailable or unknown configuration',()=>{
  assert.equal(registrationNeedsEmail({accepted:true,message:'Generic acknowledgement'}),true);
  assert.equal(registrationNeedsEmail({user:{id:'existing'},workspace:{id:'existing'}}),false);
  assert.equal(registrationNeedsEmail(null),false);
  const enabled=render({surface:'signup'});assert.doesNotMatch(submit(enabled,'Create workspace'),/disabled/);assert.match(enabled,/Confirm your email before signing in/);
  const unavailable=render({surface:'signup',available:false});assert.match(submit(unavailable,'Create workspace'),/disabled/);assert.match(unavailable,/Existing accounts can still sign in/);
  for(const configuration of ['loading','error','missing','malformed'] as const){const html=render({surface:'signup',configuration});assert.match(submit(html,'Create workspace'),/disabled/);assert.doesNotMatch(html,/PRIVATE synthetic|Email verification is optional/);}
  const bypass=render({surface:'signup',required:false,available:false});assert.doesNotMatch(submit(bypass,'Create workspace'),/disabled/);assert.match(bypass,/Addresses are verified only after confirmation/);
});

test('accepted signup is generic even with an unrelated existing session and exposes no workspace or recipient assumption',()=>{
  const html=render({signedIn:true,registrationAccepted:true});assert.match(html,/Check your email/);assert.match(html,/If this address can be registered, a verification email will be sent shortly/);
  assert.doesNotMatch(html,/viewer@example.test|Your email address is verified|Back to your workspace/);assert.match(html,/Send again in 60s/);assert.match(html,/href="\/sign-in\?next=%2Fapp"/);
});

test('public resend does not claim sender availability from malformed or stale configuration',()=>{
  for(const configuration of ['error','missing','malformed'] as const){const html=render({configuration});assert.match(html,/couldn’t check email verification availability/);assert.match(submit(html,'Send verification email'),/disabled/);assert.doesNotMatch(html,/PRIVATE synthetic|Verification email is temporarily unavailable/);}
  const off=render({available:false});assert.match(off,/Verification email is temporarily unavailable/);assert.match(submit(off,'Send verification email'),/disabled/);
});

test('verification fragment capture is purpose-separated, removes query/fragment state and never renders its token',()=>{
  assert.deepEqual(capture('#token='+syntheticToken),['/verify-email/confirm']);const html=render({surface:'confirm',available:false,signedIn:true});
  assert.match(html,/Confirm your email address/);assert.match(html,/Use your existing password/);assert.match(html,/will not switch your signed-in account/);
  assert.match(html,/autoComplete="current-password"/);assert.doesNotMatch(html,/minLength="10"|new-password|viewer@example.test/);assert.doesNotMatch(html,new RegExp(syntheticToken));assert.doesNotMatch(html,/name="token"|type="hidden"|token=/);assert.doesNotMatch(submit(html,'Verify email'),/disabled/);
  assert.match(html,/<meta name="referrer" content="no-referrer"/);capture('');
  capturePasswordResetLink({location:{pathname:'/reset-password',hash:'#token='+'r'.repeat(43)},history:{state:null,replaceState(){}}});
  assert.deepEqual(capture('#token='+syntheticToken,'/reset-password'),[]);assert.doesNotMatch(render({surface:'confirm'}),/<form/);assert.match(render({surface:'recovery'}),/Choose a new password/);
  capturePasswordResetLink({location:{pathname:'/reset-password',hash:''},history:{state:null,replaceState(){}}});
});

test('missing, malformed, duplicate and unremovable verification links require reopening the original email',()=>{
  for(const fragment of ['', '#token=short', '#token='+'.'.repeat(43), '#token='+syntheticToken+'&token='+syntheticToken]){capture(fragment);const html=render({surface:'confirm'});assert.match(html,/reopen the original email link/);assert.doesNotMatch(html,/<form|type="password"/);assert.match(html,/Request a verification email/);}
  capture('#token='+syntheticToken);capture('');assert.doesNotMatch(render({surface:'confirm'}),/<form/);
  capture('#token='+syntheticToken,'/verify-email/confirm',true);assert.doesNotMatch(render({surface:'confirm'}),/<form/);
});

test('confirmation proof accepts existing short or spaced credentials and preserves sign-in creation-policy separation',()=>{
  for(const password of ['x','  ','short','a'.repeat(128)])assert.equal(verificationPasswordError(password),'');
  assert.match(verificationPasswordError(''),/Enter your Folio password/);assert.match(verificationPasswordError('a'.repeat(129)),/Enter your Folio password/);
  const signIn=render({surface:'signin',available:false});assert.doesNotMatch(signIn.match(/<input[^>]*type="password"[^>]*>/)?.[0]||'',/minLength/);assert.doesNotMatch(submit(signIn,'Sign in'),/disabled/);assert.match(signIn,/Need a verification email/);
  assert.match(render({surface:'signup'}),/minLength="10"/);
});

test('legacy viewers can request personal verification without losing workspace access or receiving fabricated timestamps',()=>{
  const html=render({surface:'status',signedIn:true});assert.match(html,/viewer@example.test/);assert.match(html,/Your existing workspace access is unchanged/);assert.doesNotMatch(submit(html,'Send verification email'),/disabled/);assert.match(html,/Check verification status/);assert.doesNotMatch(html,/Verified 14|Your email address is verified/);
  const prompt=render({surface:'prompt',signedIn:true});assert.match(prompt,/Verify email/);assert.doesNotMatch(prompt,/cannot access|Sign in/);
  const verified=render({surface:'status',signedIn:true,verified:true});assert.match(verified,/Your email address is verified/);assert.doesNotMatch(verified,/Send verification email/);assert.equal(render({surface:'prompt',signedIn:true,verified:true}),'');
  const stale=render({surface:'status',signedIn:true,statusError:true});assert.match(stale,/couldn’t check your email verification status/);assert.doesNotMatch(stale,/Send verification email|PRIVATE synthetic/);
});

test('personal verification controls remain outside the password form and are available to workspace viewers',()=>{
  const html=render({surface:'settings',signedIn:true});assert.match(html,/Your email address/);assert.match(html,/Change your password/);assert.match(html,/Send verification email/);assert.equal((html.match(/<form\b/g)||[]).length,1);assert.ok(html.indexOf('Send verification email')<html.indexOf('<form'));
});
