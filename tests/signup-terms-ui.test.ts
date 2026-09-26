import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {registerHooks} from 'node:module';
import Auth from '../src/features/auth/Auth';
import AccountTermsRecord from '../src/features/settings/AccountTermsRecord';
import {currentTermsAcceptance} from '../src/features/auth/SignupTerms';
import {SessionProvider} from '../src/lib/session';
import type {SignupPolicy,SignupTermsAcceptance} from '../shared/signup-terms';

// Browser acceptance owns stylesheet/layout checks; these fixtures render real UI states offline.
const cssUrl=new URL('../src/features/settings/settings.css',import.meta.url).href;
const hooks=registerHooks({load(url,context,next){return url===cssUrl?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const Settings=await import('../src/features/settings/Settings').then(module=>module.default).finally(()=>hooks.deregister());
const workspace='signup-terms-ui',userId='owned-terms-reader';
const policy:SignupPolicy={version:'synthetic-v1',language:'en-IE',title:'Synthetic signup terms',text:'Synthetic fixture only.\nExact spacing:  two spaces.\n<script>alert("fixture")</script> & literal text.',url:'https://example.test/terms/v1',agreementText:'I agree to the synthetic signup terms.',sha256:'a'.repeat(64)};
const record={policy,acceptedAt:'2026-09-26T10:00:00.000Z',recordedAt:'2026-09-26T10:01:00.000Z',evidenceNotice:'This records signup acceptance, not email delivery, payment or a subscription.'};
type Options={surface?:'signup'|'signin'|'record'|'settings';terms?:unknown;termsState?:'loading'|'error'|'fetching';recordData?:unknown;recordState?:'loading'|'error';role?:'owner'|'admin'|'editor'|'viewer';signedIn?:boolean};
function render({surface='signup',terms={enabled:false,policy:null},termsState,recordData={record},recordState,role='viewer',signedIn=surface==='record'||surface==='settings'}:Options={}){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch=globalThis.fetch;let requests=0;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>workspace,setItem:()=>{throw new Error('No storage writes in this fixture');}}});
  globalThis.fetch=(async()=>{requests++;throw new Error('Network is forbidden in the signup UI fixture');}) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  client.setQueryData([workspace,'/api/config'],{preview:true,inviteRequired:false,hosted:true,emailVerification:{available:true,requiredForSignup:true}});
  client.setQueryData(['session',workspace],signedIn?{user:{id:userId,name:'Owned reader',email:'reader@example.test',emailVerifiedAt:null,emailVerificationRequired:false},workspace:{id:workspace,name:'Owned workspace',role},workspaces:[]}:null);
  // A fresh completed response, without SSR's optimistic stale-time-zero refetch.
  if(termsState!=='loading')client.setQueryData(['signup-terms'],terms,{updatedAt:Date.now()+60_000});
  if(termsState==='error')client.getQueryCache().find({queryKey:['signup-terms'],exact:true})!.setState({status:'error',error:new Error('PRIVATE policy configuration detail'),fetchStatus:'idle'});
  if(termsState==='fetching')client.getQueryCache().find({queryKey:['signup-terms'],exact:true})!.setState({fetchStatus:'fetching'});
  if(recordState!=='loading')client.setQueryData(['signup-terms-record',userId],recordData);
  if(recordState==='error')client.getQueryCache().find({queryKey:['signup-terms-record',userId],exact:true})!.setState({status:'error',error:new Error('PRIVATE personal record detail'),fetchStatus:'idle'});
  client.setQueryData([workspace,'/api/workspace/settings'],{workspace:{id:workspace,name:'Owned workspace',settings:{}},role,limits:{maxBytes:10*1024*1024,maxPages:30},authentication:{provider:'local-scrypt',emailVerification:true,passwordResetEmail:true}});
  try{
    const component=surface==='record'?createElement(AccountTermsRecord):surface==='settings'?createElement(Settings):createElement(Auth,{signUp:surface==='signup'});
    const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,{initialEntries:[surface==='settings'?'/app/settings?tab=account-terms':surface==='signup'?'/sign-up':'/sign-in']},createElement(SessionProvider,null,component))));
    assert.equal(requests,0);return html;
  }finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}
function button(html:string,label:string){const tag=html.match(new RegExp(`<button\\b([^>]*)>${label}`));assert.ok(tag,`Missing ${label}`);return tag[1];}

test('disabled signup terms preserve the ordinary signup form without fabricated consent',()=>{
  const html=render();assert.doesNotMatch(button(html,'Create workspace'),/disabled/);
  assert.doesNotMatch(html,/type="checkbox"|Signup terms|I agree|Read the signup terms/);
  assert.match(html,/Confirm your email before signing in/);
});

test('missing, failed, stale-error and malformed terms status block signup with safe recovery',()=>{
  const loading=render({termsState:'loading'});assert.match(button(loading,'Create workspace'),/disabled/);assert.match(loading,/Checking signup terms/);
  for(const options of [{termsState:'error',terms:{enabled:true,policy}},{terms:{enabled:false}},{terms:{enabled:true,policy:null}},{terms:{enabled:false,policy}},{terms:{enabled:'false',policy:null}}] as Options[]){
    const html=render(options);assert.match(button(html,'Create workspace'),/disabled/);assert.match(html,/Retry signup terms/);assert.doesNotMatch(html,/PRIVATE policy|Read the signup terms|I agree/);
  }
  const fetching=render({termsState:'fetching',terms:{enabled:true,policy}});assert.match(button(fetching,'Create workspace'),/disabled/);assert.match(fetching,/Checking the latest signup terms/);
});

