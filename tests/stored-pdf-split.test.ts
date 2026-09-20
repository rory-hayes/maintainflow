import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,withWorkspace,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {addDocument} from '../server/core/intake.js';
import {addArchiveDocuments} from '../server/core/archive-import-intake.js';
import {addSplitDocuments} from '../server/core/pdf-split-intake.js';
import {splitStoredPdf} from '../server/core/stored-pdf-split.js';
import {splitPdfSource} from '../server/core/source.js';
import {deleteStoredFile} from '../server/core/retention.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;documentId:string;sha256:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>(),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const originalFetch=globalThis.fetch,every={mode:'every' as const,pagesPerDocument:2};
let app:FastifyInstance,verified=false,pdf:Buffer,fetches=0,reads=0,writes=0;
const storage:PrivateStorage={kind:'supabase',
 async write(key,bytes){writes++;objects.set(key,Buffer.from(bytes));},
 async read(key){reads++;const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned original unavailable'),{statusCode:404});return Buffer.from(bytes);},
 async remove(key){objects.delete(key);},
};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const authorization=(a:Account)=>({actor:actor(a),tokenHash:hashToken(a.cookie.split('; ').find(value=>value.startsWith('folio_session='))!.slice('folio_session='.length))});
async function request(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={}){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id,...headers}});}
async function fixture(label:string):Promise<Fixture>{
 const registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned stored PDF',workspaceName:`Owned stored PDF ${label}`,email:`stored-pdf-${randomUUID()}@example.test`,password:'Owned stored PDF fixture password'}});assert.equal(registered.statusCode,201,registered.body);
 const account={...registered.json(),cookie:registered.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000') where id=$1",[account.workspace.id]);
 const parser=await request(account,'POST','/api/parsers',{name:'Owned stored PDF parser',useCase:'custom',mode:'rules',allowedFormats:['pdf'],schema:{fields:[{key:'reference',label:'Reference',type:'string',anchor:'Reference'}]}});assert.equal(parser.statusCode,201,parser.body);
 const parserId=parser.json().parser.id,source=await addDocument(actor(account),parserId,pdf,'owned-stored-source.pdf');
 return {account,parserId,documentId:source.document.id,sha256:hash(pdf)};
}
const submit=(f:Fixture,requestId=randomUUID(),options:unknown=every,sourceSha256=f.sha256,documentId=f.documentId)=>request(f.account,'POST',`/api/documents/${documentId}/pdf-splits`,{requestId,sourceSha256,options});
async function counts(f:Fixture){return (await adminPool.query(`select
 (select count(*)::int from documents where workspace_id=$1) documents,
 (select count(*)::int from jobs where workspace_id=$1) jobs,
 (select count(*)::int from pdf_splits where workspace_id=$1) splits,
 (select count(*)::int from stored_pdf_split_requests where workspace_id=$1) admissions,
 (select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages`,[f.account.workspace.id])).rows[0];}

before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,url?5432:55432);if(!url)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No external requests in stored PDF fixtures');};app=await buildApp();
 const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica);
 for(let index=1;index<=4;index++){const page=document.addPage([300,300]);page.drawText(`Reference: STORED-${index}`,{x:20,y:250,font,size:12});if(index===1||index===3)page.drawText('START DOC',{x:20,y:230,font,size:12});}
 pdf=Buffer.from(await document.save());
});
afterEach(()=>assert.equal(fetches,0));
after(async()=>{setStorageForTests(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}}finally{objects.clear();await closeDatabase();}});

