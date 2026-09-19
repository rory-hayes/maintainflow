import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import {ArchiveImportValidationError,archiveImportValidationReasons,canonicalArchiveImportSpec,type ArchiveImportSpec} from '../shared/archive-import.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,withWorkspace,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addArchiveDocuments,previewArchiveDocuments} from '../server/core/archive-import-intake.js';
import {addSplitDocuments} from '../server/core/pdf-split-intake.js';
import {addDocument} from '../server/core/intake.js';
import {importArchiveSource,previewArchiveSource} from '../server/core/source.js';
import {ParserFormatNotAllowedError} from '../server/core/intake-policy.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {reserveDirectUpload,finalizeDirectUpload,previewDirectArchive,confirmDirectArchive,reconcileExpiredDirectUploads} from '../server/core/upload-routes.js';
import {deleteStoredFile,purgeArchiveImport} from '../server/core/retention.js';
import {reconcileInterruptedIntake} from '../server/core/object-reconciliation.js';
import {readArchiveImportReceipt} from '../server/core/archive-import-records.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;schemaId:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>(),hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
let app:FastifyInstance,verified=false,zipBytes:Buffer,pdf:Buffer,decoded:Awaited<ReturnType<typeof previewArchiveSource>>,writes=0,reads=0,removes=0,fetches=0;
let selected:ArchiveImportSpec,twins:ArchiveImportSpec,one:ArchiveImportSpec;
const leaf=Buffer.from('Reference: OWNED-ARCHIVE\nTotal: 42');
let onWrite:((key:string,bytes:Buffer)=>Promise<void>)|undefined,onRead:((key:string)=>Promise<void>)|undefined,failRemove=false;
const originalFetch=globalThis.fetch;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){writes++;await onWrite?.(key,bytes);objects.set(key,Buffer.from(bytes));},async read(key){reads++;await onRead?.(key);const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned staging fixture missing'),{statusCode:404});return Buffer.from(bytes);},async remove(key){removes++;if(failRemove)throw new Error('Owned physical removal failure');objects.delete(key);},async signUpload(key){return `https://owned.example.test/upload/${key}`;}};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
async function request(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={}){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,...headers}});}
async function fixture(label:string):Promise<Fixture>{
 const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned ZIP import',workspaceName:`Owned ZIP ${label}`,email:`archive-${randomUUID()}@example.test`,password:'Owned ZIP fixture password'}});assert.equal(response.statusCode,201,response.body);
 const a={...response.json(),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(a);
 await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{monthlyPages}','1000'),'{maxParsers}','30') where id=$1",[a.workspace.id]);
 const created=await request(a,'POST','/api/parsers',{name:'Owned ZIP parser',useCase:'custom',mode:'rules',schema:{fields:[{key:'reference',label:'Reference',type:'string',anchor:'Reference'}]}});assert.equal(created.statusCode,201,created.body);
 return {account:a,parserId:created.json().parser.id,schemaId:created.json().schema.id};
}
async function add(f:Fixture,spec:ArchiveImportSpec=selected,id=randomUUID(),options:Parameters<typeof addArchiveDocuments>[6]={}){return addArchiveDocuments(actor(f.account),f.parserId,zipBytes,'PRIVATE-original.zip',id,spec,options);}
async function controlled(_bytes:Buffer,_name:string,spec:ArchiveImportSpec,_options?:unknown){
 const parts=decoded.parts.filter(part=>spec.entries.includes(part.index)).map(part=>({...part,bytes:Buffer.from(part.bytes),source:{...part.source,pages:part.source.pages.map(page=>({...page}))}}));
 return {...decoded,entries:decoded.entries.map(entry=>({...entry})),parts,totalPages:parts.reduce((sum,part)=>sum+part.source.pageCount,0)};
}
async function counts(f:Fixture){const out:Record<string,number>={};for(const table of ['archive_imports','archive_import_entries','documents','jobs','usage_ledger','intake_files','file_deletions'])out[table]=(await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`,[f.account.workspace.id])).rows[0].n;out.pages=(await adminPool.query('select coalesce(sum(pages),0)::int n from usage_ledger where workspace_id=$1',[f.account.workspace.id])).rows[0].n;return out;}
const status=(n:number)=>(error:any)=>{assert.equal(error.statusCode,n);return true;};
function gate(){let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});return {pending,release};}
async function until(check:()=>boolean){for(let i=0;i<1000&&!check();i++)await new Promise(r=>setTimeout(r,5));assert.ok(check());}
function multipart(bytes:Buffer,id:string,spec?:ArchiveImportSpec,extra?:string){const boundary=`owned-${randomUUID()}`;const fields=[['requestId',id],...(spec?[['options',JSON.stringify(spec)]]:[]),...(extra?[['unexpected',extra]]:[])];return {headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([...fields.map(([key,value])=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)),Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned.zip"\r\nContent-Type: application/zip\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])};}
before(async()=>{

 assert.equal(databaseSchema,'public');
 const pools=[[adminPool,'folio_admin'],[appPool,'folio_app']] as const,urlMode=Boolean(adminPool.options.connectionString||appPool.options.connectionString);
 for(const [pool,role] of pools){
  if(urlMode){
   assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(process.env.DATABASE_ADMIN_URL&&process.env.DATABASE_URL);
   assert.equal(typeof pool.options.connectionString,'string');const url=new URL(pool.options.connectionString!);
   assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');
  }else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];
  assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,urlMode?5432:55432);if(!urlMode)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No external calls in archive fixtures');};app=await buildApp();
 const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica);for(let i=1;i<=2;i++)document.addPage([300,300]).drawText(`Reference: OWNED-PDF-${i}`,{font,x:20,y:250,size:12});pdf=Buffer.from(await document.save());
 const zip=new JSZip();zip.folder('docs');zip.file('docs/repeated.txt',leaf);zip.file('other/repeated.txt',leaf);zip.file('invoice.pdf',pdf);zip.file('unselected.csv','Column,Value\nprivate,omitted');zip.file('unsupported.exe',Buffer.from([0x7f,0x45,0x4c,0x46,1]));zip.file('.DS_Store',Buffer.from([0,0,0,1,66,117,100,49]));zipBytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 decoded=await previewArchiveSource(zipBytes,'owned.zip');
 const index=(path:string)=>decoded.entries.find(e=>e.path===path)!.index;
 selected={mode:'zip',version:1,sourceSha256:hash(zipBytes),entries:[index('docs/repeated.txt'),index('invoice.pdf')]};twins={...selected,entries:[index('docs/repeated.txt'),index('other/repeated.txt')]};one={...selected,entries:[index('docs/repeated.txt')]};
});
afterEach(()=>{onWrite=undefined;onRead=undefined;failRemove=false;setStorageForTests(storage);assert.equal(fetches,0);});
after(async()=>{setStorageForTests(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts){await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);await adminPool.query('delete from users where id=$1',[a.user.id]);await fs.rm(path.join(config.storageDir,a.workspace.id),{recursive:true,force:true});}}}finally{objects.clear();await closeDatabase();}});

test('preview lists all files without acceptance, and selected import preserves exact source and central-entry lineage',async()=>{
 const f=await fixture('real'),id=randomUUID(),beforeWrites=writes;
 const payload=multipart(zipBytes,id),preview=await request(f.account,'POST',`/api/parsers/${f.parserId}/archive-imports/preview`,payload.payload,payload.headers);
 assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().requestId,id);assert.equal(preview.json().parserId,f.parserId);assert.equal(preview.json().sourceSha256,hash(zipBytes));assert.equal(preview.json().sourceByteSize,zipBytes.length);
 assert.ok(preview.json().entries.some((e:any)=>e.status==='metadata'));assert.ok(preview.json().entries.some((e:any)=>e.status==='unsupported'));assert.ok(!('parts'in preview.json()));assert.equal(writes,beforeWrites);assert.equal((await counts(f)).pages,0);assert.equal((await counts(f)).archive_imports,0);
 const body=multipart(zipBytes,id,selected),accepted=await request(f.account,'POST',`/api/parsers/${f.parserId}/archive-imports`,body.payload,body.headers);assert.equal(accepted.statusCode,202,accepted.body);const result=accepted.json();
 assert.equal(result.archive.totalPages,3);assert.equal(result.archive.childCount,2);assert.deepEqual(result.documents.map((d:any)=>d.index),selected.entries);assert.deepEqual(result.documents.map((d:any)=>d.path),['docs/repeated.txt','invoice.pdf']);assert.deepEqual(result.documents.map((d:any)=>d.pageCount),[1,2]);assert.deepEqual(objects.get(`${f.account.workspace.id}/${result.archive.id}`),zipBytes);
 for(const d of result.documents){const entry=decoded.parts.find(part=>part.index===d.index)!;assert.deepEqual(objects.get(`${f.account.workspace.id}/${d.id}`),entry.bytes);const row=(await adminPool.query('select * from documents where id=$1',[d.id])).rows[0];assert.equal(row.sha256,hash(entry.bytes));assert.deepEqual(row.source_text,entry.source.pages);}
 const jobs=(await adminPool.query('select * from jobs where workspace_id=$1',[f.account.workspace.id])).rows;assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.schema_version_id===f.schemaId&&!j.waiting_for_schema));assert.deepEqual(jobs[0].config,jobs[1].config);
 const events=(await adminPool.query('select metadata from audit_events where workspace_id=$1',[f.account.workspace.id])).rows;assert.ok(!JSON.stringify(events).includes('PRIVATE'));assert.ok(!JSON.stringify(events).includes('docs/repeated'));assert.ok(!JSON.stringify(result).includes(hash(zipBytes)));
 assert.deepEqual(await counts(f),{archive_imports:1,archive_import_entries:2,documents:2,jobs:2,usage_ledger:2,intake_files:0,file_deletions:0,pages:3});
});

test('duplicate leaf bytes retain distinct archive identities and never alias ordinary deduplication',async()=>{
 const f=await fixture('duplicates'),ordinary=await addDocument(actor(f.account),f.parserId,leaf,'ordinary.txt');
 const result=await add(f,twins);assert.equal(result.documents.length,2);assert.notEqual(result.documents[0].id,result.documents[1].id);assert.ok(result.documents.every(d=>d.id!==ordinary.document.id));assert.deepEqual(result.documents.map(d=>d.name),['repeated.txt','repeated.txt']);
 const again=await addDocument(actor(f.account),f.parserId,leaf,'ordinary.txt');assert.equal(again.document.id,ordinary.document.id);assert.equal(again.duplicate,true);assert.equal((await counts(f)).pages,3);
});

test('request replay binds source/parser/selection before decode and preserves accepted identity at exhausted quota',async()=>{
 const f=await fixture('replay'),id=randomUUID(),first=await add(f,selected,id),state=await counts(f),beforeWrites=writes;
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','3') where id=$1",[f.account.workspace.id]);await adminPool.query("update parsers set archived=true,allowed_formats=ARRAY['csv'] where id=$1",[f.parserId]);
 const forbidden=async()=>{throw new Error('Replay must not decode');};
 const repeated=await add(f,selected,id,{importSource:forbidden});assert.equal(repeated.replayed,true);assert.equal(repeated.archive.id,first.archive.id);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),state);
 await assert.rejects(add(f,twins,id,{importSource:forbidden}),status(409));
 const read=await request(f.account,'GET',`/api/parsers/${f.parserId}/archive-imports/requests/${id}`);assert.equal(read.statusCode,200,read.body);
});

test('selected unsupported entries and current leaf policies reject durably without originals or charges',async()=>{
 const f=await fixture('reject'),bad={...selected,entries:[decoded.entries.find(e=>e.status==='unsupported')!.index]},id=randomUUID(),beforeWrites=writes;
 await assert.rejects(add(f,bad,id),(e:any)=>e instanceof ArchiveImportValidationError&&e.reason==='selection_mismatch');
 await assert.rejects(add(f,bad,id,{importSource:async()=>{throw new Error('Durable rejection must not decode');}}),(e:any)=>e instanceof ArchiveImportValidationError&&e.reason==='selection_mismatch');
 await adminPool.query("update parsers set allowed_formats=ARRAY['txt'] where id=$1",[f.parserId]);
 const preview=await previewArchiveDocuments(actor(f.account),f.parserId,zipBytes,'owned.zip',randomUUID());const blocked=preview.entries.find(e=>e.path==='invoice.pdf')!;assert.equal(blocked.status,'unsupported');assert.equal(blocked.format,'pdf');assert.equal(preview.totalPages,2);
 await assert.rejects(add(f,selected),e=>e instanceof ParserFormatNotAllowedError&&e.format==='pdf');
 assert.equal(writes,beforeWrites);const state=await counts(f);assert.equal(state.archive_imports,2);assert.equal(state.documents,0);assert.equal(state.pages,0);assert.equal(state.intake_files,0);
});

test('finite archive rejection reasons are constrained and status-only/forged adapter failures remain retryable',async()=>{
 const f=await fixture('catalogue');
 for(const reason of Object.keys(archiveImportValidationReasons) as Array<keyof typeof archiveImportValidationReasons>){await assert.rejects(add(f,one,randomUUID(),{importSource:async()=>{throw new ArchiveImportValidationError(reason);}}),e=>e instanceof ArchiveImportValidationError&&e.reason===reason);}
 assert.equal((await counts(f)).archive_imports,Object.keys(archiveImportValidationReasons).length);
 const id=randomUUID(),beforeWrites=writes;
 await assert.rejects(add(f,selected,id,{importSource:async()=>{throw Object.assign(new Error('PRIVATE unknown decoder fault'),{statusCode:400});}}),status(400));
 await assert.rejects(add(f,selected,id,{importSource:async(...args)=>{const result=await controlled(...args);result.parts[0].sha256='0'.repeat(64);return result;}}),status(503));
 assert.equal(writes,beforeWrites);assert.equal((await counts(f)).archive_imports,Object.keys(archiveImportValidationReasons).length);assert.equal((await counts(f)).pages,0);
 await add(f,selected,id,{importSource:controlled});assert.equal((await counts(f)).pages,3);
});

test('concurrent identical archive requests commit once and preserve race-loser cleanup accounting',async()=>{
 const f=await fixture('same-race'),id=randomUUID(),hold=gate();let started=0;onWrite=async()=>{started++;await hold.pending;};
 const pending=[add(f,twins,id,{importSource:controlled}),add(f,twins,id,{importSource:controlled})];await until(()=>started===4);hold.release();const result=await Promise.all(pending);
 assert.equal(result[0].archive.id,result[1].archive.id);assert.equal(result.filter(r=>!r.replayed).length,1);const state=await counts(f);assert.equal(state.documents,2);assert.equal(state.pages,2);assert.equal(state.intake_files,3);assert.equal(state.file_deletions,3);
});

test('competing archive requests consume actual selected pages atomically without partial acceptance',async()=>{
 const f=await fixture('quota-race');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','2') where id=$1",[f.account.workspace.id]);
 const hold=gate();let started=0;onWrite=async()=>{started++;await hold.pending;};const pending=[add(f,twins,randomUUID(),{importSource:controlled}),add(f,twins,randomUUID(),{importSource:controlled})];await until(()=>started===4);hold.release();const results=await Promise.allSettled(pending);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.statusCode,429);const state=await counts(f);assert.equal(state.archive_imports,1);assert.equal(state.documents,2);assert.equal(state.jobs,2);assert.equal(state.pages,2);
});

test('commit-time leaf policy changes reject all children and retain failed-write cleanup intents',async()=>{
 const f=await fixture('policy-race');let changed=false;onWrite=async()=>{if(!changed){changed=true;await adminPool.query("update parsers set allowed_formats=ARRAY['txt'] where id=$1",[f.parserId]);}};
 const id=randomUUID();await assert.rejects(add(f,selected,id,{importSource:controlled}),e=>e instanceof ParserFormatNotAllowedError&&e.format==='pdf');const state=await counts(f);assert.equal(state.archive_imports,1);assert.equal(state.documents,0);assert.equal(state.jobs,0);assert.equal(state.pages,0);assert.equal(state.intake_files,3);assert.equal(state.file_deletions,3);
 await adminPool.query('update parsers set allowed_formats=null where id=$1',[f.parserId]);await assert.rejects(add(f,selected,id),e=>e instanceof ParserFormatNotAllowedError);onWrite=undefined;await add(f,selected,randomUUID(),{importSource:controlled});assert.equal((await counts(f)).pages,3);
});

test('audit rollback leaves no accepted batch, and lost COMMIT acknowledgement preserves committed originals',async()=>{
 const f=await fixture('rollback'),id=randomUUID(),suffix=randomUUID().replaceAll('-',''),fn=`owned_archive_${suffix}`;
 await adminPool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.workspace_id='${f.account.workspace.id}'::uuid and NEW.action='document.archive_imported' then raise exception 'Owned archive rollback'; end if; return NEW; end $$`);
 await adminPool.query(`create trigger ${fn} before insert on audit_events for each row execute function ${fn}()`);
 try{await assert.rejects(add(f,selected,id,{importSource:controlled}));}finally{await adminPool.query(`drop trigger ${fn} on audit_events`);await adminPool.query(`drop function ${fn}()`);}
 const state=await counts(f);assert.equal(state.archive_imports,0);assert.equal(state.documents,0);assert.equal(state.jobs,0);assert.equal(state.pages,0);assert.equal(state.intake_files,3);assert.equal(state.file_deletions,3);
 await add(f,selected,id,{importSource:controlled});assert.equal((await counts(f)).pages,3);
 const second=await fixture('commit-loss'),requestId=randomUUID(),originalConnect=appPool.connect;let injected=false;
 (appPool as any).connect=async()=>{const client=await(originalConnect as ()=>Promise<import('pg').PoolClient>).call(appPool);let accepting=false;return new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const sql=String(args[0]);if(sql.includes('insert into archive_imports')&&sql.includes("'accepted'"))accepting=true;const result=await(target.query as any)(...args);if(sql==='COMMIT'&&accepting&&!injected){injected=true;throw new Error('Owned lost archive COMMIT acknowledgement');}return result;};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});};
 try{await assert.rejects(add(second,selected,requestId,{importSource:controlled}));}finally{appPool.connect=originalConnect;}
 assert.equal(injected,true);const before=await counts(second),beforeWrites=writes;assert.equal(before.documents,2);assert.equal(before.file_deletions,0);assert.equal(before.intake_files,0);
 const replay=await add(second,selected,requestId,{importSource:async()=>{throw new Error('Must recover committed receipt');}});assert.equal(replay.replayed,true);assert.equal(writes,beforeWrites);assert.ok(objects.has(`${second.account.workspace.id}/${replay.archive.id}`));assert.deepEqual(await counts(second),before);
});

