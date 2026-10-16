/** Owned API/worker/outbox fixtures only; the transport and AI are controlled in memory. */
import test,{before,beforeEach,afterEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {z,ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool,appPool,withWorkspace,transaction,closeDatabase,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob,setExtractionProvider,enforceRetention} from '../server/core/worker.js';
import {extractRules} from '../server/core/extraction.js';
import {appendDocumentEvent} from '../server/core/document-events.js';
import {failInitialSetup} from '../server/core/parser-setup.js';
import {registerExports} from '../server/integrations/exports.js';
import {renderExport} from '../server/integrations/export-format.js';
import {registerIntegrations,enqueueFailureEvents,enqueueIntegrationEvents,processOneDelivery} from '../server/integrations/webhooks.js';
import {reserveSheetWrite} from '../server/integrations/providers.js';
import {deliveryAttemptAuditSchema} from '../server/integrations/delivery-attempt-audit.js';
import {encryptSecret} from '../server/integrations/secrets.js';
import type {PublicRequestOptions} from '../server/integrations/network.js';
import {verifyWebhookDelivery} from '../examples/automations/verify.js';
import {webhookEvents,type WebhookEvent} from '../shared/webhook-events.js';
import type {Actor} from '../shared/types.js';

type Account={actor:Actor;cookie:string;parser:any};
const accounts:Account[]=[],originalFetch=globalThis.fetch;
const secret='owned-webhook-failure-fixture-secret';
const failures=z.fromJSONSchema(JSON.parse(await fs.readFile(new URL('../fixtures/automations/document-failed.schema.json',import.meta.url),'utf8')));
let app:FastifyInstance,networkCalls=0,validationCalls=0,renderOverride:typeof renderExport|undefined;
async function privateDatabase(){
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  if(pool.options.connectionString){const url=new URL(pool.options.connectionString);assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/folio');assert.equal(url.port||'5432','5432');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.ok(config.root.startsWith('/private/tmp/')||config.root.startsWith('/tmp/'),'Webhook fixtures require a private copied checkout');assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
 }
 const row=(await adminPool.query('select current_database() db,current_schema() schema,inet_server_addr()::text address')).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');if(!adminPool.options.connectionString)assert.equal(row.address,null);
}
before(async()=>{
 await privateDatabase();globalThis.fetch=async()=>{networkCalls++;throw new Error('External network forbidden in webhook fixtures');};
 app=Fastify();await app.register(cookie);await app.register(multipart);
 app.setErrorHandler((error:any,_request,reply)=>{reply.code(error instanceof ZodError?400:error.statusCode||500).send({error:error.message});});
 await registerCore(app);await registerExports(app,{render:(records,options)=>(renderOverride??renderExport)(records,options)});
 await registerIntegrations(app,{validateDestination:async raw=>{validationCalls++;assert.equal(raw,'https://receiver.example/owned');return {url:new URL(raw),address:'8.8.8.8',family:4};}});
 await app.ready();
});
beforeEach(()=>{setExtractionProvider({configured:()=>true,async extract(input){return extractRules(input.pages,input.schema,input.locale,[],input.timezone);}});});
afterEach(()=>{renderOverride=undefined;setExtractionProvider(undefined);assert.equal(networkCalls,0);});
after(async()=>{
 setExtractionProvider(undefined);globalThis.fetch=originalFetch;await app?.close();
 for(const account of accounts){await adminPool.query('delete from workspaces where id=$1',[account.actor.workspaceId]);await fs.rm(path.join(config.storageDir,account.actor.workspaceId),{recursive:true,force:true});await adminPool.query('delete from users where id=$1',[account.actor.userId]);}
 await closeDatabase();
});
function request(account:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={}){
 return app.inject({method,url,payload:payload as any,headers:{cookie:account.cookie,origin:config.origin,...headers}});
}
async function fixture(mode:'rules'|'ai'='rules'){
 const registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned webhook fixture',email:`webhook-${randomUUID()}@example.test`,password:'Owned webhook fixture password',workspaceName:'Owned webhook workspace'}});
 assert.equal(registered.statusCode,201,registered.body);const body=registered.json();
 const account:Account={actor:{userId:body.user.id,workspaceId:body.workspace.id,role:'owner',authType:'session'},cookie:registered.cookies.map(value=>`${value.name}=${value.value}`).join('; '),parser:null};accounts.push(account);
 const parser=await request(account,'POST','/api/parsers',{name:'Webhook fixture',mode,schema:{fields:[{key:'reference',label:'Reference',type:'string',required:true}]}});assert.equal(parser.statusCode,201,parser.body);account.parser=parser.json().parser;return account;
}
async function connection(account:Account,events?:readonly WebhookEvent[],options:{kind?:'webhook'|'google_sheets';parserId?:string|null;enabled?:boolean;future?:boolean}={}){
 const id=randomUUID();await withWorkspace(account.actor.workspaceId,c=>c.query(`insert into integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext,enabled,created_at)
 values($1,$2,$3,'Owned receiver',$4,$5,$6,$7,clock_timestamp()+($8::int*interval '1 second'))`,[id,account.actor.workspaceId,options.parserId===undefined?account.parser.id:options.parserId,options.kind??'webhook',JSON.stringify({url:'https://receiver.example/owned',...(events===undefined?{}:{events})}),encryptSecret(secret),options.enabled??true,options.future?3600:-1]));return id;
}
async function upload(account:Account){const source=await addDocument(account.actor,account.parser.id,Buffer.from(`Reference: owned-${randomUUID()}`),'owned-webhook.txt');assert.ok(source.jobId);return {...source,jobId:source.jobId!};}
async function detail(account:Account,documentId:string){const response=await request(account,'GET',`/api/documents/${documentId}`);assert.equal(response.statusCode,200,response.body);return response.json();}
async function approved(account:Account){const source=await upload(account);await processOneCoreJob(source.jobId);const data=await detail(account,source.document.id),run=data.runs.find((value:any)=>value.id===data.document.latestRunId);const response=await request(account,'POST',`/api/runs/${run.id}/approve`,{});assert.equal(response.statusCode,200,response.body);return {...source,run,approval:response.json().approval};}
const deliveries=async(account:Account)=>(await adminPool.query('select * from webhook_deliveries where workspace_id=$1 order by created_at,id',[account.actor.workspaceId])).rows;
const history=async(account:Account,documentId:string)=>(await adminPool.query("select * from document_events where workspace_id=$1 and document_id=$2 and state='failed' order by sequence",[account.actor.workspaceId,documentId])).rows;
const attemptHistory=async(account:Account,deliveryId:string)=>(await adminPool.query("select * from audit_events where workspace_id=$1 and entity_id=$2 and action in('delivery.attempt_claimed','delivery.attempt_finished','delivery.lease_expired') order by created_at,id",[account.actor.workspaceId,deliveryId])).rows;
async function fail(account:Account){setExtractionProvider({configured:()=>true,async extract(){throw Object.assign(new Error('private provider error must not leave the app'),{permanent:true});}});const source=await upload(account);await processOneCoreJob(source.jobId);assert.equal((await detail(account,source.document.id)).document.status,'failed');return source;}

test('creation validates distinct known choices, defaults approval-only, and enforces role, scope and parser ownership',async()=>{
 const account=await fixture(),foreign=await fixture();
 const base={name:'Owned hook',url:'https://receiver.example/owned',parserId:account.parser.id};
 const normal=await request(account,'POST','/api/integrations/webhooks',base);assert.equal(normal.statusCode,200,normal.body);assert.deepEqual(normal.json().config.events,['document.approved']);assert.ok(normal.json().secret);
 const all=await request(account,'POST','/api/integrations/webhooks',{...base,events:webhookEvents});assert.equal(all.statusCode,200,all.body);assert.deepEqual(all.json().config.events,webhookEvents);
 const before=validationCalls;
 for(const events of [[],null,'document.approved',['unknown'],['document.approved','document.approved'],[...webhookEvents,'document.approved'],[null]])assert.equal((await request(account,'POST','/api/integrations/webhooks',{...base,events})).statusCode,400);
 assert.equal(validationCalls,before,'Malformed choices must fail before destination validation');
 assert.equal((await request(foreign,'POST','/api/integrations/webhooks',base)).statusCode,404);
 for(const role of ['viewer','editor']){await adminPool.query('update memberships set role=$3 where workspace_id=$1 and user_id=$2',[account.actor.workspaceId,account.actor.userId,role]);assert.equal((await request(account,'POST','/api/integrations/webhooks',base)).statusCode,403);}
 await adminPool.query("update memberships set role='admin' where workspace_id=$1 and user_id=$2",[account.actor.workspaceId,account.actor.userId]);assert.equal((await request(account,'POST','/api/integrations/webhooks',{...base,events:['document.export_failed']})).statusCode,200);
 await adminPool.query("update memberships set role='owner' where workspace_id=$1 and user_id=$2",[account.actor.workspaceId,account.actor.userId]);
 const issued=await request(account,'POST','/api/workspace/api-keys',{name:'Read only webhook fixture',scopes:['results:read']});assert.equal(issued.statusCode,200,issued.body);
 assert.equal((await request(account,'POST','/api/integrations/webhooks',base,{authorization:`Bearer ${issued.json().token}`})).statusCode,403);
 const list=await request(account,'GET','/api/integrations');assert.ok(list.json().integrations.every((value:any)=>!('secret' in value)&&!('secretCiphertext' in value)));
 assert.deepEqual((await request(foreign,'GET','/api/integrations')).json().integrations,[]);
});

test('bounded concurrent reconciliation respects subscriptions and Sheets approval-only without rewriting legacy payloads',async()=>{
 const account=await fixture('ai'),foreign=await fixture('ai');
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','3') where id=$1",[account.actor.workspaceId]);
 const second=await request(account,'POST','/api/parsers',{name:'Different parser',schema:{fields:[{key:'reference',label:'Reference',type:'string'}]}});assert.equal(second.statusCode,201,second.body);
 const legacy=await connection(account),approval=await connection(account,['document.approved']),failed=await connection(account,['document.extraction_failed']),all=await connection(account,webhookEvents,{parserId:null}),sheets=await connection(account,webhookEvents,{kind:'google_sheets'});
 const excluded=[await connection(account,webhookEvents,{enabled:false}),await connection(account,webhookEvents,{parserId:second.json().parser.id}),await connection(account,webhookEvents,{future:true}),await connection(foreign,webhookEvents)];
 const good=await approved(account),bad=await fail(account);
 await enqueueIntegrationEvents({workspaceId:account.actor.workspaceId,limit:1});assert.equal((await deliveries(account)).length,2);
 await Promise.all(Array.from({length:4},()=>enqueueIntegrationEvents({workspaceId:account.actor.workspaceId,limit:1})));
 for(let i=0;i<4;i++)await enqueueIntegrationEvents({workspaceId:account.actor.workspaceId,limit:1});
 const rows=await deliveries(account);assert.equal(rows.length,6);assert.equal(new Set(rows.map(row=>`${row.integration_id}/${row.event_key}`)).size,6);
 for(const integrationId of [legacy,approval,all,sheets])assert.equal(rows.filter(row=>row.integration_id===integrationId&&row.payload.event==='document.approved').length,1);
 for(const integrationId of [failed,all]){const row=rows.find(value=>value.integration_id===integrationId&&value.payload.event==='document.extraction_failed');assert.ok(row);failures.parse(row.payload);assert.equal(row.payload.jobId,bad.jobId);assert.equal(row.payload.document.id,bad.document.id);assert.ok(!JSON.stringify(row.payload).includes('private provider'));}
 assert.ok(excluded.every(id=>!rows.some(row=>row.integration_id===id)));assert.deepEqual(await deliveries(foreign),[]);
 const legacyRow=rows.find(row=>row.integration_id===legacy);assert.deepEqual(legacyRow.payload.values,good.approval.values);assert.equal(legacyRow.event_key,`approval:${good.approval.id}`);
 const unchanged=JSON.stringify(rows.map(row=>[row.id,row.event_key,row.payload]));await enqueueIntegrationEvents({workspaceId:account.actor.workspaceId});assert.equal(JSON.stringify((await deliveries(account)).map(row=>[row.id,row.event_key,row.payload])),unchanged);
 const response=await request(account,'GET','/api/deliveries');assert.equal(response.statusCode,200);for(const row of response.json().deliveries){assert.ok(webhookEvents.includes(row.event));assert.ok([good.document.id,bad.document.id].includes(row.documentId));assert.equal(row.documentName,'owned-webhook.txt');assert.equal('payload' in row,false);}
 assert.deepEqual((await request(foreign,'GET','/api/deliveries')).json().deliveries,[]);
 assert.equal((await request(foreign,'POST',`/api/deliveries/${legacyRow.id}/replay`,{})).statusCode,400);
});

test('only terminal worker failure emits, and later successful reprocessing preserves the failed episode',async()=>{
 const account=await fixture('ai');await connection(account,['document.extraction_failed']);const source=await upload(account);let attempts=0;
 setExtractionProvider({configured:()=>true,async extract(){attempts++;throw new Error('private transient extraction marker');}});
 for(let attempt=1;attempt<=3;attempt++){
  await adminPool.query('update jobs set available_at=now() where id=$1',[source.jobId]);assert.equal(await processOneCoreJob(source.jobId),true);
  await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.equal((await deliveries(account)).length,attempt===3?1:0);
 }
 assert.equal(attempts,3);const [event]=await history(account,source.document.id),[delivery]=await deliveries(account);assert.equal(delivery.payload.id,event.id);assert.equal(delivery.payload.jobId,source.jobId);failures.parse(delivery.payload);
 const stored=JSON.stringify(delivery.payload);setExtractionProvider({configured:()=>true,async extract(input){return extractRules(input.pages,input.schema,input.locale,[],input.timezone);}});
 const retry=await request(account,'POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(retry.statusCode,200,retry.body);assert.notEqual(retry.json().job.id,source.jobId);await processOneCoreJob(retry.json().job.id);assert.equal((await detail(account,source.document.id)).document.status,'needs_review');
 await enqueueIntegrationEvents({workspaceId:account.actor.workspaceId});assert.equal((await deliveries(account)).length,1);assert.equal(JSON.stringify((await deliveries(account))[0].payload),stored);
});

test('bounded reconciliation skips held document locks, processes other events and catches up exactly once after release',async()=>{
 const account=await fixture();await connection(account,webhookEvents);const held=await approved(account),available=await approved(account);
 renderOverride=async()=>{throw new Error('Controlled render failure for document lock fixture');};
 const exported=await request(account,'POST','/api/exports',{documentIds:[held.document.id,available.document.id],format:'csv'});assert.equal(exported.statusCode,500,exported.body);renderOverride=undefined;
 const lock=await adminPool.connect();let pending:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await lock.query('BEGIN');await lock.query('select id from documents where id=$1 for update',[held.document.id]);
  pending=enqueueIntegrationEvents({workspaceId:account.actor.workspaceId,limit:1});
  await Promise.race([pending,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Reconciliation waited for a held document instead of skipping it')),3000);})]);
  const rows=await deliveries(account);assert.equal(rows.length,2);assert.ok(rows.every(row=>row.payload.document.id===available.document.id));assert.deepEqual(rows.map(row=>row.payload.event).sort(),['document.approved','document.export_failed']);
 }finally{
  if(timer)clearTimeout(timer);await lock.query('ROLLBACK');lock.release();await pending;
 }
 await enqueueIntegrationEvents({workspaceId:account.actor.workspaceId,limit:1});const caughtUp=await deliveries(account);assert.equal(caughtUp.length,4);assert.equal(caughtUp.filter(row=>row.payload.document.id===held.document.id).length,2);
 await enqueueIntegrationEvents({workspaceId:account.actor.workspaceId,limit:1});assert.deepEqual((await deliveries(account)).map(row=>row.id),caughtUp.map(row=>row.id));
});

test('expired final jobs journal failure after approval or correction changes the previous run display status',async()=>{
 const account=await fixture();await connection(account,['document.extraction_failed']);
 for(const action of ['approve','corrections'] as const){
  const old=await approved(account),retry=await request(account,'POST',`/api/documents/${old.document.id}/reprocess`,{});assert.equal(retry.statusCode,200,retry.body);const jobId=retry.json().job.id;
  await transaction(adminPool,async c=>{await c.query("update jobs set state='processing',attempts=max_attempts,lease_owner=$2,lease_until=now()+interval '1 minute' where id=$1",[jobId,randomUUID()]);await c.query("update documents set status='processing' where id=$1",[old.document.id]);});
  const changed=await request(account,'POST',`/api/runs/${old.run.id}/${action}`,action==='approve'?{}:{values:{reference:'Reviewed previous run'}});assert.equal(changed.statusCode,200,changed.body);
  assert.equal((await detail(account,old.document.id)).document.status,action==='approve'?'processed':'needs_review');
  await adminPool.query("update jobs set lease_until=now()-interval '1 second' where id=$1",[jobId]);assert.equal(await processOneCoreJob(jobId),false);
  const current=await detail(account,old.document.id);assert.equal(current.document.status,'failed');assert.equal(current.document.latestRunId,old.run.id);assert.equal(current.jobs.find((job:any)=>job.id===jobId).state,'failed');
  const events=await history(account,old.document.id);assert.equal(events.length,1);assert.equal(events[0].operation_id,jobId);
  await processOneCoreJob(jobId);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.equal((await deliveries(account)).filter(row=>row.payload.document.id===old.document.id).length,1);
 }
});

test('setup failure episodes that reuse a job retain distinct immutable events, while malformed history is skipped',async()=>{
 const account=await fixture();await connection(account,['document.extraction_failed','document.export_failed']);const source=await upload(account);
 await withWorkspace(account.actor.workspaceId,async c=>{
  await c.query("update parsers set field_setup_state='suggesting' where id=$1",[account.parser.id]);await c.query('update jobs set waiting_for_schema=true where id=$1',[source.jobId]);
  await failInitialSetup(c,{...account.parser,field_setup_state:'suggesting'},'private setup marker one');
  await c.query("update jobs set state='queued' where id=$1",[source.jobId]);await c.query("update documents set status='queued' where id=$1",[source.document.id]);
  await failInitialSetup(c,{...account.parser,field_setup_state:'suggesting'},'private setup marker two');
  await appendDocumentEvent(c,account.actor.workspaceId,source.document.id,{phase:'export',state:'failed',details:{format:'csv'}});
  await appendDocumentEvent(c,account.actor.workspaceId,source.document.id,{phase:'export',state:'failed',operationId:randomUUID(),details:{format:'csv'}});
  await appendDocumentEvent(c,account.actor.workspaceId,source.document.id,{phase:'processing',state:'failed'});
 });
 await enqueueFailureEvents({workspaceId:account.actor.workspaceId});const rows=await deliveries(account);assert.equal(rows.length,2);assert.equal(new Set(rows.map(row=>row.payload.id)).size,2);assert.ok(rows.every(row=>row.payload.jobId===source.jobId&&!JSON.stringify(row.payload).includes('private setup')));rows.forEach(row=>failures.parse(row.payload));
});

test('export failures retain every exact selected approval and safe reasons across renderer, size and persistence failures',async()=>{
 const account=await fixture();await connection(account,['document.export_failed']);const first=await approved(account),second=await approved(account),ids=[first.document.id,second.document.id];
 await request(account,'POST',`/api/runs/${first.run.id}/corrections`,{values:{reference:'New unapproved private value'}});
 const revisions=[{documentId:first.document.id,approvalId:first.approval.id},{documentId:second.document.id,approvalId:second.approval.id}];
 const selected={documentIds:ids,revisions,format:'xlsx'};
 for(const variant of ['renderer','size','persistence'] as const){
  renderOverride=async()=>{if(variant==='persistence')return {bytes:Buffer.from('controlled bytes'),mime:null as unknown as string,extension:'xlsx'};throw Object.assign(new Error('private export exception marker'),variant==='size'?{statusCode:413}:{});};
  const result=await request(account,'POST','/api/exports',selected);assert.equal(result.statusCode,variant==='size'?413:500,result.body);assert.ok(!result.body.includes('private export'));
 }
 renderOverride=undefined;await enqueueFailureEvents({workspaceId:account.actor.workspaceId});const rows=await deliveries(account);assert.equal(rows.length,6);assert.equal(new Set(rows.map(row=>row.payload.exportId)).size,3);
 for(const row of rows){failures.parse(row.payload);const source=row.payload.document.id===first.document.id?first:second;assert.equal(row.payload.runId,source.run.id);assert.equal(row.payload.approvalId,source.approval.id);assert.equal(row.payload.format,'xlsx');assert.equal('values' in row.payload,false);assert.ok(!JSON.stringify(row.payload).includes('private'));}
 assert.equal(rows.filter(row=>row.payload.error.code==='export_size_limit').length,2);
 assert.equal((await adminPool.query('select id from export_snapshots where workspace_id=$1',[account.actor.workspaceId])).rowCount,0);
 const initial=rows.map(row=>row.id);assert.equal((await request(account,'POST','/api/exports',{documentIds:[first.document.id],format:'invalid'})).statusCode,400);assert.equal((await request(account,'GET',`/api/exports/${randomUUID()}/download`)).statusCode,404);
 const success=await request(account,'POST','/api/exports',selected);assert.equal(success.statusCode,200,success.body);assert.equal((await request(account,'GET',success.json().downloadUrl)).statusCode,200);
 await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.deepEqual((await deliveries(account)).map(row=>row.id),initial);
});

test('failure retries and replay keep signed bytes and identity; Sheets rejects an invalid failure outbox row before transport',async()=>{
 const account=await fixture('ai'),integrationId=await connection(account,['document.extraction_failed']),source=await fail(account);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});const [original]=await deliveries(account);
 const captured:{body:string;headers:Record<string,string>}[]=[];
 const transport=async(_url:string,options:PublicRequestOptions={})=>{assert.equal(_url,'https://receiver.example/owned');const value={body:options.body!,headers:options.headers!};captured.push(value);assert.equal(verifyWebhookDelivery({body:Buffer.from(value.body),headers:value.headers},secret).deliveryId,original.id);return {status:captured.length===1?503:204,bytes:Buffer.alloc(0)};};
 await processOneDelivery({workspaceId:account.actor.workspaceId,transport});let row=(await deliveries(account))[0];assert.equal(row.status,'retry');assert.equal(row.attempts,1);
 await adminPool.query('update webhook_deliveries set next_attempt_at=now() where id=$1',[original.id]);await processOneDelivery({workspaceId:account.actor.workspaceId,transport});row=(await deliveries(account))[0];assert.equal(row.status,'delivered');assert.equal(row.attempts,2);
 const replay=await request(account,'POST',`/api/deliveries/${original.id}/replay`,{});assert.equal(replay.statusCode,200,replay.body);await processOneDelivery({workspaceId:account.actor.workspaceId,transport});
 assert.equal(captured.length,3);for(const item of captured){assert.equal(item.body,captured[0].body);assert.equal(item.headers['Idempotency-Key'],original.id);assert.equal(item.headers['X-Folio-Delivery'],original.id);}
 assert.equal((await adminPool.query("select id from audit_events where workspace_id=$1 and entity_id=$2 and action='delivery.replayed'",[account.actor.workspaceId,original.id])).rowCount,1);
 const attempts=await attemptHistory(account,original.id);attempts.forEach(event=>deliveryAttemptAuditSchema.parse(event.metadata));
 const claims=attempts.filter(event=>event.action==='delivery.attempt_claimed').map(event=>event.metadata),finishes=attempts.filter(event=>event.action==='delivery.attempt_finished').map(event=>event.metadata);
 assert.deepEqual(claims.map(event=>[event.attempt,event.priorAttempts,event.acquiredFrom,event.priorLeaseExpired]),[[1,0,'queued',false],[2,1,'retry',false],[1,0,'queued',false]]);
 assert.equal(new Set(claims.map(event=>event.attemptId)).size,3);assert.deepEqual(finishes.map(event=>[event.outcome,event.responseStatus,event.path]),[['retry',503,'webhook_request'],['delivered',204,'webhook_request'],['delivered',204,'webhook_request']]);
 for(const claim of claims){const finish=finishes.find(event=>event.attemptId===claim.attemptId);assert.ok(finish);assert.ok(finish.elapsedMs>=claim.elapsedMs);}
 await adminPool.query("update webhook_deliveries set status='delivering',attempts=5,lease_until=now()-interval '1 second',lease_token=$2 where id=$1",[original.id,randomUUID()]);assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),false);assert.equal((await deliveries(account))[0].status,'failed');assert.equal(captured.length,3);
 assert.equal((await attemptHistory(account,original.id)).filter(event=>event.action==='delivery.lease_expired').length,1);assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),false);assert.equal((await attemptHistory(account,original.id)).filter(event=>event.action==='delivery.lease_expired').length,1);
 const sheets=await connection(account,['document.approved'],{kind:'google_sheets'}),invalid=randomUUID();await adminPool.query("insert into webhook_deliveries(id,workspace_id,integration_id,event_key,payload) values($1,$2,$3,'controlled-invalid-sheet-event',$4)",[invalid,account.actor.workspaceId,sheets,JSON.stringify(original.payload)]);
 await processOneDelivery({workspaceId:account.actor.workspaceId,transport});assert.equal(captured.length,3);assert.equal(networkCalls,0);assert.match((await adminPool.query('select error from webhook_deliveries where id=$1',[invalid])).rows[0].error,/approval events only/);
 assert.equal(original.integration_id,integrationId);assert.equal(original.payload.document.id,source.document.id);
});

