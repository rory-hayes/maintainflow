/** Owned PostgreSQL fixture + controlled Supabase transport only. Never reads application credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {runBackup} from './backup.js';
import {readMigrations,buildMigrationSql} from './migration-sql.js';
import {backupWatchdog} from './backup/watchdog.js';
import {openSourceDatabase} from './backup/database.js';
import {openArchive} from './backup/archive.js';
import {sha256} from './backup/files.js';
import type {BackupConfig} from './backup/types.js';
import {canonicalSignupPolicy} from '../shared/signup-terms.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),exec=promisify(execFile),args=process.argv.slice(2);
assert.deepEqual(args,['--execute'],'Pass --execute to create and clean an owned socket-only PostgreSQL17 fixture. No hosted credentials are read.');
const id=randomUUID(),base=path.join(root,'.local/managed-backup'),run=path.join(base,id),cluster=path.join(run,'cluster'),socket=path.join(await fs.realpath(os.tmpdir()),'fmb-'+id.slice(0,8));
const port=57000+Math.floor(Math.random()*7000),bin=process.env.FOLIO_BACKUP_QA_PG_BIN??'/opt/homebrew/opt/postgresql@17/bin';
const environment={PATH:process.env.PATH,LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'},originalFetch=globalThis.fetch;
const checks:string[]=[],receipt:Record<string,unknown>={runId:id,startedAt:new Date().toISOString(),node:process.versions.node,hostedCalls:0,providerCalls:0,sharedDevelopmentDatabaseTouched:false,port,checks};
let running=false,observer:pg.Client|undefined;
const connection=(db:string,user='backup_owner')=>new pg.Client({host:socket,port,database:db,user,connectionTimeoutMillis:5000});
async function sql<T>(db:string,fn:(client:pg.Client)=>Promise<T>){assert.ok(['postgres','source','target','bad_target'].includes(db));const c=connection(db);await c.connect();try{const actual=(await c.query("SELECT current_setting('unix_socket_directories') socket,current_setting('port')::int port,current_setting('server_version_num')::int version,inet_server_addr() address")).rows[0];assert.equal(actual.socket,socket);assert.equal(actual.port,port);assert.equal(actual.address,null);assert.ok(actual.version>=170000&&actual.version<180000);return await fn(c);}finally{await c.end();}}
async function command(name:string,argv:string[]){const result=await exec(path.join(bin,name),argv,{env:environment,timeout:90000,maxBuffer:1024*1024});await fs.writeFile(path.join(run,name+'-'+randomUUID()+'.log'),result.stdout+result.stderr,{mode:0o600});}
async function json(name:string,value:unknown){await fs.writeFile(path.join(run,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});}
const checkpoint=(name:string)=>{checks.push(name);console.log('PASS '+name);};
const cfg=(database:string,managed=false):BackupConfig=>({version:1,database:{host:socket,port,database,user:'backup_owner'},schema:'folio',adminRole:'backup_admin',appRole:'backup_app',storageDir:path.join(run,database+'-files'),integrationKeyFile:path.join(run,database+'-key'),...(managed?{databaseProfile:'managed-source',sourceStorage:{kind:'supabase',url:'https://owned-managed-fixture.supabase.co',serviceRoleKeyFile:path.join(run,'storage-credential')}}:{})});
const source=cfg('source',true),target=cfg('target'),badTarget=cfg('bad_target'),migrations=path.join(root,'migrations');
const objects=new Map<string,Buffer>(),records=new Map<string,{id:string;updated_at:string}>();let requests=0;
const termsSnapshot=(database:string)=>sql(database,async c=>({
 contracts:(await c.query('SELECT to_jsonb(c) body FROM folio.checkout_contracts c ORDER BY id')).rows,
 receipts:(await c.query('SELECT to_jsonb(r) body FROM folio.checkout_contract_receipts r ORDER BY contract_id')).rows,
 signup:(await c.query('SELECT to_jsonb(s) body FROM folio.signup_terms_acceptances s ORDER BY user_id')).rows,
}));
function transport(){globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));assert.equal(url.origin,source.sourceStorage!.url);assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer owned-fixture-key');requests++;
 if(url.pathname==='/storage/v1/bucket/folio-originals'){assert.equal(init.method,'GET');return Response.json({id:'folio-originals',public:false,file_size_limit:10485760});}
 if(url.pathname==='/storage/v1/object/list/folio-originals'){assert.equal(init.method,'POST');const {prefix,offset,limit}=JSON.parse(String(init.body));const items=prefix?[...objects].filter(([k])=>k.startsWith(prefix+'/')).map(([key,bytes])=>({name:key.split('/')[1],...records.get(key),metadata:{size:bytes.length}})):[...new Set([...objects.keys()].map(k=>k.split('/')[0]))].map(name=>({name,id:null}));return Response.json(items.slice(offset,offset+limit));}
 assert.equal(init.method,'GET');assert.ok(url.pathname.startsWith('/storage/v1/object/authenticated/folio-originals/'));const key=url.pathname.split('/folio-originals/')[1],bytes=objects.get(key);assert.ok(bytes);return new Response(new Uint8Array(bytes));
};}
try{
 process.umask(0o077);await fs.mkdir(run,{recursive:true,mode:0o700});await fs.mkdir(socket,{mode:0o700});
 await command('initdb',['-D',cluster,'--username=backup_owner','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C']);
 await command('pg_ctl',['-D',cluster,'-l',path.join(run,'postgres.log'),'-o',`-k ${socket} -p ${port} -c listen_addresses=''`,'-w','start']);running=true;
 await sql('postgres',async c=>{for(const name of ['backup_admin','backup_app','platform_reader'])await c.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);await c.query('CREATE ROLE platform_owner NOLOGIN');for(const name of ['source','target','bad_target'])await c.query(`CREATE DATABASE ${name}`);});
 await sql('source',async c=>{
  await c.query('CREATE SCHEMA folio');await c.query(buildMigrationSql(await readMigrations(migrations),{schema:'folio',adminRole:'backup_admin',appRole:'backup_app'}));await c.query((await backupWatchdog('folio','backup_admin','backup_app')).sql);
  await c.query('CREATE SCHEMA platform AUTHORIZATION platform_owner; CREATE TABLE platform.unrelated(value text); ALTER DEFAULT PRIVILEGES FOR ROLE platform_owner GRANT SELECT ON TABLES TO platform_reader');
  for(let i=0;i<2;i++){const workspace=randomUUID(),parser=randomUUID(),key=workspace+'/'+randomUUID(),bytes=Buffer.from('Owned managed backup fixture '+i);objects.set(key,bytes);await c.query('INSERT INTO folio.workspaces(id,name,slug) VALUES($1,$2,$3)',[workspace,'Owned '+i,'owned-'+id+'-'+i]);await c.query('INSERT INTO folio.parsers(id,workspace_id,name) VALUES($1,$2,$3)',[parser,workspace,'Rules fixture']);await c.query("INSERT INTO folio.documents(workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,page_count) VALUES($1,$2,'fixture.txt','text/plain',$3,$4,$5,1)",[workspace,parser,bytes.length,sha256(bytes),key]);
   // Clearly synthetic, populated evidence proves these new tables survive a
   // real encrypted capture/restore, including their immutable history.
   const contract=randomUUID(),session='cs_owned_restore_'+i,text='SYNTHETIC RESTORE FIXTURE — not customer terms.\nExact retained policy bytes '+i;
   const policy={version:'synthetic-restore-v1',language:'en-IE',title:'Synthetic restore terms',text,url:'https://example.test/synthetic-restore-v1',agreementText:'Synthetic restore acceptance.',sha256:sha256(text)};
   const offer={planName:'Standard',currency:'eur',amountMinor:1900,interval:'month',pagesPerCalendarMonth:300,aiSuggestionsPerCalendarMonth:5};
   const params={customer:'cus_owned_restore_'+i,mode:'subscription',line_items:[{price:'price_owned_restore',quantity:1}],success_url:'https://example.test/success',cancel_url:'https://example.test/cancel',client_reference_id:workspace,consent_collection:{terms_of_service:'required'},custom_text:{terms_of_service_acceptance:{message:`${policy.agreementText} [${policy.title}](${policy.url})`}},metadata:{folio_contract:contract,folio_contract_sha256:policy.sha256}};
   const canonical=JSON.stringify(params,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
   await c.query("INSERT INTO folio.checkout_contracts(id,workspace_id,billing_mode,customer_id,plan_id,policy,offer,create_params,params_sha256,session_id) VALUES($1,$2,'test',$3,'standard',$4,$5,$6,$7,$8)",[contract,workspace,params.customer,JSON.stringify(policy),JSON.stringify(offer),JSON.stringify(params),sha256(canonical),session]);
   await c.query("INSERT INTO folio.checkout_contract_receipts(contract_id,workspace_id,session_id,event_id,state,provider_event_created_at) VALUES($1,$2,$3,$4,$5,'2026-09-20T00:00:00Z')",[contract,workspace,session,'evt_owned_restore_'+i,i===0?'accepted':'not_recorded']);
   const user=randomUUID();
   await c.query('INSERT INTO folio.users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[user,`synthetic-restore-${i}@example.test`,'Synthetic terms restore user','synthetic-unusable-password-hash']);
   const signupInput={version:'synthetic-signup-restore-v1',language:'en-IE',title:'Synthetic signup terms',text:'SYNTHETIC RESTORE FIXTURE ONLY\nExact signup policy bytes '+i,url:'https://example.test/synthetic-signup-restore-v1',agreementText:'I agree to these synthetic test terms.'};
   await c.query("INSERT INTO folio.signup_terms_acceptances(user_id,policy,accepted_at) VALUES($1,$2,'2026-09-20T00:00:00Z')",[user,JSON.stringify({...signupInput,sha256:sha256(canonicalSignupPolicy(signupInput))})]);
   if(i===0){const optional=workspace+'/'+randomUUID(),absent=workspace+'/'+randomUUID(),omitted=workspace+'/'+randomUUID();objects.set(optional,Buffer.from('Retained deletion retry'));objects.set(omitted,Buffer.from('Unreferenced physical object'));await c.query('INSERT INTO folio.file_deletions(workspace_id,storage_key) VALUES($1,$2),($1,$3)',[workspace,optional,absent]);}
  }
  await c.query("SELECT setval('folio.document_events_sequence_seq',99,false)");
 });
 const originalTerms=await termsSnapshot('source');assert.equal(originalTerms.contracts.length,2);assert.equal(originalTerms.receipts.length,2);
 assert.equal(originalTerms.signup.length,2);
 for(const key of objects.keys())records.set(key,{id:randomUUID(),updated_at:'2026-09-20T00:00:00.000Z'});
 await fs.mkdir(source.storageDir,{mode:0o700});await fs.writeFile(source.integrationKeyFile,randomBytes(32),{mode:0o600});await fs.writeFile(source.sourceStorage!.serviceRoleKeyFile,'owned-fixture-key',{mode:0o600});await json('source.json',source);await json('target.json',target);await json('bad-target.json',badTarget);
 observer=connection('source','platform_reader');await observer.connect();transport();checkpoint('OwnedSocketOnlyPostgres17CurrentMigrationsTwoTenantsAndPlatformObserver');
 await assert.rejects(openSourceDatabase({...source,databaseProfile:undefined},migrations),/Stop all other clients/);checkpoint('DedicatedModeStillRejectsUnrelatedClients');
 await assert.rejects(openSourceDatabase({...source,database:{...source.database,user:'platform_reader'}},migrations));checkpoint('ManagedModeDoesNotAcceptARestrictedRuntimeOrReadOnlyIdentity');
 const sourceSnapshot=await openSourceDatabase(source,migrations);assert.equal(sourceSnapshot.manifest.tables.find(t=>t.name==='documents')?.rows,2);assert.ok(sourceSnapshot.manifest.watchdogSha256);assert.equal(sourceSnapshot.objects.length,4);await sourceSnapshot.close();checkpoint('ManagedSnapshotCoversBothTenantsJournalSequenceAndAllCurrentReferenceQueries');
 await sql('source',c=>c.query('ALTER TABLE folio.checkout_contracts DISABLE TRIGGER checkout_contract_immutable'));
 await assert.rejects(openSourceDatabase(source,migrations),/triggers differ/);
 await sql('source',c=>c.query('ALTER TABLE folio.checkout_contracts ENABLE TRIGGER checkout_contract_immutable'));
 await sql('source',c=>c.query('CREATE TRIGGER unreviewed_terms_trigger BEFORE UPDATE ON folio.checkout_contracts FOR EACH ROW EXECUTE FUNCTION folio.preserve_checkout_contract()'));
 await assert.rejects(openSourceDatabase(source,migrations),/triggers differ/);
 await sql('source',c=>c.query('DROP TRIGGER unreviewed_terms_trigger ON folio.checkout_contracts'));
 checkpoint('DisabledOrUnreviewedCheckoutTermsTriggersRefused');
 await sql('source',c=>c.query('ALTER TABLE folio.signup_terms_acceptances DISABLE TRIGGER signup_terms_acceptance_immutable'));
 await assert.rejects(openSourceDatabase(source,migrations),/triggers differ/);
 await sql('source',c=>c.query('ALTER TABLE folio.signup_terms_acceptances ENABLE TRIGGER signup_terms_acceptance_immutable'));
 checkpoint('DisabledSignupTermsImmutabilityRefused');
 await sql('source',c=>c.query('GRANT EXECUTE ON FUNCTION folio.worker_has_runnable_work() TO backup_admin'));
 await assert.rejects(openSourceDatabase(source,migrations),/only by its owner/);await sql('source',c=>c.query('REVOKE EXECUTE ON FUNCTION folio.worker_has_runnable_work() FROM backup_admin'));checkpoint('WidenedWatchdogPermissionRefused');
 await sql('source',c=>c.query("INSERT INTO folio.intake_files(id,workspace_id,storage_key) SELECT gen_random_uuid(),id,id::text||'/'||gen_random_uuid()::text FROM folio.workspaces LIMIT 1"));
 await assert.rejects(openSourceDatabase(source,migrations),/Drain all in-flight/);await sql('source',c=>c.query('DELETE FROM folio.intake_files'));checkpoint('OutstandingWriterLeaseRefused');
 const identity=path.join(run,'identity'),recipient=path.join(run,'recipient'),artifact=path.join(run,'backup.age');
 await runBackup(['keygen','--identity-file',identity,'--recipient-file',recipient]);
 const captured=await runBackup(['create','--config',path.join(run,'source.json'),'--recipient-file',recipient,'--output',artifact,'--quiesced']);assert.equal(captured.status,'backup_created');checkpoint('ActualCliEncryptedManagedCaptureUsesReadOnlyControlledBucketTransport');
 await observer.end();observer=undefined;
 const unpack=path.join(run,'unpack');await fs.mkdir(unpack,{mode:0o700});const authenticated=await openArchive(artifact,(await fs.readFile(identity,'utf8')).trim(),unpack),manifest=authenticated.manifest;
 assert.equal(manifest.capture,'quiesced-supabase');assert.equal(manifest.database.migrations.length,(await readMigrations(migrations)).length);assert.equal(manifest.objects.filter(o=>o.present).length,3);assert.equal(manifest.objects.filter(o=>!o.present).length,1);assert.equal(manifest.omittedObjects.length,1);assert.ok(manifest.database.watchdogSha256);receipt.applicationTables=manifest.database.tables.length;receipt.migrations=manifest.database.migrations.length;receipt.ciphertextSha256=authenticated.ciphertextSha256;checkpoint('AuthenticatedInventoryBindsRequiredOptionalAbsentAndOmittedObjects');
 const restored=await runBackup(['restore','--config',path.join(run,'target.json'),'--input',artifact,'--identity-file',identity]);assert.equal(restored.status,'restored_inactive');checkpoint('ExactBinaryDataAndOwnersAclRlsConstraintsWatchdogRestoredInTransaction');
 assert.deepEqual(await termsSnapshot('target'),originalTerms);
 await sql('target',async c=>{
  await assert.rejects(c.query("UPDATE folio.checkout_contracts SET policy=policy||'{\"text\":\"changed\"}'"),/immutable/);
  await assert.rejects(c.query("UPDATE folio.checkout_contract_receipts SET state='accepted'"),/immutable/);
  await assert.rejects(c.query("UPDATE folio.signup_terms_acceptances SET accepted_at=clock_timestamp()"),/immutable/);
 });
 checkpoint('CheckoutTermsBytesBindingsReceiptsAndImmutabilitySurviveEncryptedRestore');
 checkpoint('SignupPolicyBytesDigestsAcceptanceTimesAndImmutabilitySurviveEncryptedRestore');
 const activated=await runBackup(['activate','--config',path.join(run,'target.json'),'--input',artifact,'--identity-file',identity,'--allow-outbound']);assert.equal(activated.status,'restore_activated');checkpoint('ActivationRechecksFullDatabaseAndObjectsWithoutStartingServices');
 await sql('target',async c=>{assert.equal((await c.query('SELECT count(*)::int n FROM folio.documents')).rows[0].n,2);assert.deepEqual((await c.query('SELECT last_value::text,is_called FROM folio.document_events_sequence_seq')).rows[0],{last_value:'99',is_called:false});const r=(await c.query("SELECT has_function_privilege('backup_admin','folio.worker_has_runnable_work()','EXECUTE') admin,has_function_privilege('backup_app','folio.worker_has_runnable_work()','EXECUTE') app")).rows[0];assert.deepEqual(r,{admin:false,app:false});assert.equal((await c.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname IN ('cron','vault','platform')")).rows[0].n,0);});
 const tenant=connection('target','backup_app');await tenant.connect();try{assert.equal((await tenant.query('SELECT count(*)::int n FROM folio.documents')).rows[0].n,0);for(const table of ['checkout_contracts','checkout_contract_receipts'])assert.equal((await tenant.query(`SELECT count(*)::int n FROM folio.${table}`)).rows[0].n,0);const workspace=[...objects.keys()][0].split('/')[0];await tenant.query("SELECT set_config('app.workspace_id',$1,false)",[workspace]);assert.equal((await tenant.query('SELECT count(*)::int n FROM folio.documents')).rows[0].n,1);for(const table of ['checkout_contracts','checkout_contract_receipts']){const rows=(await tenant.query(`SELECT workspace_id FROM folio.${table}`)).rows;assert.deepEqual(rows,[{workspace_id:workspace}]);assert.equal((await tenant.query(`DELETE FROM folio.${table}`)).rowCount,0);}await assert.rejects(tenant.query('SELECT * FROM folio.schema_migrations'),(error:any)=>error.code==='42501');}finally{await tenant.end();}checkpoint('RestoredTenantIsolationJournalDenialSequenceAndNoSchedulerActivation');
 const baseSnapshot=await openSourceDatabase({...source,sourceStorage:undefined},migrations);await baseSnapshot.close();
 const accountReader=connection('target','backup_app');await accountReader.connect();
 try{
  assert.equal((await accountReader.query('SELECT count(*)::int n FROM folio.signup_terms_acceptances')).rows[0].n,0);
  // A workspace scope cannot grant access to a personal signup record.
  await accountReader.query("SELECT set_config('app.workspace_id',$1,false)",[[...objects.keys()][0].split('/')[0]]);
  assert.equal((await accountReader.query('SELECT count(*)::int n FROM folio.signup_terms_acceptances')).rows[0].n,0);
  const own=originalTerms.signup[0].body;
  await accountReader.query("SELECT set_config('app.user_id',$1,false)",[own.user_id]);
  assert.deepEqual((await accountReader.query('SELECT to_jsonb(s) body FROM folio.signup_terms_acceptances s')).rows,[{body:own}]);
  await assert.rejects(accountReader.query('DELETE FROM folio.signup_terms_acceptances'),(error:any)=>error.code==='42501');
  await assert.rejects(accountReader.query("UPDATE folio.signup_terms_acceptances SET accepted_at=clock_timestamp()"),(error:any)=>error.code==='42501');
 }finally{await accountReader.end();}
 checkpoint('RestoredSignupEvidenceIsSelfOnlyReadOnlyAndIndependentOfWorkspace');
 await sql('source',c=>c.query('GRANT SELECT ON folio.documents TO PUBLIC'));
 const altered=path.join(run,'altered.age');await runBackup(['create','--config',path.join(run,'source.json'),'--recipient-file',recipient,'--output',altered,'--quiesced']);
 await assert.rejects(runBackup(['restore','--config',path.join(run,'bad-target.json'),'--input',altered,'--identity-file',identity]),/permissions, constraints or definitions differ/);
 await sql('bad_target',async c=>assert.equal((await c.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='folio'")).rows[0].n,0));assert.ok(await fs.stat(path.join(badTarget.storageDir,'.folio-restore-pending.json')));checkpoint('ArbitrarySourceAclDriftCannotRestoreAndRollbackLeavesDestinationInactive');
 receipt.result='passed';receipt.controlledStorageRequests=requests;
}catch(error){receipt.result='failed';receipt.failure=error instanceof Error?error.message:'Unknown controlled failure';throw error;}
finally{
 globalThis.fetch=originalFetch;await observer?.end().catch(()=>{});
 try{if(running){await command('pg_ctl',['-D',cluster,'-m','immediate','-w','stop']);running=false;}}finally{
  receipt.finishedAt=new Date().toISOString();receipt.isolatedClusterStopped=!running;
  if(!running){for(const name of ['cluster','source-files','target-files','bad_target-files','bad_target-key','target-key','source-key','storage-credential','identity','recipient','backup.age','altered.age','unpack','source.json','target.json','bad-target.json'])await fs.rm(path.join(run,name),{recursive:true,force:true});await fs.rm(socket,{recursive:true,force:true});receipt.ownedPlaintextKeysAndObjectsRemoved=true;}
  await json('receipt.json',receipt);console.log('RECEIPT '+path.join(run,'receipt.json'));
 }
}