test('stored API preserves the source and binds replay to source document, digest, parser and canonical plan',async()=>{
 const f=await fixture('replay'),id=randomUUID(),sourceBefore=(await adminPool.query('select * from documents where id=$1',[f.documentId])).rows[0];
 const accepted=await submit(f,id);assert.equal(accepted.statusCode,202,accepted.body);const receipt=accepted.json();
 assert.equal(receipt.split.origin,'stored');assert.equal(receipt.split.sourceDocumentId,f.documentId);assert.equal(receipt.split.sourceSha256,f.sha256);assert.equal(receipt.split.sourceDocumentAvailable,true);
 assert.deepEqual(receipt.documents.map((d:any)=>[d.originalPageStart,d.originalPageEnd,d.root.pageStart,d.root.pageEnd]),[[1,2,1,2],[3,4,3,4]]);
 assert.ok(receipt.documents.every((d:any)=>d.root.kind==='document'&&d.root.id===f.documentId&&d.root.sha256===f.sha256&&d.root.pageCount===4));
 assert.deepEqual((await adminPool.query('select * from documents where id=$1',[f.documentId])).rows[0],sourceBefore);assert.deepEqual(objects.get(`${f.account.workspace.id}/${f.documentId}`),pdf);
 const before=await counts(f),io=[reads,writes],replayed=await submit(f,id,{pagesPerDocument:2,mode:'every'});
 assert.equal(replayed.statusCode,202,replayed.body);assert.equal(replayed.json().split.id,receipt.split.id);assert.equal(replayed.json().replayed,true);assert.deepEqual([reads,writes],io);assert.deepEqual(await counts(f),before);
 assert.equal((await submit(f,id,{mode:'every',pagesPerDocument:1})).statusCode,409);assert.equal((await submit(f,id,every,'0'.repeat(64))).statusCode,409);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,pdf,'ordinary.pdf',id,every),(error:any)=>error.statusCode===409);
 const recovery=await request(f.account,'GET',`/api/parsers/${f.parserId}/pdf-splits/requests/${id}`);assert.equal(recovery.statusCode,200,recovery.body);assert.equal(recovery.json().split.id,receipt.split.id);
 assert.deepEqual(await counts(f),{documents:3,jobs:3,splits:1,admissions:1,pages:8});
});

test('stored split admission enforces actual PDF type, digest, strict input, origin, roles, scopes and tenant ownership',async()=>{
 const f=await fixture('guards'),foreign=await fixture('foreign'),payload={requestId:randomUUID(),sourceSha256:f.sha256,options:every};
 assert.equal((await request(f.account,'POST',`/api/documents/${f.documentId}/pdf-splits`,{...payload,extra:true})).statusCode,400);
 assert.equal((await submit(f,randomUUID(),every,'0'.repeat(64))).statusCode,409);
 assert.equal((await submit(f,randomUUID(),{mode:'ranges',ranges:[{start:5,end:5}]})).statusCode,400);
 assert.equal((await request(f.account,'POST',`/api/documents/${f.documentId}/pdf-splits`,payload,{origin:'https://foreign.example.test'})).statusCode,403);
 assert.equal((await request(foreign.account,'POST',`/api/documents/${f.documentId}/pdf-splits`,payload)).statusCode,404);
 const viewer=await fixture('viewer');await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[f.account.workspace.id,viewer.account.user.id]);
 assert.equal((await request(viewer.account,'POST',`/api/documents/${f.documentId}/pdf-splits`,payload,{'x-workspace-id':f.account.workspace.id})).statusCode,403);
 const readKey=await request(f.account,'POST','/api/workspace/api-keys',{name:'Read-only fixture',scopes:['documents:read']});assert.equal(readKey.statusCode,200,readKey.body);
 assert.equal((await request(f.account,'POST',`/api/documents/${f.documentId}/pdf-splits`,payload,{authorization:`Bearer ${readKey.json().token}`})).statusCode,403);
 const writeKey=await request(f.account,'POST','/api/workspace/api-keys',{name:'Write fixture',scopes:['documents:read','documents:write']});
 const keyed=await request(f.account,'POST',`/api/documents/${f.documentId}/pdf-splits`,{...payload,requestId:randomUUID()},{authorization:`Bearer ${writeKey.json().token}`});assert.equal(keyed.statusCode,202,keyed.body);
 await adminPool.query("update parsers set allowed_formats=null where id=$1",[f.parserId]);
 const text=await addDocument(actor(f.account),f.parserId,Buffer.from('Owned text'),'owned.txt');assert.equal((await submit(f,randomUUID(),every,text.document.sha256,text.document.id)).statusCode,415);
});