test('reclaimed failure-delivery leases fence late opposite outcomes without duplicate events or usage', {timeout:20_000}, async()=>{
 const account=await fixture('ai');await connection(account,['document.extraction_failed']);const source=await fail(account);
 await enqueueFailureEvents({workspaceId:account.actor.workspaceId});const [original]=await deliveries(account);assert.ok(original);
 const beforeDocument=await detail(account,source.document.id),beforeHistory=await history(account,source.document.id);
 const usage=async()=>(await adminPool.query('select * from usage_ledger where workspace_id=$1 order by id',[account.actor.workspaceId])).rows;
 const notifications=async()=>{const response=await request(account,'GET','/api/workspace/notifications');assert.equal(response.statusCode,200,response.body);return response.json();};
 const beforeUsage=await usage(),beforeNotifications=await notifications();
 assert.equal(beforeHistory.length,1);assert.equal(beforeUsage.length,1);assert.equal(beforeNotifications.notifications.length,1);
 const captured:{body:string;headers:Record<string,string>}[]=[];
 async function bounded<T>(work:Promise<T>):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Controlled delivery barrier timed out.')),5_000);})]);}
  finally{if(timer)clearTimeout(timer);}
 }
 for(const [index,variant] of [{stale:204,current:503},{stale:503,current:204}].entries()){
  if(index){const replay=await request(account,'POST',`/api/deliveries/${original.id}/replay`,{});assert.equal(replay.statusCode,200,replay.body);}
  let release!:()=>void,entered!:()=>void,calls=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const transport=async(_url:string,options:PublicRequestOptions={})=>{
   assert.equal(_url,'https://receiver.example/owned');const value={body:options.body!,headers:options.headers!};captured.push(value);
   assert.equal(verifyWebhookDelivery({body:Buffer.from(value.body),headers:value.headers},secret).deliveryId,original.id);
   calls++;if(calls===1){entered();await gate;return {status:variant.stale,bytes:Buffer.alloc(0)};}
   return {status:calls===2?variant.current:204,bytes:Buffer.alloc(0)};
  };
  const stale=processOneDelivery({workspaceId:account.actor.workspaceId,transport});
  try{
   await bounded(started);const held=(await deliveries(account))[0];assert.equal(held.id,original.id);assert.equal(held.attempts,1);assert.equal(held.status,'delivering');assert.ok(held.lease_token);
   const heldClaim=(await attemptHistory(account,original.id)).filter(event=>event.action==='delivery.attempt_claimed').at(-1)!.metadata;assert.notEqual(heldClaim.attemptId,held.lease_token);
   const freshHistory=await attemptHistory(account,original.id);assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport:async()=>{throw new Error('A fresh lease cannot send again.');}}),false);assert.deepEqual(await attemptHistory(account,original.id),freshHistory);
   // Only this disposable local fixture's lease is advanced; no wall-clock wait or live queue.
   await adminPool.query("update webhook_deliveries set lease_until=now()-interval '1 second' where id=$1 and lease_token=$2",[original.id,held.lease_token]);
   assert.equal(await bounded(processOneDelivery({workspaceId:account.actor.workspaceId,transport})),true);
   const current=(await deliveries(account))[0];assert.equal(current.attempts,2);assert.equal(current.response_status,variant.current);
   assert.equal(current.status,variant.current===204?'delivered':'retry');assert.equal(current.lease_token,null);assert.equal(current.lease_until,null);
   const reclaimed=(await attemptHistory(account,original.id)).filter(event=>event.action==='delivery.attempt_claimed').at(-1)!.metadata;assert.equal(reclaimed.acquiredFrom,'expired_lease');assert.equal(reclaimed.priorLeaseExpired,true);assert.equal(reclaimed.priorAttempts,1);assert.notEqual(reclaimed.attemptId,heldClaim.attemptId);
   if(variant.current===204){assert.ok(current.delivered_at);assert.equal(current.error,null);}else{assert.equal(current.delivered_at,null);assert.match(current.error,/HTTP 503/);}
   release();assert.equal(await bounded(stale),true);
   // A stale success cannot erase the current retry; a stale failure cannot undo current success.
   assert.deepEqual((await deliveries(account))[0],current);
   const staleFinish=(await attemptHistory(account,original.id)).find(event=>event.action==='delivery.attempt_finished'&&event.metadata.attemptId===heldClaim.attemptId)!.metadata;
   assert.equal(staleFinish.outcome,'fence_lost');assert.equal(staleFinish.responseStatus,variant.stale);
   if(variant.current===503){
    await adminPool.query('update webhook_deliveries set next_attempt_at=now() where id=$1',[original.id]);
    assert.equal(await bounded(processOneDelivery({workspaceId:account.actor.workspaceId,transport})),true);
    const recovered=(await deliveries(account))[0];assert.equal(recovered.status,'delivered');assert.equal(recovered.attempts,3);assert.equal(recovered.response_status,204);assert.equal(recovered.error,null);
   }
   assert.equal(calls,variant.current===503?3:2);
  }finally{release();await bounded(stale);}
 }
 await enqueueFailureEvents({workspaceId:account.actor.workspaceId});const final=await deliveries(account);assert.equal(final.length,1);
 assert.equal(final[0].id,original.id);assert.equal(final[0].event_key,original.event_key);assert.deepEqual(final[0].payload,original.payload);assert.equal(final[0].attempts,2);
 assert.equal(captured.length,5);for(const item of captured){assert.equal(item.body,captured[0].body);assert.equal(item.headers['Idempotency-Key'],original.id);assert.equal(item.headers['X-Folio-Delivery'],original.id);}
 assert.deepEqual(await detail(account,source.document.id),beforeDocument);assert.deepEqual(await history(account,source.document.id),beforeHistory);
 assert.deepEqual(await usage(),beforeUsage);assert.deepEqual(await notifications(),beforeNotifications);assert.equal(networkCalls,0);
 const audited=await attemptHistory(account,original.id);audited.forEach(event=>deliveryAttemptAuditSchema.parse(event.metadata));assert.equal(audited.filter(event=>event.action==='delivery.attempt_claimed').length,5);assert.equal(audited.filter(event=>event.metadata.outcome==='fence_lost').length,2);
 // Lease fencing protects durable outcome metadata; an already-sent HTTP request cannot be unsent.
 // The five controlled calls prove stable receiver identity, not exactly-once third-party side effects.
});

