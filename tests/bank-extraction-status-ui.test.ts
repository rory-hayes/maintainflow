import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter,Routes,Route} from 'react-router-dom';
import BankExtractionStatus,{type BankExtractionJob} from '../src/features/bank-statements/BankExtractionStatus';
import {SessionProvider} from '../src/lib/session';
import type {BankValues} from '../shared/bank-statements';
import type {BankRun} from '../src/features/bank-statements/bank-ui';

const privateError='PRIVATE upstream exception https://private.example.test/object?token=do-not-show';
const job=(state:string,attempts=0,maxAttempts=3):BankExtractionJob=>({id:'synthetic-job',state,attempts,maxAttempts,error:privateError});
const renderStatus=(latestJob?:BankExtractionJob,hasRun=true,canEdit=true,documentStatus='needs_review',documentError?:string)=>renderToStaticMarkup(createElement(BankExtractionStatus,{documentStatus,documentError,latestJob,hasRun,canEdit}));

test('new extraction, automatic retry and processing have distinct fixed status copy',()=>{
  const queued=renderStatus(job('queued'));
  assert.match(queued,/Extraction queued/);assert.doesNotMatch(queued,/last attempt|Attempt 0|attempts used/);
  const retry=renderStatus(job('queued',1));
  assert.match(retry,/Another extraction attempt is queued/);assert.match(retry,/retry automatically/);assert.match(retry,/1 of 3 attempts used/);
  const processing=renderStatus(job('processing',2));
  assert.match(processing,/Extraction in progress/);assert.match(processing,/Attempt 2 of 3/);
  for(const html of [queued,retry,processing]){
    assert.match(html,/role="status"/);assert.match(html,/aria-live="polite"/);assert.match(html,/aria-atomic="true"/);
    assert.match(html,/selected earlier extraction/);assert.match(html,/Approved downloads still use the saved approval/);assert.doesNotMatch(html,/PRIVATE|private\.example|do-not-show/);
  }
});

test('known temporary terminal failure explains a delayed charged retry and respects viewer access',()=>{
  const temporary={...job('failed',3),error:'Private storage is temporarily unavailable. Retry shortly.'};
  const failed=renderStatus(temporary);assert.match(failed,/latest extraction could not finish/);assert.match(failed,/Wait a little before using Extract again/);assert.match(failed,/uses pages from your allowance/);assert.doesNotMatch(failed,/retry automatically|PRIVATE/);
  const viewer=renderStatus(temporary,true,false);assert.match(viewer,/Ask a workspace editor/);assert.doesNotMatch(viewer,/using Extract again/);
});

test('configuration, provider access and quota failures direct customers to MaintainFlow support',()=>{
  const errors=[
    'Bank statement extraction is unavailable because the AI provider is not configured. Ask your administrator to enable it, then retry the statement.',
    'OpenAI rejected the server credentials or model access. Check the configured project.',
    'Private storage credentials are not configured',
    'The OpenAI project has no available API quota. Check project billing and limits.',
  ];
  for(const error of errors){
    const html=renderStatus({...job('failed',1),error});assert.match(html,/Contact MaintainFlow support before starting another extraction/);assert.doesNotMatch(html,/using Extract again|retry automatically|workspace owner|provider|storage|billing|quota|configuration/i);assert.ok(!html.includes(error));
  }
  assert.match(renderStatus({...job('failed',1),error:errors[3]}),/Statement processing is unavailable right now/);
});

test('source binding and input limits require inspection and support before another extraction',()=>{
  for(const error of [
    'The original bank PDF no longer matches its verified intake. Reprocess a verified source.',
    'The original PDF changed before its extraction result could be saved. Reprocess a verified source.',
    'The document exceeds AI input limits or has invalid page metadata.',
    'File exceeds the 10 MB limit',
    'Original file is unavailable',
  ]){
    const html=renderStatus({...job('failed',1),error});assert.match(html,/Check the original file and supported limits/);assert.match(html,/contact support before starting another extraction/);assert.doesNotMatch(html,/using Extract again|retry automatically/);assert.ok(!html.includes(error));
  }
});

test('unknown and almost-matching exceptions never leak or recommend blind charged retries',()=>{
  for(const error of [privateError,null,'Private storage is temporarily unavailable. Retry shortly. '+privateError]){
    const html=renderStatus({...job('failed',3),error});assert.match(html,/Contact MaintainFlow support to check this failure/);assert.doesNotMatch(html,/using Extract again|retry automatically|workspace owner|PRIVATE|private\.example|do-not-show/);
  }
  const documentError='Private storage credentials are not configured';
  assert.match(renderStatus(undefined,false,true,'failed',documentError),/Contact MaintainFlow support before starting another extraction/);
  // A latest job with no classified error must not borrow an older document error.
  assert.match(renderStatus({...job('failed',1),error:null},true,true,'failed',documentError),/Contact MaintainFlow support to check this failure/);
});

test('missing or malformed attempt metadata cannot invent attempt counts or an automatic retry',()=>{
  for(const latestJob of [
    {id:'legacy',state:'queued'},job('queued',-1),job('queued',1.5),job('queued',Infinity),job('queued',1,0),job('queued',4,3),job('queued',1,Number.MAX_SAFE_INTEGER+1),
  ]){const html=renderStatus(latestJob);assert.match(html,/Extraction queued/);assert.doesNotMatch(html,/retry automatically|attempts used|Attempt \d/);}
  assert.doesNotMatch(renderStatus(job('queued',3,3)),/retry automatically/);
});

