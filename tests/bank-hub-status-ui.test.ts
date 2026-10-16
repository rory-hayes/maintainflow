import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';
import {SessionProvider} from '../src/lib/session';
import type {BankDocument} from '../src/features/bank-statements/bank-ui';

const css=new URL('../src/features/bank-statements/bank-statements.css',import.meta.url).href;
const hook=registerHooks({load(url,context,next){return url===css?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const BankStatements=await import('../src/features/bank-statements/BankStatements').then(module=>module.default).finally(()=>hook.deregister());
const privateError='PRIVATE worker exception https://private.example.test/object?token=do-not-show';

// Render the real hub with cached synthetic data; no API, database or provider is used.
function renderHub(documents:BankDocument[],role:'owner'|'viewer'='owner'){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch=globalThis.fetch;
  let requests=0;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=> 'synthetic-workspace'}});
  globalThis.fetch=(async()=>{requests++;throw new Error('Network forbidden in synthetic hub fixture');}) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  client.setQueryData(['session','synthetic-workspace'],{user:{id:'synthetic-user'},workspace:{id:'synthetic-workspace',role},workspaces:[]});
  client.setQueryData(['synthetic-workspace','/api/bank-statements?page=1&pageSize=50'],{documents,parser:{id:'synthetic-parser',locale:'en-IE'},providerConfigured:true,total:documents.length});
  try{
    const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,null,createElement(SessionProvider,null,createElement(BankStatements)))));
    assert.equal(requests,0);return html;
  }finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}

function statement(state:'failed'|'queued',approved:boolean,error:string|null=privateError):BankDocument{
  return {id:`synthetic-${state}`,name:`Synthetic ${state} statement.pdf`,status:state,pageCount:2,mimeType:'application/pdf',error,bankSummary:{accountCount:1,transactionCount:2,errorCount:0,warningCount:0,approvalId:approved?'synthetic-prior-approval':null}};
}
const card=(html:string)=>{const match=html.match(/<article class="bank-document-card">[\s\S]*?<\/article>/);assert.ok(match,'The real hub must render its statement card');return match[0];};

test('failed and queued hub cards hide private diagnostics while retaining status, Open and prior-approval selection',()=>{
  for(const state of ['failed','queued'] as const)for(const role of ['owner','viewer'] as const){
    const html=renderHub([statement(state,true)],role),item=card(html);
    assert.equal(/PRIVATE|private\.example|do-not-show|worker exception/.test(html),false,'Raw worker diagnostics must never become hub copy');
    assert.match(item,/Open this statement to check extraction status and next steps\./);
    assert.ok(item.includes(`<span class="status ${state}"><span></span>${state==='failed'?'Failed':'Queued'}</span>`));
    assert.match(item,new RegExp(`class="button secondary" href="/app/bank-statements/synthetic-${state}"`));
    assert.match(item,/>Open<svg/);
    const checkbox=item.match(/<input[^>]*type="checkbox"[^>]*>/);assert.ok(checkbox);
    assert.match(checkbox[0],/aria-label="Select Synthetic (failed|queued) statement\.pdf for export"/);
    assert.doesNotMatch(checkbox[0],/disabled=/,'A prior approval remains available for selection');
    assert.doesNotMatch(item,/>Retry<|retry automatically|Extract again|Upload again/);
    if(role==='viewer')assert.match(html,/You have view-only access/);
  }
});

test('hub cards without a diagnostic do not invent failure guidance and unapproved selection stays disabled',()=>{
  for(const state of ['failed','queued'] as const){
    const item=card(renderHub([statement(state,false,null)]));
    assert.doesNotMatch(item,/bank-error-text|check extraction status and next steps/);
    assert.match(item,/<input[^>]*type="checkbox"[^>]*disabled=""/);
    assert.match(item,new RegExp(`class="button secondary" href="/app/bank-statements/synthetic-${state}"`));
    assert.ok(item.includes(`class="status ${state}"`));
  }
});
