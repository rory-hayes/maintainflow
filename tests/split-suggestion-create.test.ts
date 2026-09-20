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
import {splitStoredPdf} from '../server/core/stored-pdf-split.js';
import {createSuggestedSplit} from '../server/core/split-suggestion-create.js';
import {setSplitSuggestionProvider,processOneSplitSuggestion,reconcileExpiredSplitSuggestions} from '../server/core/split-suggestions.js';
import {splitPdfSource} from '../server/core/source.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {makeTiff} from './fixtures/tiff.js';

type Account={user:{id:string;email:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;suggestion:any;sourceDocumentId:string|null;bytes:Buffer};
const accounts:Account[]=[],objects=new Map<string,Buffer>();
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const originalFetch=globalThis.fetch,options={mode:'ranges' as const,ranges:[{start:1,end:1},{start:2,end:4}]};
let app:FastifyInstance,verified=false,pdf:Buffer,fetches=0,writes=0;
let writeHook:undefined|((key:string,bytes:Buffer)=>Promise<void>);
const storage:PrivateStorage={kind:'supabase',
 async write(key,bytes){writes++;await writeHook?.(key,bytes);objects.set(key,Buffer.from(bytes));},
 async read(key){const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned source unavailable'),{statusCode:404});return Buffer.from(bytes);},
 async remove(key){objects.delete(key);},
};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const authorization=(a:Account)=>({actor:actor(a),tokenHash:hashToken(a.cookie.split('; ').find(value=>value.startsWith('folio_session='))!.slice('folio_session='.length))});
async function request(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id}});}
async function fixture(stored=false,bytes=pdf):Promise<Fixture>{
 const registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned AI split',workspaceName:'Owned AI split',email:`ai-create-${randomUUID()}@example.test`,password:'Owned AI split fixture password'}});assert.equal(registered.statusCode,201,registered.body);
 const account={...registered.json(),cookie:registered.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000') where id=$1",[account.workspace.id]);
 const parser=await request(account,'POST','/api/parsers',{name:'AI split parser',useCase:'custom',mode:'rules',allowedFormats:['pdf','tiff'],schema:{fields:[{key:'reference',label:'Reference',type:'string',anchor:'Reference'}]}});assert.equal(parser.statusCode,201,parser.body);
 const parserId=parser.json().parser.id,name=bytes===pdf?'bundle.pdf':'bundle.tiff';
 let sourceDocumentId:string|null=null,response;
 if(stored){const source=await addDocument(actor(account),parserId,bytes,name);sourceDocumentId=source.document.id;response=await request(account,'POST',`/api/parsers/${parserId}/split-suggestions`,{requestId:randomUUID(),documentId:sourceDocumentId,sourceSha256:hash(bytes)});}
 else{
  const boundary='owned-'+randomUUID(),requestId=randomUUID();
  const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="requestId"\r\n\r\n${requestId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="sourceSha256"\r\n\r\n${hash(bytes)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  response=await app.inject({method:'POST',url:`/api/parsers/${parserId}/split-suggestions`,headers:{origin:config.origin,cookie:account.cookie,'x-workspace-id':account.workspace.id,'content-type':`multipart/form-data; boundary=${boundary}`},payload});
 }
 assert.equal(response.statusCode,202,response.body);const suggestionId=response.json().suggestion.id;
 assert.equal(await processOneSplitSuggestion(suggestionId),true);
 const ready=await request(account,'GET',`/api/parsers/${parserId}/split-suggestions/${suggestionId}`);assert.equal(ready.statusCode,200,ready.body);assert.equal(ready.json().suggestion.state,'ready',ready.body);
 return{account,parserId,suggestion:ready.json().suggestion,sourceDocumentId,bytes};
}
const submit=(f:Fixture,requestId:string=randomUUID(),spec:unknown=options)=>request(f.account,'POST',`/api/parsers/${f.parserId}/split-suggestions/${f.suggestion.id}/create`,{requestId,options:spec});
const status=(f:Fixture)=>request(f.account,'GET',`/api/parsers/${f.parserId}/split-suggestions/${f.suggestion.id}`);
async function counts(f:Fixture){return(await adminPool.query(`select
 (select count(*)::int from documents where workspace_id=$1) documents,
 (select count(*)::int from jobs where workspace_id=$1) jobs,
 (select count(*)::int from pdf_splits where workspace_id=$1) splits,
 (select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages`,[f.account.workspace.id])).rows[0];}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return{promise,resolve};};

before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role]of [[adminPool,'folio_admin'],[appPool,'folio_app']]as const){
  const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,url?5432:55432);if(!url)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No provider calls in AI Create fixtures');};
 setSplitSuggestionProvider({configured:()=>true,async suggest(value){return{startPages:value.pages.length===4?[1,3]:[1],model:'controlled-boundaries',promptVersion:'owned-v1',tokenUsage:{inputTokens:100,outputTokens:10},costUsd:0.001};}});
 app=await buildApp();const document=await PDFDocument.create(),font=await document.embedFont(StandardFonts.Helvetica);
 for(let n=1;n<=4;n++)document.addPage([300,300]).drawText(`Reference: AI-CREATE-${n}`,{x:20,y:240,font,size:12});pdf=Buffer.from(await document.save());
});
afterEach(()=>{writeHook=undefined;assert.equal(fetches,0);});
after(async()=>{writeHook=undefined;setSplitSuggestionProvider(undefined);setStorageForTests(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}}finally{objects.clear();await closeDatabase();}});

