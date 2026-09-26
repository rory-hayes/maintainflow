import fs from 'node:fs/promises';
import {constants,createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {z} from 'zod';
import {backupAssert,BackupError} from './errors.js';
import type {BackupConfig,BackupManifest,BackupPayloadFile} from './types.js';

export const backupLimits={payloadBytes:20*1024**3,manifestBytes:32*1024**2,files:100_000,objectBytes:10*1024**2,headerBytes:64*1024};
export const pendingName='.folio-restore-pending.json';
export const receiptName='.folio-restore-receipt.json';
const identifier=z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export const objectKey=new RegExp('^'+uuid+'/'+uuid+'$');
const absolute=z.string().min(1).max(4096).refine(value=>path.isAbsolute(value)&&!value.includes('\0'));
const configSchema=z.object({version:z.literal(1),database:z.object({host:z.string().min(1).max(1024),port:z.number().int().min(1).max(65535),database:identifier,user:identifier,passwordFile:absolute.optional(),sslCaFile:absolute.optional()}).strict(),schema:identifier,adminRole:identifier,appRole:identifier,storageDir:absolute,integrationKeyFile:absolute,databaseProfile:z.literal('managed-source').optional(),sourceStorage:z.object({kind:z.literal('supabase'),url:z.string().url().max(2048),serviceRoleKeyFile:absolute}).strict().optional()}).strict();
const reference=z.object({key:z.string().regex(objectKey),required:z.boolean(),byteSize:z.number().int().min(0).max(backupLimits.objectBytes).optional(),sha256:digest.optional(),present:z.boolean(),bytes:z.number().int().min(0).max(backupLimits.objectBytes).optional()}).strict();
const fileSchema=z.object({name:z.string().max(160),bytes:z.number().int().min(0).max(backupLimits.payloadBytes),sha256:digest}).strict();
const manifestSchema=z.object({format:z.literal('folio-backup'),version:z.literal(1),id:z.string().uuid(),createdAt:z.string().datetime(),capture:z.enum(['quiesced-filesystem','quiesced-supabase']),database:z.object({schema:identifier,postgresMajor:z.literal(17),encoding:z.literal('UTF8'),sourceIdentity:digest,securitySha256:digest,watchdogSha256:digest.optional(),tables:z.array(z.object({name:identifier,columns:z.array(z.object({name:identifier,type:z.string().min(1).max(512),generated:z.string().max(1),identity:z.string().max(1)}).strict()).min(1).max(256),primaryKey:z.array(identifier).min(1).max(256),rows:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict()).min(1).max(256),sequences:z.array(z.object({name:identifier,lastValue:z.string().regex(/^-?\d{1,19}$/),isCalled:z.boolean()}).strict()).max(256),migrations:z.array(z.object({name:z.string().regex(/^\d+_[a-z0-9_]+\.sql$/),sha256:digest}).strict()).min(1).max(1000)}).strict(),files:z.array(fileSchema).min(1).max(backupLimits.files),objects:z.array(reference).max(backupLimits.files),integrationKeySha256:digest,omittedObjects:z.array(z.object({key:z.string().regex(objectKey),bytes:z.number().int().min(0).max(backupLimits.objectBytes),sha256:digest}).strict()).max(backupLimits.files)}).strict();

export function sha256(bytes:Uint8Array|string){return createHash('sha256').update(bytes).digest('hex');}
export function validPayloadName(name:string){return name==='integration-key.bin'||/^tables\/[a-z][a-z0-9_]{0,62}\.bin$/.test(name)||name.startsWith('objects/')&&objectKey.test(name.slice(8));}
export function validateManifest(value:unknown):BackupManifest{
  const parsed=manifestSchema.safeParse(value);
  backupAssert(parsed.success,'BACKUP_MANIFEST','The backup manifest is invalid or unsupported.');
  const manifest=parsed.data;
  const names=new Set<string>(),fileByName=new Map<string,BackupPayloadFile>();let bytes=0;
  for(const file of manifest.files){backupAssert(validPayloadName(file.name)&&!names.has(file.name),'BACKUP_PATH','The backup has an invalid or duplicate payload path.');names.add(file.name);fileByName.set(file.name,file);bytes+=file.bytes;}
  backupAssert(bytes<=backupLimits.payloadBytes,'BACKUP_LIMIT','The backup exceeds the supported 20 GiB payload limit.');
  const expected=new Set(['integration-key.bin']);
  const tableNames=new Set<string>();
  for(const table of manifest.database.tables){
    backupAssert(!tableNames.has(table.name)&&new Set(table.columns.map(c=>c.name)).size===table.columns.length&&new Set(table.primaryKey).size===table.primaryKey.length&&table.primaryKey.every(key=>table.columns.some(c=>c.name===key)),'BACKUP_TABLE','The backup table inventory is inconsistent.');
    tableNames.add(table.name);expected.add('tables/'+table.name+'.bin');
  }
  backupAssert(new Set(manifest.database.sequences.map(s=>s.name)).size===manifest.database.sequences.length&&new Set(manifest.database.migrations.map(m=>m.name)).size===manifest.database.migrations.length,'BACKUP_DATABASE','The backup database inventory contains duplicates.');
  const keys=new Set<string>();
  for(const object of manifest.objects){
    backupAssert(!keys.has(object.key)&&(!object.required||object.present)&&(!object.present||object.bytes!==undefined&&object.sha256!==undefined),'BACKUP_OBJECT','The backup object inventory is inconsistent.');keys.add(object.key);
    if(object.present){const name='objects/'+object.key;expected.add(name);const file=fileByName.get(name);backupAssert(file&&file.bytes===object.bytes&&file.sha256===object.sha256&&(!object.required||object.byteSize===object.bytes),'BACKUP_OBJECT','A required original is missing or inconsistent in the backup.');}
    else backupAssert(object.bytes===undefined&&object.sha256===undefined,'BACKUP_OBJECT','An absent optional object must not declare content.');
  }
  for(const omitted of manifest.omittedObjects){backupAssert(!keys.has(omitted.key),'BACKUP_OBJECT','An omitted object overlaps another inventory entry.');keys.add(omitted.key);}
  backupAssert(names.size===expected.size&&[...expected].every(name=>names.has(name)),'BACKUP_INVENTORY','The backup payload inventory does not match its manifest.');
  const key=fileByName.get('integration-key.bin');
  backupAssert(key?.bytes===32&&key.sha256===manifest.integrationKeySha256,'BACKUP_KEY','The backup integration key is missing or inconsistent.');
  return manifest;
}
export async function readPrivateFile(filename:string,maxBytes=64*1024){
  backupAssert(path.isAbsolute(filename),'BACKUP_PATH','Use an absolute private file path.');
  const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat();backupAssert(stat.isFile()&&(stat.mode&0o077)===0&&stat.size<=maxBytes,'BACKUP_PRIVATE_FILE','A selected private file must be a regular owner-only file within the size limit.');const bytes=await handle.readFile();backupAssert(bytes.length<=maxBytes,'BACKUP_LIMIT','A selected private file exceeds its limit.');return bytes;}finally{await handle.close();}
}
export async function readConfig(filename:string):Promise<BackupConfig>{
  let value:unknown;try{value=JSON.parse((await readPrivateFile(filename)).toString('utf8'));}catch(error){if(error instanceof BackupError)throw error;throw new BackupError('BACKUP_CONFIG','The backup configuration could not be read. Use a private JSON file.');}
  const result=configSchema.safeParse(value);backupAssert(result.success,'BACKUP_CONFIG','The backup configuration is invalid. Supply all explicit database, role, storage and key-file settings.');
  const config=result.data;
  backupAssert(config.adminRole!==config.appRole&&config.database.user!==config.adminRole&&config.database.user!==config.appRole,'BACKUP_ROLES','Use distinct migration, administrator and tenant database identities.');
  const local=path.isAbsolute(config.database.host)||['127.0.0.1','localhost','::1'].includes(config.database.host);
  backupAssert(local||config.database.sslCaFile,'BACKUP_TLS','A remote database requires an explicit trusted TLS CA file.');
  backupAssert(!config.database.host.includes('\0'),'BACKUP_CONFIG','The database host is invalid.');
  return config;
}
export async function readIntegrationKey(filename:string){
  const bytes=await readPrivateFile(filename,256);if(bytes.length===32)return bytes;
  const value=bytes.toString('utf8').trim(),decoded=Buffer.from(value,'base64');
  backupAssert(decoded.length===32&&decoded.toString('base64')===value,'BACKUP_KEY','The integration key file must contain 32 raw bytes or their canonical base64 encoding.');return decoded;
}
export async function ensurePrivateDirectory(directory:string){
  const stat=await fs.lstat(directory);backupAssert(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'BACKUP_DIRECTORY','Use a real owner-only directory for private backup state.');
  return fs.realpath(directory);
}
export async function absent(filename:string){try{await fs.lstat(filename);return false;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return true;throw error;}}
export async function safeDestination(root:string,name:string){
  backupAssert(validPayloadName(name),'BACKUP_PATH','The backup payload path is invalid.');
  let directory=root;
  for(const component of name.split('/').slice(0,-1)){
    directory=path.join(directory,component);try{await fs.mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    await ensurePrivateDirectory(directory);
  }
  return path.join(root,name);
}
export async function hashFile(filename:string,maxBytes=backupLimits.payloadBytes):Promise<{bytes:number;sha256:string}>{
  const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const stat=await handle.stat();backupAssert(stat.isFile()&&stat.size<=maxBytes,'BACKUP_FILE','A backup source must be a regular file within its size limit.');const hash=createHash('sha256');let bytes=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;backupAssert(bytes<=maxBytes,'BACKUP_LIMIT','A source file grew beyond its size limit.');hash.update(chunk);}
    backupAssert(bytes===stat.size,'BACKUP_CHANGED','A source file changed during capture. Stop all writers before retrying.');return {bytes,sha256:hash.digest('hex')};
  }finally{await handle.close();}
}
export async function copyFileChecked(source:string,destination:string,maxBytes=backupLimits.payloadBytes):Promise<{bytes:number;sha256:string}>{
  const handle=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes=0;const hash=createHash('sha256');
  try{const stat=await handle.stat();backupAssert(stat.isFile()&&stat.size<=maxBytes,'BACKUP_FILE','A backup source must be a regular file within its size limit.');
    const meter=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>maxBytes)return callback(new BackupError('BACKUP_LIMIT','A source file exceeds its limit.'));hash.update(chunk);callback(null,chunk);}});
    await pipeline(handle.createReadStream({autoClose:false}),meter,createWriteStream(destination,{flags:'wx',mode:0o600}));
    backupAssert(bytes===stat.size,'BACKUP_CHANGED','A source file changed during capture. Stop all writers before retrying.');return {bytes,sha256:hash.digest('hex')};
  }finally{await handle.close();}
}
export async function scanStorage(root:string,allowPending=false){
  await ensurePrivateDirectory(root);const records:Array<{key:string;bytes:number;sha256:string}>=[];
  for(const workspace of (await fs.readdir(root)).sort()){
    backupAssert(workspace!==pendingName||allowPending,'BACKUP_INACTIVE','This restoration is inactive. Verify and activate it before creating another backup.');
    if(workspace===pendingName&&allowPending)continue;
    if(workspace===receiptName)continue;
    backupAssert(new RegExp('^'+uuid+'$').test(workspace),'BACKUP_STORAGE','The originals directory contains an unexpected entry.');
    const directory=path.join(root,workspace);await ensurePrivateDirectory(directory);
    for(const object of (await fs.readdir(directory)).sort()){
      const key=workspace+'/'+object;backupAssert(objectKey.test(key),'BACKUP_STORAGE','The originals directory contains an invalid object path.');
      records.push({key,...await hashFile(path.join(directory,object),backupLimits.objectBytes)});
      backupAssert(records.length<=backupLimits.files,'BACKUP_LIMIT','The originals inventory exceeds the supported file limit.');
    }
  }
  return records;
}
export async function syncFile(filename:string){const file=await fs.open(filename,'r');try{await file.sync();}finally{await file.close();}}
export function configDigest(config:BackupConfig){return sha256(JSON.stringify(config));}
export function payloadRecord(name:string,record:{bytes:number;sha256:string}):BackupPayloadFile{return {name,...record};}