test('signed ZIP preview has no acceptance and selection confirmation is immutable across staging and multipart',async()=>{
 const f=await fixture('direct'),foreign=await fixture('direct-foreign'),id=randomUUID(),input={filename:'owned.zip',size:zipBytes.length,sha256:hash(zipBytes),archiveImport:{requestId:id}};
 const reserved=await reserveDirectUpload(actor(f.account),f.parserId,input);objects.set(`${f.account.workspace.id}/${reserved.uploadId}`,zipBytes);
 const beforeReads=reads;await assert.rejects(previewDirectArchive(actor(foreign.account),reserved.uploadId),status(404));assert.equal(reads,beforeReads);
 await assert.rejects(finalizeDirectUpload(actor(f.account),reserved.uploadId),status(409));assert.equal(reads,beforeReads);
 const preview=await previewDirectArchive(actor(f.account),reserved.uploadId);assert.equal(preview.requestId,id);assert.equal(preview.sourceSha256,hash(zipBytes));assert.equal((await counts(f)).pages,0);assert.equal((await counts(f)).documents,0);
 await assert.rejects(confirmDirectArchive(actor(f.account),reserved.uploadId,{options:{...selected,sourceSha256:'0'.repeat(64)}}),status(409));
 assert.deepEqual(await confirmDirectArchive(actor(f.account),reserved.uploadId,{options:selected}),{ok:true});assert.deepEqual(await confirmDirectArchive(actor(f.account),reserved.uploadId,{options:selected}),{ok:true});
 await assert.rejects(confirmDirectArchive(actor(f.account),reserved.uploadId,{options:twins}),status(409));await assert.rejects(add(f,twins,id,{importSource:controlled}),status(409));await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{...input,archiveImport:{requestId:id,options:twins}}),status(409));
 const result=await finalizeDirectUpload(actor(f.account),reserved.uploadId);assert.equal(result.archive.totalPages,3);const row=(await adminPool.query('select * from direct_uploads where id=$1',[reserved.uploadId])).rows[0];assert.equal(row.state,'complete');assert.equal(row.archive_import_id,result.archive.id);assert.equal(row.document_id,null);assert.equal(row.job_id,null);assert.equal(row.finalize_owner,null);
 const beforeWrites=writes;assert.equal((await finalizeDirectUpload(actor(f.account),reserved.uploadId)).replayed,true);assert.equal(writes,beforeWrites);assert.equal((await counts(f)).pages,3);
});

