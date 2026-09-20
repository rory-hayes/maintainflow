import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import {PDFDocument} from 'pdf-lib';
import type {FastifyInstance} from 'fastify';
import type {Actor,ProviderInput} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {addArchiveDocuments} from '../server/core/archive-import-intake.js';
import {previewArchiveSource} from '../server/core/source.js';
import {reserveDirectUpload,finalizeDirectUpload} from '../server/core/upload-routes.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {processOneSchemaSuggestion,setSchemaSuggestionProvider} from '../server/core/schema-suggestions.js';
import {ParserFormatNotAllowedError,SourceIntakeRejectedError} from '../server/core/intake-policy.js';
import {tiffRenderVersion} from '../shared/tiff.js';
import {makeTiff} from './fixtures/tiff.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;schemaId:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>();
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const schema={fields:[{key:'reference',label:'Reference',type:'string' as const,required:true}]};
const bytes=makeTiff([{width:40,height:20,color:[255,0,0]},{width:16,height:32,color:[0,255,0],orientation:6}],{bigTiff:true,byteOrder:'MM'});
const originalFetch=globalThis.fetch;
let app:FastifyInstance,verified=false,fetches=0,onRead:((key:string)=>Promise<void>)|undefined;
const storage:PrivateStorage={kind:'supabase',async write(key,value){objects.set(key,Buffer.from(value));},async read(key){await onRead?.(key);const value=objects.get(key);if(!value)throw new Error('Missing owned TIFF original');return Buffer.from(value);},async remove(key){objects.delete(key);},async signUpload(key){return `https://owned.example.test/upload/${key}`;}};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
async function request(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={}){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,...headers}});}
async function fixture(label:string,mode:'rules'|'ai'='ai',allowedFormats:string[]|null=['tiff']):Promise<Fixture>{
 const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned TIFF QA',workspaceName:`Owned TIFF ${label}`,email:`tiff-${randomUUID()}@example.test`,password:'Owned TIFF fixture password'}});assert.equal(response.statusCode,201,response.body);
 const account={...response.json(),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000') where id=$1",[account.workspace.id]);
 const created=await request(account,'POST','/api/parsers',{name:'Owned TIFF parser',useCase:'custom',mode,schema,allowedFormats});assert.equal(created.statusCode,201,created.body);
 return {account,parserId:created.json().parser.id,schemaId:created.json().schema.id};
}
const add=(f:Fixture,key=randomUUID(),source=bytes)=>addDocument(actor(f.account),f.parserId,source,'renamed.txt','text/plain',key);
async function counts(f:Fixture){const out:Record<string,number>={};for(const table of ['documents','jobs','extraction_runs','usage_ledger'])out[table]=(await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`,[f.account.workspace.id])).rows[0].n;out.pages=(await adminPool.query('select coalesce(sum(pages),0)::int n from usage_ledger where workspace_id=$1',[f.account.workspace.id])).rows[0].n;return out;}
async function checkVisual(input:Pick<ProviderInput,'bytes'|'mimeType'|'pages'|'visualDocument'>){assert.equal(input.mimeType,'image/tiff');assert.deepEqual(input.bytes,bytes);assert.deepEqual(input.pages,[{page:1,text:''},{page:2,text:''}]);assert.ok(input.visualDocument);assert.equal(input.visualDocument.sourceSha256,hash(bytes));assert.equal(input.visualDocument.renderVersion,tiffRenderVersion);const pdf=await PDFDocument.load(input.visualDocument.bytes);assert.deepEqual(pdf.getPages().map(p=>[p.getWidth(),p.getHeight()]),[[40,20],[32,16]]);}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}

before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,url?5432:55432);if(!url)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No external transport in owned TIFF tests');};app=await buildApp();
});
afterEach(()=>{onRead=undefined;setExtractionProvider(undefined);setSchemaSuggestionProvider(undefined);assert.equal(fetches,0);});
after(async()=>{setStorageForTests(undefined);setExtractionProvider(undefined);setSchemaSuggestionProvider(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts){await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);await adminPool.query('delete from users where id=$1',[a.user.id]);}}}finally{objects.clear();await closeDatabase();}});

test('TIFF identity, page charge and immutable originals survive replay and authenticated page previews',async()=>{
 const f=await fixture('preview'),foreign=await fixture('foreign'),id=randomUUID(),first=await add(f,id),documentId=first.document.id;
 assert.equal(first.document.mimeType,'image/tiff');assert.equal(first.document.pageCount,2);assert.equal(first.document.sha256,hash(bytes));
 const before=await counts(f);assert.deepEqual(before,{documents:1,jobs:1,extraction_runs:0,usage_ledger:1,pages:2});
 for(const page of [1,2]){const preview=await request(f.account,'GET',`/api/documents/${documentId}/preview?page=${page}`);assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.headers['content-type'],'image/jpeg');assert.equal(preview.headers['x-folio-preview-page'],String(page));assert.equal(preview.headers['x-folio-source-sha256'],hash(bytes));assert.match(String(preview.headers['cache-control']),/private, no-store/);assert.equal(preview.headers['x-content-type-options'],'nosniff');const decoded=await sharp(preview.rawPayload).raw().toBuffer({resolveWithObject:true});assert.deepEqual([decoded.info.width,decoded.info.height],page===1?[40,20]:[32,16]);const channel=page===1?0:1;assert.ok(decoded.data[channel]>240);}
 for(const query of ['0','3','31','1.5','abc'])assert.equal((await request(f.account,'GET',`/api/documents/${documentId}/preview?page=${query}`)).statusCode,400);
 assert.equal((await app.inject({url:`/api/documents/${documentId}/preview`})).statusCode,401);
 assert.equal((await request(foreign.account,'GET',`/api/documents/${documentId}/preview`)).statusCode,404);
 const key=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned TIFF results-only',scopes:['results:read']});assert.equal(key.statusCode,200,key.body);
 assert.equal((await app.inject({url:`/api/documents/${documentId}/preview`,headers:{authorization:`Bearer ${key.json().token}`}})).statusCode,403);
 const replay=await add(f,id);assert.equal(replay.document.id,documentId);assert.equal(replay.duplicate,true);assert.deepEqual(await counts(f),before);
 const original=await request(f.account,'GET',`/api/documents/${documentId}/original`);assert.equal(original.statusCode,200);assert.deepEqual(original.rawPayload,bytes);assert.match(String(original.headers['content-disposition']),/^attachment/);
});

test('both queued AI paths receive a real ordered PDF derivative and retain original TIFF provenance once',async()=>{
 const f=await fixture('workers'),uploaded=await add(f);let extractionCalls=0,suggestionCalls=0;
 setExtractionProvider({configured:()=>true,extract:async input=>{extractionCalls++;await checkVisual(input);return {rawValues:{reference:'CONTROLLED-2'},normalizedValues:{reference:'CONTROLLED-2'},evidence:{reference:[{page:2,text:'CONTROLLED-2',source:'model-visual'}]},issues:[],model:'controlled-tiff-model',engine:'controlled-ai',promptVersion:'owned-tiff-v1',tokenUsage:{inputTokens:123},costUsd:0};}});
 assert.equal(await processOneCoreJob(uploaded.jobId!),true);assert.equal(await processOneCoreJob(uploaded.jobId!),false);assert.equal(extractionCalls,1);
 const detail=(await request(f.account,'GET',`/api/documents/${uploaded.document.id}`)).json(),run=detail.runs[0];assert.equal(detail.document.status,'needs_review');assert.equal(run.documentSha256,hash(bytes));assert.equal(run.evidence.reference[0].page,2);assert.equal(run.tokenUsage.inputTokens,123);assert.equal(run.tokenUsage.sourceRendering.sourceSha256,hash(bytes));assert.equal(run.tokenUsage.sourceRendering.pageCount,2);
 setSchemaSuggestionProvider({configured:()=>true,suggest:async input=>{suggestionCalls++;await checkVisual(input);return {schema:{fields:schema.fields.map(field=>({...field,required:false}))},model:'controlled-tiff-schema',promptVersion:'owned-tiff-schema-v1',tokenUsage:{inputTokens:77},costUsd:0};}});
 const queued=await request(f.account,'POST',`/api/parsers/${f.parserId}/schema-suggestions`,{documentId:uploaded.document.id,baseSchemaId:f.schemaId,requestId:randomUUID()});assert.equal(queued.statusCode,202,queued.body);const suggestionId=queued.json().suggestion.id;
 assert.equal(await processOneSchemaSuggestion(suggestionId),true);assert.equal(await processOneSchemaSuggestion(suggestionId),false);assert.equal(suggestionCalls,1);
 const saved=(await adminPool.query('select state,token_usage,document_sha256 from schema_suggestions where id=$1',[suggestionId])).rows[0];assert.equal(saved.state,'ready');assert.equal(saved.document_sha256,hash(bytes));assert.equal(saved.token_usage.inputTokens,77);assert.deepEqual(saved.token_usage.sourceRendering,run.tokenUsage.sourceRendering);
 assert.deepEqual(await counts(f),{documents:1,jobs:1,extraction_runs:1,usage_ledger:1,pages:2});assert.deepEqual(objects.get(`${f.account.workspace.id}/${uploaded.document.id}`),bytes);
});

test('rules and unconfigured AI retain TIFFs with explicit failure and no invented OCR results',async()=>{
 for(const mode of ['rules','ai'] as const){const f=await fixture(`unconfigured-${mode}`,mode),uploaded=await add(f);assert.equal(await processOneCoreJob(uploaded.jobId!),true);const detail=(await request(f.account,'GET',`/api/documents/${uploaded.document.id}`)).json();assert.equal(detail.document.status,'failed');assert.match(detail.document.error,mode==='rules'?/require a configured OCR\/AI provider/:/AI extraction is not configured/);assert.equal(detail.runs.length,0);assert.equal(detail.jobs[0].attempts,1);assert.deepEqual((await request(f.account,'GET',`/api/documents/${uploaded.document.id}/original`)).rawPayload,bytes);}
});

test('TIFF policy and structural rejection receipts replay without documents, jobs, charges or retained originals',async()=>{
 for(const invalid of [false,true]){const f=await fixture(`reject-${invalid}`,'ai',invalid?['tiff']:['txt']),id=randomUUID(),input=invalid?bytes.subarray(0,20):bytes;
  const expected=(error:any)=>invalid?error instanceof SourceIntakeRejectedError&&error.reason==='tiff_invalid':error instanceof ParserFormatNotAllowedError&&error.format==='tiff';
  await assert.rejects(add(f,id,input),expected);await assert.rejects(addDocument(actor(f.account),f.parserId,input,'renamed.txt',undefined,id,{inspectSource:async()=>{throw new Error('Durable rejection cannot decode again');}}),expected);
  assert.deepEqual(await counts(f),{documents:0,jobs:0,extraction_runs:0,usage_ledger:0,pages:0});assert.equal([...objects.keys()].filter(k=>k.startsWith(f.account.workspace.id+'/')).length,0);
  const receipt=(await adminPool.query('select rejection_format,rejection_reason,rejection_sha256 from intake_events where workspace_id=$1',[f.account.workspace.id])).rows;assert.equal(receipt.length,1);assert.equal(receipt[0].rejection_sha256,hash(input));assert.equal(invalid?receipt[0].rejection_reason:receipt[0].rejection_format,invalid?'tiff_invalid':'tiff');
 }
});

test('signed finalization and selected ZIP TIFF imports preserve page counts, exact bytes and separate replay identities',async()=>{
 const f=await fixture('signed-zip'),reservation=await reserveDirectUpload(actor(f.account),f.parserId,{filename:'owned.tif',size:bytes.length,sha256:hash(bytes)});objects.set(`${f.account.workspace.id}/${reservation.uploadId}`,Buffer.from(bytes));
 const direct=await finalizeDirectUpload(actor(f.account),reservation.uploadId);assert.equal(direct.document.pageCount,2);assert.equal(direct.document.mimeType,'image/tiff');assert.equal((await finalizeDirectUpload(actor(f.account),reservation.uploadId)).document.id,direct.document.id);
 const zip=new JSZip();zip.file('selected/renamed.txt',bytes);zip.file('unselected.txt','Do not import');const zipBytes=await zip.generateAsync({type:'nodebuffer'}),preview=await previewArchiveSource(zipBytes,'owned.zip'),entry=preview.entries.find(e=>e.path==='selected/renamed.txt')!;assert.equal(entry.format,'tiff');assert.equal(entry.pageCount,2);
 const id=randomUUID(),spec={mode:'zip' as const,version:1 as const,sourceSha256:hash(zipBytes),entries:[entry.index]},accepted=await addArchiveDocuments(actor(f.account),f.parserId,zipBytes,'owned.zip',id,spec);assert.equal(accepted.archive.totalPages,2);assert.equal(accepted.documents.length,1);assert.equal(accepted.documents[0].pageCount,2);assert.notEqual(accepted.documents[0].id,direct.document.id);assert.deepEqual(objects.get(`${f.account.workspace.id}/${accepted.documents[0].id}`),bytes);
 const again=await addArchiveDocuments(actor(f.account),f.parserId,zipBytes,'owned.zip',id,spec);assert.equal(again.replayed,true);assert.equal(again.documents[0].id,accepted.documents[0].id);assert.deepEqual(await counts(f),{documents:2,jobs:2,extraction_runs:0,usage_ledger:2,pages:4});
 assert.equal((await request(f.account,'DELETE',`/api/documents/${accepted.documents[0].id}`)).statusCode,200);const deleted=await addArchiveDocuments(actor(f.account),f.parserId,zipBytes,'owned.zip',id,spec);assert.equal(deleted.documents[0].available,false);assert.equal((await counts(f)).pages,4);
});

test('page preview rechecks access and document lifetime after slow storage and refuses changed originals',async()=>{
 for(const change of ['delete','revoke','corrupt'] as const){const f=await fixture(`race-${change}`),uploaded=await add(f),key=`${f.account.workspace.id}/${uploaded.document.id}`,url=`/api/documents/${uploaded.document.id}/preview?page=2`;
  if(change==='corrupt'){objects.set(key,Buffer.from('Changed original'));const response=await request(f.account,'GET',url);assert.equal(response.statusCode,409);assert.match(response.json().message,/original could not be verified/);continue;}
  const entered=gate(),resume=gate();onRead=async candidate=>{if(candidate===key){entered.release();await resume.promise;}};
  const response=request(f.account,'GET',url);await entered.promise;
  try{if(change==='delete')assert.equal((await request(f.account,'DELETE',`/api/documents/${uploaded.document.id}`)).statusCode,200);else await adminPool.query('delete from sessions where user_id=$1',[f.account.user.id]);}finally{resume.release();}
  const result=await response;assert.equal(result.statusCode,change==='delete'?404:401,result.body);assert.notEqual(result.headers['content-type'],'image/jpeg');onRead=undefined;
 }
 const text=await fixture('non-tiff','rules',null),uploaded=await add(text,randomUUID(),Buffer.from('Reference: text'));assert.equal((await request(text.account,'GET',`/api/documents/${uploaded.document.id}/preview`)).statusCode,415);
});
