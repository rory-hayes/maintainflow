import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {databaseConfig} from '../server/core/config.js';
import {secureDatabaseConfig,closeDatabase} from '../server/core/db.js';

// Test-owned empty copies of the real columns. No cron, HTTP, Vault, provider,
// shared queue mutation, or role creation occurs in this predicate regression.
const schema=`watchdog_qa_${randomUUID().replaceAll('-','')}`;
const client=new pg.Client(process.env.DATABASE_ADMIN_URL?secureDatabaseConfig({connectionString:process.env.DATABASE_ADMIN_URL}):{...databaseConfig,user:process.env.PGADMINUSER||'folio_admin'});
let tables:string[]=[];
before(async()=>{
 const sql=await fs.readFile('deploy/supabase-worker.sql','utf8');
 const functionSql=sql.match(/CREATE OR REPLACE FUNCTION folio\.worker_has_runnable_work\(\)[\s\S]*?\$folio_work\$;/)?.[0];
 assert.ok(functionSql);
 tables=[...new Set([...functionSql.matchAll(/\bfolio\.([a-z_]+)\b/g)].map(match=>match[1]).filter(name=>name!=='worker_has_runnable_work'))];
 await client.connect();await client.query(`CREATE SCHEMA ${schema}`);
 for(const table of tables)await client.query(`CREATE TABLE ${schema}.${table} AS SELECT * FROM ${process.env.DATABASE_SCHEMA??'public'}.${table} WITH NO DATA`);
 await client.query(functionSql.replaceAll('folio.',`${schema}.`));
 await client.query(`REVOKE ALL ON FUNCTION ${schema}.worker_has_runnable_work() FROM PUBLIC,folio_app`);
});
after(async()=>{await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end();await closeDatabase();});
async function clear(){await client.query(`TRUNCATE ${tables.map(table=>`${schema}.${table}`).join(',')}`);}
async function insert(table:string,row:Record<string,unknown>){
 assert.ok(tables.includes(table));const keys=Object.keys(row);assert.ok(keys.every(key=>/^[a-z_]+$/.test(key)));
 await client.query(`INSERT INTO ${schema}.${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
async function runnable(){return (await client.query(`SELECT ${schema}.worker_has_runnable_work() value`)).rows[0].value;}
const past=new Date(Date.now()-2*60*60_000),future=new Date(Date.now()+60*60_000),longPast=new Date(Date.now()-100*24*60*60_000);
const workspace=randomUUID();
async function workspaceFixture(){await insert('workspaces',{id:workspace,plan:{maxConcurrent:1},settings:{retentionDays:30}});}
async function queue(table:string,extra:Record<string,unknown>={}){await insert(table,{id:randomUUID(),workspace_id:workspace,state:'queued',available_at:past,attempts:0,max_attempts:3,...(table==='jobs'?{waiting_for_schema:false}:{}),...(table==='split_suggestions'?{expires_at:future}:{}),...extra});}
async function integrationFixture(config:unknown={},kind='webhook',extra:Record<string,unknown>={}){
 const integration=randomUUID(),doc=randomUUID(),parser=randomUUID(),run=randomUUID(),approval=randomUUID();
 await workspaceFixture();
 await insert('documents',{id:doc,workspace_id:workspace,parser_id:parser,status:'needs_review',created_at:new Date()});
 await insert('integrations',{id:integration,workspace_id:workspace,parser_id:parser,enabled:true,kind,config,created_at:past,...extra});
 return {integration,doc,parser,run,approval};
}
async function approvalFixture(config:unknown={},kind='webhook'){
 const fixture=await integrationFixture(config,kind);
 await insert('extraction_runs',{id:fixture.run,workspace_id:workspace,document_id:fixture.doc});
 await insert('approvals',{id:fixture.approval,workspace_id:workspace,run_id:fixture.run,created_at:new Date()});
 return fixture;
}
async function failureFixture(phase:'processing'|'export',config:unknown={events:['document.extraction_failed','document.export_failed']},kind='webhook',extra:Record<string,unknown>={}){
 const fixture=await integrationFixture(config,kind),event=randomUUID(),operation=randomUUID();
 const details=phase==='export'?{format:'csv',runId:fixture.run,approvalId:fixture.approval}:{};
 await insert('document_events',{id:event,workspace_id:workspace,document_id:fixture.doc,phase,state:'failed',operation_id:operation,created_at:new Date(),details,...extra});
 return {...fixture,event,operation};
}

test('watchdog is invoker-only with a fixed search path and no public execute',async()=>{
 const {rows:[row]}=await client.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='worker_has_runnable_work'`,[schema]);
 assert.deepEqual(row,{prosecdef:false,provolatile:'s',proconfig:['search_path=pg_catalog'],public_execute:false});
 await clear();assert.equal(await runnable(),false);
});