test('signed restaging recovers a missing PUT at the final credit without changing confirmed selection',async()=>{
 const f=await fixture('last-credit');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1') where id=$1",[f.account.workspace.id]);
 const id=randomUUID(),input={filename:'owned.zip',size:zipBytes.length,sha256:hash(zipBytes),archiveImport:{requestId:id,options:one}};
 const missing=await reserveDirectUpload(actor(f.account),f.parserId,input);await assert.rejects(previewDirectArchive(actor(f.account),missing.uploadId),status(404));await assert.rejects(finalizeDirectUpload(actor(f.account),missing.uploadId),status(404));
 await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{...input,archiveImport:{requestId:id,options:twins}}),status(409));await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{...input,archiveImport:{requestId:randomUUID(),options:one}}),status(429));
 const fresh=await reserveDirectUpload(actor(f.account),f.parserId,input);assert.notEqual(fresh.uploadId,missing.uploadId);objects.set(`${f.account.workspace.id}/${fresh.uploadId}`,zipBytes);const result=await finalizeDirectUpload(actor(f.account),fresh.uploadId);assert.equal(result.archive.totalPages,1);assert.equal(result.archive.requestId,id);
 const before=await counts(f);assert.equal((await finalizeDirectUpload(actor(f.account),fresh.uploadId)).replayed,true);assert.deepEqual(await counts(f),before);assert.equal(before.pages,1);
});