test('server recomputes native marker boundaries and accepted children contain the selected source pages',async()=>{
 const f=await fixture('marker'),badId=randomUUID();
 const rejected=await submit(f,badId,{mode:'marker',marker:'START DOC',ranges:[{start:1,end:4}]});assert.equal(rejected.statusCode,400,rejected.body);
 const io=[reads,writes],replayed=await submit(f,badId,{mode:'marker',marker:'START DOC',ranges:[{start:1,end:4}]});assert.equal(replayed.statusCode,400);assert.deepEqual([reads,writes],io);
 const terminal=await request(f.account,'GET',`/api/parsers/${f.parserId}/pdf-splits/requests/${badId}`);assert.equal(terminal.statusCode,200,terminal.body);
 assert.deepEqual(terminal.json().rejected,{id:(await adminPool.query('select id from pdf_splits where request_id=$1 and workspace_id=$2',[badId,f.account.workspace.id])).rows[0].id,requestId:badId,parserId:f.parserId,sourceDocumentId:f.documentId,sourceSha256:f.sha256,options:{mode:'marker',marker:'START DOC',ranges:[{start:1,end:4}]},code:'pdf_split_validation_failed',reason:'marker_plan_mismatch',message:'The confirmed page ranges do not match this PDF’s text marker. Preview the split again.'});
 const response=await submit(f,randomUUID(),{mode:'marker',marker:'START DOC',ranges:[{start:1,end:2},{start:3,end:4}]});assert.equal(response.statusCode,202,response.body);
 const children=(await adminPool.query('select source_text from documents where pdf_split_id=$1 order by pdf_split_index',[response.json().split.id])).rows;
 assert.match(children[0].source_text[0].text,/STORED-1/);assert.match(children[1].source_text[0].text,/STORED-3/);assert.equal(response.json().split.selectedPages,4);
});

test('existing uploaded split children preserve cumulative root pages across repeated stored splitting',async()=>{
 const f=await fixture('root'),uploaded=await addSplitDocuments(actor(f.account),f.parserId,pdf,'uploaded-root.pdf',randomUUID(),{mode:'ranges',ranges:[{start:2,end:4}]});
 const source=uploaded.documents[0]!,sourceRow=(await adminPool.query('select sha256 from documents where id=$1',[source.id])).rows[0];
 const result=await submit(f,randomUUID(),{mode:'ranges',ranges:[{start:2,end:3}]},sourceRow.sha256,source.id);assert.equal(result.statusCode,202,result.body);
 const child=result.json().documents[0];assert.deepEqual(child.root,{kind:'pdf-split',id:uploaded.split.id,sha256:f.sha256,pageCount:4,pageStart:3,pageEnd:4});assert.equal(child.originalPageStart,2);
 const childRow=(await adminPool.query('select sha256 from documents where id=$1',[child.id])).rows[0];
 const grandchild=await submit(f,randomUUID(),{mode:'ranges',ranges:[{start:2,end:2}]},childRow.sha256,child.id);assert.equal(grandchild.statusCode,202,grandchild.body);
 assert.deepEqual(grandchild.json().documents[0].root,{kind:'pdf-split',id:uploaded.split.id,sha256:f.sha256,pageCount:4,pageStart:4,pageEnd:4});
 const detail=await request(f.account,'GET',`/api/documents/${grandchild.json().documents[0].id}`);assert.deepEqual(detail.json().split.root,grandchild.json().documents[0].root);
});

test('quota rejection commits no batch, jobs, objects or charge; same bound request succeeds once capacity exists',async()=>{
 const f=await fixture('quota'),id=randomUUID();await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','7') where id=$1",[f.account.workspace.id]);const beforeWrites=writes;
 const blocked=await submit(f,id);assert.equal(blocked.statusCode,429,blocked.body);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:0,admissions:1,pages:4});
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','8') where id=$1",[f.account.workspace.id]);
 const result=await submit(f,id);assert.equal(result.statusCode,202,result.body);assert.equal((await submit(f,id)).statusCode,202);assert.equal((await counts(f)).pages,8);
});