test('all three extraction queues wake only eligible work and share one concurrency budget',async()=>{
 for(const table of ['jobs','schema_suggestions','split_suggestions']){
  await clear();await workspaceFixture();await queue(table);assert.equal(await runnable(),true,table);
  await clear();await workspaceFixture();await queue(table,{available_at:future});assert.equal(await runnable(),false,`${table} future`);
  await clear();await workspaceFixture();await queue(table,{attempts:3});assert.equal(await runnable(),false,`${table} exhausted`);
  for(const running of ['jobs','schema_suggestions','split_suggestions']){
   await clear();await workspaceFixture();await queue(table);await queue(running,{state:'processing',lease_until:future});assert.equal(await runnable(),false,`${table} blocked by ${running}`);
  }
 }
 await clear();await workspaceFixture();await queue('jobs',{waiting_for_schema:true});assert.equal(await runnable(),false);
 await clear();await workspaceFixture();await queue('split_suggestions',{expires_at:past});assert.equal(await runnable(),false);
 await clear();await workspaceFixture();await queue('split_suggestions',{write_until:future});assert.equal(await runnable(),false);
});

test('expired extraction leases wake even at the shared capacity or retry limit',async()=>{
 for(const table of ['jobs','schema_suggestions','split_suggestions']){await clear();await workspaceFixture();await queue(table,{state:'processing',attempts:3,lease_until:past});assert.equal(await runnable(),true,table);}
});

test('split-source expiry and cancellation cleanup honor both writer and processing fences',async()=>{
 for(const extra of [{state:'ready',source_storage_key:'owned/source',expires_at:past},{state:'cancelled',source_storage_key:'owned/source',expires_at:future},{state:'failed',staging_storage_key:'owned/stage',staging_expires_at:past}]){
  await clear();await queue('split_suggestions',extra);assert.equal(await runnable(),true);
  for(const fence of ['write_until','lease_until']){await clear();await queue('split_suggestions',{...extra,[fence]:future});assert.equal(await runnable(),false,fence);}
 }
});

test('account request queues alone wake and future mail waits until due or expiry',async()=>{
 for(const table of ['account_registration_requests','email_verification_requests','account_recovery_requests']){await clear();await insert(table,{id:randomUUID(),expires_at:future});assert.equal(await runnable(),true,table);}
 for(const table of ['account_email_outbox','invitation_email_outbox']){
  for(const row of [{state:'pending',available_at:past,expires_at:future},{state:'sending',lease_until:past,expires_at:future},{state:'pending',available_at:future,expires_at:past}]){await clear();await insert(table,row);assert.equal(await runnable(),true,table);}
  await clear();await insert(table,{state:'pending',available_at:future,expires_at:future});assert.equal(await runnable(),false);
  await clear();await insert(table,{state:'sending',lease_until:future,expires_at:future});assert.equal(await runnable(),false);
 }
});

test('credential/email cleanup wakes without requiring another intake request',async()=>{
 for(const table of ['account_recovery_tokens','email_verification_tokens','account_registration_limits','email_verification_limits','account_recovery_limits','invitation_email_limits']){await clear();await insert(table,{expires_at:past});assert.equal(await runnable(),true,table);await clear();await insert(table,{expires_at:future});assert.equal(await runnable(),false,table);}
 await clear();await insert('account_email_outbox',{state:'accepted',finished_at:longPast});assert.equal(await runnable(),true);
 await clear();await insert('account_security_events',{created_at:longPast});assert.equal(await runnable(),true);
 const invitation=randomUUID();await clear();await insert('invitation_email_outbox',{invitation_id:invitation,state:'accepted',finished_at:longPast,created_at:longPast});assert.equal(await runnable(),false,'latest invitation status is intentionally retained');
 await insert('invitation_email_outbox',{invitation_id:invitation,state:'accepted',finished_at:past,created_at:past});assert.equal(await runnable(),true,'older superseded mail may be cleaned');
});

