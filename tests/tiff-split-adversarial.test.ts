import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipartPlugin from '@fastify/multipart';
import {ZodError} from 'zod';
import sharp from 'sharp';
import type {Actor} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {registerSplitPreview} from '../server/core/split-preview.js';
import {reserveDirectUpload,finalizeDirectUpload,confirmDirectSplit} from '../server/core/upload-routes.js';
import {addDocument} from '../server/core/intake.js';
import {addSplitDocuments} from '../server/core/pdf-split-intake.js';
import {splitStoredPdf} from '../server/core/stored-pdf-split.js';
import {deleteStoredFile} from '../server/core/retention.js';
import {renderTiffPage} from '../server/core/source.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {makeTiff} from './fixtures/tiff.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>(),extraApps:FastifyInstance[]=[];
const originalFetch=globalThis.fetch,hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const splitOptions={mode:'every' as const,pagesPerDocument:1};
let app:FastifyInstance,verified=false,tiff:Buffer,fetches=0,writes=0;
let onRead:((key:string)=>Promise<void>)|undefined;
let onWrite:((key:string)=>Promise<void>)|undefined;
const storage:PrivateStorage={kind:'supabase',
 async write(key,bytes){writes++;await onWrite?.(key);objects.set(key,Buffer.from(bytes));},
 async read(key){const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned fixture object unavailable'),{statusCode:404});const copy=Buffer.from(bytes);await onRead?.(key);return copy;},
 async remove(key){objects.delete(key);},async signUpload(key){return `https://owned.example.test/upload/${key}`;},
};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const sessionHash=(a:Account)=>hashToken(a.cookie.split('; ').find(c=>c.startsWith('folio_session='))!.slice('folio_session='.length));
const headers=(a:Account,extra:Record<string,string>={})=>({origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id,...extra});
const request=(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,extra:Record<string,string>={})=>app.inject({method,url,payload:payload as any,headers:headers(a,extra)});
async function fixture(label:string,formats=['tiff']):Promise<Fixture>{
 const registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned TIFF split',workspaceName:`Owned TIFF split ${label}`,email:`tiff-split-${randomUUID()}@example.test`,password:'Owned TIFF split fixture password'}});assert.equal(registered.statusCode,201,registered.body);
 const account={...registered.json(),cookie:registered.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 const parser=await request(account,'POST','/api/parsers',{name:'Owned TIFF parser',useCase:'custom',mode:'rules',allowedFormats:formats,schema:{fields:[{key:'reference',label:'Reference',type:'string'}]}});assert.equal(parser.statusCode,201,parser.body);
 return {account,parserId:parser.json().parser.id};
}
async function counts(f:Fixture){return (await adminPool.query(`select
 (select count(*)::int from documents where workspace_id=$1) documents,
 (select count(*)::int from jobs where workspace_id=$1) jobs,
 (select count(*)::int from pdf_splits where workspace_id=$1) splits,
 (select count(*)::int from stored_pdf_split_requests where workspace_id=$1) admissions,
 (select count(*)::int from intake_files where workspace_id=$1) intents,
 (select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages`,[f.account.workspace.id])).rows[0];}
const empty={documents:0,jobs:0,splits:0,admissions:0,intents:0,pages:0};
function form(bytes=tiff,fields:Array<[string,string]>=[['page','2']],filename='misleading.pdf'){
 const boundary=`owned-${randomUUID()}`,chunks:Buffer[]=[];
 for(const [key,value]of fields)chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
 chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`));
 return {body:Buffer.concat(chunks),contentType:`multipart/form-data; boundary=${boundary}`};
}
function preview(f:Fixture,server=app,bytes=tiff,fields:Array<[string,string]>=[['page','2']],extra:Record<string,string>={}){
 const data=form(bytes,fields);return server.inject({method:'POST',url:`/api/parsers/${f.parserId}/pdf-splits/preview`,headers:headers(f.account,{'content-type':data.contentType,...extra}),payload:data.body});
}
async function reservation(f:Fixture,bytes=tiff){
 const response=await reserveDirectUpload(actor(f.account),f.parserId,{filename:'owned-source.tiff',size:bytes.length,sha256:hash(bytes),pdfSplit:{requestId:randomUUID(),options:splitOptions}});
 const key=`${f.account.workspace.id}/${response.uploadId}`;objects.set(key,Buffer.from(bytes));return {id:response.uploadId,key};
}
const stagedPreview=(f:Fixture,id:string,server=app,page=2)=>server.inject({method:'POST',url:`/api/uploads/${id}/split-preview`,headers:headers(f.account),payload:{page}});
async function lease(id:string){return (await adminPool.query('select state,finalize_owner,finalize_lease_until from direct_uploads where id=$1',[id])).rows[0];}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<400;i++){if(await check())return;await delay(10);}assert.fail('Owned preview reached its controlled gate');}
async function isolated(options:Parameters<typeof registerSplitPreview>[1]){
 const server=Fastify();await server.register(cookie);await server.register(multipartPlugin);
 server.setErrorHandler((error,_request,reply)=>reply.code(error instanceof ZodError?400:(error as any).statusCode??500).send({message:error instanceof Error?error.message:'Fixture error'}));
 registerSplitPreview(server,options);await server.ready();extraApps.push(server);return server;
}

before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role]of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,url?5432:55432);if(!url)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('External requests blocked in owned TIFF split tests');};app=await buildApp();
 tiff=makeTiff([{width:40,height:60,color:[180,20,30],compression:'deflate'},{width:70,height:30,orientation:6,color:[20,160,40],compression:'deflate'},{width:32,height:40,color:[20,30,190],compression:'deflate'}],{bigTiff:true,byteOrder:'MM'});
});
afterEach(()=>{onRead=undefined;onWrite=undefined;assert.equal(fetches,0);});
after(async()=>{onRead=undefined;onWrite=undefined;setStorageForTests(undefined);globalThis.fetch=originalFetch;try{for(const server of extraApps)await server.close();await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}}finally{objects.clear();await closeDatabase();}});

test('multipart TIFF preview binds an oriented JPEG to original bytes without admissions, storage or page charges',async()=>{
 const f=await fixture('multipart'),beforeWrites=writes,original=Buffer.from(tiff),response=await preview(f);
 assert.equal(response.statusCode,200,response.body);assert.match(response.headers['content-type']!,/^image\/jpeg/);
 assert.equal(response.headers['x-folio-source-sha256'],hash(tiff));assert.equal(response.headers['x-folio-preview-page'],'2');assert.equal(response.headers['x-folio-page-count'],'3');
 assert.equal(response.headers['cache-control'],'private, no-store');assert.equal(response.headers['referrer-policy'],'no-referrer');assert.equal(response.headers['x-content-type-options'],'nosniff');
 const metadata=await sharp(response.rawPayload).metadata();assert.equal(metadata.width,30);assert.equal(metadata.height,70);assert.deepEqual(tiff,original);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),empty);
});

test('preview rejects malformed fields, other formats, foreign parsers and insufficient key scopes before accepting bytes',async()=>{
 const f=await fixture('validation'),other=await fixture('foreign'),pdfOnly=await fixture('pdf-only',['pdf']);
 for(const fields of [[['page','0']],[['page','31']],[['page','1'],['page','2']],[['page','1'],['extra','x']],[]] as Array<Array<[string,string]>>)assert.ok([400,413].includes((await preview(f,app,tiff,fields)).statusCode));
 assert.equal((await preview(f,app,Buffer.from('%PDF-1.7\n'))).statusCode,415);
 assert.equal((await preview(f,app,tiff,[['page','4']])).statusCode,400);
 assert.equal((await preview(pdfOnly)).statusCode,415);
 assert.equal((await preview({...f,account:other.account})).statusCode,404);
 const key=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned write-only preview key',scopes:['documents:write']});assert.equal(key.statusCode,200,key.body);
 assert.equal((await preview(f,app,tiff,[['page','1']],{authorization:`Bearer ${key.json().token}`})).statusCode,403);
 assert.deepEqual(await counts(f),empty);
});

test('late multipart rendering cannot publish after membership downgrade, parser policy change or key read-scope removal',async()=>{
 for(const change of ['membership','policy','read-scope'] as const){
  const f=await fixture(change),hold=gate();let entered=false;const server=await isolated({renderPage:async(...args)=>{const value=await renderTiffPage(...args);entered=true;await hold.promise;return value;}});
  let extra:Record<string,string>={},keyId:string|undefined;
  if(change==='read-scope'){const key=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned preview key',scopes:['documents:read','documents:write']});assert.equal(key.statusCode,200,key.body);extra={authorization:`Bearer ${key.json().token}`};keyId=key.json().apiKey.id;}
  const pending=preview(f,server,tiff,[['page','2']],extra);
  try{await until(()=>entered);
   if(change==='membership')await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,f.account.user.id]);
   else if(change==='policy')await adminPool.query("update parsers set allowed_formats=ARRAY['pdf']::text[] where id=$1",[f.parserId]);
   else await adminPool.query('update api_keys set scopes=$2::jsonb where id=$1',[keyId,JSON.stringify(['documents:write'])]);
  }finally{hold.release();}
  const result=await pending;assert.equal(result.statusCode,change==='policy'?415:403,result.body);assert.doesNotMatch(result.headers['content-type']??'',/image/);assert.deepEqual(await counts(f),empty);
 }
});

test('signed preview supports an unconfirmed split while excluding simultaneous preview and finalize, then releases only its lease',async()=>{
 const f=await fixture('signed-lease'),upload=await reservation(f);await adminPool.query('update direct_uploads set pdf_split_spec=null where id=$1',[upload.id]);
 const hold=gate();let entered=false;onRead=async key=>{if(key===upload.key){entered=true;await hold.promise;}};
 const pending=stagedPreview(f,upload.id);
 try{await until(()=>entered);assert.equal((await lease(upload.id)).state,'finalizing');assert.equal((await stagedPreview(f,upload.id)).statusCode,409);await assert.rejects(finalizeDirectUpload(actor(f.account),upload.id),(error:any)=>error.statusCode===409);}
 finally{hold.release();}
 const response=await pending;assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['x-folio-source-sha256'],hash(tiff));assert.deepEqual(await lease(upload.id),{state:'pending',finalize_owner:null,finalize_lease_until:null});assert.deepEqual(await counts(f),empty);
});

test('signed preview verifies size and digest, expiry and immutable reservation after a held source read',async()=>{
 for(const change of ['bytes','expiry','descriptor'] as const){
  const f=await fixture(change),upload=await reservation(f),hold=gate();let entered=false;
  if(change==='bytes'){const changed=Buffer.from(tiff);changed[changed.length-1]^=1;objects.set(upload.key,changed);}
  onRead=async key=>{if(key===upload.key){entered=true;await hold.promise;}};const pending=stagedPreview(f,upload.id);
  try{await until(()=>entered);if(change==='expiry')await adminPool.query("update direct_uploads set expires_at=clock_timestamp()-interval '1 second' where id=$1",[upload.id]);if(change==='descriptor')await adminPool.query('update direct_uploads set expected_sha256=$2 where id=$1',[upload.id,'0'.repeat(64)]);}
  finally{hold.release();}
  const result=await pending;assert.equal(result.statusCode,409,result.body);assert.doesNotMatch(result.headers['content-type']??'',/image/);assert.deepEqual(await lease(upload.id),{state:'pending',finalize_owner:null,finalize_lease_until:null});assert.deepEqual(await counts(f),empty);onRead=undefined;
 }
});

test('expired source-read deadline prevents late decode and leaves an upload available for same-reservation retry',async()=>{
 const f=await fixture('read-timeout'),upload=await reservation(f),hold=gate();let entered=false,renders=0;
 const server=await isolated({timeoutMs:300,readSource:async key=>{assert.equal(key,upload.key);entered=true;await hold.promise;return Buffer.from(tiff);},renderPage:async(...args)=>{renders++;return renderTiffPage(...args);}});
 const pending=stagedPreview(f,upload.id,server);await until(()=>entered);const result=await pending;assert.equal(result.statusCode,503,result.body);assert.deepEqual(await lease(upload.id),{state:'pending',finalize_owner:null,finalize_lease_until:null});hold.release();await delay(25);assert.equal(renders,0);
 assert.equal((await stagedPreview(f,upload.id)).statusCode,200);assert.deepEqual(await counts(f),empty);
});

test('stale preview cannot clear a replacement lease or publish after its session is revoked',async()=>{
 for(const change of ['lease','session'] as const){
  const f=await fixture(change),upload=await reservation(f),hold=gate();let entered=false;
  const server=await isolated({renderPage:async(...args)=>{const value=await renderTiffPage(...args);entered=true;await hold.promise;return value;}}),pending=stagedPreview(f,upload.id,server),replacement=randomUUID();
  try{await until(()=>entered);if(change==='lease')await adminPool.query('update direct_uploads set finalize_owner=$2 where id=$1',[upload.id,replacement]);else await adminPool.query('delete from sessions where token_hash=$1',[sessionHash(f.account)]);}
  finally{hold.release();}
  const result=await pending;assert.equal(result.statusCode,change==='lease'?409:401,result.body);assert.doesNotMatch(result.headers['content-type']??'',/image/);
  const row=await lease(upload.id);assert.equal(row.finalize_owner,change==='lease'?replacement:null);assert.equal(row.state,change==='lease'?'finalizing':'pending');assert.deepEqual(await counts(f),empty);
 }
});

test('stored TIFF format changes during source read cannot be accepted; the unchanged request recovers only its original bytes',async()=>{
 const f=await fixture('stored-mime'),source=await addDocument(actor(f.account),f.parserId,tiff,'owned-source.tiff'),id=source.document.id,requestId=randomUUID(),hold=gate();let entered=false;
 const spec={mode:'ranges' as const,ranges:[{start:1,end:1},{start:3,end:3}]},auth={actor:actor(f.account),tokenHash:sessionHash(f.account)},beforeWrites=writes;
 onRead=async key=>{if(key===`${f.account.workspace.id}/${id}`){entered=true;await hold.promise;}};
 const pending=splitStoredPdf(auth,id,requestId,hash(tiff),spec);const rejected=assert.rejects(pending,(error:any)=>error.statusCode===409);
 try{await until(()=>entered);await adminPool.query("update documents set mime_type='application/pdf' where id=$1",[id]);}finally{hold.release();}
 await rejected;assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:0,admissions:1,intents:0,pages:3});onRead=undefined;
 await adminPool.query("update documents set mime_type='image/tiff' where id=$1",[id]);
 const accepted=await splitStoredPdf(auth,id,requestId,hash(tiff),spec);assert.equal(accepted.split.sourceMimeType,'image/tiff');assert.equal(accepted.documents.length,2);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,tiff,'ordinary-same-bytes.tiff',requestId,spec),(error:any)=>error.statusCode===409);
 await assert.rejects(reserveDirectUpload(actor(f.account),f.parserId,{filename:'same.tiff',size:tiff.length,sha256:hash(tiff),pdfSplit:{requestId,options:spec}}),(error:any)=>error.statusCode===409);
 assert.equal((await request(f.account,'DELETE',`/api/documents/${id}`)).statusCode,200);
 const replay=await splitStoredPdf(auth,id,requestId,hash(tiff),spec);assert.equal(replay.replayed,true);assert.equal(replay.split.id,accepted.split.id);assert.equal(replay.split.sourceMimeType,'image/tiff');assert.equal(replay.split.sourceDocumentAvailable,false);
 const original=await request(f.account,'GET',`/api/documents/${accepted.documents[0].id}/bundle-original`);assert.equal(original.statusCode,200);assert.match(original.headers['content-disposition']!,/^attachment/);assert.equal(hash(original.rawPayload),hash(tiff));assert.equal((await counts(f)).pages,5);
});

test('a quota change during TIFF child writes rolls back every child and queues all uncommitted objects for cleanup',async()=>{
 const f=await fixture('late-quota'),source=await addDocument(actor(f.account),f.parserId,tiff,'owned-source.tiff'),hold=gate(),requestId=randomUUID();let entered=0;
 const auth={actor:actor(f.account),tokenHash:sessionHash(f.account)},spec={mode:'ranges' as const,ranges:[{start:1,end:1},{start:3,end:3}]};
 onWrite=async()=>{entered++;await hold.promise;};
 const pending=splitStoredPdf(auth,source.document.id,requestId,hash(tiff),spec);const rejected=assert.rejects(pending,(error:any)=>error.statusCode===429);
 try{await until(()=>entered>=2);await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','3') where id=$1",[f.account.workspace.id]);}finally{hold.release();}
 await rejected;onWrite=undefined;
 const before=await counts(f);assert.equal(before.documents,1);assert.equal(before.jobs,1);assert.equal(before.splits,0);assert.equal(before.admissions,1);assert.equal(before.pages,3);assert.equal(before.intents,3);
 const keys=(await adminPool.query('select storage_key from file_deletions where workspace_id=$1',[f.account.workspace.id])).rows.map(row=>row.storage_key);assert.equal(keys.length,3);
 for(const key of keys)assert.equal(await deleteStoredFile(f.account.workspace.id,key),'complete');
 assert.equal((await counts(f)).intents,0);assert.deepEqual([...objects.keys()].filter(key=>key.startsWith(f.account.workspace.id+'/')),[`${f.account.workspace.id}/${source.document.id}`]);assert.equal(hash(objects.get(`${f.account.workspace.id}/${source.document.id}`)!),hash(tiff));
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','100') where id=$1",[f.account.workspace.id]);
 const accepted=await splitStoredPdf(auth,source.document.id,requestId,hash(tiff),spec);assert.equal(accepted.documents.length,2);assert.equal((await counts(f)).pages,5);assert.equal((await counts(f)).splits,1);
});

test('every preview reservation with one request UUID shares source and confirmation identity, including multipart bypass',async()=>{
 const f=await fixture('confirmation-binding'),requestId=randomUUID(),input={filename:'owned-source.tiff',size:tiff.length,sha256:hash(tiff),pdfSplit:{requestId}},a=actor(f.account);
 const first=await reserveDirectUpload(a,f.parserId,input),second=await reserveDirectUpload(a,f.parserId,input);
 const changed=makeTiff([{width:12,height:10,color:[80,20,40]}]);
 await assert.rejects(reserveDirectUpload(a,f.parserId,{...input,size:changed.length,sha256:hash(changed)}),(error:any)=>error.statusCode===409);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','2') where id=$1",[f.account.workspace.id]);
 const parser=await request(f.account,'POST','/api/parsers',{name:'Owned second TIFF parser',useCase:'custom',mode:'rules',allowedFormats:['tiff'],schema:{fields:[{key:'reference',label:'Reference',type:'string'}]}});assert.equal(parser.statusCode,201,parser.body);
 await assert.rejects(reserveDirectUpload(a,parser.json().parser.id,input),(error:any)=>error.statusCode===409);
 await assert.rejects(finalizeDirectUpload(a,first.uploadId),(error:any)=>error.statusCode===409);
 const firstPlan={mode:'ranges' as const,ranges:[{start:1,end:1}]},otherPlan={mode:'ranges' as const,ranges:[{start:2,end:2}]};
 assert.deepEqual(await confirmDirectSplit(a,first.uploadId,{options:firstPlan}),{ok:true});
 await assert.rejects(confirmDirectSplit(a,second.uploadId,{options:otherPlan}),(error:any)=>error.statusCode===409);
 await assert.rejects(reserveDirectUpload(a,f.parserId,{...input,pdfSplit:{requestId,options:otherPlan}}),(error:any)=>error.statusCode===409);
 assert.deepEqual(await confirmDirectSplit(a,second.uploadId,{options:firstPlan}),{ok:true});
 let decoded=0;
 await assert.rejects(addSplitDocuments(a,f.parserId,tiff,'bypass.tiff',requestId,otherPlan,{splitSource:async()=>{decoded++;throw new Error('Must reject before decoder');}}),(error:any)=>error.statusCode===409);
 await assert.rejects(addSplitDocuments(a,f.parserId,changed,'different.tiff',requestId,firstPlan,{splitSource:async()=>{decoded++;throw new Error('Must reject before decoder');}}),(error:any)=>error.statusCode===409);
 assert.equal(decoded,0);assert.deepEqual(await counts(f),empty);
 const rows=(await adminPool.query('select expected_sha256,pdf_split_spec from direct_uploads where workspace_id=$1 and pdf_split_request_id=$2 order by id',[f.account.workspace.id,requestId])).rows;assert.equal(rows.length,2);assert.ok(rows.every(row=>row.expected_sha256===hash(tiff)));assert.ok(rows.every(row=>JSON.stringify(row.pdf_split_spec)===JSON.stringify(rows[0].pdf_split_spec)));
});

test('one remaining page credit permits retrying an unconfirmed TIFF request while counting both physical reservations',async()=>{
 const f=await fixture('last-credit'),a=actor(f.account),requestId=randomUUID(),input={filename:'last-credit.tiff',size:tiff.length,sha256:hash(tiff),pdfSplit:{requestId}};
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1') where id=$1",[f.account.workspace.id]);
 const first=await reserveDirectUpload(a,f.parserId,input),retry=await reserveDirectUpload(a,f.parserId,input);assert.notEqual(first.uploadId,retry.uploadId);
 const rows=(await adminPool.query('select id,storage_key,expected_bytes,pdf_split_spec from direct_uploads where workspace_id=$1 and pdf_split_request_id=$2 order by id',[f.account.workspace.id,requestId])).rows;
 assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.storage_key)).size,2);assert.ok(rows.every(row=>row.pdf_split_spec===null&&row.expected_bytes===tiff.length));
 await assert.rejects(reserveDirectUpload(a,f.parserId,{...input,pdfSplit:{requestId:randomUUID()}}),(error:any)=>error.statusCode===429);
 assert.equal((await adminPool.query('select count(*)::int n from direct_uploads where workspace_id=$1',[f.account.workspace.id])).rows[0].n,2);assert.deepEqual(await counts(f),empty);
});
