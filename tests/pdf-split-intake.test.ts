import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import type {PdfSplitSpec} from '../shared/pdf-split.js';
import {planPdfSplit,PdfSplitValidationError} from '../shared/pdf-split.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,withWorkspace,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addSplitDocuments} from '../server/core/pdf-split-intake.js';
import {addDocument} from '../server/core/intake.js';
import {splitPdfSource} from '../server/core/source.js';
import {SourceIntakeRejectedError,ParserFormatNotAllowedError} from '../server/core/intake-policy.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {reserveDirectUpload,finalizeDirectUpload} from '../server/core/upload-routes.js';
import {deleteStoredFile} from '../server/core/retention.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;schemaId:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>(),hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const every:PdfSplitSpec={mode:'every',pagesPerDocument:2},selected:PdfSplitSpec={mode:'ranges',ranges:[{start:1,end:1},{start:3,end:4}]};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let app:FastifyInstance,verified=false,pdf:Buffer,onePage:Buffer,writes=0,removes=0,fetches=0,lastError:Error|undefined;
let onWrite:((key:string,bytes:Buffer)=>Promise<void>)|undefined;
const originalFetch=globalThis.fetch;
const storage:PrivateStorage={kind:'supabase',
 async write(key,bytes){writes++;await onWrite?.(key,bytes);objects.set(key,Buffer.from(bytes));},
 async read(key){const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned staged upload missing'),{statusCode:404});return Buffer.from(bytes);},
 async remove(key){removes++;objects.delete(key);},async signUpload(key){return `https://owned.example.test/upload/${key}`;},
};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
async function request(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={}){
 return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,...headers}});
}
async function fixture(label:string):Promise<Fixture>{
 const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned PDF split',workspaceName:`Owned split ${label}`,email:`split-${randomUUID()}@example.test`,password:'Owned PDF split fixture password'}});
 assert.equal(response.statusCode,201,response.body);
 const a={...response.json(),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(a);
 await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{monthlyPages}','1000'),'{maxParsers}','30') where id=$1",[a.workspace.id]);
 const created=await request(a,'POST','/api/parsers',{name:'Owned PDF parser',useCase:'custom',mode:'rules',schema:{fields:[{key:'reference',label:'Reference',type:'string',anchor:'Reference'}]}});
 assert.equal(created.statusCode,201,created.body);
 return {account:a,parserId:created.json().parser.id,schemaId:created.json().schema.id};
}
async function split(f:Fixture,spec:PdfSplitSpec=every,id=randomUUID(),options:Parameters<typeof addSplitDocuments>[6]={}){
 return addSplitDocuments(actor(f.account),f.parserId,pdf,'PRIVATE-bundle.pdf',id,spec,options);
}
async function counts(f:Fixture){
 const out:Record<string,number>={};
 for(const table of ['pdf_splits','pdf_split_children','documents','jobs','usage_ledger','intake_events','intake_files','file_deletions'])out[table]=(await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`,[f.account.workspace.id])).rows[0].n;
 out.pages=(await adminPool.query('select coalesce(sum(pages),0)::int n from usage_ledger where workspace_id=$1',[f.account.workspace.id])).rows[0].n;return out;
}
const status=(expected:number)=>(error:any)=>{assert.equal(error.statusCode,expected);return true;};
function gate(){let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});return {pending,release};}
async function until(check:()=>boolean){for(let n=0;n<200&&!check();n++)await sleep(5);assert.ok(check(),'Owned asynchronous fixture reached its gate');}
function multipart(bytes:Buffer,id:string,spec:PdfSplitSpec,extra=''){
 const boundary=`owned-${randomUUID()}`;
 const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="options"\r\n\r\n${JSON.stringify(spec)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),bytes,Buffer.from(`\r\n${extra?`--${boundary}\r\nContent-Disposition: form-data; name="extra"\r\n\r\n${extra}\r\n`:''}--${boundary}--\r\n`)]);
 return {payload,headers:{'content-type':`multipart/form-data; boundary=${boundary}`}};
}
async function controlled(_bytes:Buffer,_name:string,spec:PdfSplitSpec,_options?:unknown){
 const plan=planPdfSplit(spec,4);
 return {sourcePageCount:4,selectedPages:plan.selectedPages,parts:plan.ranges.map(range=>({range,bytes:onePage,source:{mimeType:'application/pdf' as const,pageCount:range.end-range.start+1,pages:Array.from({length:range.end-range.start+1},(_,i)=>({page:i+1,text:`Reference: OWNED-${i+1}`}))}}))};
}

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
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No external calls in PDF split tests');};app=await buildApp();
 app.addHook('onError',async(_request,_reply,error)=>{lastError=error;});
 const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica);
 for(let i=1;i<=4;i++){const page=document.addPage([300,300]);page.drawText(`Reference: OWNED-PAGE-${i}`,{x:20,y:250,size:12,font});}
 pdf=Buffer.from(await document.save());onePage=(await splitPdfSource(pdf,'owned.pdf',{mode:'ranges',ranges:[{start:1,end:1}]})).parts[0]!.bytes;
});
afterEach(()=>{onWrite=undefined;assert.equal(fetches,0);});
after(async()=>{
 onWrite=undefined;setStorageForTests(undefined);globalThis.fetch=originalFetch;
 try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}}
 finally{objects.clear();await closeDatabase();}
});

test('real PDF ranges atomically retain source lineage, selected-page usage, rebased text and one pinned job configuration',async()=>{
 const f=await fixture('real'),result=await split(f,selected);
 assert.equal(result.replayed,false);assert.equal(result.documents.length,2);assert.equal(result.split.sourcePageCount,4);assert.equal(result.split.selectedPages,3);
 assert.deepEqual(result.documents.map(d=>[d.index,d.originalPageStart,d.originalPageEnd,d.pageCount,d.available]),[[1,1,1,1,true],[2,3,4,2,true]]);
 assert.equal(/storage|sha256|lease|sourceText|OWNED-PAGE/.test(JSON.stringify(result)),false);
 const rows=(await adminPool.query('select * from documents where pdf_split_id=$1 order by pdf_split_index',[result.split.id])).rows;
 for(const row of rows){assert.equal(row.sha256,hash(objects.get(row.storage_key)!));assert.deepEqual(row.source_text.map((p:any)=>p.page),Array.from({length:row.page_count},(_,i)=>i+1));}
 assert.match(rows[1].source_text[0].text,/OWNED-PAGE-3/);assert.match(rows[1].source_text[1].text,/OWNED-PAGE-4/);
 assert.deepEqual(objects.get(`${f.account.workspace.id}/${result.split.id}`),pdf);
 const jobs=(await adminPool.query('select * from jobs where workspace_id=$1',[f.account.workspace.id])).rows;
 assert.equal(jobs.length,2);assert.ok(jobs.every(j=>j.schema_version_id===f.schemaId&&!j.waiting_for_schema&&j.config.templatePolicy==='complete-v1'));assert.deepEqual(jobs[0].config,jobs[1].config);
 assert.deepEqual(await counts(f),{pdf_splits:1,pdf_split_children:2,documents:2,jobs:2,usage_ledger:2,intake_events:0,intake_files:0,file_deletions:0,pages:3});
});

test('identical child bytes remain separate identities and cannot alias ordinary byte deduplication',async()=>{
 const f=await fixture('equal'),ordinary=await addDocument(actor(f.account),f.parserId,onePage,'ordinary.pdf');
 const result=await split(f,{mode:'ranges',ranges:[{start:1,end:1},{start:2,end:2}]},randomUUID(),{splitSource:controlled});
 assert.equal(result.documents.length,2);assert.notEqual(result.documents[0]!.id,result.documents[1]!.id);assert.ok(result.documents.every(d=>d.id!==ordinary.document.id));
 const again=await addDocument(actor(f.account),f.parserId,onePage,'ordinary.pdf');assert.equal(again.document.id,ordinary.document.id);assert.equal(again.duplicate,true);
 const hashes=(await adminPool.query('select sha256 from documents where parser_id=$1',[f.parserId])).rows;assert.equal(hashes.length,3);assert.equal(new Set(hashes.map(r=>r.sha256)).size,1);assert.equal((await counts(f)).pages,3);
});

test('request replay precedes decoding and current settings, binds bytes/parser/spec and preserves deleted-child tombstones',async()=>{
 const f=await fixture('replay'),id=randomUUID(),first=await split(f,every,id),before=await counts(f),beforeWrites=writes;
 const forbidden=async()=>{throw new Error('Replay must not inspect bytes');};
 await adminPool.query("update parsers set archived=true,allowed_formats=ARRAY['txt'] where id=$1",[f.parserId]);
 const replay=await split(f,every,id,{splitSource:forbidden});assert.equal(replay.replayed,true);assert.deepEqual(replay.documents,first.documents);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),before);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,Buffer.from('different'),'owned.pdf',id,every,{splitSource:forbidden}),status(409));
 await assert.rejects(split(f,selected,id,{splitSource:forbidden}),status(409));
 const second=await request(f.account,'POST','/api/parsers',{name:'Second',useCase:'custom'});assert.equal(second.statusCode,201);
 await assert.rejects(addSplitDocuments(actor(f.account),second.json().parser.id,pdf,'owned.pdf',id,every,{splitSource:forbidden}),status(409));
 const removed=await request(f.account,'DELETE',`/api/documents/${first.documents[0]!.id}`);assert.equal(removed.statusCode,200,removed.body);
 const tombstone=await split(f,every,id,{splitSource:forbidden});assert.equal(tombstone.documents[0]!.available,false);assert.equal(tombstone.documents[0]!.name,null);assert.equal(tombstone.documents[1]!.available,true);assert.equal((await counts(f)).pages,4);
 await adminPool.query('update parsers set archived=false,allowed_formats=null where id=$1',[f.parserId]);
 const fresh=await split(f,every,randomUUID());assert.notEqual(fresh.split.id,first.split.id);assert.equal((await counts(f)).pages,8);
});

test('typed source/policy/split rejections are durable and bounded; status lookalikes stay retryable',async()=>{
 const f=await fixture('rejections'),malformed=Buffer.from('%PDF-1.7\nPRIVATE BROKEN PDF\n%%EOF'),id=randomUUID(),beforeWrites=writes;
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,malformed,'PRIVATE.pdf',id,every),error=>error instanceof SourceIntakeRejectedError);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,malformed,'changed.pdf',id,every,{splitSource:async()=>{throw new Error('No retry');}}),error=>error instanceof SourceIntakeRejectedError);
 await assert.rejects(split(f,{mode:'ranges',ranges:[{start:5,end:5}]}),error=>error instanceof PdfSplitValidationError&&error.reason==='page_bounds');
 await adminPool.query("update parsers set allowed_formats=ARRAY['txt'] where id=$1",[f.parserId]);const policyId=randomUUID();
 await assert.rejects(split(f,every,policyId),error=>error instanceof ParserFormatNotAllowedError);
 await adminPool.query('update parsers set allowed_formats=null where id=$1',[f.parserId]);
 await assert.rejects(split(f,every,policyId),error=>error instanceof ParserFormatNotAllowedError);
 assert.equal(writes,beforeWrites);const state=await counts(f);assert.equal(state.pdf_splits,3);assert.equal(state.documents,0);assert.equal(state.intake_files,0);assert.equal(state.pages,0);
 const stored=(await adminPool.query('select * from pdf_splits where workspace_id=$1',[f.account.workspace.id])).rows;
 assert.ok(stored.every(r=>r.state==='rejected'&&r.source_name===null&&r.source_storage_key===null));assert.equal(JSON.stringify(stored).includes('PRIVATE'),false);
 const retryId=randomUUID();await assert.rejects(split(f,every,retryId,{splitSource:async()=>{throw Object.assign(new Error('Controlled dependency fault'),{statusCode:422,code:'source_validation_failed',reason:'pdf_invalid'});}}));
 assert.equal((await counts(f)).pdf_splits,3);await split(f,every,retryId);assert.equal((await counts(f)).pages,4);
});

test('concurrent identical requests commit once and all race-loser writes have tracked cleanup',async()=>{
 const f=await fixture('same-race'),id=randomUUID(),hold=gate();let started=0;
 onWrite=async()=>{started++;await hold.pending;};
 const pending=[split(f,every,id,{splitSource:controlled}),split(f,every,id,{splitSource:controlled})];
 await until(()=>started===4);hold.release();const results=await Promise.all(pending);
 assert.equal(results[0].split.id,results[1].split.id);assert.equal(results.filter(r=>!r.replayed).length,1);
 const state=await counts(f);assert.equal(state.pdf_splits,1);assert.equal(state.documents,2);assert.equal(state.jobs,2);assert.equal(state.pages,4);assert.equal(state.file_deletions,3);assert.equal(state.intake_files,3);
 const unreferenced=(await adminPool.query('select storage_key from file_deletions where workspace_id=$1',[f.account.workspace.id])).rows;
 assert.ok(unreferenced.every(r=>objects.has(r.storage_key)));
});

test('competing quota decisions accept a whole batch or none, without partial usage',async()=>{
 const f=await fixture('quota-race');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','3') where id=$1",[f.account.workspace.id]);
 const hold=gate();let started=0;onWrite=async()=>{started++;await hold.pending;};
 const spec:PdfSplitSpec={mode:'ranges',ranges:[{start:1,end:1},{start:3,end:3}]};
 const pending=[split(f,spec,randomUUID(),{splitSource:controlled}),split(f,spec,randomUUID(),{splitSource:controlled})];await until(()=>started===4);hold.release();
 const results=await Promise.allSettled(pending);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason.statusCode,429);
 const state=await counts(f);assert.equal(state.pdf_splits,1);assert.equal(state.documents,2);assert.equal(state.jobs,2);assert.equal(state.usage_ledger,2);assert.equal(state.pages,2);assert.equal(state.intake_files,3);
});

test('commit-time parser/schema changes are coherent and archival rejects every child',async()=>{
 const f=await fixture('settings'),hold=gate();let started=0;onWrite=async()=>{started++;await hold.pending;};
 const pending=split(f,every,randomUUID(),{splitSource:controlled});await until(()=>started===2);
 const saved=await request(f.account,'POST',`/api/parsers/${f.parserId}/schema`,{fields:[{key:'changed',label:'Changed',type:'string',anchor:'Reference'}]});assert.equal(saved.statusCode,200,saved.body);
 assert.equal((await request(f.account,'PATCH',`/api/parsers/${f.parserId}`,{instructions:'Commit-time configuration'})).statusCode,200);hold.release();await pending;
 const jobs=(await adminPool.query('select * from jobs where workspace_id=$1',[f.account.workspace.id])).rows;assert.ok(jobs.every(j=>j.schema_version_id===saved.json().schema.id&&j.config.instructions==='Commit-time configuration'));
 const blocked=await fixture('archive-race'),secondHold=gate();let secondStarted=0;onWrite=async()=>{secondStarted++;await secondHold.pending;};
 const denied=split(blocked,every,randomUUID(),{splitSource:controlled});await until(()=>secondStarted===2);await adminPool.query('update parsers set archived=true where id=$1',[blocked.parserId]);secondHold.release();await assert.rejects(denied,status(404));
 const state=await counts(blocked);assert.equal(state.pdf_splits,0);assert.equal(state.documents,0);assert.equal(state.jobs,0);assert.equal(state.pages,0);assert.equal(state.file_deletions,3);
});

test('audit failure rolls back the entire batch and permits retry with the same request',async()=>{
 const f=await fixture('audit'),id=randomUUID(),suffix=randomUUID().replaceAll('-',''),fn=`owned_split_${suffix}`,trigger=`owned_split_${suffix}`;
 await adminPool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.workspace_id='${f.account.workspace.id}'::uuid and NEW.action='document.split' then raise exception 'Owned audit rollback'; end if; return NEW; end $$`);
 await adminPool.query(`create trigger ${trigger} before insert on audit_events for each row execute function ${fn}()`);
 try{await assert.rejects(split(f,every,id,{splitSource:controlled}));}finally{await adminPool.query(`drop trigger ${trigger} on audit_events`);await adminPool.query(`drop function ${fn}()`);}
 const state=await counts(f);assert.equal(state.pdf_splits,0);assert.equal(state.pdf_split_children,0);assert.equal(state.documents,0);assert.equal(state.jobs,0);assert.equal(state.pages,0);assert.equal(state.intake_files,3);assert.equal(state.file_deletions,3);
 await split(f,every,id,{splitSource:controlled});assert.equal((await counts(f)).pages,4);
});