test('enabled terms are unchecked, accessible literal text with a safe separate link and no privacy-consent claim',()=>{
  const html=render({terms:{enabled:true,policy}});assert.match(button(html,'Create workspace'),/disabled/);
  const checkbox=html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];assert.ok(checkbox);assert.match(checkbox,/required=""/);assert.doesNotMatch(checkbox,/checked=""/);
  assert.match(html,/<details[^>]*><summary>Read the signup terms<\/summary>/);
  assert.ok(html.includes('Exact spacing:  two spaces.\n&lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt; &amp; literal text.'));
  assert.match(html,/href="https:\/\/example.test\/terms\/v1"[^>]*rel="noopener noreferrer"/);
  assert.match(html,/Version synthetic-v1/);assert.match(html,/Language en-IE/);assert.match(html,/I agree to the synthetic signup terms/);
  assert.doesNotMatch(html,/<script>|privacy consent|consent to processing|aaaaaaaaaaaaaaaa/);
});

test('unsafe URLs, invalid content and malformed policy digests never become an actionable agreement',()=>{
  for(const change of [{url:'javascript:alert(1)'},{url:'https://user:password@example.test/'},{sha256:'bad'},{text:''},{language:'" onmouseover="x'},{text:'x'.repeat(16_001)}]){
    const html=render({terms:{enabled:true,policy:{...policy,...change}}});assert.match(button(html,'Create workspace'),/disabled/);assert.match(html,/Retry signup terms/);assert.doesNotMatch(html,/type="checkbox"|javascript:/);
  }
});

test('acceptance payload is bound to exact displayed version and digest and cannot cross disablement',()=>{
  const status={enabled:true as const,policy},consent:SignupTermsAcceptance={accepted:true,version:policy.version,sha256:policy.sha256};
  assert.deepEqual(currentTermsAcceptance(status,consent),consent);
  for(const changed of [{...status,policy:{...policy,version:'synthetic-v2'}},{...status,policy:{...policy,sha256:'b'.repeat(64)}},{enabled:false as const,policy:null},undefined])assert.equal(currentTermsAcceptance(changed,consent),undefined);
  assert.equal(currentTermsAcceptance(status,null),undefined);
  assert.equal(currentTermsAcceptance(status,{...consent,accepted:false} as unknown as SignupTermsAcceptance),undefined);
});

test('sign-in remains available when signup terms are loading, failed or malformed',()=>{
  for(const options of [{termsState:'loading'},{termsState:'error'},{terms:{enabled:true,policy:null}}] as Options[]){const html=render({...options,surface:'signin'});assert.doesNotMatch(button(html,'Sign in'),/disabled/);assert.doesNotMatch(html,/signup terms|Retry signup|type="checkbox"/);assert.match(html,/Forgot password/);}
});

test('every session role can view its own recorded policy independent of current signup configuration',()=>{
  for(const role of ['owner','admin','editor','viewer'] as const){
    const html=render({surface:'record',role,terms:{enabled:true,policy:null}});assert.match(html,/Your signup terms record/);assert.match(html,/Acceptance received/);assert.match(html,/Record saved/);
    assert.match(html,/dateTime="2026-09-26T10:00:00.000Z"/);assert.match(html,/dateTime="2026-09-26T10:01:00.000Z"/);
    assert.match(html,/Read the recorded signup terms/);assert.match(html,/Download signup terms record/);assert.match(html,/not email delivery, payment or a subscription/);assert.doesNotMatch(html,/<script>|type="checkbox"/);
  }
});

test('legacy no-record state does not invent acceptance, delivery, timestamps or downloads',()=>{
  const html=render({surface:'record',recordData:{record:null}});assert.match(html,/No signup terms acceptance record is available/);assert.match(html,/Earlier accounts may not have a record/);
  assert.doesNotMatch(html,/Acceptance received|Record saved|Download signup|<time|accepted your terms/i);
});

test('record read errors and malformed cached records show safe retry without exposing stale evidence',()=>{
  for(const options of [{recordState:'error'},{recordData:{record:{...record,acceptedAt:'not a timestamp'}}},{recordData:{record:{...record,policy:{...policy,url:'javascript:alert(1)'}}}}] as Options[]){
    const html=render({...options,surface:'record'});assert.match(html,/Retry account terms/);assert.doesNotMatch(html,/PRIVATE personal|Download signup|Read the recorded|<time/);
  }
  const loading=render({surface:'record',recordState:'loading'});assert.match(loading,/Loading your signup terms record/);assert.doesNotMatch(loading,/No signup terms acceptance/);
  const signedOut=render({surface:'record',signedIn:false});assert.match(signedOut,/Sign in to view your signup terms record/);assert.doesNotMatch(signedOut,/Synthetic signup|Download signup/);
});

test('personal account terms is its own settings tab for viewers, separate from Checkout and password forms',()=>{
  const html=render({surface:'settings',role:'viewer'});assert.match(html,/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>Account terms<\/button>/);
  assert.match(html,/Your signup terms record/);assert.doesNotMatch(html,/<form|Checkout terms records|Change your password|API keys/);
});
