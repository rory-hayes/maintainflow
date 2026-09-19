/** Independent, local-only backup acceptance. Never connects to the normal development database. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import pg from 'pg';
import type {BackupConfig} from './backup/types.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pgBin=process.env.FOLIO_BACKUP_QA_PG_BIN??'/opt/homebrew/opt/postgresql@17/bin';
const base=path.join(root,'.local/backup-restore-2026-09-20');
const args=process.argv.slice(2),resume=args.indexOf('--resume');
const id=resume<0?randomUUID():path.basename(path.resolve(args[resume+1]!));
assert.match(id,/^[a-f0-9-]{36}$/);
const run=path.join(base,'runs',id),socket=path.join(await fs.realpath('/tmp'),`fbr-${id.slice(0,8)}`);
const port=55439,cluster=path.join(run,'cluster'),privateCwd=path.join(run,'empty-cwd');
const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'};
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const quote=(s:string)=>{assert.match(s,/^[a-z][a-z0-9_]*$/);return `"${s}"`;};
process.umask(0o077);
let running=resume>=0;
let receipt:any={runId:id,startedAt:new Date().toISOString(),controlledOnly:true,realProviderCalls:0,checks:{},failures:[],cluster:{socket,port,source:'backup_source',target:'backup_target',schema:'folio'},node:process.versions.node};
async function write(name:string,data:unknown){await fs.writeFile(path.join(run,name),JSON.stringify(data,null,2)+'\n',{mode:0o600});}
async function command(binary:string,argv:string[],log:string,options:{allowFailure?:boolean;env?:NodeJS.ProcessEnv}={}){
 const chunks:Buffer[]=[];let size=0,timedOut=false;
 const code=await new Promise<number>((resolve,reject)=>{
  const child=spawn(binary,argv,{cwd:privateCwd,env:{...environment,...options.env},stdio:['ignore','pipe','pipe']});
  let force:ReturnType<typeof setTimeout>|undefined;
  const deadline=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');force=setTimeout(()=>child.kill('SIGKILL'),1500);},120_000);
  const clear=()=>{clearTimeout(deadline);if(force)clearTimeout(force);};
  const collect=(value:Buffer)=>{size+=value.length;if(size<4*1024*1024)chunks.push(value);};
  child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',error=>{clear();reject(error);});child.once('close',code=>{clear();resolve(code??1);});
 });
 await fs.writeFile(path.join(run,log),Buffer.concat(chunks),{mode:0o600});
 assert.equal(timedOut,false,`Controlled subprocess exceeded its 120-second deadline; inspect private ${log}`);
 if(!options.allowFailure)assert.equal(code,0,`Controlled command failed; inspect private ${log}`);
 return {code,output:Buffer.concat(chunks).toString()};
}
const connect=(database:string,user='backup_owner')=>new pg.Client({host:socket,port,database,user});
async function guarded<T>(database:string,fn:(client:pg.Client)=>Promise<T>){
 assert.ok(['postgres','backup_source','backup_target','backend_source','backend_target','backup_reject'].includes(database)||/^backup_reject_(malformed|truncated|wrong_key|missing_required|missing_object|optional_object)$/.test(database));
 const c=connect(database);await c.connect();
 try{const r=(await c.query("select current_database() db,current_setting('unix_socket_directories') socket,current_setting('port')::int port,inet_server_addr() address,current_setting('server_version_num')::int version")).rows[0];assert.equal(r.db,database);assert.equal(r.socket,socket);assert.equal(r.port,port);assert.equal(r.address,null);assert.ok(r.version>=170000&&r.version<180000);return await fn(c);}finally{await c.end();}
}
async function snapshot(database:string){return guarded(database,async c=>{
 const tables=(await c.query("select tablename from pg_tables where schemaname='folio' order by tablename")).rows.map(r=>r.tablename);
 const result:Record<string,{rows:number;sha256:string}>={};
 for(const name of tables){const rows=(await c.query(`select to_jsonb(t)::text body from folio.${quote(name)} t order by to_jsonb(t)::text`)).rows.map(r=>r.body);result[name]={rows:rows.length,sha256:hash(JSON.stringify(rows))};}
 const sequences:Record<string,unknown>={};for(const row of(await c.query("select sequencename from pg_sequences where schemaname='folio' order by sequencename")).rows)sequences[row.sequencename]=(await c.query(`select last_value::text,is_called from folio.${quote(row.sequencename)}`)).rows[0];
 return {tables:result,sequences};
});}
async function storageSnapshot(directory:string,prefix=''):Promise<Record<string,string>>{
 const result:Record<string,string>={};
 for(const entry of(await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const relative=path.join(prefix,entry.name),absolute=path.join(directory,entry.name);assert.equal(entry.isSymbolicLink(),false);if(entry.isDirectory())Object.assign(result,await storageSnapshot(absolute,relative));else{assert.ok(entry.isFile());result[relative]=hash(await fs.readFile(absolute));}}
 return result;
}
async function checkpoint(name:string){receipt.checks[name]=true;await write('progress.json',receipt);console.log('PASS '+name);}
async function fingerprint(){
 const names=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(n=>/^(server|shared|src|tests|migrations|scripts|\.github)\//.test(n)||['package.json','package-lock.json','tsconfig.json','vite.config.ts','vercel.json','index.html'].includes(n));
 const files:Record<string,string>={};for(const name of [...new Set(names)].sort())if((await fs.stat(path.join(root,name)).catch(()=>undefined))?.isFile())files[name]=hash(await fs.readFile(path.join(root,name)));
 return{count:Object.keys(files).length,fingerprint:hash(JSON.stringify(files)),files};
}
async function runtime(phase:string,config:string){return command(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'scripts/backup/acceptance-runtime.ts'),phase,config,run],`runtime-${phase}.log`);}
function cfg(database:string,storage:string,key:string):BackupConfig{return{version:1,database:{host:socket,port,database,user:'backup_owner'},schema:'folio',adminRole:'backup_admin',appRole:'backup_app',storageDir:path.join(run,storage),integrationKeyFile:path.join(run,key)};}
const sourceConfig=path.join(run,'source.json'),targetConfig=path.join(run,'target.json');
const cli=(name:string,rest:string[],allowFailure=false)=>command(process.execPath,['--import',path.join(root,'node_modules/tsx/dist/loader.mjs'),path.join(root,'scripts/backup.ts'),...rest],`cli-${name}.log`,{allowFailure});

try{
 if(resume<0){
  await fs.mkdir(privateCwd,{recursive:true,mode:0o700});await fs.mkdir(socket,{mode:0o700});
  await command(path.join(pgBin,'initdb'),['-D',cluster,'--username=backup_owner','--auth-local=trust','--auth-host=reject','--encoding=UTF8','--locale=C'],'initdb.log');
  await command(path.join(pgBin,'pg_ctl'),['-D',cluster,'-l',path.join(run,'postgres.log'),'-o',`-k ${socket} -p ${port} -c listen_addresses=''`,'-w','start'],'pg-start.log');running=true;
  await guarded('postgres',async c=>{for(const name of ['backup_admin','backup_app'])await c.query(`CREATE ROLE ${quote(name)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);for(const name of ['backup_source','backup_target','backend_source','backend_target','backup_reject'])await c.query(`CREATE DATABASE ${quote(name)} OWNER backup_owner`);});
  await fs.writeFile(path.join(run,'source-key'),randomBytes(32),{mode:0o600});
  await write('source.json',cfg('backup_source','source-files','source-key'));await write('target.json',cfg('backup_target','target-files','target-key'));await write('reject.json',cfg('backup_reject','reject-files','reject-key'));
  await write('backend-source.json',cfg('backend_source','backend-source-files','backend-source-key'));await write('backend-target.json',cfg('backend_target','backend-target-files','backend-target-key'));
  await write('cluster-identity.json',{runId:id,run,socket,port,owner:'backup_owner',adminRole:'backup_admin',appRole:'backup_app',sourceConfig,targetConfig,backendSourceConfig:path.join(run,'backend-source.json'),backendTargetConfig:path.join(run,'backend-target.json'),normalDevelopmentDatabaseTouched:false});
  await checkpoint('NewIsolatedPostgres17ClusterRestrictedRolesAndDistinctDatabases');
  await runtime('seed',sourceConfig);
  receipt.sourceSnapshot=await snapshot('backup_source');await checkpoint('SyntheticSourceFixtureAndEveryTableSnapshotAfterRuntimeShutdown');
  await write('prepared.json',receipt);console.log('PREPARED '+run);
  if(args.includes('--prepare-only')){running=false;process.exitCode=0;}
 }
 if(!args.includes('--prepare-only')){
  if(resume>=0)receipt=JSON.parse(await fs.readFile(path.join(run,'prepared.json'),'utf8'));
  assert.deepEqual(JSON.parse(await fs.readFile(sourceConfig,'utf8')),cfg('backup_source','source-files','source-key'));
  assert.deepEqual(JSON.parse(await fs.readFile(targetConfig,'utf8')),cfg('backup_target','target-files','target-key'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(run,'reject.json'),'utf8')),cfg('backup_reject','reject-files','reject-key'));
  if(args.includes('--retry')){
   assert.ok(resume>=0,'Retry requires the exact owned prepared run');
   const attempts=path.join(run,'attempts',new Date().toISOString().replaceAll(':','-'));await fs.mkdir(attempts,{recursive:true,mode:0o700});
   for(const name of await fs.readdir(run))if(/^(?:cli-.*\.log|runtime-(?:blocked|verify)\.log|runtime-(?:blocked|verification)\.json|results\.json|progress\.json|.*\.age|.*\.agekey)$/.test(name))await fs.rename(path.join(run,name),path.join(attempts,name));
   await guarded('postgres',async c=>{for(const database of ['backup_target','backup_reject']){assert.equal((await c.query('select count(*)::int n from pg_stat_activity where datname=$1',[database])).rows[0].n,0);await c.query(`DROP DATABASE ${quote(database)}`);await c.query(`CREATE DATABASE ${quote(database)} OWNER backup_owner`);}});
   for(const name of ['target-files','target-key','reject-files','reject-key'])await fs.rm(path.join(run,name),{recursive:true,force:true});
  }
  receipt.acceptanceStartedAt=new Date().toISOString();receipt.sourceBefore=await fingerprint();
  const identity=path.join(run,'identity.agekey'),recipient=path.join(run,'recipient.age'),artifact=path.join(run,'folio-backup.age');
  await cli('keygen',['keygen','--identity-file',identity,'--recipient-file',recipient]);
  await cli('create',['create','--config',sourceConfig,'--recipient-file',recipient,'--output',artifact,'--quiesced']);
  await cli('inspect',['inspect','--input',artifact,'--identity-file',identity]);
  const age=await import('age-encryption'),d=new age.Decrypter();d.addIdentity((await fs.readFile(identity,'utf8')).trim());
  const encryptedBytes=await fs.readFile(artifact),plaintext=Buffer.from(await d.decrypt(encryptedBytes));
  const prefix=Buffer.from('FOLIO-BACKUP\n1\n');assert.deepEqual(plaintext.subarray(0,prefix.length),prefix);const manifestSize=plaintext.readUInt32BE(prefix.length),offset=prefix.length+4+manifestSize;
  const manifest=JSON.parse(plaintext.subarray(prefix.length+4,offset).toString());let cursor=offset;const payloads=new Map<string,Buffer>();
  for(const item of manifest.files){const bytes=plaintext.subarray(cursor,cursor+item.bytes);assert.equal(bytes.length,item.bytes);assert.equal(hash(bytes),item.sha256);payloads.set(item.name,bytes);cursor+=item.bytes;}assert.equal(cursor,plaintext.length);
  assert.equal(manifest.database.tables.length,Object.keys(receipt.sourceSnapshot.tables).length);assert.equal(hash(payloads.get('integration-key.bin')!),hash(await fs.readFile(path.join(run,'source-key'))));
  assert.equal(encryptedBytes.includes(await fs.readFile(path.join(run,'source-key'))),false);receipt.archive={bytes:encryptedBytes.length,sha256:hash(encryptedBytes),tables:manifest.database.tables.length,payloadFiles:manifest.files.length,objects:manifest.objects.length};
  // Independently reseal invalid inventories with a real recipient, retaining valid authenticated ciphertext.
  async function reseal(name:string,value:any){const json=Buffer.from(JSON.stringify(value)),length=Buffer.alloc(4);length.writeUInt32BE(json.length);const e=new age.Encrypter();e.addRecipient((await fs.readFile(recipient,'utf8')).trim());await fs.writeFile(path.join(run,name),await e.encrypt(Buffer.concat([prefix,length,json,...value.files.map((f:any)=>payloads.get(f.name)!)])),{mode:0o600});}
  await reseal('missing-required.age',{...manifest,files:manifest.files.filter((f:any)=>f.name!=='integration-key.bin')});
  const fixture=JSON.parse(await fs.readFile(path.join(run,'fixture-private.json'),'utf8'));
  const missingSource=manifest.objects.find((item:any)=>item.required&&item.present&&item.key===fixture.originals[0].storage_key);assert.ok(missingSource);
  const reducedFiles=manifest.files.filter((f:any)=>f.name!=='objects/'+missingSource.key);
  await reseal('missing-object.age',{...manifest,objects:manifest.objects.filter((o:any)=>o.key!==missingSource.key),files:reducedFiles});
  await reseal('optional-object.age',{...manifest,objects:manifest.objects.map((o:any)=>o.key===missingSource.key?{key:o.key,required:false,present:false}:o),files:reducedFiles});
  await checkpoint('RealEncryptedCreateAndInspectAfterQuiescedSourceShutdown');
  const sourceFile=path.join(run,'source-files',missingSource.key),heldFile=path.join(run,'temporarily-held-object');
  await fs.rename(sourceFile,heldFile);try{assert.notEqual((await cli('missing-source-file',['create','--config',sourceConfig,'--recipient-file',recipient,'--output',path.join(run,'missing-source.age'),'--quiesced'],true)).code,0);assert.equal(await fs.stat(path.join(run,'missing-source.age')).then(()=>true,()=>false),false);}finally{await fs.rename(heldFile,sourceFile);}
  assert.deepEqual(await snapshot('backup_source'),receipt.sourceSnapshot);await checkpoint('MissingRequiredSourceFileRefusesCaptureWithoutDatabaseChanges');
  await cli('restore',['restore','--config',targetConfig,'--input',artifact,'--identity-file',identity]);
  assert.deepEqual(await snapshot('backup_target'),receipt.sourceSnapshot);await checkpoint('EveryTableAndSequenceExactlyRestoredBeforeRuntimeMutation');
  await runtime('blocked',targetConfig);assert.deepEqual(await snapshot('backup_target'),receipt.sourceSnapshot);await checkpoint('FreshApiAndWorkerRefusePendingRestoreBeforeActivation');
  await cli('activate-without-consent',['activate','--config',targetConfig,'--input',artifact,'--identity-file',identity],true).then(r=>assert.notEqual(r.code,0));
  const targetObject=path.join(run,'target-files',missingSource.key),targetOriginal=await fs.readFile(targetObject),changed=Buffer.from(targetOriginal);changed[0]^=1;
  await fs.writeFile(targetObject,changed);try{assert.notEqual((await cli('activate-changed-object',['activate','--config',targetConfig,'--input',artifact,'--identity-file',identity,'--allow-outbound'],true)).code,0);assert.ok(await fs.stat(path.join(run,'target-files/.folio-restore-pending.json')));}finally{await fs.writeFile(targetObject,targetOriginal);}
  await checkpoint('ActivationRequiresExplicitOutboundFlagAndExactRestoredObjectBytes');
  await cli('activate',['activate','--config',targetConfig,'--input',artifact,'--identity-file',identity,'--allow-outbound']);
  const receiptFile=path.join(run,'target-files/.folio-restore-receipt.json'),pendingFile=path.join(run,'target-files/.folio-restore-pending.json');
  const activated=JSON.parse(await fs.readFile(receiptFile,'utf8'));const {activatedAt,...marker}=activated;assert.equal(typeof activatedAt,'string');
  await fs.writeFile(pendingFile,JSON.stringify(marker)+'\n',{mode:0o600});
  const recovered=await cli('activate-interrupted-publication',['activate','--config',targetConfig,'--input',artifact,'--identity-file',identity,'--allow-outbound']);assert.equal(JSON.parse(recovered.output).status,'restore_activated');assert.equal(await fs.stat(pendingFile).then(()=>true,()=>false),false);
  const repeated=await cli('activate-repeat',['activate','--config',targetConfig,'--input',artifact,'--identity-file',identity,'--allow-outbound']);assert.equal(JSON.parse(repeated.output).status,'restore_already_activated');assert.deepEqual(await snapshot('backup_target'),receipt.sourceSnapshot);
  await checkpoint('ActivationReceiptCrashRecoveryAndRepeatDoNotStartServicesOrChangeData');
  await runtime('verify',targetConfig);await checkpoint('FreshRestoredRuntimeLoginTenantIsolationOriginalsExportsKeyAndQueueOnce');
  // Every failure gets a distinct empty database and storage/key destination.
  await fs.writeFile(path.join(run,'malformed.age'),Buffer.from('not an age artifact'));
  const encrypted=await fs.readFile(artifact);await fs.writeFile(path.join(run,'truncated.age'),encrypted.subarray(0,Math.floor(encrypted.length/2)));
  await cli('wrong-keygen',['keygen','--identity-file',path.join(run,'wrong.agekey'),'--recipient-file',path.join(run,'wrong.age')]);
  receipt.rejections=[];
  for(const [name,input,key]of [['malformed','malformed.age','identity.agekey'],['truncated','truncated.age','identity.agekey'],['wrong-key','folio-backup.age','wrong.agekey'],['missing-required','missing-required.age','identity.agekey'],['missing-object','missing-object.age','identity.agekey'],['optional-object','optional-object.age','identity.agekey']]){
   const database='backup_reject_'+name.replaceAll('-','_'),configName=`reject-${name}.json`,storageName=`reject-${name}-files`,keyName=`reject-${name}-key`,reject=path.join(run,configName);
   await guarded('postgres',async c=>{await c.query(`CREATE DATABASE ${quote(database)} OWNER backup_owner`);});await write(configName,cfg(database,storageName,keyName));const before=await snapshot(database);
   const failure=await cli(name,['restore','--config',reject,'--input',path.join(run,input),'--identity-file',path.join(run,key)],true);assert.notEqual(failure.code,0);
   assert.deepEqual(await snapshot(database),before);const schemaCount=await guarded(database,async c=>(await c.query("select count(*)::int n from pg_namespace where nspname='folio'")).rows[0].n);assert.equal(schemaCount,0);
   const markerPresent=await fs.stat(path.join(run,storageName,'.folio-restore-pending.json')).then(()=>true,()=>false);
   if(name!=='missing-object'&&name!=='optional-object'){assert.equal(await fs.stat(path.join(run,storageName)).then(()=>true,()=>false),false);assert.equal(await fs.stat(path.join(run,keyName)).then(()=>true,()=>false),false);}
   receipt.rejections.push({case:name,code:JSON.parse(failure.output).code,databaseSchemaAbsent:true,pendingMarkerRetained:markerPresent});
  }
  const populatedBefore=await snapshot('backup_target'),storedBefore=await storageSnapshot(path.join(run,'target-files')),keyBefore=hash(await fs.readFile(path.join(run,'target-key')));assert.notEqual((await cli('existing-target',['restore','--config',targetConfig,'--input',artifact,'--identity-file',identity],true)).code,0);assert.deepEqual(await snapshot('backup_target'),populatedBefore);assert.deepEqual(await storageSnapshot(path.join(run,'target-files')),storedBefore);assert.equal(hash(await fs.readFile(path.join(run,'target-key'))),keyBefore);
  await checkpoint('DistinctEmptyTargetsRejectMalformedTruncatedWrongIdentityMissingPayloadAndRequiredObjectOmissionOrDowngrade');
  await checkpoint('ExistingTargetDatabaseStorageAndKeyRemainUnchangedAfterRefusedRestore');
  receipt.runtime=JSON.parse(await fs.readFile(path.join(run,'runtime-verification.json'),'utf8'));receipt.passed=true;
 }
}catch(error){receipt.passed=false;receipt.failure=error instanceof Error?error.message:String(error);process.exitCode=1;console.log('FAIL '+receipt.failure);}
finally{
 if(running&&!args.includes('--keep-cluster')){
  const stopped=await command(path.join(pgBin,'pg_ctl'),['-D',cluster,'-m','fast','-w','stop'],'pg-stop.log',{allowFailure:true});receipt.clusterStopped=stopped.code===0;
  if(stopped.code===0){
   await fs.rm(socket,{recursive:true,force:true});await fs.rm(cluster,{recursive:true,force:true});
   for(const name of ['source-files','source-key','target-files','target-key','reject-files','reject-key','backend-source-files','backend-source-key','backend-target-files','backend-target-key','fixture-private.json','identity.agekey','wrong.agekey'])await fs.rm(path.join(run,name),{recursive:true,force:true});
   for(const name of await fs.readdir(run))if(/^reject-(malformed|truncated|wrong-key|missing-required|missing-object|optional-object)-(files|key)$/.test(name))await fs.rm(path.join(run,name),{recursive:true,force:true});
   for(const removed of [cluster,socket,path.join(run,'source-files'),path.join(run,'target-files'),path.join(run,'source-key'),path.join(run,'target-key'),path.join(run,'fixture-private.json'),path.join(run,'identity.agekey')])assert.equal(await fs.stat(removed).then(()=>true,()=>false),false);
   receipt.cleanup={clusterRemoved:true,socketRemoved:true,sourceAndRestoredStorageRemoved:true,privateKeysAndCredentialFixtureRemoved:true,ownedAccountsPerPopulatedDatabase:2,populatedDatabases:receipt.passed?2:undefined,normalDevelopmentDatabaseTouched:false};
  }else{receipt.passed=false;process.exitCode=1;}
 }
 if(receipt.sourceBefore){receipt.sourceAfter=await fingerprint();receipt.sourceUnchanged=receipt.sourceBefore.fingerprint===receipt.sourceAfter.fingerprint;}
 receipt.completedAt=new Date().toISOString();await write('results.json',receipt).catch(()=>{});
 if(!args.includes('--prepare-only'))await fs.writeFile(path.join(base,'final-results.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
}
