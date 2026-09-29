import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import type {UploadItem} from '../src/features/bank-statements/BankStatements';
import type {BankDocument} from '../src/features/bank-statements/bank-ui';
const css=new URL('../src/features/bank-statements/bank-statements.css',import.meta.url).href;
const hook=registerHooks({load(url,context,next){return url===css?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {BankUploadResults}=await import('../src/features/bank-statements/BankStatements').finally(()=>hook.deregister());
const item=(key:string,state:UploadItem['state']='received'):UploadItem=>({key,file:new File(['synthetic'],key+'.pdf'),state,documentId:'doc-'+key});
const document=(id:string,status:string):BankDocument=>({id:'doc-'+id,name:id+'.pdf',status,pageCount:1,mimeType:'application/pdf'});
const render=(items:UploadItem[],documents:BankDocument[],canEdit=true,uploading=false)=>renderToStaticMarkup(createElement(MemoryRouter,null,createElement(BankUploadResults,{items,documents,canEdit,uploading,onRetry:()=>{throw Error('Render cannot retry uploads');}})));

test('received batch follows replacement polling data through queued, processing and terminal review',()=>{
 const items=[item('a'),item('b')],queued=render(items,[document('a','queued'),document('b','processing')]);
 assert.match(queued,/Received · extraction queued/);assert.match(queued,/Received · extracting transactions/);
 const terminal=render(items,[document('a','needs_review'),document('b','needs_review')]);
 assert.equal(terminal.match(/Received · ready for review/g)?.length,2);assert.doesNotMatch(terminal,/processing in the background|extracting transactions|>Retry</);
 assert.match(terminal,/2 of 2 received or checked/);assert.equal(terminal.match(/>Open<\/a>/g)?.length,2);
});

test('terminal extraction failure preserves receipt without offering an upload retry',()=>{
 const html=render([item('a')],[{...document('a','failed'),error:'PRIVATE original worker detail'}]);
 assert.match(html,/Received · extraction could not finish; open for details/);assert.match(html,/href="\/app\/bank-statements\/doc-a"/);assert.doesNotMatch(html,/>Retry<|PRIVATE/);
 const retryQueued=render([item('a')],[document('a','queued')]);assert.match(retryQueued,/Received · extraction queued/);assert.doesNotMatch(retryQueued,/ready for review|failed|Attempt \d|retry automatically/);
});

test('partial uploads preserve waiting, checked rejection and retryable failure as separate receipt states',()=>{
 const items=[item('a'),{...item('bad','failed'),error:'Choose a corrected file',retryable:false},{...item('temporary','failed'),error:'Temporary upload failure',retryable:true},item('next','waiting'),item('sending','uploading')];
 const html=render(items,[document('a','needs_review')]);assert.match(html,/3 of 5 received or checked/);assert.match(html,/Waiting to upload/);assert.match(html,/Uploading and checking file/);assert.match(html,/Choose a corrected file using Choose files above/);assert.equal(html.match(/>Retry<\/button>/g)?.length,1);assert.equal(html.match(/>Open<\/a>/g)?.length,1);
 for(const blocked of [render(items,[],false),render(items,[],true,true)])assert.match(blocked,/<button[^>]*disabled=""[^>]*>.*?Retry<\/button>/);
});

test('duplicate, approved and unknown or off-page rows never invent ongoing processing',()=>{
 const existing={...item('a'),duplicate:true};assert.match(render([existing],[document('a','processed')]),/Already uploaded · approved · ready to export/);
 for(const docs of [[],[document('other','processing')],[document('a','future_state')],[document('a','toString')]]){const html=render([item('a')],docs);assert.match(html,/Received · open for current status/);assert.doesNotMatch(html,/processing in the background|extracting transactions|ready for review/);}
 assert.match(render([item('a')],[document('a','exported')]),/Received · exported/);assert.equal(render([],[]),'');
});
