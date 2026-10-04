import {legacyBankStatementSchema} from '../shared/bank-statement-preset.js';
import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {assertBankFixtureDatabase,bankRawFixture,legacyBankRawFixture,createLegacyBankFixture,cleanupBankFixtures,createBankFixture,setBankFixtureProvider} from './bank-statement-fixtures.js';
let app:Awaited<ReturnType<typeof buildApp>>,networkCalls=0;
const originalFetch=globalThis.fetch;
before(async()=>{await assertBankFixtureDatabase();globalThis.fetch=async()=>{networkCalls++;throw new Error('External network forbidden in bank locale fixtures');};app=await buildApp();});
afterEach(()=>{setExtractionProvider(undefined);setStorageForTests(undefined);assert.equal(networkCalls,0);});
after(async()=>{setExtractionProvider(undefined);setStorageForTests(undefined);globalThis.fetch=originalFetch;await app?.close();await cleanupBankFixtures();await closeDatabase();});
const hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const config=async(id:string)=>(await adminPool.query('select config from jobs where id=$1',[id])).rows[0].config;
const counts=async(workspace:string)=>(await adminPool.query('select (select count(*)::int from documents where workspace_id=$1) documents,(select count(*)::int from jobs where workspace_id=$1) jobs,(select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages',[workspace])).rows[0];
function multipart(bytes:Buffer){const boundary='bank-'+randomUUID();return {payload:Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned-bank.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]),headers:{'content-type':`multipart/form-data; boundary=${boundary}`}};}
function useStorage(){const objects=new Map<string,Buffer>();const storage:PrivateStorage={kind:'supabase',async signUpload(key){return `https://owned.example.test/${key}`;},async write(key,value){objects.set(key,Buffer.from(value));},async read(key){const value=objects.get(key);assert.ok(value,'Owned staging bytes must exist');return Buffer.from(value);},async remove(key){objects.delete(key);}};setStorageForTests(storage);return objects;}

test('concurrent multipart bank batches pin their selected locale and exact duplicates retain the original job and usage',async()=>{
 const f=await createBankFixture(app);await f.request('POST','/api/bank-statements/setup',{locale:'de-DE'});
 const send=async(bytes:Buffer,locale:string)=>{const data=multipart(bytes);return app.inject({method:'POST',url:`/api/parsers/${f.parser.id}/documents?bankLocale=${locale}`,headers:{...f.headers,...data.headers},payload:data.payload});};
 const usBytes=Buffer.from('Owned US locale '+randomUUID()),deBytes=Buffer.from('Owned DE locale '+randomUUID());
 const [us,de]=await Promise.all([send(usBytes,'en-US'),send(deBytes,'de-DE')]);assert.equal(us.statusCode,202,us.body);assert.equal(de.statusCode,202,de.body);assert.equal((await config(us.json().jobId)).locale,'en-US');assert.equal((await config(de.json().jobId)).locale,'de-DE');assert.equal((await adminPool.query('select locale from parsers where id=$1',[f.parser.id])).rows[0].locale,'de-DE');
 const raw=bankRawFixture();raw.accounts[0].date_format='Dates use MM/DD/YYYY.';raw.accounts[0].transactions[0].date='09/02/2026';setBankFixtureProvider(raw);await processOneCoreJob(us.json().jobId);const run=(await f.detail(us.json().document.id)).runs[0];assert.equal(run.bankContext.locale,'en-US');assert.equal(run.bankValues.accounts[0].transactions[0].date,'2026-09-02');
 const before=await counts(f.actor.workspaceId),duplicate=await send(usBytes,'de-DE');assert.equal(duplicate.statusCode,202,duplicate.body);assert.equal(duplicate.json().duplicate,true);assert.equal(duplicate.json().document.id,us.json().document.id);assert.equal(duplicate.json().jobId,null);assert.deepEqual(await counts(f.actor.workspaceId),before);assert.equal((await config(us.json().jobId)).locale,'en-US');
 assert.equal((await send(Buffer.from('invalid'),'fr-FR')).statusCode,400);
});

