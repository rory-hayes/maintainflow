import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {PDFDocument,StandardFonts,degrees} from 'pdf-lib';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {readPdfGeometry,type DecoderOptions} from '../server/core/source.js';
import {pinnedTemplateConfig} from '../server/core/template-snapshot.js';
import {bankPdfLayoutVersion} from '../shared/bank-pdf-layout.js';
import {pdfGeometryVersion} from '../shared/pdf-regions.js';
import {bankStatementSchema} from '../shared/bank-statement-preset.js';
import type {ExtractionResult,ProviderInput} from '../shared/types.js';
import {assertBankFixtureDatabase,bankRawFixture,cleanupBankFixtures,createBankFixture} from './bank-statement-fixtures.js';

// Owned synthetic inputs and fake extraction only; never contact a provider.
const objects=new Map<string,Buffer>();let storageReads=0,networkCalls=0;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){storageReads++;const value=objects.get(key);assert.ok(value,'Owned synthetic object exists');return Buffer.from(value);},async remove(key){objects.delete(key);}};
let app:Awaited<ReturnType<typeof buildApp>>,verified=false;
const originalFetch=globalThis.fetch;
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const result=():ExtractionResult=>({rawValues:bankRawFixture() as unknown as Record<string,unknown>,normalizedValues:{},evidence:{'accounts[0].bank_name':[{page:1,text:'Synthetic Example Bank',source:'matched-text'}]},issues:[],engine:'controlled-layout-fixture',model:'synthetic',promptVersion:'controlled-provider-v1'});
function provider(visit?:(input:ProviderInput)=>Promise<void>|void,forge=false){setExtractionProvider({configured:()=>true,async extract(input){await visit?.(input);return {...result(),...(forge?{tokenUsage:{bankPdfLayoutInput:{forged:true}}}:{})};}});}
async function pdf(kind:'native'|'blank'|'unsupported'|'geometry-limit'='native'){
 const doc=await PDFDocument.create({updateMetadata:false}),font=await doc.embedFont(StandardFonts.Helvetica);
 doc.setTitle('SYNTHETIC BANK LAYOUT '+randomUUID());const page=doc.addPage(kind==='geometry-limit'?[15000,700]:[600,800]);
 if(kind!=='blank')page.drawText('Synthetic Example Bank',{x:40,y:680,font,size:12,...(kind==='unsupported'?{rotate:degrees(15)}:{})});
 if(kind==='native'){page.drawText('Debit',{x:320,y:600,font,size:12});page.drawText('Credit',{x:420,y:600,font,size:12});page.drawText('50.00',{x:420,y:575,font,size:12});}
 return Buffer.from(await doc.save());
}
async function queued(f:Awaited<ReturnType<typeof createBankFixture>>,bytes?:Buffer) {bytes??=await pdf();const added=await addDocument(f.actor,f.parser.id,bytes,'synthetic-bank-layout.pdf');assert.ok(added.jobId);return {...added,jobId:added.jobId!,bytes};}
async function job(id:string){return (await adminPool.query('select * from jobs where id=$1',[id])).rows[0];}
async function run(documentId:string){return (await adminPool.query('select * from extraction_runs where document_id=$1',[documentId])).rows;}
async function noRun(source:{jobId:string;document:{id:string}},state:'queued'|'failed'='queued'){const value=await job(source.jobId);assert.equal(value.state,state,value.error);assert.equal((await run(source.document.id)).length,0);return value;}
function fakeChild(onCreate?:(child:ChildProcessWithoutNullStreams)=>void){const child=new EventEmitter() as ChildProcessWithoutNullStreams;Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false});child.kill=()=>{(child as any).killed=true;queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;};queueMicrotask(()=>onCreate?.(child));return child;}
function respond(value:unknown){return()=>fakeChild(child=>{child.stdout.emit('data',Buffer.from(JSON.stringify(value)));child.emit('close',0);});}
const mustNotDecode:DecoderOptions={spawnChild:()=>{throw new Error('Unexpected decoder invocation');}};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
before(async()=>{await assertBankFixtureDatabase();verified=true;globalThis.fetch=async()=>{networkCalls++;throw new Error('Network is forbidden in bank layout fixtures');};setStorageForTests(storage);app=await buildApp();});
afterEach(()=>{setExtractionProvider(undefined);assert.equal(networkCalls,0);});
after(async()=>{await app?.close();if(verified)await cleanupBankFixtures();setStorageForTests(undefined);globalThis.fetch=originalFetch;await closeDatabase();});

