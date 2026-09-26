import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {generateHybridIdentity,identityToRecipient} from 'age-encryption';
import {sealArchive,openArchive} from './backup/archive.js';
import {openSourceDatabase,restoreDatabase,verifyRestoredDatabase} from './backup/database.js';
import {BackupError,backupAssert} from './backup/errors.js';
import {absent,backupLimits,configDigest,copyFileChecked,ensurePrivateDirectory,payloadRecord,pendingName,readConfig,readIntegrationKey,readPrivateFile,receiptName,safeDestination,scanStorage,sha256,syncFile,validateManifest} from './backup/files.js';
import {createSupabaseBackupSource} from './backup/supabase.js';
import type {BackupConfig,BackupManifest,BackupPayloadFile} from './backup/types.js';

const migrationsDirectory=fileURLToPath(new URL('../migrations/',import.meta.url));
const usage='Use keygen, create --quiesced, inspect, restore, or activate --allow-outbound with explicit private files. See docs/BACKUP-RESTORE.md.';
const options={'config':{type:'string'},'identity-file':{type:'string'},'recipient-file':{type:'string'},'input':{type:'string'},'output':{type:'string'},'quiesced':{type:'boolean'},'allow-outbound':{type:'boolean'}} as const;
type Values=Partial<Record<keyof typeof options,string|boolean>>;
function selected(values:Values,key:keyof typeof options){const value=values[key];backupAssert(typeof value==='string'&&path.isAbsolute(value)&&!value.includes('\0'),'BACKUP_ARGUMENTS',usage);return value;}
function only(values:Values,names:Array<keyof typeof options>){backupAssert(Object.keys(values).every(name=>names.includes(name as keyof typeof options)),'BACKUP_ARGUMENTS',usage);}
async function scratch(){return fs.mkdtemp(path.join(os.tmpdir(),'folio-backup-'));}
async function canonical(filename:string):Promise<string>{try{return await fs.realpath(filename);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=path.dirname(filename);backupAssert(parent!==filename,'BACKUP_PATH','A selected path cannot be resolved.');return path.join(await canonical(parent),path.basename(filename));}}
function inside(parent:string,child:string){const relative=path.relative(parent,child);return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
async function separate(root:string,filenames:string[]){const base=await canonical(root);for(const name of filenames){const file=await canonical(name);backupAssert(!inside(base,file)&&!inside(file,base),'BACKUP_PATH','Keep configuration, keys, backup artifacts and temporary files outside the originals directory.');}}
async function freshFile(filename:string){await ensurePrivateDirectory(path.dirname(filename));backupAssert(await absent(filename),'BACKUP_EXISTS','A selected output already exists. Choose a new path.');}
async function writePrivate(filename:string,bytes:Uint8Array|string){await fs.writeFile(filename,bytes,{mode:0o600,flag:'wx'});await syncFile(filename);}
async function textKey(filename:string){return (await readPrivateFile(filename,16384)).toString('utf8').trim();}
function summary(manifest:BackupManifest){return {format:manifest.format,version:manifest.version,id:manifest.id,createdAt:manifest.createdAt,capture:manifest.capture,postgresMajor:manifest.database.postgresMajor,tables:manifest.database.tables.length,rows:manifest.database.tables.reduce((n,t)=>n+t.rows,0),payloadFiles:manifest.files.length,payloadBytes:manifest.files.reduce((n,f)=>n+f.bytes,0),originals:manifest.objects.filter(o=>o.present).length,absentOptionalObjects:manifest.objects.filter(o=>!o.present).length,omittedUnreferencedObjects:manifest.omittedObjects.length,migrations:manifest.database.migrations.length};}

async function keygen(values:Values){
 only(values,['identity-file','recipient-file']);const identityFile=selected(values,'identity-file'),recipientFile=selected(values,'recipient-file');
 backupAssert(await canonical(identityFile)!==await canonical(recipientFile),'BACKUP_PATH','Use separate private identity and public recipient files.');
 await freshFile(identityFile);await freshFile(recipientFile);
 const identity=await generateHybridIdentity(),recipient=await identityToRecipient(identity);let owned=false;
 try{await writePrivate(identityFile,identity+'\n');owned=true;await writePrivate(recipientFile,recipient+'\n');}
 catch(error){if(owned)await fs.unlink(identityFile).catch(()=>{});throw error;}
 return {status:'keypair_created',identityStoredPrivately:true};
}

async function create(values:Values){
 only(values,['config','recipient-file','output','quiesced']);backupAssert(values.quiesced===true,'BACKUP_QUIESCENCE','Stop all API, workers and storage writers, then pass --quiesced.');
 const configFile=selected(values,'config'),recipientFile=selected(values,'recipient-file'),output=selected(values,'output');
 const config=await readConfig(configFile);await freshFile(output);
 backupAssert(!config.sourceStorage||config.databaseProfile==='managed-source','BACKUP_CONFIG','Supabase capture requires explicit managed-source database checks.');
 await ensurePrivateDirectory(config.storageDir);
 const directory=await scratch();let source:Awaited<ReturnType<typeof openSourceDatabase>>|undefined;
 let storageRoot=config.storageDir,remote:Awaited<ReturnType<ReturnType<typeof createSupabaseBackupSource>['capture']>>|undefined;
 try{
  await separate(config.storageDir,[directory,configFile,recipientFile,output,config.integrationKeyFile,...[config.database.passwordFile,config.database.sslCaFile,config.sourceStorage?.serviceRoleKeyFile].filter((s):s is string=>!!s)]);
  const recipient=await textKey(recipientFile),key=await readIntegrationKey(config.integrationKeyFile);
  source=await openSourceDatabase(config,migrationsDirectory);
  if(config.sourceStorage){
   storageRoot=path.join(directory,'bucket-snapshot');await fs.mkdir(storageRoot,{mode:0o700});
   const credential=(await readPrivateFile(config.sourceStorage.serviceRoleKeyFile,16384)).toString('utf8').trim();
   remote=await createSupabaseBackupSource({url:config.sourceStorage.url,serviceRoleKey:credential}).capture(storageRoot);
   await source.verifyQuiescence();
  }
  const before=await scanStorage(storageRoot),inventory=new Map(before.map(record=>[record.key,record]));
  const files:BackupPayloadFile[]=[];let totalBytes=0;
  const add=(file:BackupPayloadFile)=>{totalBytes+=file.bytes;backupAssert(totalBytes<=backupLimits.payloadBytes&&files.length<backupLimits.files,'BACKUP_LIMIT','The backup exceeds its supported payload or file limit.');files.push(file);};
  await writePrivate(path.join(directory,'integration-key.bin'),key);add({name:'integration-key.bin',bytes:key.length,sha256:sha256(key)});
  const objects:BackupManifest['objects']=[];
  for(const reference of source.objects){
   const actual=inventory.get(reference.key);
   backupAssert(!reference.required||actual&&actual.bytes===reference.byteSize&&actual.sha256===reference.sha256,'BACKUP_ORIGINAL','A required original is missing or does not match its stored metadata.');
   if(!actual){objects.push({key:reference.key,required:false,present:false});continue;}
   const name='objects/'+reference.key,destination=await safeDestination(directory,name);
   const copied=await copyFileChecked(path.join(storageRoot,reference.key),destination,Math.min(backupLimits.objectBytes,backupLimits.payloadBytes-totalBytes));
   backupAssert(copied.bytes===actual.bytes&&copied.sha256===actual.sha256,'BACKUP_CHANGED','An original changed during capture. Stop all writers before retrying.');
   add(payloadRecord(name,copied));objects.push({key:reference.key,required:reference.required,...(reference.required?{byteSize:reference.byteSize}:{}),present:true,...copied});
  }
  for(const table of source.manifest.tables){const filename=await safeDestination(directory,'tables/'+table.name+'.bin');add(await source.writeTable(table.name,filename,backupLimits.payloadBytes-totalBytes));}
  const referenced=new Set(source.objects.map(o=>o.key));
  const manifest=validateManifest({format:'folio-backup',version:1,id:randomUUID(),createdAt:new Date().toISOString(),capture:remote?'quiesced-supabase':'quiesced-filesystem',database:source.manifest,files,objects,integrationKeySha256:sha256(key),omittedObjects:before.filter(o=>!referenced.has(o.key))});
  backupAssert(JSON.stringify(await scanStorage(storageRoot))===JSON.stringify(before)&&sha256(await readIntegrationKey(config.integrationKeyFile))===manifest.integrationKeySha256,'BACKUP_CHANGED','Storage or the integration key changed during capture. Stop all writers before retrying.');
  await remote?.verify();await source.verifyQuiescence();
  // The pending ciphertext shares the final filesystem so publication is atomic and exclusive.
  const encrypted=path.join(path.dirname(output),'.folio-encrypted-'+randomUUID()+'.tmp');
  try{await sealArchive(directory,manifest,recipient,encrypted);await source.verifyQuiescence();backupAssert(JSON.stringify(await scanStorage(storageRoot))===JSON.stringify(before)&&sha256(await readIntegrationKey(config.integrationKeyFile))===manifest.integrationKeySha256,'BACKUP_CHANGED','Storage or the integration key changed during encryption. Stop all writers before retrying.');await remote?.verify();await source.verifyQuiescence();await fs.link(encrypted,output);await syncFile(output);}
  finally{await fs.unlink(encrypted).catch(()=>{});}
  return {status:'backup_created',...summary(manifest)};
 }finally{try{await source?.close();}finally{await fs.rm(directory,{recursive:true,force:true});}}
}

async function inspect(values:Values){
 only(values,['input','identity-file']);const directory=await scratch();
 try{const result=await openArchive(selected(values,'input'),await textKey(selected(values,'identity-file')),directory);return {status:'backup_authenticated',...summary(result.manifest),ciphertextSha256:result.ciphertextSha256};}
 finally{await fs.rm(directory,{recursive:true,force:true});}
}

type Pending={format:'folio-restore';version:1;backupId:string;configSha256:string;ciphertextSha256:string};
function pending(config:BackupConfig,manifest:BackupManifest,ciphertextSha256:string):Pending{return {format:'folio-restore',version:1,backupId:manifest.id,configSha256:configDigest(config),ciphertextSha256};}
async function matchingReceipt(filename:string,expected:Pending){
 if(await absent(filename))return false;
 let actual:Record<string,unknown>;try{actual=JSON.parse((await readPrivateFile(filename)).toString('utf8'));}catch{throw new BackupError('BACKUP_ACTIVATION','The existing activation receipt is unreadable.');}
 backupAssert(actual&&typeof actual==='object'&&Object.entries(expected).every(([key,value])=>actual[key]===value)&&typeof actual.activatedAt==='string'&&Number.isFinite(Date.parse(actual.activatedAt))&&Object.keys(actual).length===6,'BACKUP_ACTIVATION','The existing activation receipt does not match this backup and configuration.');
 return true;
}
async function prepareTarget(config:BackupConfig){
 await freshFile(config.integrationKeyFile);
 if(await absent(config.storageDir)){await ensurePrivateDirectory(path.dirname(config.storageDir));await fs.mkdir(config.storageDir,{mode:0o700});}
 await ensurePrivateDirectory(config.storageDir);backupAssert((await fs.readdir(config.storageDir)).length===0,'BACKUP_TARGET','The restore originals directory must be empty.');
}
async function verifyTargetFiles(config:BackupConfig,manifest:BackupManifest){
 backupAssert(sha256(await readIntegrationKey(config.integrationKeyFile))===manifest.integrationKeySha256,'BACKUP_KEY','The restored integration key does not match the authenticated backup.');
 const expected=manifest.objects.filter(o=>o.present).map(o=>({key:o.key,bytes:o.bytes,sha256:o.sha256})).sort((a,b)=>a.key.localeCompare(b.key));
 const actual=(await scanStorage(config.storageDir,true)).sort((a,b)=>a.key.localeCompare(b.key));
 backupAssert(JSON.stringify(actual)===JSON.stringify(expected),'BACKUP_STORAGE','The restored originals differ from the authenticated backup.');
}
async function restoreOrActivate(values:Values,activate:boolean){
 only(values,activate?['config','input','identity-file','allow-outbound']:['config','input','identity-file']);
 if(activate)backupAssert(values['allow-outbound']===true,'BACKUP_ACTIVATION','Activation permits queued work and configured integrations when services next start. Pass --allow-outbound to confirm.');
 const configFile=selected(values,'config'),input=selected(values,'input'),identityFile=selected(values,'identity-file'),config=await readConfig(configFile),directory=await scratch();
 try{
  await separate(config.storageDir,[directory,configFile,input,identityFile,config.integrationKeyFile,...[config.database.passwordFile,config.database.sslCaFile].filter((s):s is string=>!!s)]);
  // Decrypt, check every byte and consume the final age authentication before destination changes.
  const {manifest,ciphertextSha256}=await openArchive(input,await textKey(identityFile),directory);
  backupAssert(!config.sourceStorage&&!config.databaseProfile,'BACKUP_TARGET','Managed-source configuration is capture-only. Select a fresh dedicated filesystem restore destination.');
  const marker=pending(config,manifest,ciphertextSha256),markerFile=path.join(config.storageDir,pendingName),receiptFile=path.join(config.storageDir,receiptName);
  if(activate){
   const recorded=await matchingReceipt(receiptFile,marker);
   if(await absent(markerFile)){
    backupAssert(recorded,'BACKUP_ACTIVATION','The selected destination has no pending restore or matching activation receipt.');
    return {status:'restore_already_activated',...summary(manifest),servicesStarted:false};
   }
   let actual:unknown;try{actual=JSON.parse((await readPrivateFile(markerFile)).toString('utf8'));}catch{throw new BackupError('BACKUP_ACTIVATION','The selected destination has no readable pending restore marker.');}
   backupAssert(JSON.stringify(actual)===JSON.stringify(marker),'BACKUP_ACTIVATION','The pending restore does not match this configuration and authenticated backup.');
   await verifyTargetFiles(config,manifest);await verifyRestoredDatabase(config,manifest.database,path.join(directory,'tables'),migrationsDirectory,manifest.objects);await verifyTargetFiles(config,manifest);
   if(!recorded)await writePrivate(receiptFile,JSON.stringify({...marker,activatedAt:new Date().toISOString()})+'\n');
   await fs.unlink(markerFile);
   return {status:'restore_activated',...summary(manifest),servicesStarted:false};
  }
  await prepareTarget(config);
  await writePrivate(markerFile,JSON.stringify(marker));
  // Failures deliberately leave this owned destination inactive, including uncertain COMMIT replies.
  for(const object of manifest.objects.filter(o=>o.present)){
   const staged='objects/'+object.key;
   // Storage uses workspace/object paths, not the archive's objects/ prefix.
   const workspace=path.join(config.storageDir,object.key.split('/')[0]!);await fs.mkdir(workspace,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await ensurePrivateDirectory(workspace);
   await copyFileChecked(path.join(directory,staged),path.join(config.storageDir,object.key),backupLimits.objectBytes);await syncFile(path.join(config.storageDir,object.key));
  }
  await writePrivate(config.integrationKeyFile,await fs.readFile(path.join(directory,'integration-key.bin')));
  await restoreDatabase(config,manifest.database,path.join(directory,'tables'),migrationsDirectory,manifest.objects);
  await verifyTargetFiles(config,manifest);
  return {status:'restored_inactive',...summary(manifest),servicesStarted:false};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}

export async function runBackup(argv:string[]){
 let parsed:{values:Values;positionals:string[]};try{parsed=parseArgs({args:argv,options,allowPositionals:true,strict:true});}catch{throw new BackupError('BACKUP_ARGUMENTS',usage);}
 const [command,...extra]=parsed.positionals;backupAssert(extra.length===0,'BACKUP_ARGUMENTS',usage);
 switch(command){case 'keygen':return keygen(parsed.values);case 'create':return create(parsed.values);case 'inspect':return inspect(parsed.values);case 'restore':return restoreOrActivate(parsed.values,false);case 'activate':return restoreOrActivate(parsed.values,true);default:throw new BackupError('BACKUP_ARGUMENTS',usage);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await runBackup(process.argv.slice(2))));}
 catch(error){const safe=error instanceof BackupError?{code:error.code,message:error.message}:{code:'BACKUP_FAILED',message:'The backup operation failed. Check the selected private files, database availability and operator prerequisites.'};console.error(JSON.stringify(safe));process.exitCode=1;}
}
