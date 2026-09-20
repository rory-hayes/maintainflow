import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {addDocument} from '../server/core/intake.js';
import {addSplitDocuments} from '../server/core/pdf-split-intake.js';
import {reserveDirectUpload} from '../server/core/upload-routes.js';
import {splitStoredPdf} from '../server/core/stored-pdf-split.js';
import {splitPdfSource} from '../server/core/source.js';
import {deleteStoredFile} from '../server/core/retention.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;documentId:string;sha256:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>(),options={mode:'every' as const,pagesPerDocument:2};
const originalFetch=globalThis.fetch,hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
let app:FastifyInstance,verified=false,pdf:Buffer,fetches=0,writes=0;
let onRead:((key:string)=>Promise<void>)|undefined,onWrite:((key:string)=>Promise<void>)|undefined;
const storage:PrivateStorage={kind:'supabase',
 async write(key,bytes){writes++;await onWrite?.(key);objects.set(key,Buffer.from(bytes));},
 async read(key){const value=objects.get(key);if(!value)throw Object.assign(new Error('Missing owned PDF original'),{statusCode:404});const copy=Buffer.from(value);await onRead?.(key);return copy;},
 async remove(key){objects.delete(key);},
 async signUpload(key){return `https://owned.example.test/upload/${key}`;},
};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const sessionHash=(a:Account)=>hashToken(a.cookie.split('; ').find(value=>value.startsWith('folio_session='))!.slice('folio_session='.length));
async function request(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={}){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id,...headers}});}
async function fixture(label:string):Promise<Fixture>{
 const registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned PDF race',workspaceName:`Owned PDF race ${label}`,email:`stored-pdf-race-${randomUUID()}@example.test`,password:'Owned stored PDF race password'}});assert.equal(registered.statusCode,201,registered.body);
 const account={...registered.json(),cookie:registered.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000') where id=$1",[account.workspace.id]);
 const parser=await request(account,'POST','/api/parsers',{name:'Owned PDF race parser',useCase:'custom',mode:'rules',allowedFormats:['pdf'],schema:{fields:[{key:'reference',label:'Reference',type:'string'}]}});assert.equal(parser.statusCode,201,parser.body);
 const parserId=parser.json().parser.id,source=await addDocument(actor(account),parserId,pdf,'owned-race.pdf');return {account,parserId,documentId:source.document.id,sha256:hash(pdf)};
}
const submit=(f:Fixture,id=randomUUID(),a=f.account,headers:Record<string,string>={},sourceId=f.documentId)=>request(a,'POST',`/api/documents/${sourceId}/pdf-splits`,{requestId:id,sourceSha256:f.sha256,options},{'x-workspace-id':f.account.workspace.id,...headers});
async function counts(f:Fixture){
 const row=(await adminPool.query(`select (select count(*)::int from documents where workspace_id=$1) documents,
  (select count(*)::int from jobs where workspace_id=$1) jobs,
  (select count(*)::int from pdf_splits where workspace_id=$1) splits,
  (select count(*)::int from stored_pdf_split_requests where workspace_id=$1) admissions,
  (select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages`,[f.account.workspace.id])).rows[0];return row;
}
async function cleanup(f:Fixture){
 const keys=(await adminPool.query('select storage_key from file_deletions where workspace_id=$1',[f.account.workspace.id])).rows.map(row=>row.storage_key as string);
 for(const key of keys)assert.equal(await deleteStoredFile(f.account.workspace.id,key),'complete');
 assert.equal((await adminPool.query('select count(*)::int n from intake_files where workspace_id=$1',[f.account.workspace.id])).rows[0].n,0);
}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>){for(let n=0;n<500;n++){if(await check())return;await delay(10);}assert.fail('Owned race reached the expected asynchronous gate');}

before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,url?5432:55432);if(!url)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No external requests in owned stored-PDF races');};app=await buildApp();
 const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica);for(let index=1;index<=4;index++)document.addPage([300,300]).drawText(`Owned source page ${index}`,{x:20,y:250,font,size:12});pdf=Buffer.from(await document.save());
});
afterEach(()=>{onRead=undefined;onWrite=undefined;assert.equal(fetches,0);});
after(async()=>{onRead=undefined;onWrite=undefined;setStorageForTests(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}}finally{objects.clear();await closeDatabase();}});