test('new bank snapshots pin layout while generic snapshots do not',()=>{
 const parser={mode:'ai',instructions:'synthetic',locale:'en-IE',timezone:'UTC',use_case:'bank_statement'};
 assert.equal(pinnedTemplateConfig(parser,[]).bankPdfLayoutVersion,bankPdfLayoutVersion);
 assert.equal(Object.hasOwn(pinnedTemplateConfig({...parser,use_case:'custom'},[]),'bankPdfLayoutVersion'),false);
});

test('new bank PDF uses real isolated geometry, unchanged original/native pages and worker-owned provenance',async()=>{
 const f=await createBankFixture(app),source=await queued(f);const pinned=(await job(source.jobId)).config;
 assert.equal(pinned.bankPdfLayoutVersion,bankPdfLayoutVersion);const native=structuredClone(source.document.sourceText);
 provider(input=>{assert.deepEqual(input.bytes,source.bytes);assert.deepEqual(input.pages,native);assert.ok(input.bankPdfLayout&&'geometry' in input.bankPdfLayout);assert.equal(input.bankPdfLayout.version,bankPdfLayoutVersion);const geometry=input.bankPdfLayout.geometry;assert.equal(geometry.sourceSha256,sha(source.bytes));assert.equal(geometry.pageCount,1);const credit=geometry.pages[0].items.find(item=>item.text==='Credit'),amount=geometry.pages[0].items.find(item=>item.text==='50.00');assert.ok(credit&&amount);assert.equal(credit.rect.x,amount.rect.x);},true);
 assert.equal(await processOneCoreJob(source.jobId),true);assert.equal((await job(source.jobId)).state,'completed');const [saved]=await run(source.document.id);
 assert.deepEqual(saved.raw_values,result().rawValues);assert.deepEqual(saved.evidence,result().evidence);assert.equal(saved.prompt_version,'controlled-provider-v1');
 const p=saved.token_usage.bankPdfLayoutInput;assert.equal(p.version,bankPdfLayoutVersion);assert.equal(p.sourceSha256,sha(source.bytes));assert.equal(p.sourceByteSize,source.bytes.length);assert.equal(p.pageCountVerification,'geometry');assert.equal(p.forged,undefined);assert.equal(p.status,'included');
 assert.deepEqual((await job(source.jobId)).config,pinned);assert.deepEqual((await adminPool.query('select source_text from documents where id=$1',[source.document.id])).rows[0].source_text,native);
 const reprocess=await f.request('POST',`/api/documents/${source.document.id}/reprocess`);assert.equal(reprocess.statusCode,200,reprocess.body);assert.equal((await job(reprocess.json().job.id)).config.bankPdfLayoutVersion,bankPdfLayoutVersion);
});

test('old bank PDFs, generic PDFs and new non-PDF bank jobs do not decode or supply bank layout',async()=>{
 const f=await createBankFixture(app),old=await queued(f);await adminPool.query("update jobs set config=config-'bankPdfLayoutVersion' where id=$1",[old.jobId]);
 const text=await f.queue('new-bank-text');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','3') where id=$1",[f.actor.workspaceId]);const generic=await f.request('POST','/api/parsers',{name:'Owned generic PDF',useCase:'custom',mode:'ai',locale:'en-IE',schema:bankStatementSchema});assert.equal(generic.statusCode,201,generic.body);
 const other=await addDocument(f.actor,generic.json().parser.id,await pdf(),'synthetic-generic.pdf');assert.ok(other.jobId);
 let calls=0;provider(input=>{calls++;assert.equal(input.bankPdfLayout,undefined);});
 for(const source of [old,text,{...other,jobId:other.jobId!}]){assert.equal(await processOneCoreJob(source.jobId,{pdfGeometryOptions:mustNotDecode}),true);assert.equal((await job(source.jobId)).state,'completed');assert.equal((await run(source.document.id))[0].token_usage.bankPdfLayoutInput,undefined);}
 assert.equal(calls,3);
});