test('attempt audits exclude caught error contents and preserve the existing admin-session workspace boundary',async()=>{
 const account=await fixture('ai'),foreign=await fixture();await connection(account,['document.extraction_failed']);await fail(account);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});const [delivery]=await deliveries(account);
 const canary='SYNTHETIC_PRIVATE_PROVIDER_DIAGNOSTIC';
 await processOneDelivery({workspaceId:account.actor.workspaceId,transport:async()=>{throw Object.assign(new Error(canary),{status:503,headers:{authorization:canary},response:{data:canary}});}});
 const events=await attemptHistory(account,delivery.id);assert.equal(events.length,2);events.forEach(event=>deliveryAttemptAuditSchema.parse(event.metadata));assert.ok(!JSON.stringify(events).includes(canary));
 const finish=events.find(event=>event.action==='delivery.attempt_finished')!.metadata;assert.equal(finish.errorKind,'operation_failed');assert.equal(finish.stage,'webhook_request');assert.equal(finish.responseStatus,null,'A thrown error status is not an observed returned response.');
 const own=await request(account,'GET','/api/workspace/audit');assert.equal(own.statusCode,200);assert.ok(own.json().events.some((event:any)=>event.id===events[0].id));
 const others=await request(foreign,'GET','/api/workspace/audit');assert.equal(others.statusCode,200);assert.ok(!others.json().events.some((event:any)=>event.entityId===delivery.id));
 assert.equal((await withWorkspace(foreign.actor.workspaceId,c=>c.query('select id from audit_events where id=$1',[events[0].id]))).rowCount,0);
 await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[account.actor.workspaceId,foreign.actor.userId]);
 assert.equal((await request(foreign,'GET','/api/workspace/audit',undefined,{'x-workspace-id':account.actor.workspaceId})).statusCode,403);
 await adminPool.query("update memberships set role='admin' where workspace_id=$1 and user_id=$2",[account.actor.workspaceId,foreign.actor.userId]);
 const admin=await request(foreign,'GET','/api/workspace/audit',undefined,{'x-workspace-id':account.actor.workspaceId});assert.equal(admin.statusCode,200);assert.ok(admin.json().events.some((event:any)=>event.id===events[0].id));
 const made=await request(account,'POST','/api/workspace/api-keys',{name:'Audit scope fixture',scopes:['results:read']});assert.equal(made.statusCode,200,made.body);
 assert.equal((await app.inject({method:'GET',url:'/api/workspace/audit',headers:{authorization:`Bearer ${made.json().token}`}})).statusCode,403);
});

