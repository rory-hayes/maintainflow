import fs from 'node:fs/promises';
import path from 'node:path';
import {backupAssert,BackupError} from './errors.js';
import {backupLimits,objectKey,sha256,ensurePrivateDirectory} from './files.js';

type InventoryObject={key:string;id:string;bytes:number;updatedAt:string};
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const bucket='folio-originals';
const fail=()=>new BackupError('BACKUP_STORAGE','The private Supabase bucket could not be read or changed during capture.');
/** Read-only transport. No bucket, object, policy, signed URL or credential mutations. */
export function createSupabaseBackupSource(options:{url:string;serviceRoleKey:string;fetch?:typeof fetch;timeoutMs?:number}){
 let url:URL;try{url=new URL(options.url);}catch{throw fail();}
 backupAssert(url.protocol==='https:'&&/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)&&!url.username&&!url.password&&!url.port&&url.pathname==='/'&&!url.search&&!url.hash,'BACKUP_STORAGE','Use the exact Supabase project HTTPS origin.');
 backupAssert(options.serviceRoleKey.length>0&&options.serviceRoleKey.length<=16384&&!/\s/.test(options.serviceRoleKey),'BACKUP_STORAGE','Use a bounded private Supabase service credential file.');
 const transport=options.fetch??fetch,base=url.origin+'/storage/v1',timeout=options.timeoutMs??45000;
 backupAssert(Number.isSafeInteger(timeout)&&timeout>0&&timeout<=45000,'BACKUP_STORAGE','Invalid storage request deadline.');
 async function request(route:string,body:unknown,maxBytes:number){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  const expired=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(fail()),{once:true}));
  try{
   const response=await Promise.race([transport(base+route,{method:body===undefined?'GET':'POST',headers:{apikey:options.serviceRoleKey,Authorization:'Bearer '+options.serviceRoleKey,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:controller.signal}),expired]);
   if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});throw fail();}
   const length=response.headers.get('content-length');backupAssert(length===null||/^\d+$/.test(length)&&Number(length)<=maxBytes,'BACKUP_LIMIT','A private storage response exceeds its supported limit.');
   reader=response.body.getReader();const chunks:Buffer[]=[];let size=0;
   for(;;){const next=await Promise.race([reader.read(),expired]);if(next.done)break;size+=next.value.byteLength;backupAssert(size<=maxBytes,'BACKUP_LIMIT','A private storage response exceeds its supported limit.');chunks.push(Buffer.from(next.value));}
   return Buffer.concat(chunks,size);
  }catch(error){controller.abort();if(error instanceof BackupError)throw error;throw fail();}
  finally{clearTimeout(timer);if(reader){void reader.cancel().catch(()=>{});reader.releaseLock();}}
 }
 async function json(route:string,body?:unknown){try{return JSON.parse((await request(route,body,2*1024*1024)).toString('utf8'));}catch(error){if(error instanceof BackupError)throw error;throw fail();}}
 async function inventory(){
  const info=await json('/bucket/'+bucket);
  backupAssert(info?.id===bucket&&info.public===false&&Number.isSafeInteger(Number(info.file_size_limit))&&Number(info.file_size_limit)>0&&Number(info.file_size_limit)<=backupLimits.objectBytes,'BACKUP_STORAGE','The originals bucket must be private with a file limit no greater than 10 MiB.');
  const policy={id:bucket,public:false,fileSizeLimit:Number(info.file_size_limit),allowedMimeTypes:info.allowed_mime_types??null};
  backupAssert(policy.allowedMimeTypes===null||Array.isArray(policy.allowedMimeTypes)&&policy.allowedMimeTypes.length<=256&&policy.allowedMimeTypes.every((s:unknown)=>typeof s==='string'&&s.length<=256),'BACKUP_STORAGE','The bucket MIME policy is invalid.');
  const objects:InventoryObject[]=[],seen=new Set<string>();let total=0;
  async function walk(prefix:string){
   for(let offset=0;;offset+=100){
    const batch=await json('/object/list/'+bucket,{prefix,limit:100,offset,sortBy:{column:'name',order:'asc'}});
    backupAssert(Array.isArray(batch)&&batch.length<=100,'BACKUP_STORAGE','The private bucket listing is invalid.');
    for(const item of batch){
     backupAssert(item&&typeof item.name==='string'&&item.name.length===36&&uuid.test(item.name),'BACKUP_STORAGE','The originals bucket contains an unexpected object path.');
     const key=prefix?prefix+'/'+item.name:item.name;backupAssert(!seen.has(key),'BACKUP_CHANGED','The private bucket listing contains repeated or changing entries.');seen.add(key);
     backupAssert(seen.size<=backupLimits.files*2,'BACKUP_LIMIT','The private bucket inventory exceeds its entry limit.');
     if(item.id===null){backupAssert(!prefix,'BACKUP_STORAGE','The private bucket has an unexpected nested folder.');await walk(key);}
     else{
      const bytes=Number(item.metadata?.size);
      backupAssert(objectKey.test(key)&&typeof item.id==='string'&&uuid.test(item.id)&&Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=backupLimits.objectBytes&&typeof item.updated_at==='string'&&Number.isFinite(Date.parse(item.updated_at)),'BACKUP_STORAGE','The private bucket object metadata is invalid.');
      total+=bytes;objects.push({key,id:item.id,bytes,updatedAt:item.updated_at});
      backupAssert(total<=backupLimits.payloadBytes&&objects.length<=backupLimits.files,'BACKUP_LIMIT','The private bucket exceeds its supported capture limit.');
     }
    }
    if(batch.length<100)break;
   }
  }
  await walk('');return {policy,objects:objects.sort((a,b)=>a.key.localeCompare(b.key))};
 }
 async function download(item:InventoryObject){const bytes=await request('/object/authenticated/'+bucket+'/'+item.key,undefined,backupLimits.objectBytes);backupAssert(bytes.length===item.bytes,'BACKUP_CHANGED','A private original changed size during capture.');return bytes;}
 return {async capture(directory:string){
  await ensurePrivateDirectory(directory);backupAssert((await fs.readdir(directory)).length===0,'BACKUP_TARGET','The private bucket staging directory must be empty.');
  const before=await inventory(),hashes=new Map<string,string>();
  for(const item of before.objects){const bytes=await download(item);hashes.set(item.key,sha256(bytes));const workspace=path.join(directory,item.key.split('/')[0]!);await fs.mkdir(workspace,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await ensurePrivateDirectory(workspace);await fs.writeFile(path.join(directory,item.key),bytes,{mode:0o600,flag:'wx'});}
  async function verify(){
   backupAssert(JSON.stringify(await inventory())===JSON.stringify(before),'BACKUP_CHANGED','The private bucket inventory or policy changed during capture.');
   // Repeat actual bytes, including optional/unreferenced objects. Inventory equality alone
   // does not establish content identity, and neither pass replaces operator quiescence.
   for(const item of before.objects)backupAssert(sha256(await download(item))===hashes.get(item.key),'BACKUP_CHANGED','A private original changed during capture.');
   backupAssert(JSON.stringify(await inventory())===JSON.stringify(before),'BACKUP_CHANGED','The private bucket changed during content verification.');
  }
  await verify();return {verify,objects:before.objects.length};
 }};
}
