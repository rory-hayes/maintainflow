import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,withWorkspace,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {reconcileInterruptedIntake} from '../server/core/object-reconciliation.js';
import {deleteStoredFile} from '../server/core/retention.js';
import {addDocument} from '../server/core/intake.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
const objects=new Map<string,Buffer>(),workspaceIds:string[]=[],userIds:string[]=[],suffix=randomUUID();
let app:FastifyInstance,owner:Account,other:Account,viewer:Account,parserId:string,reads=0,writes=0,removes=0,failWrite=false;
let readStarted:(()=>void)|undefined,readRelease:Promise<void>|undefined;
const bytes=Buffer.from('Owned direct upload fixture\nReference: UPLOAD-20260911\nAmount: 42');
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const storage:PrivateStorage={kind:'supabase',async write(key,value){writes++;objects.set(key,Buffer.from(value));if(failWrite){failWrite=false;throw Object.assign(new Error('Synthetic lost acknowledgement'),{statusCode:503});}},async read(key,maxBytes=config.maxBytes){reads++;if(readStarted){const started=readStarted;readStarted=undefined;started();await readRelease;}const value=objects.get(key);if(!value)throw Object.assign(new Error('Original file is unavailable'),{statusCode:404});if(value.length>maxBytes)throw Object.assign(new Error('File exceeds the 10 MB limit'),{statusCode:413});return Buffer.from(value);},async remove(key){removes++;objects.delete(key);},async signUpload(key){return `https://storage-fixture.supabase.co/storage/v1/object/upload/sign/folio-originals/${key}?token=controlled-token`;},async signDownload(key,name){return `https://storage-fixture.supabase.co/storage/v1/object/sign/folio-originals/${key}?token=controlled-token&download=${encodeURIComponent(name)}`;}};
async function request(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown,account=owner){return app.inject({method,url,payload:payload as any,headers:{cookie:account.cookie,origin:config.origin}});}
async function signup(label:string):Promise<Account>{const response=await app.inject({method:'POST',url:'/api/auth/register',payload:{name:`Owned upload ${label}`,email:`uploads-${label}-${suffix}@example.test`,password:'owned direct upload test password',workspaceName:`Owned upload ${label}`},headers:{origin:config.origin}});assert.equal(response.statusCode,201,response.body);const result=response.json();workspaceIds.push(result.workspace.id);userIds.push(result.user.id);return {...result,cookie:response.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')};}
async function reserve(value=bytes,name=`owned-${randomUUID()}.txt`){const response=await request('POST',`/api/parsers/${parserId}/uploads`,{filename:name,size:value.length,sha256:sha(value)});assert.equal(response.statusCode,201,response.body);const id=response.json().uploadId;const row=(await adminPool.query('select * from direct_uploads where id=$1',[id])).rows[0];return {id,key:row.storage_key,row};}
async function stage(value=bytes){const reservation=await reserve(value);objects.set(reservation.key,Buffer.from(value));return reservation;}
async function count(table:string){return (await adminPool.query(`select count(*)::int total from ${table} where workspace_id=$1`,[owner.workspace.id])).rows[0].total;}
before(async()=>{setStorageForTests(storage);app=await buildApp();await app.ready();owner=await signup('owner');other=await signup('foreign');viewer=await signup('viewer');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000'::jsonb) where id=$1",[owner.workspace.id]);await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[owner.workspace.id,viewer.user.id]);await adminPool.query('update sessions set workspace_id=$2 where user_id=$1',[viewer.user.id,owner.workspace.id]);const created=await request('POST','/api/parsers',{name:'Owned direct upload parser',useCase:'custom',mode:'rules'});assert.equal(created.statusCode,201,created.body);parserId=created.json().parser.id;});
after(async()=>{setStorageForTests(undefined);await app?.close();for(const id of workspaceIds)await adminPool.query('delete from workspaces where id=$1',[id]);for(const id of userIds)await adminPool.query('delete from users where id=$1',[id]);await closeDatabase();});

test('ordinary API responses receive the default referrer policy',async()=>{
 const response=await app.inject('/api/health');
 assert.equal(response.statusCode,200);
 assert.equal(response.headers['referrer-policy'],'same-origin');
 assert.equal(response.headers['x-content-type-options'],'nosniff');
});

test('reservation requires an editor, exact tenant/parser, valid bounds and remaining quota',async()=>{
 const input={filename:'owned.txt',size:bytes.length,sha256:sha(bytes)};
 assert.equal((await app.inject({method:'POST',url:`/api/parsers/${parserId}/uploads`,payload:input})).statusCode,401);
 assert.equal((await request('POST',`/api/parsers/${parserId}/uploads`,input,viewer)).statusCode,403);
 assert.equal((await request('POST',`/api/parsers/${parserId}/uploads`,input,other)).statusCode,404);
 assert.equal((await request('POST',`/api/parsers/${parserId}/uploads`,{...input,size:config.maxBytes+1})).statusCode,400);
 assert.equal((await request('POST',`/api/parsers/${parserId}/uploads`,{...input,storageKey:'foreign/arbitrary'})).statusCode,400);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','0'::jsonb) where id=$1",[owner.workspace.id]);
 assert.equal((await request('POST',`/api/parsers/${parserId}/uploads`,input)).statusCode,429);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000'::jsonb) where id=$1",[owner.workspace.id]);assert.equal(await count('direct_uploads'),0);
});
test('bytes are verified before intake; mismatch and oversized objects never create a document',async()=>{
 const wrong=await reserve();objects.set(wrong.key,Buffer.from(bytes.toString().replace('42','43')));
 const beforeDocuments=await count('documents'),beforeUsage=await count('usage_ledger');
 const response=await request('POST',`/api/uploads/${wrong.id}/finalize`,{});assert.equal(response.statusCode,400,response.body);assert.equal(await count('documents'),beforeDocuments);assert.equal(await count('usage_ledger'),beforeUsage);
 const oversized=await reserve();objects.set(oversized.key,Buffer.alloc(bytes.length+1));assert.equal((await request('POST',`/api/uploads/${oversized.id}/finalize`,{})).statusCode,413);
 assert.equal(await count('documents'),beforeDocuments);assert.ok(objects.has(wrong.key));assert.ok(new Date(wrong.row.cleanup_after).getTime()-Date.now()>2*60*60*1000);
});
test('finalization creates an immutable original, one job and usage entry; replay returns the stored result',async()=>{
 const staged=await stage();const beforeJobs=await count('jobs'),beforeUsage=await count('usage_ledger');
 const response=await request('POST',`/api/uploads/${staged.id}/finalize`,{});assert.equal(response.statusCode,202,response.body);const result=response.json();assert.equal(result.duplicate,false);assert.notEqual(result.document.storageKey,staged.key);assert.deepEqual(objects.get(result.document.storageKey),bytes);assert.ok(objects.has(staged.key));assert.equal(await count('jobs'),beforeJobs+1);assert.equal(await count('usage_ledger'),beforeUsage+1);
 const readsBefore=reads,writesBefore=writes;const replay=await request('POST',`/api/uploads/${staged.id}/finalize`,{});assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().document.id,result.document.id);assert.equal(replay.json().replayed,true);assert.equal(reads,readsBefore);assert.equal(writes,writesBefore);
 const native=await request('GET',`/api/documents/${result.document.id}/original`);assert.equal(native.statusCode,302);assert.match(String(native.headers.location),/https:\/\/storage-fixture.supabase.co\/storage\/v1\/object\/sign/);assert.equal(native.rawPayload.length,0);assert.equal(native.headers['referrer-policy'],'no-referrer');assert.equal(native.headers['cache-control'],'private, no-store');
 const location=await request('GET',`/api/documents/${result.document.id}/original-url`);assert.equal(location.statusCode,200);assert.equal(location.json().external,true);
 assert.equal((await request('GET',`/api/documents/${result.document.id}/original-url`,undefined,other)).statusCode,404);
});
test('foreign and viewer finalization is rejected before reading stored bytes',async()=>{
 const staged=await stage(Buffer.from('Owned isolated reservation'));const beforeReads=reads;
 assert.equal((await request('POST',`/api/uploads/${staged.id}/finalize`,{},other)).statusCode,404);
 assert.equal((await request('POST',`/api/uploads/${staged.id}/finalize`,{},viewer)).statusCode,403);assert.equal(reads,beforeReads);
 assert.equal((await withWorkspace(other.workspace.id,c=>c.query('select id from direct_uploads where id=$1',[staged.id]))).rowCount,0);
});
test('concurrent finalization claims once, and recovery after result-save interruption remains idempotent',async()=>{
 const staged=await stage(Buffer.from('Owned concurrent direct upload fixture'));let release!:()=>void;
 readRelease=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const gate=new Promise<void>(resolve=>{started=resolve;});readStarted=started;
 const first=request('POST',`/api/uploads/${staged.id}/finalize`,{});await gate;
 const second=await request('POST',`/api/uploads/${staged.id}/finalize`,{});assert.equal(second.statusCode,409);release();const accepted=await first;assert.equal(accepted.statusCode,202,accepted.body);readRelease=undefined;
 const result=accepted.json(),beforeJobs=await count('jobs'),beforeUsage=await count('usage_ledger');
 await adminPool.query("update direct_uploads set state='pending',document_id=null,job_id=null where id=$1",[staged.id]);
 const recovered=await request('POST',`/api/uploads/${staged.id}/finalize`,{});assert.equal(recovered.statusCode,202,recovered.body);assert.equal(recovered.json().document.id,result.document.id);assert.equal(recovered.json().duplicate,true);assert.equal(await count('jobs'),beforeJobs);assert.equal(await count('usage_ledger'),beforeUsage);
});
test('uncertain server writes retain delayed deletion tracking instead of leaking an unreferenced object',async()=>{
 const beforeRemoves=removes;failWrite=true;
 await assert.rejects(addDocument({userId:owner.user.id,workspaceId:owner.workspace.id,role:'owner',authType:'session'},parserId,Buffer.from('Owned uncertain write fixture'),'uncertain.txt'),/lost acknowledgement/);
 const pending=(await adminPool.query("select * from file_deletions where workspace_id=$1 and available_at>now() order by created_at desc limit 1",[owner.workspace.id])).rows[0];assert.ok(pending);assert.ok(objects.has(pending.storage_key));assert.equal(removes,beforeRemoves);assert.ok(new Date(pending.available_at).getTime()>Date.now()+240_000);
 await deleteStoredFile(owner.workspace.id,pending.storage_key);assert.ok(!objects.has(pending.storage_key));
});
test('expired upload cleanup waits beyond capability expiry and retains referenced originals',async()=>{
 const staged=await stage(Buffer.from('Owned abandoned direct upload fixture'));const originalKeys=(await adminPool.query('select storage_key from documents where workspace_id=$1',[owner.workspace.id])).rows.map(row=>row.storage_key);
 const before=await reconcileInterruptedIntake(owner.workspace.id,{limit:2});assert.equal(before.queued,0);assert.ok(objects.has(staged.key));
 await adminPool.query("update direct_uploads set cleanup_after=now()-interval '1 second',expires_at=now()-interval '2 hours' where id=$1",[staged.id]);
 const result=await reconcileInterruptedIntake(owner.workspace.id,{limit:2});assert.equal(result.queued,1);assert.equal(result.removed,0);assert.ok(objects.has(staged.key));
 assert.equal(await deleteStoredFile(owner.workspace.id,staged.key),'complete');assert.ok(!objects.has(staged.key));for(const key of originalKeys)assert.ok(objects.has(key));
 assert.equal((await request('POST',`/api/uploads/${staged.id}/finalize`,{})).statusCode,410);
});
test('remote reconciliation tracks expired uncertain writes, preserves live intents, and honors abort',async()=>{
 const expired=randomUUID(),live=randomUUID();const expiredKey=`${owner.workspace.id}/${expired}`,liveKey=`${owner.workspace.id}/${live}`;objects.set(expiredKey,Buffer.from('orphan'));objects.set(liveKey,Buffer.from('active'));
 await adminPool.query("insert into intake_files(id,workspace_id,storage_key,lease_expires_at) values($1,$2,$3,now()-interval '2 hours'),($4,$2,$5,now()+interval '1 hour')",[expired,owner.workspace.id,expiredKey,live,liveKey]);
 const canceled=await reconcileInterruptedIntake(owner.workspace.id,{signal:AbortSignal.abort()});assert.equal(canceled.queued,0);
 const result=await reconcileInterruptedIntake(owner.workspace.id,{limit:1});assert.equal(result.examined,1);assert.equal(result.queued,1);assert.ok(objects.has(liveKey));await deleteStoredFile(owner.workspace.id,expiredKey);assert.ok(!objects.has(expiredKey));assert.ok((await adminPool.query('select id from intake_files where id=$1',[live])).rowCount);
});

test('unfinished and failed capabilities reserve their full possible bytes, even when declared files are tiny',async()=>{
 const ids:string[]=[];
 try{
  for(let index=0;index<25;index++){
   const id=randomUUID();ids.push(id);
   await adminPool.query("insert into direct_uploads(id,workspace_id,parser_id,created_by,storage_key,filename,expected_bytes,expected_sha256,state) values($1,$2,$3,$4,$5,'tiny.txt',1,$6,'failed')",[id,owner.workspace.id,parserId,owner.user.id,`${owner.workspace.id}/${id}`,sha(Buffer.from('x'))]);
  }
  const beforeWrites=writes;
  const response=await request('POST',`/api/parsers/${parserId}/uploads`,{filename:'tiny.txt',size:1,sha256:sha(Buffer.from('x'))});
  assert.equal(response.statusCode,429,response.body);assert.equal(writes,beforeWrites);
 }finally{await adminPool.query('delete from direct_uploads where id=any($1::uuid[])',[ids]);}
});
