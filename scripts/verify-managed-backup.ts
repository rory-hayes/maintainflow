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
   if(i===0){const optional=workspace+'/'+randomUUID(),absent=workspace+'/'+randomUUID(),omitted=workspace+'/'+randomUUID();objects.set(optional,Buffer.from('Retained deletion retry'));objects.set(omitted,Buffer.from('Unreferenced physical object'));await c.query('INSERT INTO folio.file_deletions(workspace_id,storage_key) VALUES($1,$2),($1,$3)',[workspace,optional,absent]);}
  }
  await c.query("SELECT setval('folio.document_events_sequence_seq',99,false)");
 });
 for(const key of objects.keys())records.set(key,{id:randomUUID(),updated_at:'2026-09-20T00:00:00.000Z'});
 await fs.mkdir(source.storageDir,{mode:0o700});await fs.writeFile(source.integrationKeyFile,randomBytes(32),{mode:0o600});await fs.writeFile(source.sourceStorage!.serviceRoleKeyFile,'owned-fixture-key',{mode:0o600});await json('source.json',source);await json('target.json',target);await json('bad-target.json',badTarget);
 observer=connection('source','platform_reader');await observer.connect();transport();checkpoint('OwnedSocketOnlyPostgres17CurrentMigrationsTwoTenantsAndPlatformObserver');
 await assert.rejects(openSourceDatabase({...source,databaseProfile:undefined},migrations),/Stop all other clients/);checkpoint('DedicatedModeStillRejectsUnrelatedClients');
 await assert.rejects(openSourceDatabase({...source,database:{...source.database,user:'platform_reader'}},migrations));checkpoint('ManagedModeDoesNotAcceptARestrictedRuntimeOrReadOnlyIdentity');
 const sourceSnapshot=await openSourceDatabase(source,migrations);assert.equal(sourceSnapshot.manifest.tables.find(t=>t.name==='documents')?.rows,2);assert.ok(sourceSnapshot.manifest.watchdogSha256);assert.equal(sourceSnapshot.objects.length,4);await sourceSnapshot.close();checkpoint('ManagedSnapshotCoversBothTenantsJournalSequenceAndAllCurrentReferenceQueries');
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
 const activated=await runBackup(['activate','--config',path.join(run,'target.json'),'--input',artifact,'--identity-file',identity,'--allow-outbound']);assert.equal(activated.status,'restore_activated');checkpoint('ActivationRechecksFullDatabaseAndObjectsWithoutStartingServices');
 await sql('target',async c=>{assert.equal((await c.query('SELECT count(*)::int n FROM folio.documents')).rows[0].n,2);assert.deepEqual((await c.query('SELECT last_value::text,is_called FROM folio.document_events_sequence_seq')).rows[0],{last_value:'99',is_called:false});const r=(await c.query("SELECT has_function_privilege('backup_admin','folio.worker_has_runnable_work()','EXECUTE') admin,has_function_privilege('backup_app','folio.worker_has_runnable_work()','EXECUTE') app")).rows[0];assert.deepEqual(r,{admin:false,app:false});assert.equal((await c.query("SELECT count(*)::int n FROM pg_namespace WHERE nspname IN ('cron','vault','platform')")).rows[0].n,0);});
 const tenant=connection('target','backup_app');await tenant.connect();try{assert.equal((await tenant.query('SELECT count(*)::int n FROM folio.documents')).rows[0].n,0);const workspace=[...objects.keys()][0].split('/')[0];await tenant.query("SELECT set_config('app.workspace_id',$1,false)",[workspace]);assert.equal((await tenant.query('SELECT count(*)::int n FROM folio.documents')).rows[0].n,1);await assert.rejects(tenant.query('SELECT * FROM folio.schema_migrations'),(error:any)=>error.code==='42501');}finally{await tenant.end();}checkpoint('RestoredTenantIsolationJournalDenialSequenceAndNoSchedulerActivation');
 const baseSnapshot=await openSourceDatabase({...source,sourceStorage:undefined},migrations);await baseSnapshot.close();
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