test('unknown, null and non-bank layout markers fail before source reads or decoder/provider work',async()=>{
 for(const patch of [{bankPdfLayoutVersion:'future-version'},{bankPdfLayoutVersion:null},{useCase:'custom',bankWorkflow:null}]){
  const f=await createBankFixture(app),source=await queued(f);await adminPool.query('update jobs set config=config||$2::jsonb where id=$1',[source.jobId,JSON.stringify(patch)]);storageReads=0;let calls=0;provider(()=>{calls++;});
  assert.equal(await processOneCoreJob(source.jobId,{pdfGeometryOptions:mustNotDecode}),true);const failed=await noRun(source,'failed');assert.match(failed.error,/unsupported bank PDF input version/);assert.equal(storageReads,0);assert.equal(calls,0);
 }
});

test('altered original bytes, byte size and malformed intake page metadata fail before decode or provider',async()=>{
 for(const changed of ['bytes','byte_size','pages'] as const){
  const f=await createBankFixture(app),source=await queued(f);if(changed==='bytes')objects.set(source.document.storageKey,Buffer.from('%PDF-altered synthetic original'));
  else if(changed==='byte_size')await adminPool.query('update documents set byte_size=byte_size+1 where id=$1',[source.document.id]);
  else await adminPool.query('update documents set source_text=$2 where id=$1',[source.document.id,JSON.stringify([{page:2,text:'Synthetic Example Bank'}])]);
  let calls=0;provider(()=>{calls++;});await processOneCoreJob(source.jobId,{pdfGeometryOptions:mustNotDecode});await noRun(source,'failed');assert.equal(calls,0);
 }
});

test('fresh geometry page count must equal intake count before provider invocation',async()=>{
 const f=await createBankFixture(app),source=await queued(f);await adminPool.query('update documents set page_count=2,source_text=$2 where id=$1',[source.document.id,JSON.stringify([{page:1,text:'Synthetic Example Bank'},{page:2,text:''}])]);let calls=0;provider(()=>{calls++;});
 await processOneCoreJob(source.jobId);const failed=await noRun(source,'failed');assert.match(failed.error,/page count or source identity changed/);assert.equal(calls,0);
});

test('real blank, unsupported geometry and stricter geometry-limit PDFs preserve original-only extraction and provenance',async()=>{
 for(const kind of ['blank','unsupported','geometry-limit'] as const){
  const f=await createBankFixture(app),source=await queued(f,await pdf(kind));provider(input=>{assert.deepEqual(input.bytes,source.bytes);assert.deepEqual(input.pages,source.document.sourceText);assert.ok(input.bankPdfLayout);});
  await processOneCoreJob(source.jobId);const state=await job(source.jobId);assert.equal(state.state,'completed',state.error);const [saved]=await run(source.document.id),p=saved.token_usage.bankPdfLayoutInput;assert.equal(p.sourceSha256,sha(source.bytes));assert.equal(p.sourceByteSize,source.bytes.length);
  if(kind==='geometry-limit'){assert.equal(p.status,'omitted_geometry_limit');assert.equal(p.geometryVersion,pdfGeometryVersion);assert.equal(p.pageCountVerification,'intake_source_hash');for(const key of ['itemCount','pagesWithNativeText','serializedBytes','unavailablePages'])assert.equal(Object.hasOwn(p,key),false);}
  else{assert.equal(p.status,'included');assert.deepEqual(p.unavailablePages,[{page:1,reason:kind==='blank'?'no_native_text':'unsupported_text_geometry'}]);}
 }
});