test('stale preview and finalization owners cannot report success or accept children after lease change',async()=>{
 const f=await fixture('leases'),input={filename:'owned.zip',size:zipBytes.length,sha256:hash(zipBytes)};
 const preview=await reserveDirectUpload(actor(f.account),f.parserId,{...input,archiveImport:{requestId:randomUUID()}});objects.set(`${f.account.workspace.id}/${preview.uploadId}`,zipBytes);
 onRead=async()=>{await adminPool.query('update direct_uploads set finalize_owner=$2 where id=$1',[preview.uploadId,randomUUID()]);};await assert.rejects(previewDirectArchive(actor(f.account),preview.uploadId),status(409));onRead=undefined;assert.equal((await counts(f)).pages,0);
 const id=randomUUID(),target=await reserveDirectUpload(actor(f.account),f.parserId,{...input,archiveImport:{requestId:id,options:selected}});objects.set(`${f.account.workspace.id}/${target.uploadId}`,zipBytes);let changed=false;
 onWrite=async()=>{if(!changed){changed=true;await adminPool.query('update direct_uploads set finalize_owner=$2 where id=$1',[target.uploadId,randomUUID()]);}};await assert.rejects(finalizeDirectUpload(actor(f.account),target.uploadId),status(409));onWrite=undefined;const state=await counts(f);assert.equal(state.archive_imports,0);assert.equal(state.documents,0);assert.equal(state.pages,0);assert.equal(state.file_deletions,3);
 const fresh=await reserveDirectUpload(actor(f.account),f.parserId,{...input,archiveImport:{requestId:id,options:selected}});objects.set(`${f.account.workspace.id}/${fresh.uploadId}`,zipBytes);const accepted=await finalizeDirectUpload(actor(f.account),fresh.uploadId);assert.equal(accepted.archive.totalPages,3);
});