test('provider retry hints preserve mode enforcement in the worker and skip future/exhausted rows',async()=>{
 for(const provider of ['resend','stripe']){
  await clear();await insert('provider_events',{provider,status:'retry',attempts:2,next_attempt_at:past});assert.equal(await runnable(),true,provider);
  await clear();await insert('provider_events',{provider,status:'retry',attempts:2,next_attempt_at:future});assert.equal(await runnable(),false);
  await clear();await insert('provider_events',{provider,status:'retry',attempts:5,next_attempt_at:past});assert.equal(await runnable(),false);
  await clear();await insert('provider_events',{provider,status:'processing',attempts:5,lease_until:past});assert.equal(await runnable(),true);
 }
});

test('object cleanup does not hot-loop already queued protected split intents',async()=>{
 const key=`${workspace}/${randomUUID()}`;
 await clear();await insert('intake_files',{workspace_id:workspace,storage_key:key,split_attempt_id:randomUUID(),lease_expires_at:past});assert.equal(await runnable(),true);
 await insert('file_deletions',{workspace_id:workspace,storage_key:key,status:'pending',available_at:future});assert.equal(await runnable(),false);
 await clear();await insert('direct_uploads',{state:'pending',cleanup_after:past,finalize_lease_until:future});assert.equal(await runnable(),false);
 await clear();await insert('direct_uploads',{state:'pending',cleanup_after:past,finalize_lease_until:past});assert.equal(await runnable(),true);
 await clear();await insert('file_deletions',{status:'pending',available_at:past});assert.equal(await runnable(),true);
});

test('existing delivery and retention predicates remain conditional',async()=>{
 const integration=randomUUID(),doc=randomUUID();
 await clear();await insert('integrations',{id:integration,enabled:false});await insert('webhook_deliveries',{integration_id:integration,status:'retry',attempts:0,next_attempt_at:past});assert.equal(await runnable(),false);
 await client.query(`UPDATE ${schema}.integrations SET enabled=true`);assert.equal(await runnable(),true);
 await clear();await workspaceFixture();await insert('documents',{id:doc,workspace_id:workspace,created_at:longPast});assert.equal(await runnable(),true);
 await queue('jobs',{document_id:doc,waiting_for_schema:true});assert.equal(await runnable(),false,'retention cannot delete a waiting-schema document');
});

test('approval wake respects webhook subscriptions while legacy webhooks and Sheets remain approval-only',async()=>{
 for(const [config,kind,expected] of [
  [{},'webhook',true],
  [{events:['document.approved']},'webhook',true],
  [{events:['document.extraction_failed']},'webhook',false],
  [{events:['document.export_failed']},'webhook',false],
  [{events:[]},'webhook',false],
  [{events:null},'webhook',false],
  [{events:'document.approved'},'webhook',false],
  [{},'google_sheets',true],
  [{events:['document.extraction_failed']},'google_sheets',true],
  [{events:['document.approved']},'unknown_kind',false],
 ] as const){
  await clear();const fixture=await approvalFixture(config,kind);assert.equal(await runnable(),expected,`${kind} ${JSON.stringify(config)}`);
  if(expected){await insert('webhook_deliveries',{integration_id:fixture.integration,event_key:`approval:${fixture.approval}`,status:'delivered',attempts:1});assert.equal(await runnable(),false,'the original approval key remains the dedupe identity');}
 }
});