test('an actual ZIP PDF leaf can split directly and its root page numbers belong to the leaf PDF',async()=>{
 const f=await fixture('zip-leaf'),zip=new JSZip();zip.file('owned-leaf.pdf',pdf);
 const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 const imported=await addArchiveDocuments(actor(f.account),f.parserId,bytes,'owned.zip',randomUUID(),{mode:'zip',version:1,sourceSha256:hash(bytes),entries:[1]});
 const leaf=imported.documents[0]!;
 const response=await submit(f,randomUUID(),{mode:'ranges',ranges:[{start:2,end:4}]},f.sha256,leaf.id);assert.equal(response.statusCode,202,response.body);
 assert.equal(response.json().split.sourceDocumentId,leaf.id);assert.deepEqual(response.json().documents[0].root,{kind:'document',id:leaf.id,sha256:f.sha256,pageCount:4,pageStart:2,pageEnd:4});
 const original=await request(f.account,'GET',`/api/documents/${leaf.id}`);assert.equal(original.statusCode,200);assert.equal(original.json().archive.id,imported.archive.id);
 assert.deepEqual(objects.get(`${f.account.workspace.id}/${imported.archive.id}`),bytes);assert.deepEqual(objects.get(`${f.account.workspace.id}/${leaf.id}`),pdf);
});

test('explicit undo is stored-only, idempotent, source-preserving and does not remove independent descendant or sibling batches',async()=>{
 const f=await fixture('undo'),id=randomUUID(),first=await submit(f,id),second=await submit(f);assert.equal(first.statusCode,202,first.body);assert.equal(second.statusCode,202,second.body);
 const child=first.json().documents[0],childRow=(await adminPool.query('select sha256 from documents where id=$1',[child.id])).rows[0];
 const nested=await submit(f,randomUUID(),{mode:'every',pagesPerDocument:1},childRow.sha256,child.id);assert.equal(nested.statusCode,202,nested.body);const pages=(await counts(f)).pages;
 const response=await request(f.account,'POST',`/api/pdf-splits/${first.json().split.id}/undo`,{});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().removedDocuments,2);assert.ok(response.json().receipt.split.undoneAt);assert.equal(response.json().receipt.split.sourceDocumentAvailable,true);
 const repeated=await request(f.account,'POST',`/api/pdf-splits/${first.json().split.id}/undo`,{});assert.equal(repeated.statusCode,200,repeated.body);assert.equal(repeated.json().removedDocuments,0);assert.equal(repeated.json().receipt.split.undoneAt,response.json().receipt.split.undoneAt);
 const replay=await submit(f,id);assert.equal(replay.statusCode,202);assert.ok(replay.json().documents.every((d:any)=>!d.available));assert.equal((await counts(f)).pages,pages);
 assert.equal((await request(f.account,'GET',`/api/documents/${f.documentId}`)).statusCode,200);
 for(const d of [...second.json().documents,...nested.json().documents])assert.equal((await request(f.account,'GET',`/api/documents/${d.id}`)).statusCode,200);
 const nestedRecovery=await request(f.account,'GET',`/api/parsers/${f.parserId}/pdf-splits/requests/${nested.json().split.requestId}`);assert.equal(nestedRecovery.json().split.sourceDocumentAvailable,false);assert.equal(nestedRecovery.json().split.sourceAvailable,true);
 const uploaded=await addSplitDocuments(actor(f.account),f.parserId,pdf,'uploaded.pdf',randomUUID(),every);assert.equal((await request(f.account,'POST',`/api/pdf-splits/${uploaded.split.id}/undo`,{})).statusCode,409);
});

