/** Synthetic rows and controlled Stripe only; never the retained real-TEST acceptance database. */
import test,{before,after,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import type {Pool} from 'pg';
import type Stripe from 'stripe';
import {adminPool,appPool,closeDatabase,createDatabasePool,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {storeProviderEvent,tickProviders} from '../server/integrations/providers.js';
import {inspectStripeEventRecovery,recoverStripeEvent,stripeEventRecoveryAuditAction,StripeEventRecoveryError,type StripeEventRecoveryInput} from '../server/integrations/stripe-event-recovery.js';

const fixtures:{userId:string;workspaces:string[];eventIds:string[]}[]=[];
const envKeys=['STRIPE_MODE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','STRIPE_ACCOUNT_ID','STRIPE_PORTAL_CONFIGURATION_ID','STRIPE_TEST_CLOCK_ID','FOLIO_BILLING_MOCK','FOLIO_PREVIEW_MODE'] as const;
const original=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
let verified=false,networkCalls=0;
const query=async(sql:string,parameters:unknown[]=[])=>adminPool.query(sql,parameters);
const row=async(id:string)=>(await query('SELECT * FROM provider_events WHERE id=$1',[id])).rows[0];
const audits=async(workspaceId:string,eventId:string)=>(await query("SELECT * FROM audit_events WHERE workspace_id=$1 AND action=$2 AND metadata->>'providerEvent'=$3 ORDER BY created_at,id",[workspaceId,stripeEventRecoveryAuditAction,eventId])).rows;
async function fixture(){
 const userId=randomUUID(),workspaceId=randomUUID(),controlId=randomUUID(),customerId=`cus_recovery_${randomUUID()}`,eventId=`stripe:evt_recovery_${randomUUID()}`,controlEvent=`stripe:evt_recovery_control_${randomUUID()}`;
 fixtures.push({userId,workspaces:[workspaceId,controlId],eventIds:[eventId,controlEvent]});
 await query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,`recovery-${userId}@example.test`,'Synthetic recovery fixture','unused synthetic fixture hash']);
 const plan={id:'explore',name:'Explore',monthlyPages:50,maxParsers:1,maxConcurrent:1,maxBytes:10485760,maxPages:30,billingMode:'test'};
 for(const id of [workspaceId,controlId]){
  await query('INSERT INTO workspaces(id,name,slug,plan) VALUES($1,$2,$3,$4)',[id,'Synthetic recovery workspace',`recovery-${id}`,JSON.stringify(plan)]);
  await query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[id,userId]);
  await query("INSERT INTO subscriptions(workspace_id,billing_mode,customer_id) VALUES($1,'test',$2)",[id,id===workspaceId?customerId:`cus_control_${id}`]);
 }
 const parserId=(await query("INSERT INTO parsers(workspace_id,name,use_case,mode) VALUES($1,'Synthetic retained recovery parser','receipt','rules') RETURNING id",[workspaceId])).rows[0].id;
 const schemaId=(await query('INSERT INTO schema_versions(workspace_id,parser_id,version,schema,created_by) VALUES($1,$2,1,$3,$4) RETURNING id',[workspaceId,parserId,JSON.stringify({fields:[]}),userId])).rows[0].id;
 await query('UPDATE parsers SET active_schema_id=$2 WHERE id=$1',[parserId,schemaId]);
 const documentId=randomUUID();await query("INSERT INTO documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,source_text) VALUES($1,$2,$3,'synthetic-retained.txt','text/plain',9,$4,$5,'queued',1,$6)",[documentId,workspaceId,parserId,'a'.repeat(64),`${workspaceId}/${documentId}`,JSON.stringify([{page:1,text:'SYNTHETIC'}])]);
 await query('INSERT INTO jobs(workspace_id,document_id,schema_version_id,config) VALUES($1,$2,$3,$4)',[workspaceId,documentId,schemaId,JSON.stringify({mode:'rules',synthetic:true})]);
 await query("INSERT INTO usage_ledger(workspace_id,document_id,event,pages,idempotency_key) VALUES($1,$2,'upload',1,$3)",[workspaceId,documentId,`recovery-fixture:${documentId}`]);
 const payload={id:eventId.slice(7),type:'invoice.paid',created:100,customerId,mode:'test'};
 await query("INSERT INTO provider_events(id,provider,payload,status,attempts,error) VALUES($1,'stripe',$2,'failed',5,'Synthetic provider failure')",[eventId,JSON.stringify(payload)]);
 await query("INSERT INTO provider_events(id,provider,payload,next_attempt_at) VALUES($1,'stripe',$2,now()+interval '1 day')",[controlEvent,JSON.stringify({...payload,id:controlEvent.slice(7),customerId:`cus_control_${controlId}`})]);
 return {eventId,workspaceId,controlId,customerId,mode:'test' as const,payload,controlEvent};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const target=(f:Fixture):StripeEventRecoveryInput=>({eventId:f.eventId,workspaceId:f.workspaceId,customerId:f.customerId,mode:f.mode});