test('malformed IPC, invalid geometry, spawn errors and decoder timeout never invoke provider fallback',async()=>{
 const options:DecoderOptions[]=[{spawnChild:respond({ok:true,geometry:{}})},{spawnChild:respond({ok:false,code:'pdf_geometry_failed',reason:'geometry_invalid'})},{spawnChild:()=>{throw new Error('synthetic spawn failure');}},{spawnChild:()=>fakeChild(),timeoutMs:10}];
 for(const pdfGeometryOptions of options){const f=await createBankFixture(app),source=await queued(f);let calls=0;provider(()=>{calls++;});await processOneCoreJob(source.jobId,{pdfGeometryOptions});await noRun(source);assert.equal(calls,0);}
});

test('outer deadline aborts a held geometry child and prevents any late provider/save',async()=>{
 const f=await createBankFixture(app),source=await queued(f);let child:ChildProcessWithoutNullStreams|undefined,calls=0;provider(()=>{calls++;});
 await processOneCoreJob(source.jobId,{providerTimeoutMs:500,pdfGeometryOptions:{spawnChild:()=>child=fakeChild()}});assert.ok(child);assert.equal(child.killed,true);const state=await noRun(source);assert.match(state.error,/90-second timeout/);assert.equal(calls,0);
});

test('worker shutdown aborts the same geometry signal and shared decoder capacity is not bypassed',async()=>{
 const f=await createBankFixture(app),source=await queued(f),started=deferred(),controller=new AbortController();let child:ChildProcessWithoutNullStreams|undefined,calls=0;provider(()=>{calls++;});
 const processing=processOneCoreJob(source.jobId,{signal:controller.signal,pdfGeometryOptions:{spawnChild:()=>{child=fakeChild();started.resolve();return child;}}});await started.promise;controller.abort();await processing;assert.equal(child!.killed,true);await noRun(source);assert.equal(calls,0);
 const other=await queued(f);const held:ChildProcessWithoutNullStreams[]=[];const spawnChild=()=>{const c=fakeChild();held.push(c);return c;};
 const occupied=[readPdfGeometry(source.bytes,{spawnChild}),readPdfGeometry(source.bytes,{spawnChild})];const cleanup=Promise.allSettled(occupied);
 try{await processOneCoreJob(other.jobId,{pdfGeometryOptions:{spawnChild:()=>{throw Error('capacity should stop before spawn');}}});const state=await noRun(other);assert.match(state.error,/decoding is busy/);assert.equal(calls,0);}finally{for(const c of held)c.kill('SIGKILL');await cleanup;}
});

test('late provider completion after the shared deadline cannot save a run',async()=>{
 const f=await createBankFixture(app),source=await queued(f),held=deferred(),started=deferred();let signal:AbortSignal|undefined;
 provider(async input=>{signal=input.signal;started.resolve();await held.promise;});
 const processing=processOneCoreJob(source.jobId,{providerTimeoutMs:5000});await started.promise;await processing;assert.equal(signal?.aborted,true);await noRun(source);held.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal((await run(source.document.id)).length,0);
});

test('source identity changes during provider work prevent saving both included and omitted layouts',async()=>{
 const mutations=["sha256=repeat('b',64)","storage_key=storage_key||'-changed'","mime_type='text/plain'","page_count=page_count+1","byte_size=byte_size+1"];
 for(const [index,mutation] of mutations.entries()){
  const f=await createBankFixture(app),source=await queued(f,await pdf(index%2?'geometry-limit':'native'));provider(async()=>{await adminPool.query(`update documents set ${mutation} where id=$1`,[source.document.id]);});
  await processOneCoreJob(source.jobId);const state=await noRun(source,'failed');assert.match(state.error,/changed before its extraction result could be saved/);
 }
 const f=await createBankFixture(app),source=await queued(f);provider(async()=>{await adminPool.query('delete from documents where id=$1',[source.document.id]);});await processOneCoreJob(source.jobId);assert.equal((await run(source.document.id)).length,0);assert.equal(await job(source.jobId),undefined);
});