test('lost COMMIT acknowledgement retains accepted objects and replay returns the committed batch',async()=>{
 const f=await fixture('commit-loss'),id=randomUUID(),originalConnect=appPool.connect;let injected=false;
 (appPool as any).connect=async()=>{
  const client=await (originalConnect as ()=>Promise<import('pg').PoolClient>).call(appPool);let accepting=false;
  return new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{
   const sql=String(args[0]);if(sql.includes('insert into pdf_splits')&&sql.includes("'accepted'"))accepting=true;
   const result=await (target.query as any)(...args);if(sql==='COMMIT'&&accepting&&!injected){injected=true;throw new Error('Owned lost COMMIT acknowledgement');}return result;
  };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
 };
 try{await assert.rejects(split(f,every,id,{splitSource:controlled}));}finally{appPool.connect=originalConnect;}
 assert.equal(injected,true);const before=await counts(f),beforeWrites=writes;assert.equal(before.documents,2);assert.equal(before.file_deletions,0);
 const result=await split(f,every,id,{splitSource:async()=>{throw new Error('Already committed');}});assert.equal(result.replayed,true);assert.equal(writes,beforeWrites);
 const keys=(await adminPool.query('select storage_key from documents where workspace_id=$1 union all select source_storage_key from pdf_splits where workspace_id=$1',[f.account.workspace.id])).rows;
 assert.equal(keys.length,3);assert.ok(keys.every(row=>objects.has(row.storage_key)));assert.deepEqual(await counts(f),before);
});