test('deleting the original during a held read rejects every child and keeps failed admission bound to source identity',async()=>{
 const f=await fixture('read-delete'),id=randomUUID(),hold=gate();let entered=false;const beforeWrites=writes;
 onRead=async key=>{if(key===`${f.account.workspace.id}/${f.documentId}`){entered=true;await hold.promise;}};
 const pending=submit(f,id);try{await until(()=>entered);assert.equal((await request(f.account,'DELETE',`/api/documents/${f.documentId}`)).statusCode,200);}finally{hold.release();}
 const response=await pending;assert.equal(response.statusCode,404,response.body);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,admissions:1,pages:4});onRead=undefined;
 const replacement=await addDocument(actor(f.account),f.parserId,pdf,'same-bytes-different-document.pdf');assert.notEqual(replacement.document.id,f.documentId);
 assert.equal((await submit(f,id,f.account,{},replacement.document.id)).statusCode,409);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,pdf,'ordinary.pdf',id,options),(error:any)=>error.statusCode===409);
 await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{filename:'ordinary.pdf',size:pdf.length,sha256:f.sha256,pdfSplit:{requestId:id,options}}),(error:any)=>error.statusCode===409);
 assert.equal((await submit(f,id)).statusCode,404);assert.equal((await counts(f)).splits,0);await cleanup(f);
});

test('deleting the original during derived writes leaves tracked cleanup and no child jobs or extra page charge',async()=>{
 const f=await fixture('write-delete'),hold=gate();let entered=0;onWrite=async()=>{entered++;await hold.promise;};
 const pending=submit(f);try{await until(()=>entered>=2);assert.equal((await request(f.account,'DELETE',`/api/documents/${f.documentId}`)).statusCode,200);}finally{hold.release();}
 const response=await pending;assert.equal(response.statusCode,404,response.body);onWrite=undefined;assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,admissions:1,pages:4});
 const staged=(await adminPool.query('select storage_key from intake_files where workspace_id=$1',[f.account.workspace.id])).rows;assert.ok(staged.length>=2);
 const deletions=new Set((await adminPool.query('select storage_key from file_deletions where workspace_id=$1',[f.account.workspace.id])).rows.map(row=>row.storage_key));for(const row of staged)assert.ok(deletions.has(row.storage_key));await cleanup(f);assert.equal([...objects.keys()].filter(key=>key.startsWith(f.account.workspace.id+'/')).length,0);
});

test('an API key revoked during writes cannot accept a batch; a fresh authorized retry uses the same admission once',async()=>{
 const f=await fixture('key-revoke'),id=randomUUID(),key=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned split writer',scopes:['documents:read','documents:write']});assert.equal(key.statusCode,200,key.body);
 const hold=gate();let entered=0;onWrite=async()=>{entered++;await hold.promise;};const pending=submit(f,id,f.account,{authorization:`Bearer ${key.json().token}`});
 try{await until(()=>entered>=2);assert.equal((await request(f.account,'DELETE',`/api/workspace/api-keys/${key.json().apiKey.id}`)).statusCode,200);}finally{hold.release();}
 const response=await pending;assert.equal(response.statusCode,401,response.body);onWrite=undefined;assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:0,admissions:1,pages:4});await cleanup(f);
 const retried=await submit(f,id);assert.equal(retried.statusCode,202,retried.body);assert.deepEqual(await counts(f),{documents:3,jobs:3,splits:1,admissions:1,pages:8});assert.equal((await submit(f,id)).json().split.id,retried.json().split.id);assert.equal((await counts(f)).pages,8);
});

test('membership downgrade during source read rejects stale editor authority without derived writes',async()=>{
 const f=await fixture('role-downgrade'),member=await fixture('editor-account');await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'editor')",[f.account.workspace.id,member.account.user.id]);
 const hold=gate();let entered=false;const beforeWrites=writes;onRead=async key=>{if(key===`${f.account.workspace.id}/${f.documentId}`){entered=true;await hold.promise;}};
 const pending=submit(f,randomUUID(),member.account);try{await until(()=>entered);const changed=await request(f.account,'PATCH',`/api/workspace/members/${member.account.user.id}`,{role:'viewer'});assert.equal(changed.statusCode,200,changed.body);}finally{hold.release();}
 const response=await pending;assert.equal(response.statusCode,403,response.body);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:0,admissions:1,pages:4});
});