const execution=async(f:Fixture)=>({...target(f),expectedDigest:(await inspectStripeEventRecovery(target(f))).snapshotDigest,operator:'synthetic-operator',reason:'Controlled provider configuration repaired'});
async function retained(f:Fixture){
 const ids=[f.workspaceId,f.controlId];
 return {
  workspaces:(await query('SELECT * FROM workspaces WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
  subscriptions:(await query('SELECT * FROM subscriptions WHERE workspace_id=ANY($1::uuid[]) ORDER BY workspace_id,billing_mode',[ids])).rows,
  parsers:(await query('SELECT * FROM parsers WHERE workspace_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
  schemas:(await query('SELECT * FROM schema_versions WHERE workspace_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
  documents:(await query('SELECT * FROM documents WHERE workspace_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
  jobs:(await query('SELECT * FROM jobs WHERE workspace_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
  usage:(await query('SELECT * FROM usage_ledger WHERE workspace_id=ANY($1::uuid[]) ORDER BY id',[ids])).rows,
  controlEvent:await row(f.controlEvent),
 };
}
async function noChange(f:Fixture,action:()=>Promise<unknown>){const before=await row(f.eventId),history=await audits(f.workspaceId,f.eventId),state=await retained(f);await action();assert.deepEqual(await row(f.eventId),before);assert.deepEqual(await audits(f.workspaceId,f.eventId),history);assert.deepEqual(await retained(f),state);}
function controlledStripe(f:Fixture,fail:()=>boolean,calls:string[]):Stripe{return {
 accounts:{retrieve:async()=>{calls.push('account');return {id:'acct_recovery_fixture'};}},
 subscriptions:{list:async({customer}:{customer:string})=>{calls.push('subscriptions');assert.equal(customer,f.customerId);if(fail())throw Object.assign(new Error('Synthetic private upstream detail must not be persisted'),{statusCode:503});return {data:[],has_more:false};}},
} as unknown as Stripe;}
before(async()=>{
 assert.equal(process.env.NODE_ENV,'test');
 const owned=databaseSchema==='folio';
 if(owned)assert.match(path.resolve(config.root),/^\/private\/tmp\/maintainflow-stripe-local-acceptance-2026-10-17\/runtime\/recovery-[0-9]{2}\/source$/);
 else assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,owned?'mf_stripe_admin':'folio_admin'],[appPool,owned?'mf_stripe_app':'folio_app']] as const){
  if(pool.options.connectionString){const url=new URL(pool.options.connectionString);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,owned?'/maintainflow_stripe_tests':'/folio');assert.equal(url.port||'5432',owned?'55497':'5432');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');if(!owned)assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');}
  else{assert.equal(owned,false);assert.ok(config.root.startsWith('/private/tmp/')||config.root.startsWith('/tmp/'));assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const identity=(await pool.query("SELECT current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,current_setting('cluster_name') cluster")).rows[0];assert.equal(identity.db,owned?'maintainflow_stripe_tests':'folio');assert.equal(identity.schema,databaseSchema);assert.equal(identity.role,role);assert.equal(identity.port,pool.options.connectionString?5432:55432);if(owned)assert.equal(identity.cluster,'mf-stripe-qa-20261017');
 }
 verified=true;const deny=()=>{networkCalls++;throw new Error('External network forbidden in Stripe recovery tests');};mock.method(globalThis,'fetch',deny);mock.method(http,'request',deny);mock.method(https,'request',deny);
 Object.assign(process.env,{STRIPE_MODE:'test',STRIPE_SECRET_KEY:'sk_test_synthetic_recovery_fixture',STRIPE_WEBHOOK_SECRET:'whsec_synthetic_recovery_fixture',STRIPE_PRICE_STANDARD:'price_recovery_standard',STRIPE_PRICE_TEAM:'price_recovery_team',STRIPE_ACCOUNT_ID:'acct_recovery_fixture',STRIPE_PORTAL_CONFIGURATION_ID:'bpc_recovery_fixture',FOLIO_BILLING_MOCK:'false',FOLIO_PREVIEW_MODE:'false'});delete process.env.STRIPE_TEST_CLOCK_ID;
});
afterEach(()=>assert.equal(networkCalls,0));
after(async()=>{try{if(verified)for(const f of fixtures){await query('DELETE FROM provider_events WHERE id=ANY($1::text[])',[f.eventIds]);await query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[f.workspaces]);await query('DELETE FROM users WHERE id=$1',[f.userId]);}}finally{mock.restoreAll();for(const key of envKeys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}await closeDatabase();}});

test('Stripe recovery inspection is read-only and binds the exact exhausted event and workspace',async()=>{
 const f=await fixture();await noChange(f,async()=>{const result=await inspectStripeEventRecovery(target(f));assert.equal(result.eligible,true);assert.equal(result.refusalCode,null);assert.equal(result.attempts,5);assert.equal(result.recoveryGeneration,0);assert.match(result.snapshotDigest,/^[a-f0-9]{64}$/);assert.equal('payload' in result,false);assert.equal('error' in result,false);assert.equal('leaseToken' in result,false);});
});
test('Stripe recovery atomically requeues one event and preserves payload, prior attempts and workspace data in audit history',async()=>{
 const f=await fixture(),before=await row(f.eventId),state=await retained(f),input=await execution(f),result=await recoverStripeEvent(input),after=await row(f.eventId);
 assert.equal(result.recovered,true);assert.equal(result.previousAttempts,5);assert.equal(result.attempts,0);assert.equal(after.status,'retry');assert.equal(after.attempts,0);assert.equal(after.error,null);assert.equal(after.lease_until,null);assert.equal(after.lease_token,null);assert.deepEqual(after.payload,before.payload);assert.equal(after.id,before.id);assert.equal(after.created_at.getTime(),before.created_at.getTime());assert.deepEqual(await retained(f),state);
 const history=await audits(f.workspaceId,f.eventId);assert.equal(history.length,1);assert.equal(history[0].metadata.recoveryId,result.recoveryId);assert.equal(history[0].metadata.operator,input.operator);assert.equal(history[0].metadata.reason,input.reason);assert.equal(history[0].metadata.previous.attempts,5);assert.equal(history[0].metadata.previous.error,before.error);assert.deepEqual(history[0].metadata.previous.payload,before.payload);assert.equal(history[0].metadata.reviewedSnapshotDigest,input.expectedDigest);assert.equal(history[0].metadata.previousGeneration,0);
 await noChange(f,()=>assert.rejects(recoverStripeEvent(input),error=>error instanceof StripeEventRecoveryError&&error.code==='stale_snapshot'));
});
test('Stripe recovery refuses wrong tenants, modes, customers, ambiguous payloads, leases and nonexhausted states',async()=>{
 const f=await fixture();
 for(const patch of [{workspaceId:f.controlId},{customerId:'cus_not_owned'},{mode:'live' as const}])await noChange(f,()=>assert.rejects(inspectStripeEventRecovery({...target(f),...patch}),StripeEventRecoveryError));
 const payloads=[{...f.payload,mode:undefined},{...f.payload,customerId:'cus_other'},{...f.payload,id:'evt_other'},{...f.payload,unexpected:'not a durable allowlisted pointer'}];
 for(const payload of payloads){await query('UPDATE provider_events SET payload=$2 WHERE id=$1',[f.eventId,JSON.stringify(payload)]);await noChange(f,()=>assert.rejects(inspectStripeEventRecovery(target(f)),StripeEventRecoveryError));}await query('UPDATE provider_events SET payload=$2 WHERE id=$1',[f.eventId,JSON.stringify(f.payload)]);
 for(const [status,attempts,leaseUntil,leaseToken] of [['queued',5,null,null],['processing',5,null,null],['completed',5,null,null],['failed',4,null,null],['failed',5,new Date(Date.now()-1000),null],['failed',5,null,randomUUID()]] as const){
  await query('UPDATE provider_events SET status=$2,attempts=$3,lease_until=$4,lease_token=$5 WHERE id=$1',[f.eventId,status,attempts,leaseUntil,leaseToken]);const preview=await inspectStripeEventRecovery(target(f));assert.equal(preview.eligible,false);await noChange(f,()=>assert.rejects(recoverStripeEvent({...target(f),expectedDigest:preview.snapshotDigest,operator:'synthetic',reason:'Must refuse'}),StripeEventRecoveryError));
 }
 await query("UPDATE provider_events SET status='failed',attempts=5,lease_until=NULL,lease_token=NULL WHERE id=$1",[f.eventId]);await query('INSERT INTO provider_event_workspaces(event_id,workspace_id) VALUES($1,$2)',[f.eventId,f.controlId]);await noChange(f,()=>assert.rejects(inspectStripeEventRecovery(target(f)),StripeEventRecoveryError));
});
test('Stripe recovery rejects stale scheduling, payload, subscription and recovery-generation previews',async()=>{
 const f=await fixture();
 for(const mutate of [()=>query("UPDATE provider_events SET next_attempt_at=next_attempt_at+interval '1 second' WHERE id=$1",[f.eventId]),()=>query("UPDATE provider_events SET payload=jsonb_set(payload,'{created}','101') WHERE id=$1",[f.eventId]),()=>query('UPDATE subscriptions SET updated_at=clock_timestamp() WHERE workspace_id=$1',[f.workspaceId]),()=>query('INSERT INTO audit_events(workspace_id,action,metadata) VALUES($1,$2,$3)',[f.workspaceId,stripeEventRecoveryAuditAction,JSON.stringify({providerEvent:f.eventId,syntheticPriorRecovery:true})])]){
  const input=await execution(f);await mutate();await noChange(f,()=>assert.rejects(recoverStripeEvent(input),error=>error instanceof StripeEventRecoveryError&&error.code==='stale_snapshot'));
 }
 const input=await execution(f),prior=await row(f.eventId);await query("UPDATE provider_events SET status='retry' WHERE id=$1",[f.eventId]);await query('UPDATE provider_events SET status=$2 WHERE id=$1',[f.eventId,prior.status]);await noChange(f,()=>assert.rejects(recoverStripeEvent(input),error=>error instanceof StripeEventRecoveryError&&error.code==='stale_snapshot'));
});
test('concurrent Stripe recoveries admit exactly one audited requeue',async()=>{
 const f=await fixture(),input=await execution(f),concurrentPool=createDatabasePool({...adminPool.options,max:2},databaseSchema);
 try{const results=await Promise.allSettled([recoverStripeEvent(input,concurrentPool),recoverStripeEvent(input,concurrentPool)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal((await audits(f.workspaceId,f.eventId)).length,1);assert.equal((await row(f.eventId)).attempts,0);assert.equal((await row(f.eventId)).status,'retry');}finally{await concurrentPool.end();}
});
test('Stripe recovery rolls back the real requeue when its audit insertion fails',async()=>{
 const f=await fixture(),input=await execution(f);let observedUpdate=false;
 const failingPool={connect:async()=>{const client=await adminPool.connect();return new Proxy(client,{get(object,key){if(key==='query')return async(text:string,...args:unknown[])=>{if(text.startsWith('INSERT INTO audit_events')){const pending=(await client.query('SELECT status,attempts FROM provider_events WHERE id=$1',[f.eventId])).rows[0];assert.deepEqual(pending,{status:'retry',attempts:0});observedUpdate=true;throw new Error('Controlled audit insertion failure');}return (client.query as any)(text,...args);};const value=Reflect.get(object,key,object);return typeof value==='function'?value.bind(object):value;}});}} as unknown as Pool;
 await noChange(f,()=>assert.rejects(recoverStripeEvent(input,failingPool),/Controlled audit insertion failure/));assert.equal(observedUpdate,true);
});
test('durable Stripe worker exhausts the same event and completes only after explicit audited recovery',async()=>{
 const f=await fixture();await query("UPDATE provider_events SET status='queued',attempts=0,error=NULL,next_attempt_at=now() WHERE id=$1",[f.eventId]);const state=await retained(f),calls:string[]=[];let fail=true;const client=controlledStripe(f,()=>fail,calls);
 for(const [index,seconds] of [60,120,240,480,960].entries()){
  const start=(await query('SELECT clock_timestamp() instant')).rows[0].instant;assert.equal(await tickProviders({},{eventId:f.eventId,stripe:client}),true);const event=await row(f.eventId),end=(await query('SELECT clock_timestamp() instant')).rows[0].instant;assert.equal(event.attempts,index+1);assert.equal(event.status,index<4?'retry':'failed');assert.equal(event.lease_until,null);assert.equal(event.lease_token,null);assert.doesNotMatch(event.error,/private upstream detail/);assert.ok(event.next_attempt_at.getTime()>=start.getTime()+seconds*1000-5);assert.ok(event.next_attempt_at.getTime()<=end.getTime()+seconds*1000);assert.deepEqual(event.payload,f.payload);assert.deepEqual(await retained(f),state);
  if(index<4)await query("UPDATE provider_events SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[f.eventId]);
 }
 const failed=await row(f.eventId);assert.equal(await tickProviders({},{eventId:f.eventId,stripe:client}),false);assert.deepEqual(await row(f.eventId),failed);
 assert.deepEqual(await storeProviderEvent('stripe',f.payload.id,f.payload),{received:true,duplicate:true});assert.deepEqual(await row(f.eventId),failed);assert.equal((await query('SELECT count(*)::int n FROM provider_event_workspaces WHERE event_id=$1',[f.eventId])).rows[0].n,0,'Failed reconciliation rolls back tentative workspace routing');
 await recoverStripeEvent(await execution(f));fail=false;assert.equal(await tickProviders({},{eventId:f.eventId,stripe:client}),true);const done=await row(f.eventId);assert.equal(done.status,'completed');assert.equal(done.attempts,1);assert.equal(done.error,null);assert.deepEqual(done.payload,f.payload);assert.equal((await audits(f.workspaceId,f.eventId))[0].metadata.previous.attempts,5);assert.equal((await query("SELECT count(*)::int n FROM audit_events WHERE workspace_id=$1 AND action='billing.reconciled'",[f.workspaceId])).rows[0].n,1);assert.equal((await query('SELECT count(*)::int n FROM provider_event_workspaces WHERE event_id=$1 AND workspace_id=$2',[f.eventId,f.workspaceId])).rows[0].n,1);
 const final=await retained(f);assert.deepEqual({...final,subscriptions:state.subscriptions},{...state});assert.deepEqual(final.subscriptions.find(s=>s.workspace_id===f.controlId),state.subscriptions.find(s=>s.workspace_id===f.controlId));assert.equal(calls.length,12);assert.equal(await tickProviders({},{eventId:f.eventId,stripe:client}),false);
});
test('a final expired Stripe lease becomes terminal without transport before audited recovery',async()=>{
 const f=await fixture(),calls:string[]=[],client=controlledStripe(f,()=>false,calls),state=await retained(f);await query("UPDATE provider_events SET status='processing',attempts=5,lease_until=now()-interval '1 second',lease_token=$2 WHERE id=$1",[f.eventId,randomUUID()]);assert.equal((await inspectStripeEventRecovery(target(f))).eligible,false);
 assert.equal(await tickProviders({},{eventId:f.eventId,stripe:client}),false);const terminal=await row(f.eventId);assert.equal(terminal.status,'failed');assert.equal(terminal.attempts,5);assert.equal(terminal.error,'Provider processing lease expired after the final attempt.');assert.equal(terminal.lease_until,null);assert.equal(terminal.lease_token,null);assert.equal(calls.length,0);assert.deepEqual(await retained(f),state);await recoverStripeEvent(await execution(f));assert.equal(await tickProviders({},{eventId:f.eventId,stripe:client}),true);assert.equal((await row(f.eventId)).status,'completed');assert.equal((await audits(f.workspaceId,f.eventId))[0].metadata.previous.error,terminal.error);
});
test('Stripe recovery preserves a valid Checkout completion pointer and refuses a foreign workspace pointer',async()=>{
 const f=await fixture(),checkout={contractId:randomUUID(),sessionId:'cs_test_recovery_fixture',workspaceId:f.workspaceId,policySha256:'b'.repeat(64),consent:'accepted'},payload={...f.payload,type:'checkout.session.completed',checkout};await query('UPDATE provider_events SET payload=$2 WHERE id=$1',[f.eventId,JSON.stringify(payload)]);
 assert.equal((await inspectStripeEventRecovery(target(f))).eligible,true);await recoverStripeEvent(await execution(f));assert.deepEqual((await row(f.eventId)).payload,payload);assert.deepEqual((await audits(f.workspaceId,f.eventId))[0].metadata.previous.payload,payload);
 await query("UPDATE provider_events SET status='failed',attempts=5,payload=$2 WHERE id=$1",[f.eventId,JSON.stringify({...payload,checkout:{...checkout,workspaceId:f.controlId}})]);await noChange(f,()=>assert.rejects(inspectStripeEventRecovery(target(f)),StripeEventRecoveryError));
});
test('the actual recovery CLI defaults to read-only inspection and executes only the reviewed fixture digest',async()=>{
 const f=await fixture(),state=await retained(f),before=await row(f.eventId);
 // Child imports can load dotenv: the guarded copied/CI source must contain no local env files.
 for(const file of ['.env','.env.local'])await assert.rejects(access(path.join(config.root,file)),error=>(error as NodeJS.ErrnoException).code==='ENOENT');
 const database=ownedDatabaseName(),connection=process.env.DATABASE_ADMIN_URL??`postgresql://folio_admin@localhost/folio?host=${encodeURIComponent(path.join(config.root,'.local/socket'))}&port=55432`;
 const denySource="import http from 'node:http';import https from 'node:https';const deny=()=>{throw new Error('External network forbidden in recovery CLI fixture')};globalThis.fetch=deny;http.request=deny;http.get=deny;https.request=deny;https.get=deny;";
 const args=['--import','tsx','--import',`data:text/javascript,${encodeURIComponent(denySource)}`,path.join(config.root,'scripts/recover-stripe-event.ts'),'--event',f.eventId,'--workspace',f.workspaceId,'--customer',f.customerId,'--mode','test','--database',database,'--schema',databaseSchema];
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:'test',DATABASE_ADMIN_URL:connection,DATABASE_SCHEMA:databaseSchema,STRIPE_MODE:'test',DATABASE_POOL_MAX:'1'};
 const invoke=async(extra:string[]=[])=>{const result=await promisify(execFile)(process.execPath,[...args,...extra],{cwd:config.root,env,timeout:20_000,maxBuffer:65_536});assert.equal(result.stderr,'');return JSON.parse(result.stdout);};
 const preview=await invoke();assert.equal(preview.operation,'inspect');assert.equal(preview.database,database);assert.equal(preview.schema,databaseSchema);assert.equal(preview.eventId,f.eventId);assert.equal(preview.eligible,true);assert.match(preview.snapshotDigest,/^[a-f0-9]{64}$/);assert.deepEqual(await row(f.eventId),before);assert.deepEqual(await audits(f.workspaceId,f.eventId),[]);assert.deepEqual(await retained(f),state);
 const result=await invoke(['--execute','--expected',preview.snapshotDigest,'--operator','synthetic-cli-operator','--reason','Controlled test repair']);assert.equal(result.operation,'requeue');assert.equal(result.recovered,true);assert.equal(result.eventId,f.eventId);assert.equal(result.previousAttempts,5);assert.equal(result.status,'retry');assert.equal((await row(f.eventId)).attempts,0);assert.deepEqual((await row(f.eventId)).payload,before.payload);assert.deepEqual(await retained(f),state);const history=await audits(f.workspaceId,f.eventId);assert.equal(history.length,1);assert.equal(history[0].metadata.operator,'synthetic-cli-operator');assert.equal(history[0].metadata.reviewedSnapshotDigest,preview.snapshotDigest);
});
function ownedDatabaseName(){return databaseSchema==='folio'?'maintainflow_stripe_tests':'folio';}
