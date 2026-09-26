import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {processOneCoreJob} from '../server/core/worker.js';
import {config} from '../server/core/config.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Key={apiKey:{id:string};token:string};
let app:FastifyInstance,account:Account,other:Account,full:Key,readOnly:Key,resultsOnly:Key,foreign:Key,exportsOnly:Key,foreignExports:Key;
let parserId:string,documentId:string,jobId:string,runId:string;
const savedExports:{id:string;downloadUrl:string;bytes:Buffer}[]=[];
const workspaceIds:string[]=[],userIds:string[]=[],suffix=randomUUID();
const bytes=Buffer.from('SYNTHETIC OWNED API DOCUMENT\nReference: 000042\nAmount: € 12.50\nPaid: no');
const eventKey=`owned-api-${suffix}`;
async function sessionRequest(method:'GET'|'POST'|'DELETE',url:string,payload?:unknown,actor=account){
 return app.inject({method,url,payload:payload as any,headers:{cookie:actor.cookie,origin:config.origin}});
}
async function bearerGet(url:string,key=full){return app.inject({method:'GET',url,headers:{authorization:`Bearer ${key.token}`}});}
async function upload(key=full,content=bytes,idempotencyKey=eventKey){
 const boundary=`folio-owned-${randomUUID()}`;
 const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned-api.txt"\r\nContent-Type: text/plain\r\n\r\n`),content,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 return app.inject({method:'POST',url:`/api/parsers/${parserId}/documents`,headers:{authorization:`Bearer ${key.token}`,'idempotency-key':idempotencyKey,'content-type':`multipart/form-data; boundary=${boundary}`},payload});
}
async function signup(label:string):Promise<Account>{
 const response=await app.inject({method:'POST',url:'/api/auth/register',payload:{name:`Owned API ${label}`,email:`api-${label}-${suffix}@example.test`,password:'owned API fixture password',workspaceName:`Owned API ${label}`},headers:{origin:config.origin}});
 assert.equal(response.statusCode,201,response.body);const body=response.json();workspaceIds.push(body.workspace.id);userIds.push(body.user.id);
 return {...body,cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
}
async function makeKey(scopes:string[],actor=account):Promise<Key>{
 const response=await sessionRequest('POST','/api/workspace/api-keys',{name:'Owned API workflow fixture',scopes},actor);assert.equal(response.statusCode,200);return response.json();
}
before(async()=>{
 app=await buildApp();await app.ready();account=await signup('primary');other=await signup('other');
 const created=await sessionRequest('POST','/api/parsers',{name:'Owned API document parser',useCase:'custom',mode:'rules',schema:{fields:[
  {key:'reference',label:'Reference',type:'string',required:true},
  {key:'amount',label:'Amount',type:'currency',required:true},
  {key:'paid',label:'Paid',type:'boolean',required:true},
  {key:'missing_date',label:'Missing date',type:'date'},
 ]}});assert.equal(created.statusCode,201,created.body);parserId=created.json().parser.id;
 full=await makeKey(['parsers:read','documents:write','documents:read','results:read']);readOnly=await makeKey(['documents:read']);resultsOnly=await makeKey(['results:read']);foreign=await makeKey(['documents:write','documents:read','results:read'],other);
 exportsOnly=await makeKey(['exports:read']);foreignExports=await makeKey(['exports:read'],other);
});
after(async()=>{
 await app?.close();for(const id of workspaceIds){await adminPool.query('delete from workspaces where id=$1',[id]);await fs.rm(path.join(config.storageDir,id),{recursive:true,force:true});}
 for(const id of userIds)await adminPool.query('delete from users where id=$1',[id]);await closeDatabase();
});
test('scoped bearer multipart upload returns a durable job, whose exact processing yields retrievable typed results',async()=>{
 const parsers=await bearerGet('/api/parsers');assert.equal(parsers.statusCode,200);assert.equal(parsers.json().parsers[0].id,parserId);
 const accepted=await upload();assert.equal(accepted.statusCode,202,accepted.body);const intake=accepted.json();assert.equal(intake.duplicate,false);assert.equal(intake.document.status,'queued');assert.equal(intake.document.parserId,parserId);assert.equal(intake.results.length,1);
 documentId=intake.document.id;jobId=intake.jobId;assert.match(jobId,/^[\da-f-]{36}$/i);
 const queued=await bearerGet(`/api/jobs/${jobId}`);assert.equal(queued.statusCode,200);assert.equal(queued.json().job.state,'queued');assert.equal(queued.json().job.documentId,documentId);
 const original=await bearerGet(`/api/documents/${documentId}/original`);assert.equal(original.statusCode,200);assert.deepEqual(original.rawPayload,bytes);assert.match(String(original.headers['cache-control']),/private/);
 // Never claim the global queue: root/browser and other suites may own unrelated jobs.
 assert.equal(await processOneCoreJob(jobId),true);
 const completed=await bearerGet(`/api/jobs/${jobId}`);assert.equal(completed.statusCode,200);assert.equal(completed.json().job.state,'completed');assert.equal(completed.json().job.attempts,1);
 const detail=await bearerGet(`/api/documents/${documentId}`);assert.equal(detail.statusCode,200);assert.equal(detail.json().document.status,'needs_review');assert.equal(detail.json().runs.length,1);runId=detail.json().document.latestRunId;
 const result=await bearerGet(`/api/runs/${runId}`);assert.equal(result.statusCode,200,result.body);const run=result.json().run;
 assert.equal(run.documentId,documentId);assert.equal(run.jobId,jobId);assert.equal(run.schemaVersion,1);assert.equal(run.documentSha256,createHash('sha256').update(bytes).digest('hex'));
 assert.deepEqual(run.normalizedValues,{reference:'000042',amount:12.5,paid:false,missing_date:null});assert.deepEqual(run.effectiveValues,run.normalizedValues);
 assert.equal(run.rawValues.amount,'€ 12.50');assert.equal(run.rawValues.paid,'no');assert.equal(run.evidence.reference[0].page,1);assert.match(run.evidence.reference[0].text,/000042/);assert.deepEqual(run.issues,[]);assert.deepEqual(run.approvals,[]);
 assert.equal(await processOneCoreJob(jobId),false);assert.equal((await bearerGet(`/api/documents/${documentId}`)).json().runs.length,1);
});
test('HTTP idempotency replay and same-content intake preserve one document, job and usage reservation',async()=>{
 for(const key of [eventKey,`${eventKey}-same-content`]){const response=await upload(full,bytes,key);assert.equal(response.statusCode,202,response.body);assert.equal(response.json().duplicate,true);assert.equal(response.json().document.id,documentId);assert.equal(response.json().jobId,null);}
 const changed=await upload(full,Buffer.concat([bytes,Buffer.from('\nReference: changed')]),eventKey);assert.equal(changed.statusCode,409);assert.match(changed.json().message,/idempotency key.*different/i);
 const list=await bearerGet('/api/documents');assert.equal(list.statusCode,200);assert.equal(list.json().total,1);assert.equal(list.json().documents[0].id,documentId);
 assert.equal((await adminPool.query('select count(*)::int n from jobs where workspace_id=$1',[account.workspace.id])).rows[0].n,1);
 assert.deepEqual((await adminPool.query('select count(*)::int events,sum(pages)::int pages from usage_ledger where workspace_id=$1',[account.workspace.id])).rows[0],{events:1,pages:1});
 assert.equal((await adminPool.query('select count(*)::int n from intake_events where workspace_id=$1',[account.workspace.id])).rows[0].n,2);
 assert.deepEqual((await fs.readdir(path.join(config.storageDir,account.workspace.id))).sort(),[documentId]);
});
test('upload, job and result endpoints enforce their own bearer scopes before accepting work',async()=>{
 const deniedUpload=await upload(readOnly);assert.equal(deniedUpload.statusCode,403);assert.match(deniedUpload.json().message,/documents:write/);
 assert.equal((await bearerGet(`/api/jobs/${jobId}`,readOnly)).statusCode,200);
 const deniedRun=await bearerGet(`/api/runs/${runId}`,readOnly);assert.equal(deniedRun.statusCode,403);assert.match(deniedRun.json().message,/results:read/);
 assert.equal((await bearerGet(`/api/runs/${runId}`,resultsOnly)).statusCode,200);
 const deniedJob=await bearerGet(`/api/jobs/${jobId}`,resultsOnly);assert.equal(deniedJob.statusCode,403);assert.match(deniedJob.json().message,/documents:read/);
 assert.equal((await adminPool.query('select count(*)::int n from jobs where workspace_id=$1',[account.workspace.id])).rows[0].n,1);
});
test('a valid key for another workspace cannot upload into or retrieve the owned workflow',async()=>{
 assert.equal((await upload(foreign)).statusCode,404);
 for(const url of [`/api/jobs/${jobId}`,`/api/documents/${documentId}`,`/api/documents/${documentId}/original`,`/api/runs/${runId}`])assert.equal((await bearerGet(url,foreign)).statusCode,404,url);
 assert.equal((await bearerGet('/api/documents',foreign)).json().total,0);
 assert.equal((await adminPool.query('select count(*)::int n from jobs where workspace_id=$1',[other.workspace.id])).rows[0].n,0);
});
test('export-only and existing result-read keys list and download the same saved approved CSV, XLSX and JSON bytes',async()=>{
 const approval=await sessionRequest('POST',`/api/runs/${runId}/approve`,{});assert.equal(approval.statusCode,200,approval.body);
 for(const format of ['csv','xlsx','json']){
  // Creating a snapshot remains a results:read action; exports:read only retrieves it.
  const created=await app.inject({method:'POST',url:'/api/exports',headers:{authorization:`Bearer ${resultsOnly.token}`},payload:{documentIds:[documentId],format}});
  assert.equal(created.statusCode,200,created.body);const result=created.json();
  const ownerBytes=await sessionRequest('GET',result.downloadUrl);assert.equal(ownerBytes.statusCode,200,ownerBytes.body);
  const stored=(await adminPool.query('select bytes from export_snapshots where id=$1 and workspace_id=$2',[result.id,account.workspace.id])).rows[0];
  assert.deepEqual(ownerBytes.rawPayload,stored.bytes);
  if(format==='json')assert.deepEqual(ownerBytes.json().documents[0].values,{reference:'000042',amount:12.5,paid:false,missing_date:null});
  savedExports.push({id:result.id,downloadUrl:result.downloadUrl,bytes:ownerBytes.rawPayload});
 }
 for(const key of [exportsOnly,resultsOnly]){
  const listed=await bearerGet('/api/exports',key);assert.equal(listed.statusCode,200,listed.body);
  assert.deepEqual(listed.json().exports.map((row:{id:string})=>row.id).sort(),savedExports.map(row=>row.id).sort());
  for(const saved of savedExports){const downloaded=await bearerGet(saved.downloadUrl,key);assert.equal(downloaded.statusCode,200,downloaded.body);assert.deepEqual(downloaded.rawPayload,saved.bytes);assert.match(String(downloaded.headers['cache-control']),/private, no-store/);}
 }
});
test('export-only access does not grant creation, extraction, originals, mappings or foreign saved exports',async()=>{
 const before=(await adminPool.query('select count(*)::int n from export_snapshots where workspace_id=$1',[account.workspace.id])).rows[0].n;
 const deniedCreate=await app.inject({method:'POST',url:'/api/exports',headers:{authorization:`Bearer ${exportsOnly.token}`},payload:{documentIds:[documentId],format:'json'}});
 assert.equal(deniedCreate.statusCode,403,deniedCreate.body);assert.match(deniedCreate.json().message,/results:read/);
 for(const url of [`/api/runs/${runId}`,`/api/documents/${documentId}/original`,`/api/jobs/${jobId}`,'/api/export-mappings'])assert.equal((await bearerGet(url,exportsOnly)).statusCode,403,url);
 assert.equal((await adminPool.query('select count(*)::int n from export_snapshots where workspace_id=$1',[account.workspace.id])).rows[0].n,before);
 const foreignList=await bearerGet('/api/exports',foreignExports);assert.equal(foreignList.statusCode,200,foreignList.body);assert.deepEqual(foreignList.json().exports,[]);
 for(const saved of savedExports){assert.equal((await bearerGet(saved.downloadUrl,foreignExports)).statusCode,404);assert.equal((await bearerGet(saved.downloadUrl,readOnly)).statusCode,403);}
 assert.equal((await bearerGet('/api/exports',readOnly)).statusCode,403);
});
test('export-only keys retain current membership, expiry and revocation checks before saved bytes are disclosed',async()=>{
 const expired=await makeKey(['exports:read']);
 await adminPool.query("update api_keys set expires_at=clock_timestamp()-interval '1 second' where id=$1 and workspace_id=$2",[expired.apiKey.id,account.workspace.id]);
 for(const url of ['/api/exports',...savedExports.map(saved=>saved.downloadUrl)])assert.equal((await bearerGet(url,expired)).statusCode,401);
 // A viewer may retrieve approved exports, but removing their membership denies the same key.
 await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2",[other.workspace.id,other.user.id]);
 assert.equal((await bearerGet('/api/exports',foreignExports)).statusCode,200);
 await adminPool.query('delete from memberships where workspace_id=$1 and user_id=$2',[other.workspace.id,other.user.id]);
 assert.equal((await bearerGet('/api/exports',foreignExports)).statusCode,401);
 assert.equal((await sessionRequest('DELETE',`/api/workspace/api-keys/${exportsOnly.apiKey.id}`)).statusCode,200);
 for(const url of ['/api/exports',...savedExports.map(saved=>saved.downloadUrl)])assert.equal((await bearerGet(url,exportsOnly)).statusCode,401);
 assert.deepEqual((await bearerGet(savedExports[0].downloadUrl,resultsOnly)).rawPayload,savedExports[0].bytes);
});
test('revocation invalidates upload and every result endpoint while the owner keeps the stored result',async()=>{
 const revoked=await sessionRequest('DELETE',`/api/workspace/api-keys/${full.apiKey.id}`);assert.equal(revoked.statusCode,200);
 assert.equal((await upload()).statusCode,401);
 for(const url of [`/api/jobs/${jobId}`,`/api/documents/${documentId}`,`/api/documents/${documentId}/original`,`/api/runs/${runId}`])assert.equal((await bearerGet(url)).statusCode,401,url);
 const detail=await sessionRequest('GET',`/api/documents/${documentId}`);assert.equal(detail.statusCode,200);assert.equal(detail.json().runs[0].id,runId);
 assert.equal((await adminPool.query('select count(*)::int n from usage_ledger where workspace_id=$1',[account.workspace.id])).rows[0].n,1);
});