test('deleting the original during a held decoder leaves the admission recoverable but accepts no children',async()=>{
 const f=await fixture('decode-delete'),hold=gate();let entered=false;const beforeWrites=writes;
 const pending=splitStoredPdf({actor:actor(f.account),tokenHash:sessionHash(f.account)},f.documentId,randomUUID(),f.sha256,options,{splitSource:async(...args)=>{entered=true;await hold.promise;return splitPdfSource(...args);}});
 const rejected=assert.rejects(pending,(error:any)=>error.statusCode===404);
 try{await until(()=>entered);assert.equal((await request(f.account,'DELETE',`/api/documents/${f.documentId}`)).statusCode,200);}finally{hold.release();}
 await rejected;assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,admissions:1,pages:4});await cleanup(f);
});

test('a timed-out source read cannot continue into decoding or writes when its late bytes arrive',async()=>{
 const f=await fixture('read-timeout'),hold=gate();let entered=false,decoded=0;const beforeWrites=writes;
 const rejected=assert.rejects(splitStoredPdf({actor:actor(f.account),tokenHash:sessionHash(f.account)},f.documentId,randomUUID(),f.sha256,options,{
  timeoutMs:250,readSource:async()=>{entered=true;await hold.promise;return Buffer.from(pdf);},splitSource:async(...args)=>{decoded++;return splitPdfSource(...args);},
 }),(error:any)=>error.statusCode===503);
 try{await until(()=>entered);await rejected;}finally{hold.release();}
 await delay(20);assert.equal(decoded,0);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:0,admissions:1,pages:4});
});

test('a session that expires while waiting for the workspace lock cannot reserve, write or charge',async()=>{
 const f=await fixture('expiry-lock'),held=await adminPool.connect();const before=await counts(f),beforeWrites=writes;let pending:ReturnType<typeof submit>|undefined;
 try{await held.query('begin');const {rows:[{pid}]}=await held.query('select pg_backend_pid() pid');await held.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[f.account.workspace.id]);
  await adminPool.query("update sessions set expires_at=clock_timestamp()+interval '1500 milliseconds' where token_hash=$1",[sessionHash(f.account)]);pending=submit(f);
  await until(async()=>Boolean((await adminPool.query("select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid)) and query like '%pg_advisory_xact_lock%') waiting",[pid])).rows[0].waiting));
  await until(async()=>!(await adminPool.query('select expires_at>clock_timestamp() live from sessions where token_hash=$1',[sessionHash(f.account)])).rows[0].live);
 }finally{await held.query('rollback');held.release();}
 assert.ok(pending);const response=await pending;assert.equal(response.statusCode,401,response.body);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),before);
});

test('conflicting account, membership and session locks return a fixed retryable error without a deadlock',async()=>{
 const f=await fixture('auth-lock');
 for(const lock of ['user','membership','session'] as const){const held=await adminPool.connect(),before=await counts(f),id=randomUUID(),beforeWrites=writes;try{
  await held.query('begin');if(lock==='user')await held.query('select id from users where id=$1 for update',[f.account.user.id]);
  else if(lock==='membership')await held.query('select user_id from memberships where workspace_id=$1 and user_id=$2 for update',[f.account.workspace.id,f.account.user.id]);
  else await held.query('select token_hash from sessions where token_hash=$1 for update',[sessionHash(f.account)]);
  const response=await submit(f,id);assert.equal(response.statusCode,503,response.body);assert.equal(/deadlock|lock_not_available|could not obtain|relation|SQLSTATE/i.test(response.body),false);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),before);
 }finally{await held.query('rollback');held.release();}
 const response=await submit(f,id);assert.equal(response.statusCode,202,response.body);
 }
});

test('post-acceptance replay after original deletion returns the surviving independent batch without I/O or duplicate usage',async()=>{
 const f=await fixture('replay-source-delete'),id=randomUUID(),first=await submit(f,id);assert.equal(first.statusCode,202,first.body);const receipt=first.json();
 assert.equal((await request(f.account,'DELETE',`/api/documents/${f.documentId}`)).statusCode,200);await cleanup(f);const before=await counts(f),beforeWrites=writes;
 onRead=async()=>{throw new Error('A stored receipt replay must not read its deleted source');};onWrite=async()=>{throw new Error('A stored receipt replay must not create another source');};
 const replay=await submit(f,id);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().split.id,receipt.split.id);assert.equal(replay.json().split.sourceDocumentAvailable,false);assert.equal(replay.json().split.sourceAvailable,true);assert.ok(replay.json().documents.every((document:any)=>document.available));assert.deepEqual(await counts(f),before);assert.equal(writes,beforeWrites);onRead=undefined;onWrite=undefined;
 assert.deepEqual(objects.get(`${f.account.workspace.id}/${receipt.split.id}`),pdf);
});