test('diagnostic INSERT failures preserve claims, retry outcomes and exhausted expiry without another outbound send',async()=>{
 const account=await fixture('ai');await connection(account,['document.extraction_failed']);const source=await fail(account);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});const [original]=await deliveries(account);
 const before=await detail(account,source.document.id),usage=(await adminPool.query('select * from usage_ledger where workspace_id=$1 order by id',[account.actor.workspaceId])).rows;
 const name=`owned_delivery_audit_failure_${randomUUID().replaceAll('-','')}`;let calls=0;
 try{
  await adminPool.query(`create function ${name}() returns trigger language plpgsql as $$ begin if NEW.workspace_id='${account.actor.workspaceId}'::uuid and NEW.action in('delivery.attempt_claimed','delivery.attempt_finished','delivery.lease_expired') then raise exception 'SYNTHETIC_PRIVATE_DIAGNOSTIC_INSERT_FAILURE'; end if; return NEW; end $$`);
  await adminPool.query(`create trigger ${name} before insert on audit_events for each row execute function ${name}()`);
  const transport=async()=>({status:++calls===1?503:204,bytes:Buffer.alloc(0)});
  assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),true);assert.equal((await deliveries(account))[0].status,'retry');assert.equal((await deliveries(account))[0].attempts,1);
  await adminPool.query('update webhook_deliveries set next_attempt_at=now() where id=$1',[original.id]);assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),true);
  const delivered=(await deliveries(account))[0];assert.equal(delivered.status,'delivered');assert.equal(delivered.attempts,2);assert.equal(calls,2);assert.deepEqual(await attemptHistory(account,original.id),[]);
  assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),false);assert.deepEqual((await deliveries(account))[0],delivered);assert.equal(calls,2,'A successful delivery remains committed despite its rejected audit; no extra send follows.');
  await adminPool.query("update webhook_deliveries set status='delivering',attempts=5,lease_until=now()-interval '1 second',lease_token=$2 where id=$1",[original.id,randomUUID()]);
  assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),false);assert.equal((await deliveries(account))[0].status,'failed');assert.equal(calls,2);assert.deepEqual(await attemptHistory(account,original.id),[]);
 }finally{await adminPool.query(`drop trigger if exists ${name} on audit_events`);await adminPool.query(`drop function if exists ${name}()`);}
 assert.deepEqual(await detail(account,source.document.id),before);assert.deepEqual((await adminPool.query('select * from usage_ledger where workspace_id=$1 order by id',[account.actor.workspaceId])).rows,usage);
});