test('failure wake requires an explicitly subscribed webhook and a usable immutable failure episode',async()=>{
 for(const phase of ['processing','export'] as const){
  const eventName=phase==='processing'?'document.extraction_failed':'document.export_failed';
  const otherEvent=phase==='processing'?'document.export_failed':'document.extraction_failed';
  for(const [config,kind,expected] of [
   [{events:[eventName]},'webhook',true],
   [{events:['document.approved',eventName]},'webhook',true],
   [{},'webhook',false],
   [{events:['document.approved']},'webhook',false],
   [{events:[otherEvent]},'webhook',false],
   [{events:[]},'webhook',false],
   [{events:null},'webhook',false],
   [{events:eventName},'webhook',false],
   [{events:[eventName]},'google_sheets',false],
  ] as const){await clear();await failureFixture(phase,config,kind);assert.equal(await runnable(),expected,`${phase} ${kind} ${JSON.stringify(config)}`);}
  for(const extra of [{state:'processing'},{state:'needs_review'},{operation_id:null},{phase:'unknown_phase'}]){
   await clear();await failureFixture(phase,{events:[eventName]},'webhook',extra);assert.equal(await runnable(),false,`${phase} ${JSON.stringify(extra)}`);
  }
 }
 for(const details of [{},{format:'pdf',runId:randomUUID(),approvalId:randomUUID()},{format:'csv',runId:'bad',approvalId:randomUUID()},{format:'xlsx',runId:randomUUID(),approvalId:null},{format:'json',runId:randomUUID()}]){
  await clear();await failureFixture('export',{events:['document.export_failed']},'webhook',{details});assert.equal(await runnable(),false,'incomplete historical export metadata cannot cause a wake loop');
 }
});

test('failure wake keeps workspace, parser, connection time and enabled boundaries',async()=>{
 for(const phase of ['processing','export'] as const){
  for(const change of [
   {sql:'UPDATE integrations SET enabled=false'},
   {sql:'UPDATE integrations SET workspace_id=$1',value:randomUUID()},
   {sql:'UPDATE integrations SET parser_id=$1',value:randomUUID()},
   {sql:'UPDATE integrations SET created_at=$1',value:future},
   {sql:'UPDATE document_events SET workspace_id=$1',value:randomUUID()},
   {sql:'DELETE FROM documents'},
  ]){
   await clear();await failureFixture(phase);assert.equal(await runnable(),true);
   await client.query(change.sql.replace(/(UPDATE|FROM) (integrations|documents|document_events)/,`$1 ${schema}.$2`),'value' in change?[change.value]:[]);
   assert.equal(await runnable(),false,`${phase} ${change.sql}`);
  }
  await clear();await failureFixture(phase);await client.query(`UPDATE ${schema}.integrations SET parser_id=NULL`);assert.equal(await runnable(),true,'workspace-wide webhook may receive this parser failure');
  await client.query(`UPDATE ${schema}.integrations SET created_at=(SELECT created_at FROM ${schema}.document_events LIMIT 1)`);assert.equal(await runnable(),true,'same timestamp is eligible like the worker enqueue predicate');
 }
});

test('queued failure identity prevents repeated wakes while delivery retry timing remains effective',async()=>{
 for(const phase of ['processing','export'] as const){
  await clear();const fixture=await failureFixture(phase);assert.equal(await runnable(),true,'a past failure still notifies after the document has returned to needs_review');
  await insert('webhook_deliveries',{integration_id:fixture.integration,event_key:`document-event:${fixture.event}`,status:'queued',attempts:0,next_attempt_at:future});
  assert.equal(await runnable(),false,'an already enqueued event does not bypass the delivery deadline');
  await client.query(`UPDATE ${schema}.webhook_deliveries SET next_attempt_at=$1`,[past]);assert.equal(await runnable(),true,'the due delivery, not the source event, wakes work');
  await client.query(`UPDATE ${schema}.webhook_deliveries SET status='delivered',attempts=1`);assert.equal(await runnable(),false);
  await client.query(`UPDATE ${schema}.webhook_deliveries SET status='failed',attempts=5`);assert.equal(await runnable(),false,'exhausted deliveries do not recreate the immutable event');
  const later=randomUUID();
  await client.query(`INSERT INTO ${schema}.document_events(id,workspace_id,document_id,phase,state,operation_id,created_at,details) SELECT $1,workspace_id,document_id,phase,state,operation_id,created_at,details FROM ${schema}.document_events WHERE id=$2`,[later,fixture.event]);
  assert.equal(await runnable(),true,'a new episode using the same operation ID has a new immutable event key');
  await insert('webhook_deliveries',{integration_id:fixture.integration,event_key:`document-event:${later}`,status:'delivered',attempts:1});assert.equal(await runnable(),false);
 }
});
