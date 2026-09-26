/** Drive/n8n recipe boundary checks through the real API; no Drive or provider transport. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {PDFDocument} from 'pdf-lib';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,closeDatabase,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';

type Account={userId:string;workspaceId:string;cookie:string};
type Fixture={account:Account;parserId:string;key:string};
const accounts:Account[]=[],originalFetch=globalThis.fetch;
let app:Awaited<ReturnType<typeof buildApp>>,networkCalls=0,providerCalls=0;
async function privateFixtureDatabase(){
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  if(pool.options.connectionString){const url=new URL(pool.options.connectionString);assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/folio');assert.equal(url.port||'5432','5432');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.ok(config.root.startsWith('/private/tmp/')||config.root.startsWith('/tmp/'),'Source intake fixtures require a private copied checkout');assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
 }
 const identity=(await adminPool.query('select current_database() db,current_schema() schema,inet_server_addr()::text address')).rows[0];assert.equal(identity.db,'folio');assert.equal(identity.schema,'public');if(!adminPool.options.connectionString)assert.equal(identity.address,null);
}
before(async()=>{await privateFixtureDatabase();globalThis.fetch=async()=>{networkCalls++;throw new Error('No external network in source recipe fixtures');};setExtractionProvider({configured:()=>false,async extract(){providerCalls++;throw new Error('Source recipe fixture must use its rules parser');}});app=await buildApp();await app.ready();});
after(async()=>{setExtractionProvider(undefined);globalThis.fetch=originalFetch;await app?.close();for(const account of accounts){await adminPool.query('delete from workspaces where id=$1',[account.workspaceId]);await fs.rm(path.join(config.storageDir,account.workspaceId),{recursive:true,force:true});await adminPool.query('delete from users where id=$1',[account.userId]);}await closeDatabase();assert.equal(networkCalls,0);assert.equal(providerCalls,0);});
const session=(account:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown)=>app.inject({method,url,payload:payload as any,headers:{cookie:account.cookie,origin:config.origin}});
const get=(f:Fixture,url:string,headers:Record<string,string>={})=>app.inject({method:'GET',url,headers:{authorization:`Bearer ${f.key}`,...headers}});
async function fixture():Promise<Fixture>{
 const suffix=randomUUID(),registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned source recipe fixture',workspaceName:'Owned source recipe '+suffix,email:'source-recipe-'+suffix+'@example.test',password:'Owned source recipe fixture password'}});assert.equal(registered.statusCode,201,registered.body);const body=registered.json(),account={userId:body.user.id,workspaceId:body.workspace.id,cookie:registered.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')};accounts.push(account);
 const created=await session(account,'POST','/api/parsers',{name:'Source recipe rules',mode:'rules',useCase:'custom',schema:{fields:[{key:'reference',label:'Reference',type:'string',required:true},{key:'amount',label:'Amount',type:'currency'}]}});assert.equal(created.statusCode,201,created.body);
 const issued=await session(account,'POST','/api/workspace/api-keys',{name:'Owned source recipe',scopes:['documents:write','documents:read','results:read']});assert.equal(issued.statusCode,200,issued.body);return {account,parserId:created.json().parser.id,key:issued.json().token};
}
const sourceKey=(f:Fixture,fileId:string,version:string)=>`gd:${f.parserId}:${fileId}:v${version}`;
const bytes=(reference='000042')=>Buffer.from(`SYNTHETIC SOURCE RECIPE\nReference: ${reference}\nAmount: 12.50\n`);
async function upload(f:Fixture,content:Buffer,key:string,options:{filename?:string;workspaceHeader?:string}={}){
 const boundary='source-recipe-'+randomUUID(),payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${options.filename??'synthetic-drive-file.txt'}"\r\nContent-Type: application/octet-stream\r\n\r\n`),content,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 return app.inject({method:'POST',url:`/api/parsers/${f.parserId}/documents`,headers:{authorization:`Bearer ${f.key}`,'idempotency-key':key,'content-type':`multipart/form-data; boundary=${boundary}`,...(options.workspaceHeader?{'x-workspace-id':options.workspaceHeader}:{})},payload});
}
const footprint=async(f:Fixture)=>(await adminPool.query('select (select count(*)::int from documents where workspace_id=$1) documents,(select count(*)::int from jobs where workspace_id=$1) jobs,(select count(*)::int from intake_events where workspace_id=$1) receipts,(select count(*)::int from usage_ledger where workspace_id=$1) events,(select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages',[f.account.workspaceId])).rows[0];
async function detail(f:Fixture,id:string){const response=await get(f,`/api/documents/${id}`);assert.equal(response.statusCode,200,response.body);return response.json();}

test('concurrent delivery of one Drive file version and a discarded upload response recover one current job from duplicate detail',async()=>{
 const f=await fixture(),content=bytes(),key=sourceKey(f,'owned-drive-file','17');
 const responses=await Promise.all(Array.from({length:4},()=>upload(f,content,key))),successful=responses.filter(response=>response.statusCode===202);
 assert.ok(successful.length>=1,'At least one concurrent file-version delivery must be admitted');
 const admitted=successful.filter(response=>!response.json().duplicate);assert.equal(admitted.length,1);const accepted=admitted[0].json();
 for(const response of responses){
  if(response.statusCode===202){assert.equal(response.json().document.id,accepted.document.id);continue;}
  // The shared decoder has a bounded queue. Only its exact busy response is
  // retryable here; a quota or unrelated 429 must still fail this contract.
  assert.equal(response.statusCode,429,response.body);assert.deepEqual(response.json(),{error:'request_error',message:'Document decoding is busy. Retry shortly.'});
  const retry=await upload(f,content,key);assert.equal(retry.statusCode,202,retry.body);assert.equal(retry.json().duplicate,true);assert.equal(retry.json().document.id,accepted.document.id);assert.equal(retry.json().jobId,null);
 }
 // The recipe has lost the original response: retrying the same file-version key
 // returns no job ID, so recover from document detail instead of marking success.
 const replay=await upload(f,content,key);assert.equal(replay.statusCode,202,replay.body);const receipt=replay.json();assert.equal(receipt.duplicate,true);assert.equal(receipt.jobId,null);assert.equal(receipt.document.status,'queued');
 const current=await detail(f,receipt.document.id),active=current.jobs.filter((job:any)=>['queued','processing'].includes(job.state));assert.equal(active.length,1);assert.equal(active[0].id,accepted.jobId);assert.equal(current.document.latestRunId,null);assert.deepEqual(current.runs,[]);
 const polled=await get(f,`/api/jobs/${active[0].id}`);assert.equal(polled.statusCode,200);assert.equal(polled.json().job.documentId,receipt.document.id);assert.equal(polled.json().job.state,'queued');
 assert.equal(await processOneCoreJob(active[0].id),true);const completed=await detail(f,receipt.document.id),run=completed.runs.find((value:any)=>value.id===completed.document.latestRunId);assert.equal(completed.jobs[0].state,'completed');assert.equal(completed.document.status,'needs_review');assert.equal(run.jobId,active[0].id);assert.deepEqual(run.effectiveValues,{reference:'000042',amount:12.5});assert.deepEqual(run.approvals,[]);
 const source=await get(f,`/api/documents/${receipt.document.id}/original`);assert.equal(source.statusCode,200);assert.deepEqual(source.rawPayload,content);assert.equal(run.documentSha256,createHash('sha256').update(content).digest('hex'));
 assert.deepEqual(await footprint(f),{documents:1,jobs:1,receipts:1,events:1,pages:1});assert.equal((await adminPool.query('select idempotency_key from intake_events where workspace_id=$1',[f.account.workspaceId])).rows[0].idempotency_key,key+':0');
});

test('Drive version changes preserve content deduplication while changed bytes require a new version key',async()=>{
 const f=await fixture(),firstKey=sourceKey(f,'owned-versioned-file','100'),secondKey=sourceKey(f,'owned-versioned-file','101'),thirdKey=sourceKey(f,'owned-versioned-file','102');
 const original=await upload(f,bytes(),firstKey);assert.equal(original.statusCode,202,original.body);
 const metadataOnly=await upload(f,bytes(),secondKey,{filename:'renamed-drive-file.txt'});assert.equal(metadataOnly.statusCode,202,metadataOnly.body);assert.equal(metadataOnly.json().duplicate,true);assert.equal(metadataOnly.json().jobId,null);assert.equal(metadataOnly.json().document.id,original.json().document.id);assert.equal(metadataOnly.json().document.name,'synthetic-drive-file.txt');
 const changed=bytes('000043'),conflict=await upload(f,changed,secondKey);assert.equal(conflict.statusCode,409,conflict.body);assert.match(conflict.json().message,/idempotency key.*different/i);
 const next=await upload(f,changed,thirdKey);assert.equal(next.statusCode,202,next.body);assert.equal(next.json().duplicate,false);assert.notEqual(next.json().document.id,original.json().document.id);assert.deepEqual(await footprint(f),{documents:2,jobs:2,receipts:3,events:2,pages:2});
});

test('quota blocks new file bytes while accepted replay remains recoverable, and bearer scope/workspace checks prevent cross-workspace intake',async()=>{
 const f=await fixture(),foreign=await fixture();await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1') where id=$1",[f.account.workspaceId]);
 const key=sourceKey(f,'owned-quota-file','1'),first=await upload(f,bytes(),key);assert.equal(first.statusCode,202,first.body);const before=await footprint(f);
 const denied=await upload(f,bytes('000043'),sourceKey(f,'owned-quota-file','2'));assert.equal(denied.statusCode,429,denied.body);assert.deepEqual(await footprint(f),before);
 const replay=await upload(f,bytes(),key);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().duplicate,true);assert.equal(replay.json().document.id,first.json().document.id);assert.deepEqual(await footprint(f),before);
 const readOnly=await session(f.account,'POST','/api/workspace/api-keys',{name:'Owned read-only recipe key',scopes:['documents:read']});assert.equal(readOnly.statusCode,200);assert.equal((await upload({...f,key:readOnly.json().token},bytes(),key)).statusCode,403);
 const attempted=await upload({...foreign,parserId:f.parserId},bytes(),key,{workspaceHeader:f.account.workspaceId});assert.equal(attempted.statusCode,404,attempted.body);
 assert.equal((await get(foreign,`/api/documents/${first.json().document.id}`,{'x-workspace-id':f.account.workspaceId})).statusCode,404);assert.equal((await get(foreign,`/api/jobs/${first.json().jobId}`,{'x-workspace-id':f.account.workspaceId})).statusCode,404);
 assert.deepEqual(await footprint(f),before);assert.deepEqual(await footprint(foreign),{documents:0,jobs:0,receipts:0,events:0,pages:0});
});

test('duplicate recovery distinguishes an active reprocess from historical success and exposes permanent failure without a result',async()=>{
 const f=await fixture(),key=sourceKey(f,'owned-reprocessed-file','1'),accepted=await upload(f,bytes(),key);assert.equal(accepted.statusCode,202,accepted.body);const documentId=accepted.json().document.id;await processOneCoreJob(accepted.json().jobId);const old=(await detail(f,documentId)).document.latestRunId;
 const reprocess=await session(f.account,'POST',`/api/documents/${documentId}/reprocess`);assert.equal(reprocess.statusCode,200,reprocess.body);
 const replay=await upload(f,bytes(),key);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().jobId,null);assert.equal(replay.json().document.status,'queued');assert.equal(replay.json().document.latestRunId,old);
 const queued=await detail(f,documentId),active=queued.jobs.filter((job:any)=>['queued','processing'].includes(job.state));assert.equal(active.length,1);assert.equal(active[0].id,reprocess.json().job.id);assert.ok(queued.runs.some((run:any)=>run.id===old));await processOneCoreJob(active[0].id);const finished=await detail(f,documentId);assert.notEqual(finished.document.latestRunId,old);assert.equal(finished.runs.find((run:any)=>run.id===finished.document.latestRunId).jobId,active[0].id);
 // A later failed attempt still leaves the last successful run visible. The
 // recipe must not mistake that historical result for this attempt's success.
 const lastSuccess=finished.document.latestRunId,changedParser=await session(f.account,'PATCH',`/api/parsers/${f.parserId}`,{mode:'ai'});assert.equal(changedParser.statusCode,200,changedParser.body);
 const unavailable=await session(f.account,'POST',`/api/documents/${documentId}/reprocess`);assert.equal(unavailable.statusCode,200,unavailable.body);await processOneCoreJob(unavailable.json().job.id);
 const failedHistory=await detail(f,documentId);assert.equal(failedHistory.document.status,'failed');assert.equal(failedHistory.document.latestRunId,lastSuccess);assert.ok(failedHistory.runs.some((run:any)=>run.id===lastSuccess));assert.equal(failedHistory.jobs.find((job:any)=>job.id===unavailable.json().job.id).state,'failed');
 const historyReplay=await upload(f,bytes(),key);assert.equal(historyReplay.statusCode,202);assert.equal(historyReplay.json().jobId,null);assert.equal(historyReplay.json().document.status,'failed');assert.equal(historyReplay.json().document.latestRunId,lastSuccess);
 assert.equal((await session(f.account,'PATCH',`/api/parsers/${f.parserId}`,{mode:'rules'})).statusCode,200);
 // A blank PDF is valid upload input but cannot be extracted by a rules parser.
 // This exercises the real permanent worker failure without an external provider.
 const pdf=await PDFDocument.create();pdf.addPage();const content=Buffer.from(await pdf.save()),failed=await upload(f,content,sourceKey(f,'owned-blank-file','1'),{filename:'synthetic-blank.pdf'});assert.equal(failed.statusCode,202,failed.body);assert.equal(await processOneCoreJob(failed.json().jobId),true);
 const status=await get(f,`/api/jobs/${failed.json().jobId}`);assert.equal(status.statusCode,200);assert.equal(status.json().job.state,'failed');assert.equal(status.json().job.attempts,1);assert.match(status.json().job.error,/no readable text/i);
 const failedDetail=await detail(f,failed.json().document.id);assert.equal(failedDetail.document.status,'failed');assert.equal(failedDetail.document.latestRunId,null);assert.deepEqual(failedDetail.runs,[]);const repeated=await upload(f,content,sourceKey(f,'owned-blank-file','1'),{filename:'synthetic-blank.pdf'});assert.equal(repeated.statusCode,202);assert.equal(repeated.json().duplicate,true);assert.equal(repeated.json().jobId,null);assert.equal(repeated.json().document.status,'failed');
 assert.deepEqual(await footprint(f),{documents:2,jobs:4,receipts:2,events:4,pages:4});
});

test('deleted source-version receipt remains a terminal 410 and cannot silently recreate a deleted document',async()=>{
 const f=await fixture(),key=sourceKey(f,'owned-deleted-file','1'),accepted=await upload(f,bytes(),key);assert.equal(accepted.statusCode,202,accepted.body);const deleted=await session(f.account,'DELETE',`/api/documents/${accepted.json().document.id}`);assert.equal(deleted.statusCode,200,deleted.body);const before=await footprint(f);
 for(const content of [bytes(),bytes('000043')]){const replay=await upload(f,content,key);assert.equal(replay.statusCode,410,replay.body);assert.match(replay.json().message,/document was deleted/i);}
 assert.equal((await get(f,`/api/documents/${accepted.json().document.id}`)).statusCode,404);assert.equal((await get(f,`/api/jobs/${accepted.json().jobId}`)).statusCode,404);assert.deepEqual(await footprint(f),before);assert.deepEqual(before,{documents:0,jobs:0,receipts:1,events:1,pages:1});
 // Only an explicitly newer Drive version is a fresh intake; the old tombstone stays terminal.
 const next=await upload(f,bytes(),sourceKey(f,'owned-deleted-file','2'));assert.equal(next.statusCode,202,next.body);assert.equal(next.json().duplicate,false);assert.notEqual(next.json().document.id,accepted.json().document.id);assert.equal((await upload(f,bytes(),key)).statusCode,410);assert.deepEqual(await footprint(f),{documents:1,jobs:1,receipts:2,events:2,pages:2});
});