test('a delivered Sheets reservation reports its shortcut without decrypting credentials or creating refresh or range proof',async()=>{
 const account=await fixture(),integrationId=await connection(account,['document.approved'],{kind:'google_sheets'});
 await adminPool.query('update integrations set config=$2,secret_ciphertext=$3 where id=$1',[integrationId,JSON.stringify({spreadsheetId:'owned_fixture_spreadsheet_12345',sheetName:'Owned QA',columns:[{source:'reference',label:'Reference'}]}),'SYNTHETIC_INVALID_CIPHERTEXT_MUST_NOT_BE_DECRYPTED']);
 await approved(account);await enqueueIntegrationEvents({workspaceId:account.actor.workspaceId});const [delivery]=await deliveries(account),integration=(await adminPool.query('select * from integrations where id=$1',[integrationId])).rows[0];
 const reserved=await reserveSheetWrite(integration,delivery);const seeded=await adminPool.query("update sheet_writes set status='delivered',delivered_at=now() where integration_id=$1 and event_key=$2",[integrationId,reserved.write.event_key]);assert.equal(seeded.rowCount,1);
 const before=(await adminPool.query('select * from sheet_writes where integration_id=$1',[integrationId])).rows,cursor=(await adminPool.query('select * from sheet_cursors where integration_id=$1',[integrationId])).rows;
 assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId}),true);const row=(await deliveries(account))[0];assert.equal(row.status,'delivered');assert.equal(row.attempts,1);
 const finish=(await attemptHistory(account,delivery.id)).find(event=>event.action==='delivery.attempt_finished')!.metadata;assert.equal(finish.path,'sheets_already_delivered');assert.equal(finish.stage,'delivery_commit');assert.equal(finish.responseStatus,200);
 assert.deepEqual((await adminPool.query('select * from sheet_writes where integration_id=$1',[integrationId])).rows,before);assert.deepEqual((await adminPool.query('select * from sheet_cursors where integration_id=$1',[integrationId])).rows,cursor);
 assert.equal((await adminPool.query("select id from audit_events where workspace_id=$1 and action='google_sheets.delivered'",[account.actor.workspaceId])).rowCount,0);assert.equal(networkCalls,0);
});