test('archive routes enforce role, tenant, origin and API scopes without source reads or partial acceptance',async()=>{
 const f=await fixture('routes'),foreign=await fixture('routes-foreign'),id=randomUUID(),preview=multipart(zipBytes,id),body=multipart(zipBytes,id,one),url=`/api/parsers/${f.parserId}/archive-imports`;
 assert.equal((await request(foreign.account,'POST',url,body.payload,body.headers)).statusCode,404);assert.equal((await request(f.account,'POST',url,body.payload,{...body.headers,origin:'https://untrusted.example.test'})).statusCode,403);
 await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,f.account.user.id]);assert.equal((await request(f.account,'POST',`${url}/preview`,preview.payload,preview.headers)).statusCode,403);assert.equal((await request(f.account,'POST',url,body.payload,body.headers)).statusCode,403);await adminPool.query("update memberships set role='owner' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,f.account.user.id]);
 const readKey=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned archive reader',scopes:['documents:read']});assert.equal(readKey.statusCode,200);const reader={cookie:'',authorization:`Bearer ${readKey.json().token}`};assert.equal((await request(f.account,'POST',url,body.payload,{...body.headers,...reader})).statusCode,403);
 const writeKey=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned archive writer',scopes:['documents:write']});assert.equal(writeKey.statusCode,200);const writer={cookie:'',authorization:`Bearer ${writeKey.json().token}`};
 const malformed=multipart(zipBytes,randomUUID(),one,'extra');assert.equal((await request(f.account,'POST',url,malformed.payload,malformed.headers)).statusCode,413);
 const result=await request(f.account,'POST',url,body.payload,{...body.headers,...writer});assert.equal(result.statusCode,202,result.body);const receipt=result.json(),lookup=`${url}/requests/${id}`;
 assert.equal((await request(f.account,'GET',lookup,undefined,writer)).statusCode,403);assert.equal((await request(foreign.account,'GET',lookup)).statusCode,404);assert.equal((await request(f.account,'GET',lookup,undefined,reader)).statusCode,200);
 assert.equal((await request(foreign.account,'GET',`/api/documents/${receipt.documents[0].id}/archive-original`)).statusCode,404);assert.equal((await request(f.account,'GET',`/api/documents/${receipt.documents[0].id}/archive-original`,undefined,writer)).statusCode,403);
 assert.equal((await request(f.account,'DELETE',`/api/archive-imports/${receipt.archive.id}`,undefined,reader)).statusCode,403);assert.equal((await request(foreign.account,'DELETE',`/api/archive-imports/${receipt.archive.id}`)).statusCode,404);assert.equal((await counts(f)).pages,1);
});