test('reviewed uploaded proposal creates only on explicit action and retains edited ranges and provider provenance',async()=>{
 const f=await fixture();assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,pages:0});
 const nonce=randomUUID(),response=await submit(f,nonce);assert.equal(response.statusCode,202,response.body);const receipt=response.json();
 assert.deepEqual(receipt.split.aiSuggestion,{suggestionId:f.suggestion.id,requestId:f.suggestion.requestId,sourceSha256:hash(pdf),sourcePageCount:4,model:'controlled-boundaries',promptVersion:'owned-v1',startPages:[1,3],confirmedRanges:options.ranges,tokenUsage:{inputTokens:100,outputTokens:10},costUsd:0.001});
 assert.deepEqual(receipt.documents.map((d:any)=>[d.originalPageStart,d.originalPageEnd]),[[1,1],[2,4]]);
 assert.deepEqual(await counts(f),{documents:2,jobs:2,splits:1,pages:4});
 const job=(await status(f)).json().suggestion;assert.equal(job.acceptedSplitId,receipt.split.id);assert.equal(job.confirmedRequestId,nonce);assert.deepEqual(job.confirmedOptions,options);assert.equal(job.creationClosed,false);
 const detail=await request(f.account,'GET',`/api/documents/${receipt.documents[0].id}`);assert.deepEqual(detail.json().split.aiSuggestion,receipt.split.aiSuggestion);
});

test('concurrent same-UUID creation replays one charged batch; changed UUID, plan and manual adoption fail',async()=>{
 const f=await fixture(),nonce=randomUUID(),responses=await Promise.all([submit(f,nonce),submit(f,nonce)]);
 for(const response of responses)assert.equal(response.statusCode,202,response.body);
 assert.equal(responses[0].json().split.id,responses[1].json().split.id);assert.deepEqual(await counts(f),{documents:2,jobs:2,splits:1,pages:4});
 assert.equal((await submit(f,randomUUID())).statusCode,409);assert.equal((await submit(f,nonce,{mode:'every',pagesPerDocument:1})).statusCode,409);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,pdf,'manual.pdf',nonce,options),(e:any)=>e.statusCode===409);
 const replay=await submit(f,nonce.toUpperCase());assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().replayed,true);
});

