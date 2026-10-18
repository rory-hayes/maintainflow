import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import {api, ApiError, uploadDocuments} from '../src/lib/api';

// Controlled transport fixtures only: no real authentication, storage or provider calls.
const PRIMARY='synthetic-upload-primary',CONTROL='synthetic-upload-control';
type Call={path:string;method:string;headers:Headers;init:RequestInit};
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function fixture(t:TestContext,respond:(call:Call)=>Response|Promise<Response>){
  const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');let selected=PRIMARY,networkAttempts=0;const calls:Call[]=[];
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>key==='folio.workspace'?selected:null}});
  const deny=()=>{networkAttempts++;throw new Error('Real network forbidden in upload transport fixtures');};
  t.mock.method(http,'request',deny);t.mock.method(http,'get',deny);t.mock.method(https,'request',deny);t.mock.method(https,'get',deny);t.mock.method(net,'connect',deny);t.mock.method(net,'createConnection',deny);t.mock.method(tls,'connect',deny);t.mock.method(dns,'lookup',deny);
  t.mock.method(globalThis,'fetch',async(input:string|URL|Request,init:RequestInit={})=>{const call={path:String(input),method:init.method||'GET',headers:new Headers(init.headers),init};calls.push(call);return respond(call);});
  t.after(()=>{if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');assert.equal(networkAttempts,0);});
  return{calls,select:(value:string)=>{selected=value;}};
}
function application(call:Call,workspace=PRIMARY){assert(call.path.startsWith('/api/'));assert.equal(call.headers.get('X-Workspace-Id'),workspace||null);assert.equal(call.init.credentials,'same-origin');}
function storagePut(call:Call){assert.match(call.path,/^https:\/\/synthetic\.supabase\.co\/owned-/);assert.equal(call.method,'PUT');assert.deepEqual([...call.headers.entries()],[['content-type','application/octet-stream'],['x-upsert','false']]);assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');assert.equal(call.init.referrerPolicy,'no-referrer');assert(call.init.body instanceof File);}

test('api defaults follow the selected workspace while an explicit operation scope remains stable',async t=>{
  const env=fixture(t,()=>Response.json({ok:true}));
  await api('/api/synthetic/default');env.select(CONTROL);await api('/api/synthetic/current');await api('/api/synthetic/owned',{},PRIMARY);await api('/api/synthetic/none',{},'');
  assert.deepEqual(env.calls.map(call=>call.headers.get('X-Workspace-Id')),[PRIMARY,CONTROL,PRIMARY,null]);env.calls.forEach(call=>assert.equal(call.init.credentials,'same-origin'));
});

test('multipart upload keeps its starting workspace when configuration resolves after a switch', {timeout:5000},async t=>{
  const config=deferred<Response>(),entered=deferred<void>();const files=[new File(['synthetic one'],'one.pdf'),new File(['synthetic two'],'two.png')];
  const receipt={results:[{document:{id:'synthetic-one'},jobId:'job-one'},{document:{id:'synthetic-two'},duplicate:true,jobId:null}]};
  const env=fixture(t,call=>{application(call);if(call.path==='/api/uploads/config'){entered.resolve();return config.promise;}assert.equal(call.path,'/api/parsers/synthetic-parser/documents?bankLocale=de-DE');assert.equal(call.method,'POST');assert(call.init.body instanceof FormData);assert.deepEqual(call.init.body.getAll('files').map(value=>(value as File).name),['one.pdf','two.png']);assert.equal(call.headers.get('content-type'),null);assert.match(call.headers.get('Idempotency-Key')||'',/^[a-f0-9-]{36}$/);return Response.json(receipt);});
  const upload=uploadDocuments('synthetic-parser',files,{bankLocale:'de-DE'});await entered.promise;env.select(CONTROL);config.resolve(Response.json({strategy:'multipart',maxBytes:10*1024*1024}));
  assert.deepEqual(await upload,receipt);assert.deepEqual(env.calls.map(call=>call.method),['GET','POST']);
});

test('signed upload keeps reservation, finalization and later batch files in the starting workspace after a held PUT', {timeout:5000},async t=>{
  const held=deferred<Response>(),entered=deferred<void>();const files=[new File(['synthetic first'],'first.pdf'),new File(['synthetic second'],'second.png')];let reservations=0,canceledBodies=0;
  const receipts=[{document:{id:'synthetic-first'},jobId:'job-first'},{document:{id:'synthetic-second'},duplicate:true,jobId:null}];
  const env=fixture(t,call=>{if(call.path.startsWith('https:')){storagePut(call);if(call.path.endsWith('owned-1')){entered.resolve();return held.promise;}assert.equal(call.path,'https://synthetic.supabase.co/owned-2');return new Response(null,{status:200});}application(call);if(call.path==='/api/uploads/config')return Response.json({strategy:'signed',maxBytes:10*1024*1024});assert.equal(call.method,'POST');assert.equal(call.headers.get('content-type'),'application/json');if(call.path==='/api/parsers/synthetic-parser/uploads'){const body=JSON.parse(String(call.init.body));assert.equal(body.filename,files[reservations].name);assert.equal(body.size,files[reservations].size);assert.match(body.sha256,/^[a-f0-9]{64}$/);assert.equal(body.bankLocale,'en-IE');reservations++;return Response.json({uploadId:'upload-'+reservations,uploadUrl:'https://synthetic.supabase.co/owned-'+reservations});}assert.match(call.path,/^\/api\/uploads\/upload-[12]\/finalize$/);assert.equal(call.init.body,'{}');return Response.json(receipts[call.path.includes('upload-1')?0:1]);});
  const upload=uploadDocuments('synthetic-parser',files,{bankLocale:'en-IE'});await entered.promise;env.select(CONTROL);held.resolve(new Response(new ReadableStream({cancel(){canceledBodies++;}}),{status:200}));
  assert.deepEqual(await upload,{results:receipts});assert.equal(canceledBodies,1);assert.equal(reservations,2);assert.deepEqual(env.calls.map(call=>call.method),['GET','POST','PUT','POST','POST','PUT','POST']);
});

test('a signed-file failure preserves its error and continues the batch in the original workspace',async t=>{
  let reservations=0;const second={document:{id:'synthetic-second'},jobId:'job-second'};let env:ReturnType<typeof fixture>;
  env=fixture(t,call=>{if(call.path.startsWith('https:')){storagePut(call);if(call.path.endsWith('owned-1')){env.select(CONTROL);return new Response(null,{status:503});}return new Response(null,{status:200});}application(call);if(call.path==='/api/uploads/config')return Response.json({strategy:'signed',maxBytes:1024});if(call.path==='/api/parsers/synthetic-parser/uploads'){reservations++;return Response.json({uploadId:'upload-'+reservations,uploadUrl:'https://synthetic.supabase.co/owned-'+reservations});}assert.equal(call.path,'/api/uploads/upload-2/finalize');return Response.json(second);});
  assert.deepEqual(await uploadDocuments('synthetic-parser',[new File(['first'],'first.pdf'),new File(['second'],'second.pdf')]),{results:[{name:'first.pdf',error:'The file could not be uploaded. Please retry.'},second]});
  assert.equal(reservations,2);assert.deepEqual(env.calls.map(call=>call.method),['GET','POST','PUT','POST','PUT','POST']);
});

test('multipart errors retain status and message after a configuration-time workspace switch', {timeout:5000},async t=>{
  const config=deferred<Response>(),entered=deferred<void>();const env=fixture(t,call=>{application(call);if(call.path==='/api/uploads/config'){entered.resolve();return config.promise;}assert.equal(call.path,'/api/parsers/synthetic-parser/documents');return Response.json({message:'Synthetic upload limit reached.'},{status:429});});
  const upload=uploadDocuments('synthetic-parser',[new File(['fixture'],'fixture.pdf')]);const rejected=assert.rejects(upload,(error:unknown)=>error instanceof ApiError&&error.status===429&&error.message==='Synthetic upload limit reached.');await entered.promise;env.select(CONTROL);config.resolve(Response.json({strategy:'multipart',maxBytes:1024}));await rejected;assert.equal(env.calls.length,2);
});