test('exhausted delivery cleanup caps each tick, skips held leases and leaves protected or foreign rows untouched', {timeout:15_000}, async()=>{
 const account=await fixture(),foreign=await fixture(),integration=await connection(account,['document.extraction_failed'],{enabled:false}),foreignIntegration=await connection(foreign,['document.extraction_failed'],{enabled:false});
 const ids=Array.from({length:28},()=>randomUUID()),fresh=randomUUID(),outside=randomUUID(),payload=JSON.stringify({event:'document.extraction_failed',id:randomUUID(),document:{id:randomUUID(),name:'Synthetic exhausted-lease fixture'}});
 await adminPool.query(`insert into webhook_deliveries(id,workspace_id,integration_id,event_key,payload,status,attempts,lease_token,lease_until)
  select id,$2,$3,'bounded-terminal:'||id::text,$4::jsonb,'delivering',5,gen_random_uuid(),now()-interval '2 hours'+n*interval '1 second' from unnest($1::uuid[]) with ordinality as fixture(id,n)`,[ids,account.actor.workspaceId,integration,payload]);
 for(const [id,workspace,connectionId,past] of [[fresh,account.actor.workspaceId,integration,false],[outside,foreign.actor.workspaceId,foreignIntegration,true]] as const)await adminPool.query(`insert into webhook_deliveries(id,workspace_id,integration_id,event_key,payload,status,attempts,lease_token,lease_until) values($1::uuid,$2::uuid,$3::uuid,'protected-terminal:'||($1::uuid)::text,$4::jsonb,'delivering',5,gen_random_uuid(),now()+($5::int*interval '1 hour'))`,[id,workspace,connectionId,payload,past?-1:1]);
 const protectedBefore=(await adminPool.query('select * from webhook_deliveries where id=any($1::uuid[]) order by id',[[fresh,outside]])).rows;
 const states=async()=>(await adminPool.query('select id,status from webhook_deliveries where id=any($1::uuid[])',[ids])).rows;
 const expired=async()=>(await adminPool.query("select * from audit_events where workspace_id=$1 and action='delivery.lease_expired' order by entity_id",[account.actor.workspaceId])).rows;
 const transport=async()=>{throw new Error('Exhausted cleanup cannot send any outbound request.');};
 const lock=await adminPool.connect();let timer:ReturnType<typeof setTimeout>|undefined,pending:Promise<boolean>|undefined;
 try{
  await lock.query('BEGIN');await lock.query('select id from webhook_deliveries where id=$1 for update',[ids[0]]);
  pending=processOneDelivery({workspaceId:account.actor.workspaceId,transport});
  assert.equal(await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Cleanup waited for a held lease instead of skipping it.')),5_000);})]),false);
  const first=await states();assert.equal(first.filter(row=>row.status==='failed').length,25);assert.equal(first.find(row=>row.id===ids[0])?.status,'delivering');
  assert.deepEqual(new Set(first.filter(row=>row.status==='failed').map(row=>row.id)),new Set(ids.slice(1,26)),'Ordered unlocked candidates are processed first.');
  assert.equal((await expired()).length,25);
 }finally{if(timer)clearTimeout(timer);await lock.query('ROLLBACK');lock.release();if(pending)await pending;}
 assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),false);assert.ok((await states()).every(row=>row.status==='failed'));assert.equal((await expired()).length,28);
 assert.equal(await processOneDelivery({workspaceId:account.actor.workspaceId,transport}),false);assert.equal((await expired()).length,28,'A completed expiry is not journalled again.');
 assert.deepEqual((await adminPool.query('select * from webhook_deliveries where id=any($1::uuid[]) order by id',[[fresh,outside]])).rows,protectedBefore);
 (await expired()).forEach(event=>deliveryAttemptAuditSchema.parse(event.metadata));assert.equal(networkCalls,0);
});

test('paused failures catch up on resume, and document deletion or retention removes payloads and their reconciliation source',async()=>{
 const account=await fixture('ai'),paused=await connection(account,['document.extraction_failed'],{enabled:false}),source=await fail(account);
 await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.deepEqual(await deliveries(account),[]);
 assert.equal((await request(account,'PATCH',`/api/integrations/${paused}`,{enabled:true})).statusCode,200);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.equal((await deliveries(account)).length,1);
 await Promise.all([enqueueFailureEvents({workspaceId:account.actor.workspaceId}),request(account,'DELETE',`/api/documents/${source.document.id}`)]);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.deepEqual(await deliveries(account),[]);assert.deepEqual(await history(account,source.document.id),[]);
 const retained=await fail(account);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.equal((await deliveries(account)).length,1);await adminPool.query("update documents set created_at=now()-interval '100 days' where id=$1",[retained.document.id]);
 assert.equal((await enforceRetention(account.actor.workspaceId)).removed,1);await enqueueFailureEvents({workspaceId:account.actor.workspaceId});assert.deepEqual(await deliveries(account),[]);assert.deepEqual(await history(account,retained.document.id),[]);
});
