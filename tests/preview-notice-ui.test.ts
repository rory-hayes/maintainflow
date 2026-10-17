import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import PreviewNotice from '../src/components/PreviewNotice';

function renderNotice(configuration?:{preview:boolean;previewBillingMode?:'mock'|'stripe_test'|null}){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=(async()=>{calls++;throw new Error('Network is forbidden in this component fixture');}) as typeof fetch;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>''}});
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  if(configuration)client.setQueryData(['','/api/config'],configuration);
  try{
    const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(PreviewNotice)));
    assert.equal(calls,0);return html;
  }finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}

test('the private preview banner distinguishes simulated billing from real Stripe TEST transport',()=>{
  const mock=renderNotice({preview:true,previewBillingMode:'mock'});
  assert.match(mock,/role="note"/);assert.match(mock,/Billing is simulated\. No payments are taken\./);assert.doesNotMatch(mock,/Stripe test mode/);
  const stripe=renderNotice({preview:true,previewBillingMode:'stripe_test'});
  assert.match(stripe,/Private test preview/);assert.match(stripe,/Stripe test mode\. No real payments are taken\./);assert.doesNotMatch(stripe,/simulated/);
});

test('absent mode metadata never promises simulated billing and nonpreview or loading has no banner',()=>{
  const unknown=renderNotice({preview:true});
  assert.match(unknown,/Private test preview/);assert.doesNotMatch(unknown,/simulated|No .*payments|Stripe test mode/);
  assert.equal(renderNotice({preview:false,previewBillingMode:null}),'');
  assert.equal(renderNotice(), '');
});