test('quota failure preserves the frozen nonce without writing children and retries once after quota changes',async()=>{
 const f=await fixture(),nonce=randomUUID();await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','3') where id=$1",[f.account.workspace.id]);const beforeWrites=writes;
 const denied=await submit(f,nonce);assert.equal(denied.statusCode,429,denied.body);assert.equal(writes,beforeWrites);assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,pages:0});
 const job=(await status(f)).json().suggestion;assert.equal(job.confirmedRequestId,nonce);assert.equal(job.creationClosed,false);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,pdf,'manual.pdf',nonce,options),(e:any)=>e.statusCode===409);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','4') where id=$1",[f.account.workspace.id]);assert.equal((await submit(f,nonce)).statusCode,202);assert.equal((await submit(f,nonce)).statusCode,202);assert.equal((await counts(f)).pages,4);
});

test('cancel during native decoding prevents late acceptance and gives authoritative manual recovery',async()=>{
 const f=await fixture(),nonce=randomUUID(),entered=deferred(),release=deferred();
 const creating=createSuggestedSplit(authorization(f.account),f.parserId,f.suggestion.id,{requestId:nonce,options},{splitSource:async(...args)=>{entered.resolve();await release.promise;return splitPdfSource(...args);}});
 const rejected=assert.rejects(creating,(e:any)=>e.statusCode===410);
 await entered.promise;const cancelled=await request(f.account,'POST',`/api/parsers/${f.parserId}/split-suggestions/${f.suggestion.id}/cancel`,{});assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().suggestion.creationClosed,true);release.resolve();await rejected;
 assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,pages:0});assert.equal((await submit(f,nonce)).statusCode,410);
 await assert.rejects(addSplitDocuments(actor(f.account),f.parserId,pdf,'manual.pdf',nonce,options),(e:any)=>e.statusCode===409);
 const manual=await addSplitDocuments(actor(f.account),f.parserId,pdf,'manual.pdf',randomUUID(),options);assert.equal(manual.split.aiSuggestion,undefined);assert.equal(manual.split.selectedPages,4);
});

test('expiry while private child writes are pending blocks final acceptance and retains no document charge',async()=>{
 const f=await fixture(),nonce=randomUUID(),entered=deferred(),release=deferred();writeHook=async()=>{entered.resolve();await release.promise;};
 const creating=submit(f,nonce);await entered.promise;await adminPool.query("update split_suggestions set expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.suggestion.id]);
 const job=(await status(f)).json().suggestion;assert.equal(job.creationClosed,true);assert.equal(job.confirmedRequestId,nonce);release.resolve();const response=await creating;assert.equal(response.statusCode,410,response.body);
 assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,pages:0});assert.equal((await submit(f,nonce)).statusCode,410);
});

test('stored PDF uses original lineage and Undo preserves AI provenance and exact replay after source expiry',async()=>{
 const f=await fixture(true),nonce=randomUUID(),response=await submit(f,nonce);assert.equal(response.statusCode,202,response.body);const receipt=response.json();
 assert.equal(receipt.split.origin,'stored');assert.equal(receipt.split.sourceDocumentId,f.sourceDocumentId);assert.equal(receipt.documents[1].root.id,f.sourceDocumentId);assert.equal(receipt.documents[1].root.pageStart,2);
 const undo=await request(f.account,'POST',`/api/pdf-splits/${receipt.split.id}/undo`,{});assert.equal(undo.statusCode,200,undo.body);assert.deepEqual(undo.json().receipt.split.aiSuggestion,receipt.split.aiSuggestion);
 await adminPool.query("update split_suggestions set expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.suggestion.id]);await reconcileExpiredSplitSuggestions(f.account.workspace.id);
 const replay=await submit(f,nonce);assert.equal(replay.statusCode,202,replay.body);assert.ok(replay.json().split.undoneAt);assert.equal(replay.json().replayed,true);assert.deepEqual(replay.json().split.aiSuggestion,receipt.split.aiSuggestion);assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:1,pages:8});
 await assert.rejects(splitStoredPdf(authorization(f.account),f.sourceDocumentId!,nonce,hash(pdf),options),(e:any)=>e.statusCode===409);
});