test('completed jobs suppress stale document failure and absent jobs use document lifecycle only',()=>{
  assert.equal(renderStatus(job('completed',2),true,true,'failed'),'');
  for(const error of ['Private storage is temporarily unavailable. Retry shortly.','The OpenAI project has no available API quota. Check project billing and limits.','The original bank PDF no longer matches its verified intake. Reprocess a verified source.'])assert.equal(renderStatus({...job('completed',2),error},true,true,'failed',error),'');
  assert.equal(renderStatus(undefined,true,true,'approved'),'');
  assert.match(renderStatus(undefined,false,true,'failed'),/latest extraction could not finish/);
  assert.doesNotMatch(renderStatus(undefined,false,true,'processing'),/earlier extraction|Attempt \d/);
});

// Render the real review screen with cached synthetic data. Browser acceptance separately
// exercises drafts, history downloads and source-link scroll/focus at desktop/mobile sizes.
const cssUrls=new Set(['../src/features/documents/review.css','../src/features/bank-statements/bank-statements.css'].map(path=>new URL(path,import.meta.url).href));
const hooks=registerHooks({load(url,context,next){return cssUrls.has(url)?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const BankReview=await import('../src/features/bank-statements/BankReview').then(module=>module.default).finally(()=>hooks.deregister());
const values:BankValues={version:1,accounts:[{id:'synthetic-account',origin:'extracted',excluded:false,exclusion_reason:null,bank_name:'Synthetic bank',account_identifier:'SYN-001',currency:'EUR',statement_start:null,statement_end:null,opening_balance:'100.00',closing_balance:'90.00',total_debits:'10.00',total_credits:'0.00',balance_convention:'credit_increases',transactions:[{id:'synthetic-transaction',origin:'extracted',excluded:false,exclusion_reason:null,date:'2026-09-01',description:'Preserved earlier transaction',reference:'SYN-TX-001',debit:'10.00',credit:null,balance:'90.00',currency:'EUR'}]}]};
const run:BankRun={id:'synthetic-run',createdAt:'2026-09-01T00:00:00Z',effectiveValues:values,effectiveRevision:'synthetic-revision',bankReviewToken:'synthetic-token',bankContext:{version:1,locale:'en-IE',accounts:{},transactions:{}},bankIssues:[],rawValues:{},evidence:{},corrections:[],approvals:[{id:'synthetic-approval',createdAt:'2026-09-01T00:01:00Z',values}]};
function renderReview(jobs:BankExtractionJob[],withRun=true,documentStatus='failed'){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch=globalThis.fetch;let requests=0;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=> 'synthetic-workspace'}});
  globalThis.fetch=(async()=>{requests++;throw new Error('Network forbidden in synthetic review fixture');}) as typeof fetch;
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
  client.setQueryData(['session','synthetic-workspace'],{user:{id:'synthetic-user'},workspace:{id:'synthetic-workspace',role:'editor'},workspaces:[]});
  client.setQueryData(['synthetic-workspace','/api/bank-statements/synthetic-document'],{document:{id:'synthetic-document',name:'Synthetic statement',status:documentStatus,pageCount:2,mimeType:'text/plain',sourceText:[{page:1,text:'Synthetic original source'}],error:privateError,approvedRunId:withRun?run.id:null},parser:{id:'synthetic-parser',useCase:'bank_statement'},runs:withRun?[run]:[],jobs});
  try{
    const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,{initialEntries:['/app/bank-statements/synthetic-document']},createElement(SessionProvider,null,createElement(Routes,null,createElement(Route,{path:'/app/bank-statements/:id',element:createElement(BankReview)}))))));
    assert.equal(requests,0);return html;
  }finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}

test('the real review screen exposes latest job progress above preserved prior transactions',()=>{
  for(const [latestJob,expected] of [[job('processing',2),'Extraction in progress'],[job('queued',1),'Another extraction attempt is queued'],[job('failed',3),'latest extraction could not finish']] as const){
    const html=renderReview([latestJob]);assert.ok(html.includes(expected));assert.match(html,/Preserved earlier transaction/);assert.match(html,/Approvals &amp; history/);assert.match(html,/Synthetic original source/);
    assert.ok(html.indexOf(expected)<html.indexOf('bank-mobile-tabs'));assert.doesNotMatch(html,/PRIVATE|private\.example|do-not-show/);
  }
});

test('a historical failed job cannot overwrite completed latest extraction status',()=>{
  const html=renderReview([job('completed',2),{...job('failed',3),id:'older-job'}],true,'needs_review');
  assert.match(html,/Preserved earlier transaction/);assert.doesNotMatch(html,/latest extraction could not finish|retry automatically|PRIVATE/);
});

test('initial extraction failures remain actionable without displaying raw document or job errors',()=>{
  const html=renderReview([job('failed',3)],false);
  assert.match(html,/latest extraction could not finish/);assert.match(html,/Contact MaintainFlow support to check this failure/);assert.match(html,/No transactions to review yet/);
  assert.doesNotMatch(html,/selected earlier extraction|PRIVATE|private\.example|do-not-show/);
});