test('deadline before storage prevents late acceptance; late writes retain delayed cleanup reservations',async()=>{
 const f=await fixture('deadline');await assert.rejects(split(f,every,randomUUID(),{timeoutMs:10,splitSource:async(...args)=>{await sleep(40);return controlled(...args);}}),status(503));await sleep(50);
 assert.equal((await counts(f)).pdf_splits,0);assert.equal((await counts(f)).intake_files,0);
 onWrite=async()=>{await sleep(50);};await assert.rejects(split(f,every,randomUUID(),{timeoutMs:25,splitSource:controlled}),status(503));await sleep(60);
 const state=await counts(f);assert.equal(state.pdf_splits,0);assert.equal(state.documents,0);assert.equal(state.pages,0);assert.equal(state.file_deletions,2);assert.equal(state.intake_files,2);
 const deletions=(await adminPool.query('select *,available_at>now() delayed from file_deletions where workspace_id=$1',[f.account.workspace.id])).rows;
 assert.ok(deletions.every(r=>r.delayed&&objects.has(r.storage_key)));
});

test('direct upload uses persisted split spec, commits its receipt atomically and fences an obsolete finalizer',async()=>{
 const f=await fixture('signed'),id=randomUUID();
 const reserve=await reserveDirectUpload(actor(f.account),f.parserId,{filename:'owned.pdf',size:pdf.length,sha256:hash(pdf),pdfSplit:{requestId:id,options:selected}});
 const key=`${f.account.workspace.id}/${reserve.uploadId}`;objects.set(key,pdf);
 const first=await finalizeDirectUpload(actor(f.account),reserve.uploadId);assert.equal(first.split.selectedPages,3);assert.equal(first.documents.length,2);
 const row=(await adminPool.query('select * from direct_uploads where id=$1',[reserve.uploadId])).rows[0];assert.equal(row.state,'complete');assert.equal(row.pdf_split_id,first.split.id);assert.equal(row.document_id,null);assert.equal(row.finalize_owner,null);assert.notEqual(key,`${f.account.workspace.id}/${first.split.id}`);
 const beforeWrites=writes;const replay=await finalizeDirectUpload(actor(f.account),reserve.uploadId);assert.equal(replay.replayed,true);assert.equal(writes,beforeWrites);
 const anotherId=randomUUID(),another=await reserveDirectUpload(actor(f.account),f.parserId,{filename:'owned.pdf',size:pdf.length,sha256:hash(pdf),pdfSplit:{requestId:anotherId,options:every}});objects.set(`${f.account.workspace.id}/${another.uploadId}`,pdf);
 let changed=false;onWrite=async()=>{if(!changed){changed=true;await adminPool.query('update direct_uploads set finalize_owner=$2 where id=$1',[another.uploadId,randomUUID()]);}};
 await assert.rejects(finalizeDirectUpload(actor(f.account),another.uploadId),status(409));assert.equal((await counts(f)).pdf_splits,1);assert.equal((await counts(f)).pages,3);
 onWrite=undefined;
 const retry=await reserveDirectUpload(actor(f.account),f.parserId,{filename:'owned.pdf',size:pdf.length,sha256:hash(pdf),pdfSplit:{requestId:anotherId,options:every}});objects.set(`${f.account.workspace.id}/${retry.uploadId}`,pdf);
 const accepted=await finalizeDirectUpload(actor(f.account),retry.uploadId);assert.equal(accepted.split.requestId,anotherId);assert.equal((await counts(f)).pages,7);
});