test('deleting a stored original during decoding closes its proposal and rejects the late Create',async()=>{
 const f=await fixture(true),nonce=randomUUID(),entered=deferred(),release=deferred();
 const creating=createSuggestedSplit(authorization(f.account),f.parserId,f.suggestion.id,{requestId:nonce,options},{splitSource:async(...args)=>{entered.resolve();await release.promise;return splitPdfSource(...args);}});const rejected=assert.rejects(creating,(e:any)=>[404,410].includes(e.statusCode));
 await entered.promise;const deleted=await request(f.account,'DELETE',`/api/documents/${f.sourceDocumentId}`);assert.equal(deleted.statusCode,200,deleted.body);release.resolve();await rejected;
 assert.equal((await status(f)).json().suggestion.creationClosed,true);assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,pages:4});
});

test('revoked sign-in during private writes prevents acceptance, while a fresh sign-in can recover the same nonce',async()=>{
 const f=await fixture(),nonce=randomUUID(),entered=deferred(),release=deferred();writeHook=async()=>{entered.resolve();await release.promise;};
 const creating=submit(f,nonce);await entered.promise;await adminPool.query('delete from sessions where user_id=$1',[f.account.user.id]);release.resolve();const result=await creating;assert.equal(result.statusCode,401,result.body);assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:0,pages:0});
 writeHook=undefined;
 const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin:config.origin},payload:{email:f.account.user.email,password:'Owned AI split fixture password'}});assert.equal(login.statusCode,200,login.body);f.account.cookie=login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');
 const recovered=await submit(f,nonce);assert.equal(recovered.statusCode,202,recovered.body);assert.equal((await counts(f)).pages,4);
});

test('stored TIFF proposal creates TIFF children and binds visual rendering provenance to the original bytes',async()=>{
 const bytes=makeTiff([{width:20,height:25,color:[20,100,200]},{width:30,height:20,color:[180,20,60],orientation:6}],{bigTiff:true,byteOrder:'MM'}),f=await fixture(true,bytes);
 const response=await submit(f,randomUUID(),{mode:'ranges',ranges:[{start:1,end:1},{start:2,end:2}]});assert.equal(response.statusCode,202,response.body);const receipt=response.json();
 assert.equal(receipt.split.sourceMimeType,'image/tiff');assert.equal(receipt.split.aiSuggestion.sourceSha256,hash(bytes));assert.ok(receipt.split.aiSuggestion.tokenUsage.sourceRendering);assert.deepEqual(receipt.documents.map((d:any)=>d.pageCount),[1,1]);
 const rows=(await adminPool.query('select mime_type from documents where pdf_split_id=$1',[receipt.split.id])).rows;assert.ok(rows.every(row=>row.mime_type==='image/tiff'));assert.equal((await counts(f)).pages,4);
});

test('terminal decoder rejection closes the draft and survives recovery without admitting or charging children',async()=>{
 const f=await fixture(),nonce=randomUUID(),invalid={mode:'marker' as const,marker:'ABSENT MARKER',ranges:[{start:1,end:4}]};
 const rejected=await submit(f,nonce,invalid);assert.equal(rejected.statusCode,400,rejected.body);const job=(await status(f)).json().suggestion;assert.equal(job.state,'cancelled');assert.equal(job.creationClosed,true);assert.equal(job.confirmedRequestId,nonce);
 const repeated=await submit(f,nonce,invalid);assert.equal(repeated.statusCode,400,repeated.body);assert.deepEqual(await counts(f),{documents:0,jobs:0,splits:1,pages:0});
 const saved=(await adminPool.query('select ai_suggestion,state from pdf_splits where workspace_id=$1',[f.account.workspace.id])).rows[0];assert.equal(saved.state,'rejected');assert.equal(saved.ai_suggestion.suggestionId,f.suggestion.id);
});
