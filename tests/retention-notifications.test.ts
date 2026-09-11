import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool,withWorkspace,transaction,closeDatabase} from '../server/core/db.js';
import {hashToken} from '../server/core/auth.js';
import {enforceRetention} from '../server/core/worker.js';
import {config} from '../server/core/config.js';

// Owned synthetic state only: no worker claim or provider call. Run with the dev worker paused.
const workspace=randomUUID(),otherWorkspace=randomUUID(),owner=randomUUID(),viewer=randomUUID();
const parser=randomUUID(),otherParser=randomUUID(),schema=randomUUID(),otherSchema=randomUUID();
const ownerToken=randomUUID(),viewerToken=randomUUID(),apiToken=`fl_${randomUUID()}`;
const run=randomUUID(),correction=randomUUID(),approval=randomUUID(),snapshot=randomUUID(),integration=randomUUID(),delivery=randomUUID();
const auditId=randomUUID(),usageId=randomUUID(),intakeId=randomUUID();
const fixtures=[
 {label:'aged-complete',age:3,state:'completed',workspace,parser,schema},
 {label:'recent-complete',age:0,state:'completed',workspace,parser,schema},
 {label:'aged-failed',age:3,state:'failed',workspace,parser,schema},
 {label:'aged-queued',age:3,state:'queued',workspace,parser,schema},
 {label:'aged-processing',age:3,state:'processing',workspace,parser,schema},
 {label:'other-aged-complete',age:3,state:'completed',workspace:otherWorkspace,parser:otherParser,schema:otherSchema},
].map(item=>({...item,id:randomUUID(),job:randomUUID(),bytes:Buffer.from(`SYNTHETIC RETENTION FIXTURE ${item.label}`)}));
const [aged,recent,failed,queued,processing,foreign]=fixtures;
let app:FastifyInstance;
async function request(method:any,url:string,payload?:unknown,asViewer=false,selectedWorkspace=workspace){
 return app.inject({method,url,payload:payload as any,headers:{cookie:`folio_session=${asViewer?viewerToken:ownerToken}`,'x-workspace-id':selectedWorkspace,origin:config.origin}});
}
async function inbox(asViewer=false,selectedWorkspace=workspace){const result=await request('GET','/api/workspace/notifications',undefined,asViewer,selectedWorkspace);assert.equal(result.statusCode,200,result.body);return result.json();}
before(async()=>{
 app=Fastify({logger:false});await app.register(cookie);await app.register(multipart);
 app.setErrorHandler((error:any,_request,reply)=>reply.code(error instanceof ZodError?400:error.statusCode||500).send({error:error.message}));
 await registerCore(app);await app.ready();
 await transaction(adminPool,async c=>{
  for(const [id,label] of [[owner,'owner'],[viewer,'viewer']])await c.query('insert into users(id,email,name,password_hash) values($1,$2,$3,$4)',[id,`notifications-${id}@example.test`,label,'unusable-fixture-hash']);
  for(const id of [workspace,otherWorkspace])await c.query('insert into workspaces(id,name,slug,settings) values($1::uuid,$2,$1::text,$3)',[id,'Owned notification and retention fixture',JSON.stringify({retentionDays:1,notifications:true})]);
  await c.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer'),($4,$3,'owner')",[workspace,owner,viewer,otherWorkspace]);
  for(const [token,userId,workspaceId] of [[ownerToken,owner,workspace],[viewerToken,viewer,otherWorkspace]])await c.query("insert into sessions(token_hash,user_id,workspace_id,expires_at) values($1,$2,$3,now()+interval '1 hour')",[hashToken(token),userId,workspaceId]);
  await c.query('insert into api_keys(workspace_id,user_id,name,prefix,token_hash,scopes) values($1,$2,$3,$4,$5,$6)',[workspace,owner,'Owned fixture','fl_fixture',hashToken(apiToken),JSON.stringify(['documents:read'])]);
  for(const [p,w,s] of [[parser,workspace,schema],[otherParser,otherWorkspace,otherSchema]]){
   await c.query("insert into parsers(id,workspace_id,name,use_case) values($1,$2,'Owned fixture','custom')",[p,w]);
   await c.query('insert into schema_versions(id,workspace_id,parser_id,version,schema) values($1,$2,$3,1,$4)',[s,w,p,JSON.stringify({fields:[{key:'reference',label:'Reference',type:'string'}]})]);
   await c.query('update parsers set active_schema_id=$2 where id=$1',[p,s]);
  }
  for(const f of fixtures){
   await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,created_at) values($1,$2,$3,$4,'text/plain',$5,$6,$7,$8,1,now()-($9::int*interval '1 day'))",[f.id,f.workspace,f.parser,`${f.label}.txt`,f.bytes.length,createHash('sha256').update(f.bytes).digest('hex'),`${f.workspace}/${f.id}`,f.state==='completed'?'needs_review':f.state,f.age]);
   await c.query("insert into jobs(id,workspace_id,document_id,schema_version_id,config,state,available_at,lease_until,error) values($1,$2,$3,$4,'{}',$5,now()+interval '1 hour',now()+interval '1 hour',$6)",[f.job,f.workspace,f.id,f.schema,f.state,f.state==='failed'?'Controlled failure with private diagnostic text':null]);
  }
  await c.query("insert into extraction_runs(id,workspace_id,document_id,schema_version_id,job_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues) values($1,$2,$3,$4,$5,'fixture','fixture','fixture','fixture',$6,$6,'{}','[]')",[run,workspace,aged.id,schema,aged.job,JSON.stringify({reference:'PRIVATE CONTROLLED VALUE'})]);
  await c.query('insert into corrections(id,workspace_id,run_id,user_id,values) values($1,$2,$3,$4,$5)',[correction,workspace,run,owner,JSON.stringify({reference:'CORRECTED PRIVATE VALUE'})]);
  await c.query('insert into approvals(id,workspace_id,run_id,correction_id,user_id,values) values($1,$2,$3,$4,$5,$6)',[approval,workspace,run,correction,owner,JSON.stringify({reference:'CORRECTED PRIVATE VALUE'})]);
  await c.query('update documents set latest_run_id=$2,approved_run_id=$2 where id=$1',[aged.id,run]);
  await c.query("insert into export_snapshots(id,workspace_id,created_by,format,document_ids,run_ids,records,options,mime_type,bytes) values($1,$2,$3,'json',$4,$5,$6,'{}','application/json',$7)",[snapshot,workspace,owner,[aged.id],[run],JSON.stringify([{reference:'PRIVATE EXPORT'}]),Buffer.from('PRIVATE EXPORT')]);
  await c.query("insert into integrations(id,workspace_id,parser_id,name,kind,enabled) values($1,$2,$3,'Owned disabled fixture','google_sheets',false)",[integration,workspace,parser]);
  await c.query("insert into sheet_writes(integration_id,workspace_id,event_key,spreadsheet_id,header_range,data_range,headers,cells) values($1,$2,$3,'fixture','A1','A2','[\"reference\"]','[[\"PRIVATE SHEET\"]]')",[integration,workspace,approval]);
  await c.query("insert into webhook_deliveries(id,workspace_id,integration_id,event_key,payload,next_attempt_at) values($1,$2,$3,$4,$5,now()+interval '1 hour')",[delivery,workspace,integration,approval,JSON.stringify({document:{id:aged.id},values:{reference:'PRIVATE DELIVERY'}})]);
  await c.query("insert into usage_ledger(id,workspace_id,document_id,event,pages,idempotency_key) values($1,$2,$3,'intake',1,$4)",[usageId,workspace,aged.id,usageId]);
  await c.query('insert into intake_events(id,workspace_id,idempotency_key,document_id) values($1::uuid,$2,$1::text,$3)',[intakeId,workspace,aged.id]);
  await c.query("insert into audit_events(id,workspace_id,user_id,action,entity_id) values($1,$2,$3,'fixture.created',$4)",[auditId,workspace,owner,aged.id]);
 });
 for(const f of fixtures){await fs.mkdir(path.join(config.storageDir,f.workspace),{recursive:true,mode:0o700});await fs.writeFile(path.join(config.storageDir,f.workspace,f.id),f.bytes,{mode:0o600});}
});
after(async()=>{
 await app?.close();await adminPool.query('delete from workspaces where id=any($1::uuid[])',[[workspace,otherWorkspace]]);
 await adminPool.query('delete from users where id=any($1::uuid[])',[[owner,viewer]]);
 for(const id of [workspace,otherWorkspace])await fs.rm(path.join(config.storageDir,id),{recursive:true,force:true});
 await closeDatabase();
});
test('notifications derive only terminal workspace jobs without copying values or private diagnostics',async()=>{
 const result=await inbox();assert.equal(result.enabled,true);assert.equal(result.unreadCount,3);assert.equal(result.notifications.length,3);
 assert.deepEqual(new Set(result.notifications.map((n:any)=>n.id)),new Set([aged.job,recent.job,failed.job]));
 for(const item of result.notifications){assert.deepEqual(Object.keys(item).sort(),['documentId','documentName','id','kind','occurredAt','read']);assert.equal(item.read,false);assert.ok(Number.isFinite(Date.parse(item.occurredAt)));}
 assert.equal(result.notifications.find((n:any)=>n.id===failed.job).kind,'processing_failed');
 assert.equal(result.notifications.find((n:any)=>n.id===aged.job).kind,'ready_for_review');
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('diagnostic'));
 assert.equal((await inbox(true,otherWorkspace)).notifications[0].id,foreign.job);
 assert.equal((await request('GET','/api/workspace/notifications',undefined,false,otherWorkspace)).statusCode,403);
 assert.equal((await app.inject({method:'GET',url:'/api/workspace/notifications',headers:{authorization:`Bearer ${apiToken}`}})).statusCode,403);
});
test('read receipts are per user, tenant scoped, and never change documents, runs, or jobs',async()=>{
 const before=(await adminPool.query('select * from documents where id=$1',[aged.id])).rows[0];
 const jobBefore=(await adminPool.query('select * from jobs where id=$1',[aged.job])).rows[0];
 const runBefore=(await adminPool.query('select * from extraction_runs where id=$1',[run])).rows[0];
 for(let i=0;i<2;i++)assert.equal((await request('POST','/api/workspace/notifications/read',{jobIds:[aged.job]})).json().markedRead,1);
 assert.equal((await inbox()).unreadCount,2);assert.equal((await inbox(true)).unreadCount,3);
 assert.equal((await request('POST','/api/workspace/notifications/read',{jobIds:[foreign.job,queued.job,processing.job]})).json().markedRead,0);
 assert.equal((await withWorkspace(otherWorkspace,c=>c.query('select * from notification_reads where workspace_id=$1',[workspace]))).rowCount,0);
 assert.deepEqual((await adminPool.query('select * from documents where id=$1',[aged.id])).rows[0],before);
 assert.deepEqual((await adminPool.query('select * from jobs where id=$1',[aged.job])).rows[0],jobBefore);
 assert.deepEqual((await adminPool.query('select * from extraction_runs where id=$1',[run])).rows[0],runBefore);
 assert.equal((await request('POST','/api/workspace/notifications/read',{})).json().markedRead,3);
 assert.equal((await inbox()).unreadCount,0);assert.equal((await inbox(true)).unreadCount,3);
});
test('workspace preference hides the inbox and restores retained outcomes and per-user read status',async()=>{
 assert.equal((await request('PATCH','/api/workspace/settings',{notifications:false},true)).statusCode,403);
 assert.equal((await request('PATCH','/api/workspace/settings',{notifications:false})).statusCode,200);
 assert.deepEqual(await inbox(),{enabled:false,unreadCount:0,notifications:[]});assert.deepEqual(await inbox(true),{enabled:false,unreadCount:0,notifications:[]});
 assert.equal((await request('PATCH','/api/workspace/settings',{notifications:true})).statusCode,200);
 assert.equal((await inbox()).notifications.length,3);assert.equal((await inbox()).unreadCount,0);assert.equal((await inbox(true)).unreadCount,3);
 // A later terminal outcome on the same durable job is unread even when its previous state was read.
 await adminPool.query("update jobs set state='failed',updated_at=clock_timestamp() where id=$1",[recent.job]);
 assert.equal((await inbox()).unreadCount,1);assert.equal((await inbox()).notifications.find((n:any)=>n.id===recent.job).kind,'processing_failed');
 await adminPool.query("update jobs set state='completed',updated_at=clock_timestamp() where id=$1",[recent.job]);
});
test('age-based retention removes aged originals and derived data while preserving active, recent, and other-workspace documents',async()=>{
 assert.deepEqual(await enforceRetention(workspace),{removed:2});
 for(const f of [aged,failed]){assert.equal((await adminPool.query('select id from documents where id=$1',[f.id])).rowCount,0);await assert.rejects(fs.access(path.join(config.storageDir,f.workspace,f.id)));}
 for(const f of [recent,queued,processing,foreign]){assert.equal((await adminPool.query('select id from documents where id=$1',[f.id])).rowCount,1);await fs.access(path.join(config.storageDir,f.workspace,f.id));}
 for(const [table,id] of [['extraction_runs',run],['corrections',correction],['approvals',approval],['export_snapshots',snapshot],['webhook_deliveries',delivery]])assert.equal((await adminPool.query(`select id from ${table} where id=$1`,[id])).rowCount,0,`${table} deleted`);
 assert.equal((await adminPool.query('select * from sheet_writes where event_key=$1',[approval])).rowCount,0);
 assert.equal((await adminPool.query('select * from notification_reads where job_id=any($1::uuid[])',[[aged.job,failed.job]])).rowCount,0);
 assert.equal((await adminPool.query('select * from file_deletions where workspace_id=$1',[workspace])).rowCount,0);
 assert.equal((await adminPool.query('select document_id from usage_ledger where id=$1',[usageId])).rows[0].document_id,null);
 assert.equal((await adminPool.query('select document_id from intake_events where id=$1',[intakeId])).rows[0].document_id,null);
 assert.equal((await adminPool.query('select id from audit_events where id=$1',[auditId])).rowCount,1);
 assert.deepEqual(await enforceRetention(workspace),{removed:0});
 assert.deepEqual((await inbox()).notifications.map((n:any)=>n.id),[recent.job]);
 // Deferred active documents become eligible only after the job finishes.
 await adminPool.query("update jobs set state='completed',lease_until=null where id=any($1::uuid[])",[[queued.job,processing.job]]);
 assert.deepEqual(await enforceRetention(workspace),{removed:2});
 for(const f of [queued,processing])await assert.rejects(fs.access(path.join(config.storageDir,f.workspace,f.id)));
 await fs.access(path.join(config.storageDir,otherWorkspace,foreign.id));
});