test('multipart/create/read/delete enforce shape, origin, tenant, role and API scopes, with archived receipt recovery',async()=>{
 const f=await fixture('routes'),foreign=await fixture('foreign'),id=randomUUID(),body=multipart(pdf,id,selected);
 const headers=body.headers,url=`/api/parsers/${f.parserId}/pdf-splits`;
 assert.equal((await request(f.account,'POST',url,body.payload,{...headers,origin:'https://untrusted.example.test'})).statusCode,403);
 assert.equal((await request(foreign.account,'POST',url,body.payload,headers)).statusCode,404);
 await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,f.account.user.id]);
 assert.equal((await request(f.account,'POST',url,body.payload,headers)).statusCode,403);await adminPool.query("update memberships set role='owner' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,f.account.user.id]);
 const readKey=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned split read',scopes:['documents:read']});assert.equal(readKey.statusCode,200);
 const reader={cookie:'',authorization:`Bearer ${readKey.json().token}`};assert.equal((await request(f.account,'POST',url,body.payload,{...headers,...reader})).statusCode,403);
 const extra=multipart(pdf,id,selected,'unexpected'),extraResponse=await request(f.account,'POST',url,extra.payload,extra.headers);assert.equal(extraResponse.statusCode,400,`${extraResponse.body} ${lastError?.stack}`);
 assert.equal((await counts(f)).pdf_splits,0);
 const writeKey=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned split write',scopes:['documents:write']});assert.equal(writeKey.statusCode,200);
 const writer={cookie:'',authorization:`Bearer ${writeKey.json().token}`};
 const accepted=await request(f.account,'POST',url,body.payload,{...headers,...writer});assert.equal(accepted.statusCode,202,accepted.body);const receipt=accepted.json();
 const lookup=`/api/parsers/${f.parserId}/pdf-splits/requests/${id}`;
 assert.equal((await request(f.account,'GET',lookup,undefined,writer)).statusCode,403);assert.equal((await request(foreign.account,'GET',lookup)).statusCode,404);
 await adminPool.query('update parsers set archived=true where id=$1',[f.parserId]);assert.equal((await request(f.account,'GET',lookup,undefined,reader)).statusCode,200);
 assert.equal((await request(foreign.account,'DELETE',`/api/pdf-splits/${receipt.split.id}`)).statusCode,404);
 const groupUrl=`/api/pdf-splits/${receipt.split.id}`,beforeRemoves=removes;
 const removed=await request(f.account,'DELETE',groupUrl,undefined,writer);assert.equal(removed.statusCode,200,removed.body);assert.equal(removed.json().removedDocuments,2);assert.equal(removed.json().storageDeletion,'pending');assert.equal(removes,beforeRemoves);
 const tombstone=(await request(f.account,'GET',lookup,undefined,reader)).json();assert.equal(tombstone.split.sourceAvailable,false);assert.ok(tombstone.documents.every((d:any)=>!d.available&&d.name===null));assert.equal((await counts(f)).pages,3);
 const groupKeys=[receipt.split.id,...receipt.documents.map((d:any)=>d.id)].map(id=>`${f.account.workspace.id}/${id}`);
 assert.ok(groupKeys.every(key=>objects.has(key)),'The request queues cleanup without storage I/O');
 assert.deepEqual((await request(f.account,'DELETE',groupUrl,undefined,writer)).json(),{ok:true,removedDocuments:0,storageDeletion:'pending'});
 await adminPool.query("update file_deletions set status='failed' where workspace_id=$1 and storage_key=$2",[f.account.workspace.id,groupKeys[0]]);
 assert.equal((await request(f.account,'DELETE',groupUrl,undefined,writer)).json().storageDeletion,'failed');assert.equal(removes,beforeRemoves);
 // Drain only this owned group's queue to model the independent cleanup worker.
 for(const key of groupKeys)assert.equal(await deleteStoredFile(f.account.workspace.id,key),'complete');
 assert.ok(groupKeys.every(key=>!objects.has(key)));assert.equal(removes,beforeRemoves+3);
 assert.deepEqual((await request(f.account,'DELETE',groupUrl,undefined,writer)).json(),{ok:true,removedDocuments:0,storageDeletion:'complete'});
});