test('child and group deletion retain complete ZIP through siblings then expose truthful tombstones and queued removal',async()=>{
 const f=await fixture('deletion'),id=randomUUID(),result=await add(f,selected,id),[first,last]=result.documents;
 const detail=await request(f.account,'GET',`/api/documents/${last.id}`);assert.equal(detail.statusCode,200);assert.deepEqual(detail.json().archive,{id:result.archive.id,index:last.index,path:last.path,childCount:2,totalPages:3,sourceName:'PRIVATE-original.zip',sourceAvailable:true,retainedDocuments:2});
 const full=await request(f.account,'GET',`/api/documents/${last.id}/archive-original`);assert.equal(full.statusCode,200);assert.deepEqual(full.rawPayload,zipBytes);assert.match(String(full.headers['content-type']),/application\/zip/);assert.match(String(full.headers['content-disposition']),/^attachment/);assert.match(String(full.headers['cache-control']),/private, no-store/);
 assert.equal((await request(f.account,'DELETE',`/api/documents/${first.id}`)).statusCode,200);assert.ok(objects.has(`${f.account.workspace.id}/${result.archive.id}`));assert.equal((await request(f.account,'GET',`/api/documents/${first.id}/archive-original`)).statusCode,404);
 const beforeRemoves=removes,removed=await request(f.account,'DELETE',`/api/archive-imports/${result.archive.id}`);assert.equal(removed.statusCode,200,removed.body);assert.equal(removed.json().storageDeletion,'pending');assert.equal(removes,beforeRemoves);
 const tombstone=await add(f,selected,id,{importSource:async()=>{throw new Error('Tombstone cannot recreate');}});assert.equal(tombstone.replayed,true);assert.equal(tombstone.archive.sourceAvailable,false);assert.equal(tombstone.archive.sourceName,null);assert.ok(tombstone.documents.every(d=>!d.available&&d.name===null&&d.path===null));assert.equal((await counts(f)).pages,3);
 for(const key of [`${f.account.workspace.id}/${last.id}`,`${f.account.workspace.id}/${result.archive.id}`])assert.equal(await deleteStoredFile(f.account.workspace.id,key),'complete');assert.equal((await request(f.account,'DELETE',`/api/archive-imports/${result.archive.id}`)).json().storageDeletion,'complete');
});

