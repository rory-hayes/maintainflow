import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import Auth from '../src/features/auth/Auth';
import PasswordRecovery,{capturePasswordResetLink,recoveryPasswordError} from '../src/features/auth/PasswordRecovery';

const syntheticToken='a'.repeat(43);
type Availability='enabled'|'disabled'|'loading'|'stale-error';
function render({reset=false,availability='enabled',auth}:{reset?:boolean;availability?:Availability;auth?:'sign-in'|'sign-up'}={}){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),previousFetch=globalThis.fetch;
  let calls=0;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>'',setItem:()=>{throw new Error('Recovery cannot write browser storage');}}});
  globalThis.fetch=(async()=>{calls++;throw new Error('Network is forbidden in this UI fixture');}) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  const key=['','/api/config'];
  if(availability!=='loading')client.setQueryData(key,{preview:true,inviteRequired:false,hosted:false,passwordRecovery:{available:availability!=='disabled'}});
  if(availability==='stale-error')client.getQueryCache().find({queryKey:key,exact:true})!.setState({status:'error',error:new Error('Sensitive synthetic provider detail'),fetchStatus:'idle'});
  const route=auth?`/${auth}`:reset?'/reset-password':'/forgot-password';
  try{
    const component=auth?createElement(Auth,{signUp:auth==='sign-up'}):createElement(PasswordRecovery,{reset});
    const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,{initialEntries:[route]},component)));
    assert.equal(calls,0);return html;
  }finally{
    client.clear();globalThis.fetch=previousFetch;
    if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');
  }
}
function capture(hash:string,pathname='/reset-password',fail=false){
  const changes:Array<{state:unknown;url:string|URL|null|undefined}>=[];
  const originalState={idx:0};
  capturePasswordResetLink({location:{pathname,hash},history:{state:originalState,replaceState(state,_title,url){if(fail)throw new Error('Synthetic history failure');changes.push({state,url});}}});
  return changes;
}
function requestButton(html:string){const button=html.match(/<button\b([^>]*)>Send reset link/);assert.ok(button);return button[1];}

test('direct fragment capture removes the token before rendering, without putting it in form values or links',()=>{
  const changes=capture(`#token=${syntheticToken}`);
  assert.deepEqual(changes,[{state:{idx:0},url:'/reset-password'}]);
  const html=render({reset:true});
  assert.match(html,/Choose a new password/);
  assert.equal((html.match(/type="password"/g)||[]).length,2);
  assert.equal((html.match(/autoComplete="new-password"/g)||[]).length,2);
  assert.match(html,/Use 10–128 characters\. Spaces are allowed\./);
  assert.match(html,/aria-describedby="reset-password-guidance"/);
  assert.doesNotMatch(html,new RegExp(syntheticToken));
  assert.doesNotMatch(html,/type="hidden"|name="token"|#token=|token=/);
  assert.match(html,/<meta name="referrer" content="no-referrer"/);
  assert.match(html,/API keys remain separately revocable in Settings/);
  capture('');
});

test('missing, malformed and duplicate fragment tokens expose only reopen-email recovery; query parameters cannot supply a token',()=>{
  for(const fragment of ['', '#token=short', `#token=${'a'.repeat(44)}`, `#token=${syntheticToken}&token=${syntheticToken}`, '#token=%00', '#token='+'.'.repeat(43), '#next=https://example.test']){
    assert.equal(capture(fragment)[0].url,'/reset-password');
    const html=render({reset:true});
    assert.match(html,/reopen the original email link/);
    assert.match(html,/href="\/forgot-password"/);
    assert.doesNotMatch(html,/<form|type="password"|Change password/);
  }
  // A reload sees the cleaned path with no fragment and cannot recover a token.
  capture(`#token=${syntheticToken}`);capture('');
  assert.match(render({reset:true}),/This page needs the link from your reset email/);
});

test('capture fails closed if history cannot be cleared and does not rewrite other app routes',()=>{
  capture(`#token=${syntheticToken}`,'/reset-password',true);
  assert.doesNotMatch(render({reset:true}),/<form/);
  assert.deepEqual(capture(`#token=${syntheticToken}`,'/sign-in'),[]);
  assert.doesNotMatch(render({reset:true}),/<form/);
});

test('forgot password checks configured availability and refuses stale enabled status after a fetch error',()=>{
  for(const availability of ['loading','disabled','stale-error'] as const){
    const html=render({availability});
    assert.match(requestButton(html),/disabled=""/);
    assert.match(html,availability==='loading'?/Checking password recovery/:availability==='disabled'?/Password recovery is temporarily unavailable/:/We couldn’t check password recovery availability/);
    assert.doesNotMatch(html,/Sensitive synthetic provider detail/);
  }
  assert.match(render({availability:'stale-error'}),/>Try again<\/button>/);
});

test('available recovery accepts an email while an existing reset link works without sender availability',()=>{
  const request=render();
  assert.doesNotMatch(requestButton(request),/disabled/);
  assert.match(request,/<input[^>]*type="email"[^>]*required=""[^>]*autoComplete="email"[^>]*maxLength="254"/);
  assert.match(request,/href="\/sign-in"/);
  capture(`#token=${syntheticToken}`);
  const reset=render({reset:true,availability:'disabled'});
  assert.match(reset,/<form/);assert.doesNotMatch(reset,/temporarily unavailable|disabled=""/);
  capture('');
});

test('new-password guidance enforces length and exact confirmation without trimming or inventing composition rules',()=>{
  assert.equal(recoveryPasswordError('123456789','123456789'),'Use at least 10 characters for your new password.');
  assert.equal(recoveryPasswordError('a'.repeat(129),'a'.repeat(129)),'Use no more than 128 characters for your new password.');
  assert.match(recoveryPasswordError('long password ','long password'),/do not match/);
  for(const password of ['1234567890','a'.repeat(128),'  password  ','🌸'.repeat(5)])assert.equal(recoveryPasswordError(password,password),'');
});

test('sign-in exposes recovery without a creation-length rule; signup retains its separate password guidance',()=>{
  const signIn=render({auth:'sign-in'});
  assert.match(signIn,/href="\/forgot-password"[^>]*>Forgot password\?/);
  const signInPassword=signIn.match(/<input[^>]*type="password"[^>]*>/)?.[0];
  assert.ok(signInPassword);assert.match(signInPassword,/autoComplete="current-password"/);assert.doesNotMatch(signInPassword,/minLength/);
  const signUp=render({auth:'sign-up'});
  assert.match(signUp,/Use at least 10 characters/);assert.match(signUp,/minLength="10"/);
  assert.match(signUp,/Email verification is not enabled yet/);
  assert.doesNotMatch(signUp,/Forgot password\?|Email verification and recovery are not enabled|Password recovery is currently unavailable/);
  assert.match(render({auth:'sign-up',availability:'disabled'}),/Password recovery is currently unavailable/);
});
