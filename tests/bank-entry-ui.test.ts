import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {SessionProvider} from '../src/lib/session';

const hook=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const BankLanding=await import('../src/features/bank-statements/BankLanding').then(module=>module.default).finally(()=>hook.deregister());
type Configuration={preview:boolean;inviteRequired:boolean;publicService?:{supportEmail:string|null}};

function render(configuration?:Configuration,signedIn=false){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch=globalThis.fetch;
  let requests=0;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>''}});
  globalThis.fetch=(async()=>{requests++;throw new Error('Network forbidden in bank entry fixture');}) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  client.setQueryData(['session',''],signedIn?{user:{id:'synthetic-user'},workspace:{id:'synthetic-workspace'},workspaces:[]}:null);
  if(configuration)client.setQueryData(['','/api/config'],configuration);
  try{
    const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,null,createElement(SessionProvider,null,createElement(BankLanding)))));
    assert.equal(requests,0);return html;
  }finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}

test('an anonymous invite-only visitor gets a request route and keeps the invite-holder signup route',()=>{
  const html=render({preview:true,inviteRequired:true,publicService:{supportEmail:'access+qa@example.test'}});
  assert.equal((html.match(/href="#early-access"/g)||[]).length,3,'Header, hero and final CTA all reach the request section');
  assert.match(html,/id="early-access"[^>]*aria-labelledby="early-access-title"/);
  assert.match(html,/href="mailto:access%2Bqa%40example.test\?subject=MaintainFlow%20early%20access"/);
  assert.match(html,/Private preview · Access is by invitation\./);
  assert.match(html,/href="\/sign-up\?next=%2Fapp%2Fbank-statements"[^>]*>Already have an invite code\?/);
  assert.match(html,/Please do not attach bank statements/);
});

test('missing support metadata never invents a contact address',()=>{
  for(const publicService of [undefined,{supportEmail:null}]){
    const html=render({preview:true,inviteRequired:true,publicService});
    assert.match(html,/Ask the person who shared MaintainFlow with you for an invitation/);
    assert.doesNotMatch(html,/mailto:/);
  }
});

test('signed-in users retain the direct bank workspace route even in private preview',()=>{
  const html=render({preview:true,inviteRequired:true,publicService:{supportEmail:'access@example.test'}},true);
  assert.equal((html.match(/href="\/app\/bank-statements"/g)||[]).length,3);
  assert.doesNotMatch(html,/Request early access|id="early-access"|mailto:/);
});

test('public and unknown configurations preserve existing signup behavior without claiming invitation access',()=>{
  for(const configuration of [undefined,{preview:false,inviteRequired:false},{preview:true,inviteRequired:false},{preview:false,inviteRequired:true}]){
    const html=render(configuration);
    assert.equal((html.match(/href="\/sign-up\?next=%2Fapp%2Fbank-statements"/g)||[]).length,3);
    assert.doesNotMatch(html,/Request early access|id="early-access"|Access is by invitation/);
  }
});