test('PDF and ZIP attempts share active slots and failed temporary-byte reservations',async()=>{
 const f=await fixture('shared-caps');
 for(const column of ['split_attempt_id','archive_attempt_id']){const id=randomUUID();await adminPool.query(`insert into intake_files(id,workspace_id,storage_key,${column},reserved_bytes) values($1,$2,$3,$4,1)`,[id,f.account.workspace.id,`${f.account.workspace.id}/${id}`,randomUUID()]);}
 const beforeWrites=writes;await assert.rejects(add(f,one,randomUUID(),{importSource:controlled}),status(429));await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,pdf,'owned.pdf',randomUUID(),{mode:'every',pagesPerDocument:2}),status(429));assert.equal(writes,beforeWrites);assert.equal((await counts(f)).pages,0);
 await adminPool.query('delete from intake_files where workspace_id=$1',[f.account.workspace.id]);
 const attemptBytes=zipBytes.length+leaf.length;
 for(let remaining=250*1024*1024-attemptBytes+1;remaining>0;){const size=Math.min(10*1024*1024,remaining),id=randomUUID();remaining-=size;await adminPool.query("insert into intake_files(id,workspace_id,storage_key,archive_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,$5,now()-interval '1 second')",[id,f.account.workspace.id,`${f.account.workspace.id}/${id}`,randomUUID(),size]);}
 await assert.rejects(add(f,one,randomUUID(),{importSource:controlled}),status(429));await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{filename:'owned.zip',size:zipBytes.length,sha256:hash(zipBytes),archiveImport:{requestId:randomUUID()}}),status(429));assert.equal(writes,beforeWrites);assert.equal((await counts(f)).archive_imports,0);
});

test('late archive writes keep byte reservations through failed physical removal and reconciliation',async()=>{
 const f=await fixture('late-cleanup');onWrite=async()=>{await new Promise(r=>setTimeout(r,200));};
 await assert.rejects(add(f,selected,randomUUID(),{importSource:controlled,timeoutMs:100}),status(503));await new Promise(r=>setTimeout(r,160));onWrite=undefined;
 const state=await counts(f);assert.equal(state.archive_imports,0);assert.equal(state.documents,0);assert.equal(state.pages,0);assert.equal(state.intake_files,2);assert.equal(state.file_deletions,2);
 const rows=(await adminPool.query('select storage_key,available_at>now() delayed from file_deletions where workspace_id=$1',[f.account.workspace.id])).rows;assert.ok(rows.every(row=>row.delayed&&objects.has(row.storage_key)));
 const reserved=async()=>Number((await adminPool.query('select coalesce(sum(reserved_bytes),0)::bigint bytes from intake_files where workspace_id=$1',[f.account.workspace.id])).rows[0].bytes),before=await reserved();assert.ok(before>0);
 failRemove=true;for(const row of rows)assert.equal(await deleteStoredFile(f.account.workspace.id,row.storage_key),'pending');assert.equal(await reserved(),before);
 await adminPool.query("update intake_files set lease_expires_at=now()-interval '2 hours' where workspace_id=$1",[f.account.workspace.id]);await reconcileInterruptedIntake(f.account.workspace.id);assert.equal(await reserved(),before);
 failRemove=false;for(const row of rows)assert.equal(await deleteStoredFile(f.account.workspace.id,row.storage_key),'complete');assert.equal(await reserved(),0);assert.equal((await counts(f)).file_deletions,0);
});

test('archive source references survive filesystem orphan reconciliation and group cleanup removes only owned files',async()=>{
 const f=await fixture('filesystem');
 const disk:PrivateStorage={kind:'filesystem',async write(key,bytes){await fs.mkdir(path.dirname(path.join(config.storageDir,key)),{recursive:true,mode:0o700});await fs.writeFile(path.join(config.storageDir,key),bytes,{mode:0o600,flag:'wx'});},async read(key){return fs.readFile(path.join(config.storageDir,key));},async remove(key){await fs.rm(path.join(config.storageDir,key),{force:true});}};setStorageForTests(disk);
 const result=await add(f,selected,randomUUID(),{importSource:controlled}),keys=[result.archive.id,...result.documents.map(d=>d.id)].map(id=>`${f.account.workspace.id}/${id}`);
 for(const key of keys)await fs.utimes(path.join(config.storageDir,key),new Date(Date.now()-7_200_000),new Date(Date.now()-7_200_000));
 await reconcileInterruptedIntake(f.account.workspace.id);assert.deepEqual(await disk.read(keys[0]),zipBytes);for(const key of keys)assert.ok((await fs.stat(path.join(config.storageDir,key))).isFile());assert.equal((await counts(f)).file_deletions,0);
 await withWorkspace(f.account.workspace.id,c=>purgeArchiveImport(c,f.account.workspace.id,result.archive.id));for(const key of keys)assert.equal(await deleteStoredFile(f.account.workspace.id,key),'complete');for(const key of keys)await assert.rejects(fs.stat(path.join(config.storageDir,key)),(e:any)=>e.code==='ENOENT');assert.equal((await counts(f)).pages,3);
});