test('source history pagination is exact at sub-millisecond timestamps and remains readable after source deletion',async()=>{
 const f=await fixture('history'),spec={mode:'every' as const,pagesPerDocument:4},decoded=await splitPdfSource(pdf,'owned.pdf',spec),receipts=[];
 for(let i=0;i<21;i++)receipts.push(await splitStoredPdf(authorization(f.account),f.documentId,randomUUID(),f.sha256,spec,{splitSource:async()=>decoded}));
 // PostgreSQL timestamps have more precision than JS Date. Cursor comparison must stay in SQL.
 await adminPool.query("update pdf_splits set created_at='2026-01-01T12:00:00.123456Z' where workspace_id=$1",[f.account.workspace.id]);
 const first=await request(f.account,'GET',`/api/documents/${f.documentId}/pdf-splits`);assert.equal(first.statusCode,200,first.body);assert.equal(first.json().batches.length,20);assert.ok(first.json().nextCursor);
 const last=await request(f.account,'GET',`/api/documents/${f.documentId}/pdf-splits?before=${first.json().nextCursor}`);assert.equal(last.statusCode,200,last.body);assert.equal(last.json().batches.length,1);assert.equal(last.json().nextCursor,null);
 assert.equal(new Set([...first.json().batches,...last.json().batches].map((b:any)=>b.split.id)).size,21);
 assert.equal((await request(f.account,'DELETE',`/api/documents/${f.documentId}`)).statusCode,200);
 const deleted=await request(f.account,'GET',`/api/documents/${f.documentId}/pdf-splits`);assert.equal(deleted.statusCode,200,deleted.body);assert.equal(deleted.json().sourceAvailable,false);
});

test('audit failure rolls back children and charge while tracked cleanup and immutable admission survive',async()=>{
 const f=await fixture('rollback'),id=randomUUID(),suffix=randomUUID().replaceAll('-',''),fn=`owned_stored_${suffix}`;
 await adminPool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.workspace_id='${f.account.workspace.id}'::uuid and NEW.action='document.split' then raise exception 'Owned stored split audit fixture'; end if; return NEW; end $$`);
 try{
  await adminPool.query(`create trigger ${fn} before insert on audit_events for each row execute function ${fn}()`);
  const response=await submit(f,id);assert.equal(response.statusCode,500,response.body);assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:0,admissions:1,pages:4});
  const intents=(await adminPool.query('select storage_key from intake_files where workspace_id=$1',[f.account.workspace.id])).rows;assert.equal(intents.length,3);
  for(const row of intents)assert.equal(await deleteStoredFile(f.account.workspace.id,row.storage_key),'complete');
  assert.deepEqual([...objects.keys()].filter(key=>key.startsWith(f.account.workspace.id+'/')),[`${f.account.workspace.id}/${f.documentId}`]);
 }finally{await adminPool.query(`drop trigger if exists ${fn} on audit_events`);await adminPool.query(`drop function ${fn}()`);}
 assert.equal((await submit(f,id)).statusCode,202);
});

test('new admission rows are tenant scoped and persisted lineage rejects partial or out-of-range shapes',async()=>{
 const f=await fixture('constraints'),other=await fixture('rls'),response=await submit(f);assert.equal(response.statusCode,202,response.body);const splitId=response.json().split.id;
 assert.equal(await withWorkspace(other.account.workspace.id,async c=>(await c.query('select 1 from stored_pdf_split_requests where workspace_id=$1',[f.account.workspace.id])).rowCount),0);
 await assert.rejects(withWorkspace(other.account.workspace.id,c=>c.query("insert into stored_pdf_split_requests(workspace_id,request_id,parser_id,source_document_id,source_sha256,canonical_spec,spec_hash) values($1,$2,$3,$4,$5,'{}',$5)",[f.account.workspace.id,randomUUID(),f.parserId,f.documentId,f.sha256])),(error:any)=>error.code==='42501');
 await assert.rejects(adminPool.query('update pdf_splits set root_id=null where id=$1',[splitId]),(error:any)=>error.code==='23514');
 await assert.rejects(adminPool.query('update pdf_splits set root_page_start=4 where id=$1',[splitId]),(error:any)=>error.code==='23514');
 const flags=(await adminPool.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='stored_pdf_split_requests'::regclass")).rows[0];assert.equal(flags.relrowsecurity,true);assert.equal(flags.relforcerowsecurity,true);
});
