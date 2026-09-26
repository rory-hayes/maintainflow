import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipartPlugin from '@fastify/multipart';
import {ZodError} from 'zod';
import {PDFDocument} from 'pdf-lib';
import type {Actor} from '../shared/types.js';
import type {SplitSuggestion,SplitSuggestionResult} from '../shared/split-suggestions.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,closeDatabase,databaseSchema,withWorkspace} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {addDocument} from '../server/core/intake.js';
import {setStorageForTests,SIGNED_UPLOAD_RETENTION_SECONDS,type PrivateStorage} from '../server/core/storage.js';
import {registerSplitSuggestions,setSplitSuggestionProvider,processOneSplitSuggestion,reconcileExpiredSplitSuggestions} from '../server/core/split-suggestions.js';
import {SplitSuggestionProviderError} from '../server/core/split-suggestion-errors.js';
import {processOneSchemaSuggestion,setSchemaSuggestionProvider,hasWorkspaceExtractionCapacity} from '../server/core/schema-suggestions.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {runnableAiWorkSql} from '../server/core/parser-setup.js';
import {makeTiff} from './fixtures/tiff.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>(),extra:FastifyInstance[]=[];
const originalFetch=globalThis.fetch;let app:FastifyInstance,server:FastifyInstance,pdf:Buffer,tiff:Buffer,verified=false,calls=0;
let onRead:((key:string)=>Promise<void>)|undefined,onWrite:((key:string,bytes:Buffer)=>Promise<void>)|undefined,onRemove:((key:string)=>Promise<void>)|undefined;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const storage:PrivateStorage={kind:'supabase',
 async read(key){const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned fixture file missing'),{statusCode:404});const copy=Buffer.from(bytes);await onRead?.(key);return copy;},
 async write(key,bytes){if(objects.has(key))throw Object.assign(new Error('Owned immutable key exists'),{statusCode:409});objects.set(key,Buffer.from(bytes));await onWrite?.(key,bytes);},
 async remove(key){await onRemove?.(key);objects.delete(key);},
 async signUpload(key){return `https://owned.example.test/upload/${key}`;},
};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const headers=(a:Account,extra:Record<string,string>={})=>({origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id,...extra});
const request=(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,extra:Record<string,string>={})=>(url.includes('/split-suggestions')?server:app).inject({method,url,headers:headers(a,extra),payload:payload as any});
const endpoint=(f:Fixture)=>`/api/parsers/${f.parserId}/split-suggestions`;
const output=(overrides:Partial<SplitSuggestionResult>={}):SplitSuggestionResult=>({startPages:[1,3],model:'controlled-split-model',promptVersion:'controlled-boundaries-v1',tokenUsage:{inputTokens:100,outputTokens:12,totalTokens:112},costUsd:0.000123,...overrides});
function configured(){setSplitSuggestionProvider({configured:()=>true,suggest:async()=>output()});}
function gate<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function entered(promise:Promise<unknown>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned fixture did not reach controlled gate')),5000);})]);}finally{clearTimeout(timer);}}
async function fixture(label:string,formats=['pdf','tiff']):Promise<Fixture>{
 const r=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned split suggestion',workspaceName:`Owned suggestion ${label}`,email:`split-suggestion-${randomUUID()}@example.test`,password:'Owned split suggestion fixture password'}});assert.equal(r.statusCode,201,r.body);
 const account={...r.json(),cookie:r.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 const p=await request(account,'POST','/api/parsers',{name:'Owned source bundles',useCase:'custom',mode:'rules',allowedFormats:formats,schema:{fields:[{key:'reference',label:'Reference',type:'string'}]}});assert.equal(p.statusCode,201,p.body);
 return {account,parserId:p.json().parser.id};
}
function form(bytes:Buffer,requestId:string=randomUUID(),sourceSha256=hash(bytes),filename='owned-source.pdf',fields?:Array<[string,string]>){
 const boundary=`owned-${randomUUID()}`,chunks:Buffer[]=[];
 for(const [key,value]of fields??[['requestId',requestId],['sourceSha256',sourceSha256]])chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
 chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`));
 return {body:Buffer.concat(chunks),contentType:`multipart/form-data; boundary=${boundary}`,requestId};
}
async function upload(f:Fixture,bytes=pdf,id:string=randomUUID(),checksum=hash(bytes),fields?:Array<[string,string]>){const data=form(bytes,id,checksum,'misleading.txt',fields);return request(f.account,'POST',endpoint(f),data.body,{'content-type':data.contentType});}
async function queue(f:Fixture,bytes=pdf,id:string=randomUUID()){const r=await upload(f,bytes,id);assert.equal(r.statusCode,202,r.body);return r.json().suggestion as SplitSuggestion;}
async function row(id:string){return (await adminPool.query('select * from split_suggestions where id=$1',[id])).rows[0];}
async function detail(f:Fixture,id:string){const r=await request(f.account,'GET',`${endpoint(f)}/${id}`);assert.equal(r.statusCode,200,r.body);return r.json().suggestion as SplitSuggestion;}
async function noAccepted(f:Fixture){const r=(await adminPool.query(`select (select count(*)::int from documents where workspace_id=$1) documents,(select count(*)::int from jobs where workspace_id=$1) jobs,(select count(*)::int from direct_uploads where workspace_id=$1) direct,(select count(*)::int from intake_files where workspace_id=$1) intents,(select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages`,[f.account.workspace.id])).rows[0];return r;}
const empty={documents:0,jobs:0,direct:0,intents:0,pages:0};
async function available(id:string){await adminPool.query('update split_suggestions set available_at=now() where id=$1',[id]);}
async function signed(f:Fixture,bytes=pdf,id:string=randomUUID()){
 const r=await request(f.account,'POST',endpoint(f),{requestId:id,filename:'owned-signed.pdf',size:bytes.length,sourceSha256:hash(bytes),mimeType:bytes===tiff?'image/tiff':'application/pdf'});assert.equal(r.statusCode,202,r.body);return r.json() as {suggestion:SplitSuggestion;upload:{url:string;headers:Record<string,string>;expiresAt:string}};
}
async function isolated(options:Parameters<typeof registerSplitSuggestions>[1]={}){
 const s=Fastify();await s.register(cookie);await s.register(multipartPlugin);s.setErrorHandler((e,_req,reply)=>reply.code(e instanceof ZodError?400:(e as any).statusCode??500).send({message:e instanceof Error?e.message:'Owned fixture error'}));await registerSplitSuggestions(s,options);await s.ready();extra.push(s);return s;
}
before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role]of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
 }
 verified=true;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected outbound call in owned split suggestions test');};setStorageForTests(storage);app=await buildApp();server=await isolated();
 const doc=await PDFDocument.create();for(let i=0;i<3;i++)doc.addPage([180+i*10,240]);pdf=Buffer.from(await doc.save());
 tiff=makeTiff([{width:12,height:18,color:[255,0,0]},{width:18,height:12,orientation:6,color:[0,255,0]},{width:10,height:10,color:[0,0,255]}],{bigTiff:true});
});
afterEach(()=>{setSplitSuggestionProvider(undefined);setSchemaSuggestionProvider(undefined);setExtractionProvider(undefined);onRead=undefined;onWrite=undefined;onRemove=undefined;});
after(async()=>{
 try{setSplitSuggestionProvider(undefined);for(const s of extra)await s.close();await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}assert.equal(calls,0);objects.clear();}
 finally{setStorageForTests(undefined);globalThis.fetch=originalFetch;await closeDatabase();}
});

test('fresh PDF suggestion preserves exact private source, request identity and zero accepted pages',async()=>{
 const f=await fixture('fresh');configured();await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','0') where id=$1",[f.account.workspace.id]);
 const id=randomUUID(),queued=await queue(f,pdf,id);assert.equal(queued.state,'queued');assert.equal(queued.sourceMimeType,'application/pdf');assert.equal(queued.requestId,id);assert.equal(queued.creationClosed,false);
 assert.deepEqual(await noAccepted(f),empty);const saved=await row(queued.id);assert.equal(saved.token_hash.length,64);assert.equal(saved.source_reserved_bytes,pdf.length);assert.equal(saved.staging_reserved_bytes,0);
 const replay=await queue(f,pdf,id);assert.equal(replay.id,queued.id);assert.equal((await adminPool.query('select id from split_suggestions where workspace_id=$1',[f.account.workspace.id])).rowCount,1);
 const downloaded=await request(f.account,'GET',`${endpoint(f)}/${queued.id}/source`);assert.equal(downloaded.statusCode,200);assert.deepEqual(downloaded.rawPayload,pdf);assert.match(downloaded.headers['content-disposition'] as string,/attachment/);assert.equal(downloaded.headers['cache-control'],'private, no-store');
 let seen=0;setSplitSuggestionProvider({configured:()=>true,suggest:async input=>{seen++;assert.deepEqual(input.bytes,pdf);assert.equal(input.mimeType,'application/pdf');assert.equal(input.pages.length,3);assert.equal(input.visualDocument,undefined);return output();}});
 assert.equal(await processOneSplitSuggestion(queued.id),true);const ready=await detail(f,queued.id);assert.equal(ready.state,'ready');assert.deepEqual(ready.ranges,[{start:1,end:2},{start:3,end:3}]);assert.equal(ready.model,'controlled-split-model');assert.equal(ready.costUsd,0.000123);assert.equal(seen,1);assert.deepEqual(await noAccepted(f),empty);
 assert.equal(await processOneSplitSuggestion(queued.id),false);assert.equal((await queue(f,pdf,id)).state,'ready');
 const recovery=await request(f.account,'GET',`${endpoint(f)}/requests/${id}`);assert.equal(recovery.statusCode,200);assert.equal(recovery.json().suggestion.id,queued.id);assert.ok(!recovery.body.includes(saved.token_hash));assert.ok(!recovery.body.includes(saved.source_storage_key));
});

test('TIFF source and isolated page preview retain identity while AI receives all derived visual pages',async()=>{
 const f=await fixture('tiff',['tiff']);configured();const queued=await queue(f,tiff);assert.equal(queued.sourceMimeType,'image/tiff');
 const preview=await request(f.account,'GET',`${endpoint(f)}/${queued.id}/preview?page=2`);assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.headers['x-folio-source-sha256'],hash(tiff));assert.equal(preview.headers['x-folio-page-count'],'3');assert.equal(preview.headers['x-folio-preview-page'],'2');assert.ok(preview.rawPayload.subarray(0,3).equals(Buffer.from([255,216,255])));
 assert.equal((await request(f.account,'GET',`${endpoint(f)}/${queued.id}/preview?page=4`)).statusCode,400);
 setSplitSuggestionProvider({configured:()=>true,suggest:async input=>{assert.deepEqual(input.bytes,tiff);assert.equal(input.pages.length,3);assert.ok(input.visualDocument);assert.equal(input.visualDocument.sourceSha256,hash(tiff));assert.equal((await PDFDocument.load(input.visualDocument.bytes)).getPageCount(),3);return output();}});
 assert.equal(await processOneSplitSuggestion(queued.id),true);const ready=await detail(f,queued.id);assert.equal(ready.state,'ready');assert.equal(ready.pageCount,3);assert.equal((ready.tokenUsage.sourceRendering as any).sourceSha256,hash(tiff));assert.deepEqual(await noAccepted(f),empty);
});

test('request conflicts, strict multipart, actual format and requester/role gates fail without new drafts',async()=>{
 const f=await fixture('gates',['pdf']),other=await fixture('other');configured();const q=await queue(f),id=q.requestId;
 assert.equal((await upload(f,tiff,id)).statusCode,415);assert.equal((await upload(f,Buffer.from('%PDF-broken'),id)).statusCode,409);
 assert.equal((await upload(f,pdf,randomUUID(),'0'.repeat(64))).statusCode,409);
 assert.equal((await upload(f,pdf,randomUUID(),hash(pdf),[['requestId',id],['sourceSha256',hash(pdf)],['extra','x']])).statusCode,413);
 assert.equal((await request(other.account,'GET',`${endpoint(f)}/${q.id}`)).statusCode,404);
 await adminPool.query('insert into memberships(workspace_id,user_id,role) values($1,$2,$3)',[f.account.workspace.id,other.account.user.id,'editor']);
 const wrong=await server.inject({method:'GET',url:`${endpoint(f)}/requests/${id}`,headers:headers(other.account,{'x-workspace-id':f.account.workspace.id})});assert.equal(wrong.statusCode,404);
 await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,f.account.user.id]);
 assert.equal((await request(f.account,'GET',`${endpoint(f)}/${q.id}`)).statusCode,403);
 assert.deepEqual(await noAccepted(f),empty);
});

test('signed uploads recover missing PUT and finalize once into a distinct immutable copy without page reservations',async()=>{
 const f=await fixture('signed');configured();const reserve=await signed(f),before=await row(reserve.suggestion.id);assert.equal(reserve.upload.headers['x-upsert'],'false');assert.equal(before.staging_reserved_bytes,10*1024*1024);assert.equal(before.source_reserved_bytes,pdf.length);assert.notEqual(before.staging_storage_key,before.source_storage_key);assert.ok(new Date(before.staging_expires_at).getTime()-new Date(before.created_at).getTime()>=SIGNED_UPLOAD_RETENTION_SECONDS*1000-10);
 const url=`${endpoint(f)}/${reserve.suggestion.id}/finalize`;assert.equal((await request(f.account,'POST',url,{})).statusCode,404);assert.equal((await row(reserve.suggestion.id)).state,'uploading');
 const replay=await signed(f,pdf,reserve.suggestion.requestId);assert.equal(replay.suggestion.id,reserve.suggestion.id);assert.equal(replay.upload.url,reserve.upload.url);
 objects.set(before.staging_storage_key,Buffer.from(pdf));const accepted=await request(f.account,'POST',url,{});assert.equal(accepted.statusCode,202,accepted.body);assert.equal(accepted.json().suggestion.state,'queued');assert.deepEqual(objects.get(before.source_storage_key),pdf);
 objects.set(before.staging_storage_key,Buffer.from('late unbound staging replacement'));
 assert.equal((await request(f.account,'POST',url,{})).json().suggestion.state,'queued');assert.equal(await processOneSplitSuggestion(reserve.suggestion.id),true);assert.equal((await detail(f,reserve.suggestion.id)).state,'ready');assert.deepEqual(await noAccepted(f),empty);
 await adminPool.query("update split_suggestions set staging_expires_at=now()-interval '1 second' where id=$1",[reserve.suggestion.id]);assert.deepEqual(await reconcileExpiredSplitSuggestions(f.account.workspace.id),{removed:1});const after=await row(reserve.suggestion.id);assert.equal(after.staging_storage_key,null);assert.equal(after.staging_reserved_bytes,0);assert.deepEqual(objects.get(after.source_storage_key),pdf);
});

test('lost private copy acknowledgement reuses the same durable request and verifies existing immutable bytes',async()=>{
 const f=await fixture('lost-copy');configured();const id=randomUUID();let once=true;onWrite=async()=>{if(once){once=false;throw new Error('PRIVATE storage lost acknowledgement');}};
 const failed=await upload(f,pdf,id);assert.equal(failed.statusCode,500);const bound=(await adminPool.query('select * from split_suggestions where workspace_id=$1 and request_id=$2',[f.account.workspace.id,id])).rows[0];assert.equal(bound.state,'uploading');assert.deepEqual(objects.get(bound.source_storage_key),pdf);
 onWrite=undefined;const queued=await queue(f,pdf,id);assert.equal(queued.id,bound.id);assert.equal(queued.state,'queued');assert.equal([...objects.keys()].filter(k=>k.startsWith(f.account.workspace.id+'/')).length,1);assert.deepEqual(await noAccepted(f),empty);
});

test('malformed sources and injected invalid results never publish ready boundaries',async()=>{
 const f=await fixture('invalid');configured();const malformed=await queue(f,Buffer.from('%PDF-invalid-source'));let seen=0;setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{seen++;return output();}});
 assert.equal(await processOneSplitSuggestion(malformed.id),true);const bad=await detail(f,malformed.id);assert.equal(bad.state,'failed');assert.equal(bad.creationClosed,true);assert.equal(seen,0);
 const invalid=await queue(f);setSplitSuggestionProvider({configured:()=>true,suggest:async()=>output({startPages:[2,1]})});assert.equal(await processOneSplitSuggestion(invalid.id),true);assert.equal((await detail(f,invalid.id)).state,'failed');assert.equal((await row(invalid.id)).start_pages,null);
 const usage=await queue(f);setSplitSuggestionProvider({configured:()=>true,suggest:async()=>output({tokenUsage:{inputTokens:Infinity}})});await processOneSplitSuggestion(usage.id);assert.equal((await detail(f,usage.id)).state,'failed');assert.deepEqual(await noAccepted(f),empty);
});

test('unknown provider failures retry safely then stop after three attempts; explicit refusal fails once',async()=>{
 const f=await fixture('retries');configured();const q=await queue(f);setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{throw Object.assign(new Error('PRIVATE provider response'),{permanent:true});}});
 for(let n=1;n<=3;n++){await available(q.id);assert.equal(await processOneSplitSuggestion(q.id),true);const current=await detail(f,q.id);assert.equal(current.attempts,n);assert.equal(current.state,n===3?'failed':'queued');assert.ok(!JSON.stringify(current).includes('PRIVATE'));}
 assert.equal(await processOneSplitSuggestion(q.id),false);configured();const refused=await queue(f);setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{throw new SplitSuggestionProviderError('AI could not suggest boundaries for this source.');}});await processOneSplitSuggestion(refused.id);assert.equal((await detail(f,refused.id)).attempts,1);assert.equal((await detail(f,refused.id)).state,'failed');
});

test('source-read and provider deadlines reject noncooperative late continuations',async()=>{
 const f=await fixture('deadlines');configured();const q=await queue(f),r=await row(q.id),readEntered=gate<void>(),release=gate<void>();let seen=0;
 onRead=async key=>{if(key===r.source_storage_key){readEntered.resolve();await release.promise;}};setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{seen++;return output();}});
 const reading=processOneSplitSuggestion(q.id,{providerTimeoutMs:100});await entered(readEntered.promise);assert.equal(await reading,true);assert.equal((await row(q.id)).state,'queued');release.resolve();await tick();assert.equal(seen,0);onRead=undefined;
 const providerEntered=gate<void>(),late=gate<SplitSuggestionResult>();let signal:AbortSignal|undefined;await available(q.id);setSplitSuggestionProvider({configured:()=>true,suggest:async input=>{signal=input.signal;providerEntered.resolve();return late.promise;}});
 const pending=processOneSplitSuggestion(q.id,{providerTimeoutMs:1500});await entered(providerEntered.promise);assert.equal(await pending,true);assert.equal(signal?.aborted,true);const snapshot=await row(q.id);late.resolve(output({model:'PRIVATE-late'}));await tick();assert.deepEqual(await row(q.id),snapshot);assert.equal(snapshot.state,'queued');
});

test('cancelled and revoked jobs discard a late provider draft and keep requester recovery authoritative',async()=>{
 for(const mode of ['cancel','revoke'] as const){const f=await fixture(mode);configured();const q=await queue(f),enteredProvider=gate<void>(),result=gate<SplitSuggestionResult>();setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{enteredProvider.resolve();return result.promise;}});const processing=processOneSplitSuggestion(q.id,{providerTimeoutMs:5000});
  try{await entered(enteredProvider.promise);if(mode==='cancel'){const cancelled=await request(f.account,'POST',`${endpoint(f)}/${q.id}/cancel`,{});assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().suggestion.creationClosed,true);assert.equal((await request(f.account,'GET',`${endpoint(f)}/${q.id}/source`)).statusCode,410);}else await adminPool.query('delete from sessions where token_hash=$1',[hashToken(f.account.cookie.split('; ').find(c=>c.startsWith('folio_session='))!.slice('folio_session='.length))]);}
  finally{result.resolve(output());await processing;}
  const saved=await row(q.id);assert.equal(saved.state,mode==='cancel'?'cancelled':'failed');assert.equal(saved.start_pages,null);assert.equal(saved.cost_usd,'0.000000');assert.deepEqual(await noAccepted(f),empty);
 }
});

test('stored sources are copied without accepting pages and deletion fences a late result',async()=>{
 const f=await fixture('stored');configured();const accepted=await addDocument(actor(f.account),f.parserId,pdf,'owned-original.pdf');const before=await noAccepted(f),id=randomUUID();
 const q=await request(f.account,'POST',endpoint(f),{requestId:id,documentId:accepted.document.id,sourceSha256:hash(pdf)});assert.equal(q.statusCode,202,q.body);const suggested=q.json().suggestion as SplitSuggestion,saved=await row(suggested.id);assert.equal(suggested.sourceDocumentId,accepted.document.id);assert.notEqual(saved.original_source_key,saved.source_storage_key);assert.deepEqual(await noAccepted(f),before);
 const replay=await request(f.account,'POST',endpoint(f),{requestId:id,documentId:accepted.document.id,sourceSha256:hash(pdf)});assert.equal(replay.json().suggestion.id,suggested.id);assert.equal((await upload(f,pdf,id)).statusCode,409);
 const started=gate<void>(),release=gate<SplitSuggestionResult>();setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{started.resolve();return release.promise;}});const pending=processOneSplitSuggestion(suggested.id,{providerTimeoutMs:5000});
 try{await entered(started.promise);const removed=await request(f.account,'DELETE',`/api/documents/${accepted.document.id}`);assert.equal(removed.statusCode,200,removed.body);}finally{release.resolve(output());await pending;}
 const final=await row(suggested.id);assert.ok(final);assert.notEqual(final.state,'ready');assert.equal(final.start_pages,null);assert.equal((await request(f.account,'GET',`${endpoint(f)}/${suggested.id}/source`)).statusCode,410);
});

test('source mutations and format-policy changes are rechecked before provider and ready commit',async()=>{
 const f=await fixture('mutations');configured();const q=await queue(f),bound=await row(q.id);objects.set(bound.source_storage_key,Buffer.from('%PDF-different'));let seen=0;setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{seen++;return output();}});await processOneSplitSuggestion(q.id);assert.equal((await detail(f,q.id)).state,'failed');assert.equal(seen,0);
 configured();const next=await queue(f),started=gate<void>(),release=gate<SplitSuggestionResult>();setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{started.resolve();return release.promise;}});const pending=processOneSplitSuggestion(next.id,{providerTimeoutMs:5000});try{await entered(started.promise);await adminPool.query('update parsers set allowed_formats=$2 where id=$1',[f.parserId,['tiff']]);}finally{release.resolve(output());await pending;}assert.equal((await row(next.id)).state,'failed');assert.equal((await row(next.id)).start_pages,null);
});

test('expired leases fence old workers and cancelled/expired cleanup retains result metadata until actual deletion',async()=>{
 const f=await fixture('lease');configured();const q=await queue(f),enteredFirst=gate<void>(),first=gate<SplitSuggestionResult>();let n=0;setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{if(++n===1){enteredFirst.resolve();return first.promise;}return output({model:'current-owner'});}});const old=processOneSplitSuggestion(q.id,{providerTimeoutMs:5000});
 try{await entered(enteredFirst.promise);await adminPool.query("update split_suggestions set lease_until=now()-interval '1 second' where id=$1",[q.id]);assert.equal(await processOneSplitSuggestion(q.id),true);}finally{first.resolve(output({model:'late-owner'}));await old;}
 assert.equal((await detail(f,q.id)).model,'current-owner');await adminPool.query("update split_suggestions set expires_at=now()-interval '1 second' where id=$1",[q.id]);assert.equal((await detail(f,q.id)).creationClosed,true);const key=(await row(q.id)).source_storage_key;
 onRemove=async()=>{throw new Error('PRIVATE removal outage');};assert.deepEqual(await reconcileExpiredSplitSuggestions(f.account.workspace.id),{removed:0});assert.equal((await row(q.id)).source_storage_key,key);assert.equal((await row(q.id)).source_reserved_bytes,pdf.length);
 onRemove=undefined;assert.deepEqual(await reconcileExpiredSplitSuggestions(f.account.workspace.id),{removed:1});const after=await row(q.id);assert.equal(after.source_storage_key,null);assert.equal(after.source_reserved_bytes,0);assert.deepEqual(after.start_pages,[1,3]);assert.equal(after.model,'current-owner');assert.equal((await request(f.account,'GET',`${endpoint(f)}/${q.id}/source`)).statusCode,410);assert.deepEqual(await noAccepted(f),empty);
});

test('API credentials require both document scopes and current expiry at provider commit',async()=>{
 const f=await fixture('api-scope');configured();
 const created=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned split scope',scopes:['documents:read','documents:write']});assert.equal(created.statusCode,200,created.body);const {apiKey,token}=created.json();
 const apiHeaders={'authorization':`Bearer ${token}`,'x-workspace-id':f.account.workspace.id};
 for(const scopes of [['documents:read'],['documents:write']]){
  await adminPool.query('update api_keys set scopes=$2 where id=$1',[apiKey.id,JSON.stringify(scopes)]);const denied=await server.inject({method:'GET',url:endpoint(f),headers:apiHeaders});assert.equal(denied.statusCode,403,denied.body);
 }
 await adminPool.query('update api_keys set scopes=$2 where id=$1',[apiKey.id,JSON.stringify(['documents:read','documents:write'])]);
 const data=form(pdf);const queued=await server.inject({method:'POST',url:endpoint(f),headers:{...apiHeaders,'content-type':data.contentType},payload:data.body});assert.equal(queued.statusCode,202,queued.body);const q=queued.json().suggestion as SplitSuggestion,bound=await row(q.id);assert.equal(bound.auth_type,'api');assert.equal(bound.token_hash,hashToken(token));assert.ok(!queued.body.includes(token));
 const started=gate<void>(),release=gate<SplitSuggestionResult>();setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{started.resolve();return release.promise;}});const work=processOneSplitSuggestion(q.id,{providerTimeoutMs:5000});
 try{await entered(started.promise);await adminPool.query("update api_keys set expires_at=clock_timestamp()-interval '1 second' where id=$1",[apiKey.id]);}finally{release.resolve(output());await work;}
 assert.equal((await row(q.id)).state,'failed');assert.equal((await row(q.id)).start_pages,null);assert.deepEqual(await noAccepted(f),empty);
});

test('a held signed copy excludes concurrent finalization and cancellation prevents a late enqueue',async()=>{
 const f=await fixture('signed-copy-race');configured();const reserved=await signed(f),bound=await row(reserved.suggestion.id);objects.set(bound.staging_storage_key,Buffer.from(pdf));
 const started=gate<void>(),release=gate<void>();onWrite=async key=>{if(key===bound.source_storage_key){started.resolve();await release.promise;}};
 const path=`${endpoint(f)}/${reserved.suggestion.id}`,first=request(f.account,'POST',`${path}/finalize`,{});
 try{await entered(started.promise);assert.equal((await request(f.account,'POST',`${path}/finalize`,{})).statusCode,409);assert.equal((await request(f.account,'POST',`${path}/cancel`,{})).statusCode,200);assert.deepEqual(await reconcileExpiredSplitSuggestions(f.account.workspace.id),{removed:0});}
 finally{release.resolve();}
 assert.equal((await first).statusCode,410);assert.equal((await row(bound.id)).state,'cancelled');assert.equal((await row(bound.id)).write_owner,null);
 assert.deepEqual(await reconcileExpiredSplitSuggestions(f.account.workspace.id),{removed:1});const final=await row(bound.id);assert.equal(final.source_storage_key,null);assert.equal(final.staging_storage_key,bound.staging_storage_key);assert.equal(final.staging_reserved_bytes,10*1024*1024);assert.equal(await processOneSplitSuggestion(bound.id),false);assert.deepEqual(await noAccepted(f),empty);
});

test('timed-out cleanup retains the byte reservation and lease until a late removal can safely recover',async()=>{
 const f=await fixture('cleanup-deadline');configured();const q=await queue(f);await request(f.account,'POST',`${endpoint(f)}/${q.id}/cancel`,{});const started=gate<void>(),release=gate<void>();onRemove=async()=>{started.resolve();await release.promise;};
 const cleanup=reconcileExpiredSplitSuggestions(f.account.workspace.id,{timeoutMs:100});await entered(started.promise);assert.deepEqual(await cleanup,{removed:0});const reserved=await row(q.id);assert.ok(reserved.write_owner);assert.equal(reserved.source_reserved_bytes,pdf.length);assert.ok(reserved.source_storage_key);
 release.resolve();await tick();onRemove=undefined;assert.deepEqual(await reconcileExpiredSplitSuggestions(f.account.workspace.id),{removed:0});await adminPool.query("update split_suggestions set write_until=clock_timestamp()-interval '1 second' where id=$1",[q.id]);
 assert.deepEqual(await reconcileExpiredSplitSuggestions(f.account.workspace.id),{removed:1});assert.equal((await row(q.id)).source_reserved_bytes,0);assert.equal((await row(q.id)).source_storage_key,null);
});

test('pending byte accounting includes other physical reservations and rejection precedes private writes',async()=>{
 const f=await fixture('pending-bytes');configured();const attempt=randomUUID();
 // Synthetic write intents represent physically reserved bytes, without storing
 // large buffers. Their legitimate per-object maxima total the full 250 MiB cap.
 for(let i=0;i<25;i++){const id=randomUUID();await adminPool.query('insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes) values($1,$2,$3,$4,$5)',[id,f.account.workspace.id,`${f.account.workspace.id}/${id}`,attempt,10*1024*1024]);}
 const before=objects.size;const denied=await upload(f);assert.equal(denied.statusCode,429,denied.body);assert.equal(objects.size,before);assert.equal((await adminPool.query('select id from split_suggestions where workspace_id=$1',[f.account.workspace.id])).rowCount,0);
 await adminPool.query('delete from intake_files where workspace_id=$1',[f.account.workspace.id]);const q=await queue(f);assert.equal(q.state,'queued');assert.deepEqual(await noAccepted(f),empty);
});

async function fieldQueue(f:Fixture,documentId:string){
 const schema=(await adminPool.query('select active_schema_id from parsers where id=$1',[f.parserId])).rows[0].active_schema_id;
 return request(f.account,'POST',`/api/parsers/${f.parserId}/schema-suggestions`,{documentId,baseSchemaId:schema,requestId:randomUUID()});
}
const fieldResult=()=>({schema:{fields:[{key:'reference',label:'Reference',type:'string' as const}]},model:'controlled-field-model',promptVersion:'controlled-fields',tokenUsage:{inputTokens:10},costUsd:0});
const extractionResult=()=>({rawValues:{reference:'OWNED'},normalizedValues:{reference:'OWNED'},evidence:{},issues:[],model:'controlled-extraction',engine:'controlled-ai',tokenUsage:{inputTokens:10},costUsd:0});

test('field and split suggestions share the actual three-pending and ten-per-day admission limits',async()=>{
 const f=await fixture('shared-limits');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{id}','\"team\"') where id=$1",[f.account.workspace.id]);configured();setSchemaSuggestionProvider({configured:()=>true,suggest:async()=>fieldResult()});
 const source=await addDocument(actor(f.account),f.parserId,pdf,'owned-field-source.pdf');const field=await fieldQueue(f,source.document.id);assert.equal(field.statusCode,202,field.body);
 const uploading=await signed(f),split=await queue(f);assert.equal((await upload(f)).statusCode,429);assert.equal((await fieldQueue(f,source.document.id)).statusCode,429);
 // Complete only this owned field draft, leaving the split and uploading jobs
 // pending. Admission immediately permits one slot, across both API routes.
 assert.equal(await processOneSchemaSuggestion(field.json().suggestion.id),true);const next=await fieldQueue(f,source.document.id);assert.equal(next.statusCode,202,next.body);
 await request(f.account,'POST',`${endpoint(f)}/${uploading.suggestion.id}/cancel`,{});await request(f.account,'POST',`${endpoint(f)}/${split.id}/cancel`,{});
 await adminPool.query("update schema_suggestions set state='failed',error='Owned limit fixture completed' where workspace_id=$1 and state='queued'",[f.account.workspace.id]);
 const count=(await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action in('schema.suggestion_requested','split.suggestion_requested')",[f.account.workspace.id])).rows[0].n;
 for(let n=count;n<10;n++)await adminPool.query('insert into audit_events(workspace_id,user_id,action,entity_id,metadata) values($1,$2,$3,$4,$5)',[f.account.workspace.id,f.account.user.id,n%2?'schema.suggestion_requested':'split.suggestion_requested',randomUUID(),'{}']);
 assert.equal((await upload(f)).statusCode,429);assert.equal((await fieldQueue(f,source.document.id)).statusCode,429);
 const replay=await request(f.account,'GET',`${endpoint(f)}/requests/${split.requestId}`);assert.equal(replay.statusCode,200);assert.equal(replay.json().suggestion.id,split.id);
});

test('real queued rows share total FIFO order and every worker respects the shared processing cap',async()=>{
 const f=await fixture('shared-workers');configured();setSchemaSuggestionProvider({configured:()=>true,suggest:async()=>fieldResult()});setExtractionProvider({configured:()=>true,extract:async()=>extractionResult()});
 await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{id}','\"team\"'),'{maxConcurrent}','1') where id=$1",[f.account.workspace.id]);await adminPool.query("update parsers set mode='ai' where id=$1",[f.parserId]);
 const source=await addDocument(actor(f.account),f.parserId,pdf,'owned-queue-source.pdf'),field=await fieldQueue(f,source.document.id);assert.equal(field.statusCode,202,field.body);const split=await queue(f),sameLane=await queue(f),tie=source.jobId!;
 await adminPool.query("update schema_suggestions set id=$2,created_at='2026-01-01 00:00:00+00' where id=$1",[field.json().suggestion.id,tie]);await adminPool.query("update split_suggestions set id=$2,created_at='2026-01-01 00:00:00+00' where id=$1",[split.id,tie]);await adminPool.query("update jobs set created_at='2026-01-01 00:00:00+00' where id=$1",[tie]);await adminPool.query("update split_suggestions set created_at='2026-01-02 00:00:00+00' where id=$1",[sameLane.id]);
 const order=await withWorkspace(f.account.workspace.id,async c=>(await c.query(`select id,lane,created_at from (${runnableAiWorkSql}) ready where workspace_id=$1 order by created_at,id,lane`,[f.account.workspace.id])).rows);assert.deepEqual(order.map(row=>[row.id,row.lane]),[[tie,0],[tie,1],[tie,2],[sameLane.id,2]]);
 for(const [index,candidate]of order.entries())assert.equal(await withWorkspace(f.account.workspace.id,c=>hasWorkspaceExtractionCapacity(c,f.account.workspace.id,{id:candidate.id,createdAt:candidate.created_at,lane:candidate.lane})),index===0);
 // Only the explicitly identified owned workers are invoked. The same FIFO SQL
 // used by their unscoped claims was executed above with this workspace bound.
 const started=gate<void>(),release=gate<ReturnType<typeof extractionResult>>();setExtractionProvider({configured:()=>true,extract:async()=>{started.resolve();return release.promise;}});const core=processOneCoreJob(tie,{providerTimeoutMs:5000});
 try{await entered(started.promise);assert.equal(await processOneSchemaSuggestion(tie),false);assert.equal(await processOneSplitSuggestion(tie),false);}finally{release.resolve(extractionResult());await core;}
 const fieldStarted=gate<void>(),fieldRelease=gate<ReturnType<typeof fieldResult>>();setSchemaSuggestionProvider({configured:()=>true,suggest:async()=>{fieldStarted.resolve();return fieldRelease.promise;}});const fieldWork=processOneSchemaSuggestion(tie,{providerTimeoutMs:5000});
 try{await entered(fieldStarted.promise);assert.equal(await processOneSplitSuggestion(tie),false);}finally{fieldRelease.resolve(fieldResult());await fieldWork;}
 const splitStarted=gate<void>(),splitRelease=gate<SplitSuggestionResult>();setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{splitStarted.resolve();return splitRelease.promise;}});const splitWork=processOneSplitSuggestion(tie,{providerTimeoutMs:5000});
 try{await entered(splitStarted.promise);assert.equal(await processOneSplitSuggestion(sameLane.id),false);const extraSource=await addDocument(actor(f.account),f.parserId,tiff,'owned-new-source.tiff');assert.equal(await processOneCoreJob(extraSource.jobId!),false);}
 finally{splitRelease.resolve(output());await splitWork;}
 assert.equal((await row(tie)).state,'ready');
 // Expired/future/exhausted rows do not block a later eligible candidate.
 await adminPool.query("update split_suggestions set expires_at=clock_timestamp()-interval '1 second' where id=$1",[sameLane.id]);
 await adminPool.query("update jobs set available_at=clock_timestamp()+interval '1 day' where workspace_id=$1 and state='queued'",[f.account.workspace.id]);
 const eligible=await queue(f);const earlier=(await adminPool.query(`select * from (${runnableAiWorkSql}) ready where workspace_id=$1 order by created_at,id,lane`,[f.account.workspace.id])).rows;assert.deepEqual(earlier.map(r=>r.id),[eligible.id]);
 assert.equal(await withWorkspace(f.account.workspace.id,c=>hasWorkspaceExtractionCapacity(c,f.account.workspace.id,{id:eligible.id,createdAt:eligible.createdAt,lane:2})),true);
});