test('database constraints preserve archive tenant ownership, finite rejection reasons and batch separation',async()=>{
 const f=await fixture('constraints'),foreign=await fixture('constraints-foreign'),result=await add(f,one,randomUUID(),{importSource:controlled});
 assert.equal((await withWorkspace(foreign.account.workspace.id,c=>c.query('select id from archive_imports'))).rowCount,0);assert.equal((await withWorkspace(foreign.account.workspace.id,c=>c.query('select document_id from archive_import_entries'))).rowCount,0);
 const newId=randomUUID();await assert.rejects(adminPool.query("insert into archive_imports(id,workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,rejection_code,rejection_reason,source_byte_size) values($1,$2,$3,$4,$5,$6,$7,'rejected','archive_import_validation_failed','invalid_archive',1)",[newId,foreign.account.workspace.id,f.parserId,randomUUID(),hash(zipBytes),canonicalArchiveImportSpec(one),hash(canonicalArchiveImportSpec(one))]),(e:any)=>e.code==='23503');
 await assert.rejects(adminPool.query("insert into archive_imports(workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,rejection_code,rejection_reason,source_byte_size) values($1,$2,$3,$4,$5,$6,'rejected','archive_import_validation_failed','arbitrary diagnostic',1)",[f.account.workspace.id,f.parserId,randomUUID(),hash(zipBytes),canonicalArchiveImportSpec(one),hash(canonicalArchiveImportSpec(one))]),(e:any)=>e.code==='23514');
 await assert.rejects(adminPool.query('update documents set pdf_split_id=$2,pdf_split_index=1 where id=$1',[result.documents[0].id,randomUUID()]),(e:any)=>e.code==='23514');
 const relations=(await adminPool.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where oid=any($1::regclass[])",[['archive_imports','archive_import_entries']])).rows;assert.equal(relations.length,2);assert.ok(relations.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
 const before=await counts(f);assert.equal(before.archive_imports,1);assert.equal(before.documents,1);assert.equal(before.pages,1);
});

test('expired and queued staging retains byte and object budgets until physical removal is confirmed',async()=>{
 const f=await fixture('expired-staging-budget'),keys:string[]=[];
 for(let n=0;n<25;n++){const id=randomUUID(),key=`${f.account.workspace.id}/${id}`;keys.push(key);objects.set(key,Buffer.from('x'));await adminPool.query("insert into direct_uploads(id,workspace_id,parser_id,created_by,storage_key,filename,expected_bytes,expected_sha256,state,expires_at,cleanup_after) values($1,$2,$3,$4,$5,'owned.zip',1,$6,'failed',now()-interval '3 hours',now()-interval '1 hour')",[id,f.account.workspace.id,f.parserId,f.account.user.id,key,hash('x')]);}
 const input={filename:'owned.zip',size:zipBytes.length,sha256:hash(zipBytes),archiveImport:{requestId:randomUUID(),options:one}},beforeWrites=writes;
 await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,input),status(429));await assert.rejects(add(f,one,randomUUID(),{importSource:controlled}),status(429));await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,pdf,'owned.pdf',randomUUID(),{mode:'every',pagesPerDocument:2}),status(429));assert.equal(writes,beforeWrites);
 await reconcileExpiredDirectUploads(f.account.workspace.id);await reconcileExpiredDirectUploads(f.account.workspace.id);
 assert.equal((await adminPool.query("select count(*)::int n from direct_uploads where workspace_id=$1 and state='cleaned'",[f.account.workspace.id])).rows[0].n,25);
 failRemove=true;assert.equal(await deleteStoredFile(f.account.workspace.id,keys[0]),'pending');await adminPool.query("update file_deletions set status='failed' where workspace_id=$1",[f.account.workspace.id]);
 await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,input),status(429));await assert.rejects(add(f,one,randomUUID(),{importSource:controlled}),status(429));assert.equal(writes,beforeWrites);
 failRemove=false;assert.equal(await deleteStoredFile(f.account.workspace.id,keys[0]),'complete');const recovered=await reserveDirectUpload(actor(f.account),f.parserId,input);assert.ok(recovered.uploadId);assert.equal((await counts(f)).pages,0);
 const many=await fixture('expired-object-budget'),ids:string[]=[];
 for(let n=0;n<100;n++){const id=randomUUID();ids.push(id);objects.set(`${many.account.workspace.id}/${id}`,Buffer.from('x'));await adminPool.query("insert into direct_uploads(id,workspace_id,parser_id,created_by,storage_key,filename,expected_bytes,expected_sha256,state,expires_at,cleanup_after) values($1,$2,$3,$4,$5,'owned',1,$6,'complete',now()-interval '3 hours',now()-interval '1 hour')",[id,many.account.workspace.id,many.parserId,many.account.user.id,`${many.account.workspace.id}/${id}`,hash('x')]);}
 const next={filename:'owned.zip',size:zipBytes.length,sha256:hash(zipBytes),archiveImport:{requestId:randomUUID()}};await assert.rejects(reserveDirectUpload(actor(many.account),many.parserId,next),status(429));
 const firstKey=`${many.account.workspace.id}/${ids[0]}`;await adminPool.query("update direct_uploads set state='cleaned' where id=$1",[ids[0]]);await adminPool.query("insert into file_deletions(workspace_id,storage_key,status) values($1,$2,'failed')",[many.account.workspace.id,firstKey]);await assert.rejects(reserveDirectUpload(actor(many.account),many.parserId,next),status(429));
 assert.equal(await deleteStoredFile(many.account.workspace.id,firstKey),'complete');assert.ok((await reserveDirectUpload(actor(many.account),many.parserId,next)).uploadId);
});