test('active split reservation cap rejects a third attempt before private writes or usage',async()=>{
 const f=await fixture('attempt-cap'),intentIds=[randomUUID(),randomUUID()];
 for(const id of intentIds)await adminPool.query('insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes) values($1,$2,$3,$4,1)',[id,f.account.workspace.id,`${f.account.workspace.id}/${id}`,randomUUID()]);
 const beforeWrites=writes;await assert.rejects(split(f,every,randomUUID(),{splitSource:controlled}),status(429));assert.equal(writes,beforeWrites);
 const state=await counts(f);assert.equal(state.pdf_splits,0);assert.equal(state.pages,0);assert.equal(state.intake_files,2);
 await adminPool.query('delete from intake_files where workspace_id=$1',[f.account.workspace.id]);
});

test('failed split writes retain summed byte reservations until removal, bounding repeated failures and allowing recovery',async()=>{
 const f=await fixture('failed-byte-budget'),limit=250*1024*1024,attemptBytes=pdf.length+2*onePage.length;
 const baseline=limit-3*attemptBytes+1,baseIds:string[]=[];
 // An existing owned cleanup backlog supplies pressure without allocating hundreds
 // of megabytes of irrelevant fixture data; the real failed attempts below write.
 for(let remaining=baseline;remaining>0;){
  const size=Math.min(10*1024*1024,remaining),id=randomUUID(),key=`${f.account.workspace.id}/${id}`;remaining-=size;baseIds.push(id);
  await adminPool.query("insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,$5,now()-interval '1 second')",[id,f.account.workspace.id,key,randomUUID(),size]);
  await adminPool.query('insert into file_deletions(workspace_id,storage_key) values($1,$2)',[f.account.workspace.id,key]);
 }
 const reserved=async()=>Number((await adminPool.query('select coalesce(sum(reserved_bytes),0)::bigint bytes from intake_files where workspace_id=$1 and split_attempt_id is not null',[f.account.workspace.id])).rows[0].bytes);
 let started=0;onWrite=async()=>{if(++started%3===0)throw Object.assign(new Error('Owned failed storage write'),{statusCode:503});};
 for(let i=1;i<=2;i++){
  await assert.rejects(split(f,every,randomUUID(),{splitSource:controlled}),status(503));
  assert.equal(await reserved(),baseline+i*attemptBytes);
  assert.equal((await adminPool.query('select count(*)::int n from intake_files where workspace_id=$1 and lease_expires_at>now()',[f.account.workspace.id])).rows[0].n,0,'Failures release active slots, not reserved bytes');
 }
 const retryId=randomUUID(),beforeWrites=writes;await assert.rejects(split(f,every,retryId,{splitSource:controlled}),status(429));assert.equal(writes,beforeWrites);
 assert.equal((await counts(f)).pages,0);assert.equal((await counts(f)).pdf_splits,0);
 const failedKeys=(await adminPool.query('select storage_key from intake_files where workspace_id=$1 and not(id=any($2::uuid[]))',[f.account.workspace.id,baseIds])).rows.map(row=>row.storage_key);
 assert.equal(failedKeys.length,6);for(const key of failedKeys)assert.equal(await deleteStoredFile(f.account.workspace.id,key),'complete');
 assert.equal(await reserved(),baseline);onWrite=undefined;
 await split(f,every,retryId,{splitSource:controlled});assert.equal((await counts(f)).pages,4);assert.equal(await reserved(),baseline);
});