test('signed bank reservations preserve locale through changed defaults, failed verification retry, finalization replay and duplicate bytes',async()=>{
 const f=await createBankFixture(app),objects=useStorage(),bytes=Buffer.from('Owned signed locale '+randomUUID());
 const reserve=async(locale:string)=>f.request('POST',`/api/parsers/${f.parser.id}/uploads`,{filename:'bank.txt',size:bytes.length,sha256:hash(bytes),bankLocale:locale});
 const reserved=await reserve('en-US');assert.equal(reserved.statusCode,201,reserved.body);const id=reserved.json().uploadId,key=`${f.actor.workspaceId}/${id}`;assert.equal((await adminPool.query('select bank_locale from direct_uploads where id=$1',[id])).rows[0].bank_locale,'en-US');
 await assert.rejects(adminPool.query("update direct_uploads set bank_locale='fr-FR' where id=$1",[id]),(error:any)=>error.code==='23514');
 await assert.rejects(adminPool.query('update direct_uploads set pdf_split_request_id=$2 where id=$1',[id,randomUUID()]),(error:any)=>error.code==='23514');
 await f.request('POST','/api/bank-statements/setup',{locale:'de-DE'});
 // A transient missing staging object leaves the same reservation available for retry.
 assert.equal((await f.request('POST',`/api/uploads/${id}/finalize`)).statusCode,500);objects.set(key,bytes);
 const finalized=await f.request('POST',`/api/uploads/${id}/finalize`);assert.equal(finalized.statusCode,202,finalized.body);const result=finalized.json();assert.equal((await config(result.jobId)).locale,'en-US');
 const raw=bankRawFixture();raw.accounts[0].date_format='Dates use MM/DD/YYYY.';raw.accounts[0].transactions[0].date='09/02/2026';setBankFixtureProvider(raw);await processOneCoreJob(result.jobId);const run=(await f.detail(result.document.id)).runs[0];assert.equal(run.bankContext.locale,'en-US');assert.equal(run.bankValues.accounts[0].opening_balance,'1000.00');assert.equal(run.bankValues.accounts[0].transactions[0].date,'2026-09-02');
 const before=await counts(f.actor.workspaceId),replay=await f.request('POST',`/api/uploads/${id}/finalize`);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().replayed,true);assert.equal(replay.json().jobId,result.jobId);assert.deepEqual(await counts(f.actor.workspaceId),before);
 const other=await reserve('de-DE');assert.equal(other.statusCode,201,other.body);objects.set(`${f.actor.workspaceId}/${other.json().uploadId}`,bytes);const duplicate=await f.request('POST',`/api/uploads/${other.json().uploadId}/finalize`);assert.equal(duplicate.statusCode,202,duplicate.body);assert.equal(duplicate.json().duplicate,true);assert.equal(duplicate.json().document.id,result.document.id);assert.deepEqual(await counts(f.actor.workspaceId),before);
 for(const body of [{bankLocale:'fr-FR'},{bankLocale:'en-US',pdfSplit:{requestId:randomUUID()}},{bankLocale:'en-US',archiveImport:{requestId:randomUUID()}}]){const response=await f.request('POST',`/api/parsers/${f.parser.id}/uploads`,{filename:'bank.txt',size:bytes.length,sha256:hash(bytes),...body});assert.equal(response.statusCode,400,response.body);}
});

