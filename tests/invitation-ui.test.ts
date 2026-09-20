import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {SessionProvider} from '../src/lib/session';
import Invite from '../src/features/settings/Invite';
import Auth from '../src/features/auth/Auth';
import {captureInvitationLink,discardInvitationLink,useInvitationLink} from '../src/features/settings/invitation-link';
const token='i'.repeat(43),workspace='invitation-ui-owned';
function capture(hash:string,pathname='/invite',search='',fail=false){
 const changes:unknown[]=[];
 captureInvitationLink({location:{pathname,hash,search},history:{state:{idx:0},replaceState(_state,_title,url){if(fail)throw new Error('Synthetic history failure');changes.push(url);}}});return changes;
}
function render({signedIn=false,auth,route='/invite'}:{signedIn?:boolean;auth?:'signin'|'signup';route?:string}={}){
 const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch=globalThis.fetch;let calls=0;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>workspace,setItem:()=>{throw new Error('Credentials must not be persisted');}}});
 globalThis.fetch=(async()=>{calls++;throw new Error('No network in this rendering fixture');}) as typeof fetch;
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 client.setQueryData(['session',workspace],signedIn?{user:{id:'owned-user',name:'Owned recipient',email:'recipient@example.test',emailVerifiedAt:null,emailVerificationRequired:false},workspace:{id:workspace,name:'Owned workspace',role:'owner'},workspaces:[]}:null);
 client.setQueryData([workspace,'/api/config'],{preview:false,inviteRequired:false,hosted:false,passwordRecovery:{available:true},emailVerification:{available:true,requiredForSignup:true}});
 try{
  const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,{initialEntries:[route]},createElement(SessionProvider,null,auth?createElement(Auth,{signUp:auth==='signup'}):createElement(Invite)))));
  assert.equal(calls,0);return html;
 }finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}
function current(){let value:{token:string;version:number}|undefined;function Probe(){value=useInvitationLink();return null;}renderToStaticMarkup(createElement(Probe));return value!;}

test('invitation fragment is removed before rendering and never copied into links, forms or sign-in next',()=>{
 assert.deepEqual(capture('#token='+token,'/invite/'),['/invite']);const html=render();
 assert.match(html,/Sign in to continue/);assert.match(html,/href="\/sign-in\?next=%2Finvite"/);assert.match(html,/href="\/sign-up\?next=%2Finvite"/);
 assert.match(html,/<meta name="referrer" content="no-referrer"/);assert.doesNotMatch(html,new RegExp(token));assert.doesNotMatch(html,/token=|type="hidden"|name="token"/);
 assert.match(html,/After verifying, reopen this invitation/);capture('');
});

test('legacy manual links are cleaned without carrying their token into authentication or accepting on GET',()=>{
 assert.deepEqual(capture('','/app/invite','?token='+token+'&next=https://example.test'),['/invite']);
 assert.match(render(),/Sign in to continue/);assert.equal(current().token,token);
 const html=render({signedIn:true});assert.match(html,/Checking your invitation/);assert.doesNotMatch(html,/>Join workspace|Owned workspace|example.test\/|token=/);capture('');
});

test('malformed, ambiguous or unremovable links require the original invitation; a clean reload cannot recover secrets',()=>{
 for(const value of ['', '#token=short','#token='+'.'.repeat(43),'#token='+token+'&token='+token]){
  capture(value);const html=render();assert.match(html,/reopen the original invitation/);assert.doesNotMatch(html,/Sign in to continue/);
 }
 capture('#token='+token,'/invite','?token='+token);assert.equal(current().token,'');
 capture('#token='+token,'/invite','',true);assert.equal(current().token,'');
 capture('#token='+token);capture('');assert.equal(current().token,'');
});

test('invitation continuation stays in memory across other routes and older completion cannot discard a new link',()=>{
 capture('#token='+token);const original=current();
 assert.deepEqual(capture('#token='+'r'.repeat(43),'/reset-password'),[]);assert.equal(current().token,token);
 assert.deepEqual(capture('','/sign-in'),[]);assert.equal(current().token,token);
 capture('#token='+'n'.repeat(43));const newer=current();discardInvitationLink(original.version);assert.deepEqual(current(),newer);
 discardInvitationLink(newer.version);assert.equal(current().token,'');
});

test('auth retains only the safe invitation destination and explains verified-account continuation',()=>{
 capture('#token='+token);
 const signin=render({auth:'signin',route:'/sign-in?next=%2Finvite'});assert.match(signin,/workspace invitation was created for/);assert.match(signin,/href="\/sign-up\?next=%2Finvite"/);assert.doesNotMatch(signin,new RegExp(token));
 const signup=render({auth:'signup',route:'/sign-up?next=%2Finvite'});assert.match(signup,/reopen the invitation after verification/);assert.match(signup,/Confirm your email before signing in/);
 for(const next of ['//example.test','/invite/elsewhere','/invite?token=bad','/invite\\example.test']){
  const html=render({auth:'signin',route:'/sign-in?next='+encodeURIComponent(next)});assert.doesNotMatch(html,/workspace invitation was created for/);
 }
 capture('');
});