test('same-bound staging retry works at the final page credit while changed bindings retain provisional quota',async()=>{
 const f=await fixture('last-credit');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1') where id=$1",[f.account.workspace.id]);
 const id=randomUUID(),options:PdfSplitSpec={mode:'every',pagesPerDocument:1},input={filename:'one.pdf',size:onePage.length,sha256:hash(onePage),pdfSplit:{requestId:id,options}};
 const interrupted=await reserveDirectUpload(actor(f.account),f.parserId,input);
 await assert.rejects(finalizeDirectUpload(actor(f.account),interrupted.uploadId),status(404));
 // A missing PUT leaves its signed reservation pending. Changed bytes or options
 // are distinct provisional work and must not receive the same-request exclusion.
 await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{...input,sha256:hash(Buffer.from('different source'))}),status(429));
 await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{...input,pdfSplit:{requestId:id,options:{mode:'ranges',ranges:[{start:1,end:1}]}}}),status(429));
 const fresh=await reserveDirectUpload(actor(f.account),f.parserId,input);assert.notEqual(fresh.uploadId,interrupted.uploadId);
 objects.set(`${f.account.workspace.id}/${fresh.uploadId}`,onePage);
 const accepted=await finalizeDirectUpload(actor(f.account),fresh.uploadId);assert.equal(accepted.split.selectedPages,1);assert.equal(accepted.split.requestId,id);
 const beforeWrites=writes;assert.equal((await finalizeDirectUpload(actor(f.account),fresh.uploadId)).replayed,true);assert.equal(writes,beforeWrites);
 const state=await counts(f);assert.equal(state.pdf_splits,1);assert.equal(state.documents,1);assert.equal(state.jobs,1);assert.equal(state.pages,1);
 assert.equal((await adminPool.query('select count(*)::int n from direct_uploads where workspace_id=$1',[f.account.workspace.id])).rows[0].n,2,'Both physical staging capabilities remain tracked');
});
