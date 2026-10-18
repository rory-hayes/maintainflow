/** Additional synthetic cases for the owned managed-backup fixture, never a hosted runner. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {runBackup} from '../backup.js';
import {openSourceDatabase} from './database.js';
import {openArchive,sealArchive} from './archive.js';
import {sha256} from './files.js';
import type {BackupConfig,BackupManifest} from './types.js';
import {assertStorageRestoreReady} from '../../server/core/restore-state.js';

type Context={run:string;source:BackupConfig;migrations:string;identity:string;recipient:string;
 sql:<T>(database:string,fn:(client:pg.Client)=>Promise<T>)=>Promise<T>;
 cfg:(database:string)=>BackupConfig;objects:Map<string,Buffer>;records:Map<string,{id:string;updated_at:string}>;
 transport:(afterRead?:()=>void)=>void;downloads:string[];checkpoint:(name:string)=>void;
 runtime:(config:BackupConfig,fixture:Record<string,string>)=>Promise<void>};

export async function verifyManagedStaging(c:Context){
 const {run,source,migrations,identity,recipient,sql,cfg,objects,records,checkpoint}=c;
 // The earlier v1 refusal deliberately widened this owned source ACL.
 await sql('source',client=>client.query('REVOKE SELECT ON folio.documents FROM PUBLIC'));
 const fixture=await sql('source',async client=>{
  const document=(await client.query('SELECT id,workspace_id,parser_id,storage_key FROM folio.documents ORDER BY id LIMIT 1')).rows[0];
  const user=(await client.query('SELECT id FROM folio.users ORDER BY id LIMIT 1')).rows[0].id as string;
  const direct:Record<string,{id:string;key:string}>={},split:Record<string,{id:string;key:string;source:string}>={};
  for(const state of ['pending','complete','failed','cleaned']){
   const id=randomUUID(),key=document.workspace_id+'/'+id;direct[state]={id,key};
   await client.query(`INSERT INTO folio.direct_uploads(id,workspace_id,parser_id,created_by,storage_key,filename,expected_bytes,expected_sha256,state,document_id,expires_at,cleanup_after)
    VALUES($1,$2,$3,$4,$5,'SYNTHETIC staging.txt',1,$6,$7,$8,now()+interval '15 minutes',now()+interval '130 minutes')`,[id,document.workspace_id,document.parser_id,user,key,sha256('x'),state,['complete','cleaned'].includes(state)?document.id:null]);
   if(state!=='pending')objects.set(key,Buffer.from('Untrusted synthetic staging'));
  }
  for(const state of ['uploading','queued','ready','cancelled']){
   const id=randomUUID(),key=document.workspace_id+'/'+randomUUID(),sourceKey=document.workspace_id+'/'+randomUUID(),bytes=Buffer.from('SYNTHETIC accepted suggestion source '+state);split[state]={id,key,source:sourceKey};
   await client.query(`INSERT INTO folio.split_suggestions(id,workspace_id,parser_id,requested_by,request_id,auth_type,token_hash,source_name,source_sha256,source_mime_type,expected_bytes,source_storage_key,source_reserved_bytes,staging_storage_key,staging_reserved_bytes,staging_expires_at,config,state,completed_at,page_count,start_pages,model,prompt_version)
    VALUES($1,$2,$3,$4,$5,'session',$6,'SYNTHETIC source.pdf',$7,'application/pdf',$8,$9,$8,$10,10485760,now()+interval '130 minutes','{}',$11,$12,$13,$14,$15,$16)`,[id,document.workspace_id,document.parser_id,user,randomUUID(),sha256('synthetic-no-real-session'),sha256(bytes),bytes.length,sourceKey,key,state,state==='ready'?new Date():null,state==='ready'?1:null,state==='ready'?'[1]':null,state==='ready'?'synthetic-model':null,state==='ready'?'synthetic-v1':null]);
   if(state!=='uploading')objects.set(sourceKey,bytes);
   if(state!=='uploading')objects.set(key,Buffer.from('Untrusted synthetic split staging'));
  }
  // Cleanup references can overlap a staging reservation without making it an original.
  await client.query('INSERT INTO folio.file_deletions(workspace_id,storage_key) VALUES($1,$2)',[document.workspace_id,direct.cleaned.key]);
  return {document,user,direct,split};
 });
 for(const key of objects.keys())if(!records.has(key))records.set(key,{id:randomUUID(),updated_at:'2026-10-18T00:00:00.000Z'});
 const v2=()=>openSourceDatabase(source,migrations,{excludeUploadStaging:true});
 await assert.rejects(openSourceDatabase(source,migrations),/signed upload\/writer capabilities/);
 const initial=await v2();assert.equal(initial.excludedUploadStaging?.length,8);await initial.close();
 checkpoint('V1StillWaitsForFutureCapabilitiesWhileV2DerivesEveryDirectAndSplitState');

 // A relation may be optional for recovery yet still must never be excluded as staging.
 const expectAlias=async(mutate:(client:pg.Client)=>Promise<unknown>,restore:(client:pg.Client)=>Promise<unknown>)=>{
  await sql('source',mutate);try{await assert.rejects(v2(),/Upload staging aliases/);}finally{await sql('source',restore);}
 };
 await expectAlias(client=>client.query('UPDATE folio.documents SET storage_key=$1 WHERE id=$2',[fixture.direct.pending.key,fixture.document.id]),client=>client.query('UPDATE folio.documents SET storage_key=$1 WHERE id=$2',[fixture.document.storage_key,fixture.document.id]));
 await expectAlias(client=>client.query('UPDATE folio.split_suggestions SET source_storage_key=$1 WHERE id=$2',[fixture.direct.pending.key,fixture.split.uploading.id]),client=>client.query('UPDATE folio.split_suggestions SET source_storage_key=$1 WHERE id=$2',[fixture.split.uploading.source,fixture.split.uploading.id]));
 await expectAlias(client=>client.query('UPDATE folio.split_suggestions SET source_document_id=$1,original_source_key=$2,original_page_count=1 WHERE id=$3',[fixture.document.id,fixture.direct.pending.key,fixture.split.cancelled.id]),client=>client.query('UPDATE folio.split_suggestions SET source_document_id=null,original_source_key=null,original_page_count=null WHERE id=$1',[fixture.split.cancelled.id]));
 const intakeId=randomUUID();
 await expectAlias(client=>client.query("INSERT INTO folio.intake_files(id,workspace_id,storage_key,lease_expires_at) VALUES($1,$2,$3,now()-interval '1 minute')",[intakeId,fixture.document.workspace_id,fixture.direct.pending.key]),client=>client.query('DELETE FROM folio.intake_files WHERE id=$1',[intakeId]));
 await expectAlias(client=>client.query('UPDATE folio.split_suggestions SET staging_storage_key=$1 WHERE id=$2',[fixture.direct.pending.key,fixture.split.uploading.id]),client=>client.query('UPDATE folio.split_suggestions SET staging_storage_key=$1 WHERE id=$2',[fixture.split.uploading.key,fixture.split.uploading.id]));
 checkpoint('V2RejectsRequiredOptionalHistoricalAndExpiredIntakeAliasesAndDuplicateCapabilities');

 const expectWriter=async(mutate:(client:pg.Client)=>Promise<unknown>,restore:(client:pg.Client)=>Promise<unknown>)=>{
  await sql('source',mutate);try{await assert.rejects(v2(),/Drain all in-flight work and active writer leases/);}finally{await sql('source',restore);}
 };
 await expectWriter(client=>client.query("UPDATE folio.direct_uploads SET state='finalizing' WHERE id=$1",[fixture.direct.pending.id]),client=>client.query("UPDATE folio.direct_uploads SET state='pending' WHERE id=$1",[fixture.direct.pending.id]));
 await expectWriter(client=>client.query("UPDATE folio.split_suggestions SET write_owner=$1,write_until=now()+interval '1 minute' WHERE id=$2",[randomUUID(),fixture.split.uploading.id]),client=>client.query('UPDATE folio.split_suggestions SET write_owner=null,write_until=null WHERE id=$1',[fixture.split.uploading.id]));
 await expectWriter(client=>client.query("UPDATE folio.split_suggestions SET state='processing',lease_owner=$1,lease_until=now()+interval '1 minute' WHERE id=$2",[randomUUID(),fixture.split.queued.id]),client=>client.query("UPDATE folio.split_suggestions SET state='queued',lease_owner=null,lease_until=null WHERE id=$1",[fixture.split.queued.id]));
 await expectWriter(client=>client.query('INSERT INTO folio.intake_files(id,workspace_id,storage_key) VALUES($1,$2,$3)',[intakeId,fixture.document.workspace_id,fixture.document.workspace_id+'/'+randomUUID()]),client=>client.query('DELETE FROM folio.intake_files WHERE id=$1',[intakeId]));
 checkpoint('V2RetainsFinalizingProcessingSplitWriteAndIntakeLeaseGuards');

 const rowSnapshot=(database:string)=>sql(database,async client=>{
  const tables=(await client.query("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='folio' AND c.relkind='r' ORDER BY c.relname")).rows;
  const state:Record<string,unknown>={};for(const {relname} of tables){assert.match(relname,/^[a-z][a-z0-9_]*$/);state[relname]=(await client.query(`SELECT to_jsonb(t)::text body FROM folio.${relname} t ORDER BY to_jsonb(t)::text`)).rows;}
  state.sequence=(await client.query('SELECT last_value::text,is_called FROM folio.document_events_sequence_seq')).rows;return sha256(JSON.stringify(state));
 });
 const before=await rowSnapshot('source'),beforeObjects=new Map([...objects].map(([key,bytes])=>[key,sha256(bytes)])),downloadsStart=c.downloads.length;
 let late=false;c.transport(()=>{if(late)return;late=true;for(const key of [fixture.direct.pending.key,fixture.split.uploading.key]){objects.set(key,Buffer.from('SYNTHETIC late PUT after inventory'));records.set(key,{id:randomUUID(),updated_at:'2026-10-18T00:01:00.000Z'});}});
 const artifact=path.join(run,'staging.age'),unpack=path.join(run,'staging-unpack');
 const capture=await runBackup(['create','--config',path.join(run,'source.json'),'--recipient-file',recipient,'--output',artifact,'--quiesced','--exclude-upload-staging']);
 assert.equal(capture.status,'backup_created');assert.equal('version' in capture&&capture.version,2);assert.equal('excludedUploadStaging' in capture&&capture.excludedUploadStaging,8);assert.ok(late);
 await fs.mkdir(unpack,{mode:0o700});const opened=await openArchive(artifact,(await fs.readFile(identity,'utf8')).trim(),unpack),manifest=opened.manifest;
 assert.equal(manifest.version,2);assert.ok(manifest.version===2);
 const exclusions=new Set(manifest.excludedUploadStaging.map(item=>item.key));
 assert.ok(c.downloads.slice(downloadsStart).every(key=>!exclusions.has(key)));
 for(const key of exclusions){assert.ok(manifest.objects.some(item=>item.key===key&&!item.required&&!item.present));assert.equal(await fs.stat(path.join(unpack,'objects',key)).then(()=>true,()=>false),false);assert.ok(!manifest.omittedObjects.some(item=>item.key===key));}
 for(const [key,digest] of beforeObjects)assert.equal(sha256(objects.get(key)!),digest);
 assert.equal(await rowSnapshot('source'),before);c.transport();
 checkpoint('V2LateKnownPutSucceedsWithoutStagingReadsAndLeavesSourceRowsAndOriginalsUnchanged');

 for(const database of ['staging_target','staging_bad_target','staging_bad_identity'])await fs.writeFile(path.join(run,database+'.json'),JSON.stringify(cfg(database)),{mode:0o600});
 const target=cfg('staging_target'),targetFile=path.join(run,'staging_target.json');
 assert.equal((await runBackup(['restore','--config',targetFile,'--input',artifact,'--identity-file',identity])).status,'restored_inactive');
 assert.equal(await rowSnapshot('staging_target'),before);
 for(const item of manifest.objects){const filename=path.join(target.storageDir,item.key);if(item.present)assert.equal(sha256(await fs.readFile(filename)),item.sha256);else assert.equal(await fs.stat(filename).then(()=>true,()=>false),false);}
 assert.equal((await runBackup(['verify','--config',targetFile,'--input',artifact,'--identity-file',identity])).status,'restored_verified_inactive');
 await assert.rejects(assertStorageRestoreReady(target.storageDir,'filesystem'),(error:any)=>error.code==='FOLIO_RESTORE_PENDING');
 checkpoint('V2RestoresEveryTableSequenceAuditAndAcceptedByteWithStagingAbsentAndStartupFenced');

 for(const [database,change] of [
  ['staging_bad_target',(value:Extract<BackupManifest,{version:2}>)=>{value.excludedUploadStaging.pop();}],
  ['staging_bad_identity',(value:Extract<BackupManifest,{version:2}>)=>{value.excludedUploadStaging.find(item=>item.recordType==='split_suggestion')!.recordId=randomUUID();}],
 ] as const){
  const changed=structuredClone(manifest);change(changed);const modified=path.join(run,database+'.age');
  await sealArchive(unpack,changed,(await fs.readFile(recipient,'utf8')).trim(),modified);
  await assert.rejects(runBackup(['restore','--config',path.join(run,database+'.json'),'--input',modified,'--identity-file',identity]),/Restored upload staging declarations differ/);
  await sql(database,async client=>assert.equal((await client.query("SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='folio'")).rows[0].n,0));
  assert.ok(await fs.stat(path.join(cfg(database).storageDir,'.folio-restore-pending.json')));
 }
 checkpoint('V2MissingOrMisboundAuthenticatedDeclarationsRollbackDatabaseAndKeepTargetInactive');
 assert.equal((await runBackup(['activate','--config',targetFile,'--input',artifact,'--identity-file',identity,'--allow-outbound'])).status,'restore_activated');
 await c.runtime(target,{workspaceId:fixture.document.workspace_id,userId:fixture.user,documentId:fixture.document.id,completeId:fixture.direct.complete.id,cleanedId:fixture.direct.cleaned.id,pendingId:fixture.direct.pending.id,failedId:fixture.direct.failed.id});
 assert.equal(await rowSnapshot('staging_target'),before);
 assert.equal(await rowSnapshot('source'),before);
 checkpoint('V2CompletedAndCleanedUploadsReplayWithoutStagingAndUnfinishedRowsRemainRecoverable');
 return {sourceRowsSha256:before,excludedUploadStaging:8,ciphertextSha256:opened.ciphertextSha256};
}