test('bank reprocessing preserves the original context or failed-job locale, accepts explicit change and rejects nonbank overrides',async()=>{
 const f=await createBankFixture(app,'en-US'),source=await f.upload();await f.request('POST','/api/bank-statements/setup',{locale:'de-DE'});
 // Job retention keeps the run's locale, but cannot reconstruct lost settings.
 await adminPool.query('delete from jobs where id=$1',[source.jobId]);const lost=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(lost.statusCode,409,lost.body);let replay=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankUseCurrentPreset:true});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().job.config.locale,'en-US');setBankFixtureProvider(bankRawFixture());await processOneCoreJob(replay.json().job.id);
 replay=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankLocale:'en-IE'});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().job.config.locale,'en-IE');assert.equal((await adminPool.query('select locale from parsers where id=$1',[f.parser.id])).rows[0].locale,'de-DE');
 const failed=await addDocument(f.actor,f.parser.id,Buffer.from('Owned failed bank '+randomUUID()),'failed.txt',undefined,undefined,{bankLocale:'en-US'});await adminPool.query("update jobs set state='failed' where id=$1",[failed.jobId]);await adminPool.query("update documents set status='failed' where id=$1",[failed.document.id]);const retry=await f.request('POST',`/api/documents/${failed.document.id}/reprocess`);assert.equal(retry.statusCode,200,retry.body);assert.equal(retry.json().job.config.locale,'en-US');
 assert.equal((await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankLocale:'fr-FR'})).statusCode,400);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','2') where id=$1",[f.actor.workspaceId]);const created=await f.request('POST','/api/parsers',{name:'Owned generic parser',mode:'rules',schema:{fields:[{key:'value',label:'Value',type:'string'}]}});assert.equal(created.statusCode,201,created.body);const generic=created.json().parser;
 const bytes=Buffer.from('Owned generic '+randomUUID());await assert.rejects(addDocument(f.actor,generic.id,bytes,'generic.txt',undefined,undefined,{bankLocale:'en-US'}),(error:any)=>error.statusCode===400);
 useStorage();assert.equal((await f.request('POST',`/api/parsers/${generic.id}/uploads`,{filename:'generic.txt',size:bytes.length,sha256:hash(bytes),bankLocale:'en-US'})).statusCode,400);
 const data=multipart(bytes);assert.equal((await app.inject({method:'POST',url:`/api/parsers/${generic.id}/documents?bankLocale=en-US`,headers:{...f.headers,...data.headers},payload:data.payload})).statusCode,400);
 const genericSource=await addDocument(f.actor,generic.id,bytes,'generic.txt');assert.equal((await f.request('POST',`/api/documents/${genericSource.document.id}/reprocess`,{bankLocale:'en-US'})).statusCode,400);
 for(const suffix of ['pdf-splits','archive-imports','archive-imports/preview']){const response=await app.inject({method:'POST',url:`/api/parsers/${f.parser.id}/${suffix}?bankLocale=en-US`,headers:{...f.headers,...data.headers},payload:data.payload});assert.equal(response.statusCode,400,response.body);}
});


test('legacy locale-only date and punctuation snapshots survive modern preset adoption and changed parser defaults',async()=>{
 for(const locale of ['en-US','de-DE']as const){const f=await createLegacyBankFixture(app,locale),source=await f.queue('legacy-locale-'+locale),raw=legacyBankRawFixture();raw.accounts[0].transactions[0].date=locale==='en-US'?'09/02/2026':'02/09/2026';
  if(locale==='de-DE'){raw.accounts[0].opening_balance='1.000,00';raw.accounts[0].closing_balance='1.030,00';raw.accounts[0].total_debits='20,00';raw.accounts[0].total_credits='50,00';raw.accounts[0].transactions[0].debit='20,00';raw.accounts[0].transactions[0].balance='980,00';raw.accounts[0].transactions[1].credit='50,00';raw.accounts[0].transactions[1].balance='1.030,00';}
  setBankFixtureProvider(raw,legacyBankStatementSchema);await processOneCoreJob(source.jobId);const old=(await f.detail(source.document.id)).runs[0];assert.equal(old.bankValues.accounts[0].opening_balance,'1000.00');assert.equal(old.bankValues.accounts[0].transactions[0].date,'2026-09-02');assert.ok(Object.values(old.bankContext.accounts).every((a:any)=>a.formats===undefined));
  const snapshot=(await adminPool.query('select schema_version_id,config from jobs where id=$1',[source.jobId])).rows[0];const setup=await f.request('POST','/api/bank-statements/setup',{locale:locale==='en-US'?'de-DE':'en-US'});assert.equal(setup.statusCode,200,setup.body);const replay=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(replay.statusCode,200,replay.body);assert.deepEqual((await adminPool.query('select schema_version_id,config from jobs where id=$1',[replay.json().job.id])).rows[0],snapshot);setBankFixtureProvider(raw,legacyBankStatementSchema);await processOneCoreJob(replay.json().job.id);const again=(await f.detail(source.document.id)).runs[0];assert.equal(again.bankValues.accounts[0].opening_balance,'1000.00');assert.equal(again.bankValues.accounts[0].transactions[0].date,'2026-09-02');assert.equal(again.bankContext.locale,locale);
 }
});
