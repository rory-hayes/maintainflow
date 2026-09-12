import fs from 'node:fs/promises';
import path from 'node:path';
import {config} from './config.js';

const uuid=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
export const ORIGINALS_BUCKET='folio-originals';
export const SIGNED_UPLOAD_RETENTION_SECONDS=2*60*60+10*60;
export interface PrivateStorage {
  readonly kind:'filesystem'|'supabase';
  write(key:string,bytes:Buffer):Promise<void>;
  read(key:string,maxBytes?:number):Promise<Buffer>;
  remove(key:string):Promise<void>;
  signUpload?(key:string):Promise<string>;
  signDownload?(key:string,filename:string):Promise<string>;
}
function storageError(message:string,statusCode=503):Error{return Object.assign(new Error(message),{statusCode});}
type StorageOperation='bucket-read'|'upload-sign'|'download-sign'|'object-write'|'object-read'|'object-delete';
type StorageCode='STORAGE_CONFIG_URL'|'STORAGE_CONFIG_CREDENTIALS'|'STORAGE_CONFIG_DRIVER'|'STORAGE_UPSTREAM_NETWORK'|'STORAGE_UPSTREAM_HTTP'|'STORAGE_RESPONSE_INVALID'|'STORAGE_BUCKET_POLICY'|'STORAGE_SIGNED_URL';
type StorageDiagnostic={storageCode:StorageCode;storageOperation?:StorageOperation;upstreamStatus?:number};
const diagnostics=new WeakMap<Error,Readonly<StorageDiagnostic>>();
/** Only diagnostics created here are loggable; arbitrary error properties are ignored. */
export function storageDiagnostic(error:unknown):Readonly<StorageDiagnostic>|undefined{return error instanceof Error?diagnostics.get(error):undefined;}
function diagnosedError(code:StorageCode,message:string,operation?:StorageOperation,upstreamStatus?:number,statusCode=503){
  const error=storageError(message,statusCode);
  diagnostics.set(error,Object.freeze({storageCode:code,...(operation?{storageOperation:operation}:{}),...(Number.isInteger(upstreamStatus)&&upstreamStatus!>=100&&upstreamStatus!<=599?{upstreamStatus}: {})}));
  return error;
}
export function validateStorageKey(key:string,workspaceId?:string){
  const parts=key.split('/');
  if(parts.length!==2||!parts.every(part=>uuid.test(part))||(workspaceId&&parts[0]!==workspaceId))throw storageError('Invalid private storage key',400);
  return key;
}
export function safeDownloadName(value:string){return path.basename(value).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,240)||'document';}
export async function readBoundedResponse(response:Response,maxBytes:number):Promise<Buffer>{
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes)){await response.body?.cancel();throw storageError('File exceeds the 10 MB limit',413);}
  if(!response.body)return Buffer.alloc(0);
  const reader=response.body.getReader();const chunks:Buffer[]=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw storageError('File exceeds the 10 MB limit',413);}chunks.push(Buffer.from(value));}}
  finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
const filesystem:PrivateStorage={
  kind:'filesystem',
  async write(key,bytes){validateStorageKey(key);if(bytes.length>config.maxBytes)throw storageError('File exceeds the 10 MB limit',413);await fs.mkdir(path.join(config.storageDir,key.split('/')[0]),{recursive:true,mode:0o700});await fs.writeFile(path.join(config.storageDir,key),bytes,{mode:0o600,flag:'wx'});},
  async read(key,maxBytes=config.maxBytes){validateStorageKey(key);const filename=path.join(config.storageDir,key);const file=await fs.open(filename,'r');try{const stat=await file.stat();if(stat.size>maxBytes)throw storageError('File exceeds the 10 MB limit',413);const bytes=await file.readFile();if(bytes.length>maxBytes)throw storageError('File exceeds the 10 MB limit',413);return bytes;}finally{await file.close();}},
  async remove(key){validateStorageKey(key);try{await fs.unlink(path.join(config.storageDir,key));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}},
};
/** Only the fixed private bucket is addressed; no user-supplied URL is fetched. */
export function createSupabaseStorage(options:{url:string;serviceRoleKey:string;fetch?:typeof fetch}):PrivateStorage{
  let base:URL;try{base=new URL(options.url);}catch{throw diagnosedError('STORAGE_CONFIG_URL','Private storage requires a Supabase project HTTPS URL');}
  if(base.protocol!=='https:'||!base.hostname.endsWith('.supabase.co')||base.username||base.password||base.port||!['','/'].includes(base.pathname)||base.search||base.hash)throw diagnosedError('STORAGE_CONFIG_URL','Private storage requires a Supabase project HTTPS URL');
  if(!options.serviceRoleKey)throw diagnosedError('STORAGE_CONFIG_CREDENTIALS','Private storage credentials are not configured');
  const origin=base.origin,api=`${origin}/storage/v1`,transport=options.fetch??fetch;
  let verifiedUntil=0;
  async function request(operation:StorageOperation,route:string,init:RequestInit={}){
    let response:Response;
    try{response=await transport(`${api}${route}`,{...init,headers:{apikey:options.serviceRoleKey,Authorization:`Bearer ${options.serviceRoleKey}`,...Object.fromEntries(new Headers(init.headers))},redirect:'error',signal:AbortSignal.timeout(45_000)});}
    catch{throw diagnosedError('STORAGE_UPSTREAM_NETWORK','Private storage is temporarily unavailable. Retry shortly.',operation);}
    if(!response.ok){const bytes=await readBoundedResponse(response,64*1024).catch(()=>Buffer.alloc(0));let detail:any;try{detail=JSON.parse(bytes.toString());}catch{}const missing=response.status===404||String(detail?.statusCode)==='404'||detail?.code==='NoSuchKey'||detail?.error==='not_found';throw diagnosedError('STORAGE_UPSTREAM_HTTP',missing?'Original file is unavailable':'Private storage could not complete the request',operation,response.status,missing?404:503);}
    return response;
  }
  async function json(operation:StorageOperation,route:string,body:unknown){const response=await request(operation,route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});try{return JSON.parse((await readBoundedResponse(response,64*1024)).toString());}catch(error){if((error as any).statusCode)throw error;throw diagnosedError('STORAGE_RESPONSE_INVALID','Private storage returned an invalid response',operation,response.status);}}
  async function ensurePrivateBucket(){
    if(Date.now()<verifiedUntil)return;
    const response=await request('bucket-read',`/bucket/${ORIGINALS_BUCKET}`);let bucket:any;
    try{bucket=JSON.parse((await readBoundedResponse(response,64*1024)).toString());}catch{throw diagnosedError('STORAGE_RESPONSE_INVALID','Private storage bucket configuration could not be verified','bucket-read',response.status);}
    if(!bucket||bucket.id!==ORIGINALS_BUCKET||bucket.public!==false||!Number.isSafeInteger(Number(bucket.file_size_limit))||Number(bucket.file_size_limit)<=0||Number(bucket.file_size_limit)>config.maxBytes)throw diagnosedError('STORAGE_BUCKET_POLICY','Configure the originals bucket as private with a 10 MB file limit before uploading','bucket-read',response.status);
    verifiedUntil=Date.now()+60_000;
  }
  function signedURL(value:unknown,operation:'upload/sign'|'sign',key:string){
    const stage=operation==='upload/sign'?'upload-sign':'download-sign';
    if(typeof value!=='string'||value.length>12_000)throw diagnosedError('STORAGE_SIGNED_URL','Private storage returned an invalid signed URL',stage);
    let url:URL;try{url=new URL(value.startsWith('/object/')?`${api}${value}`:value,api);}catch{throw diagnosedError('STORAGE_SIGNED_URL','Private storage returned an invalid signed URL',stage);}
    if(url.origin!==origin||url.pathname!==`/storage/v1/object/${operation}/${ORIGINALS_BUCKET}/${key}`||!url.searchParams.get('token')||url.username||url.password||url.hash)throw diagnosedError('STORAGE_SIGNED_URL','Private storage returned an unexpected signed URL',stage);
    return url;
  }
  return {
    kind:'supabase',
    async write(key,bytes){validateStorageKey(key);if(bytes.length>config.maxBytes)throw storageError('File exceeds the 10 MB limit',413);await ensurePrivateBucket();const response=await request('object-write',`/object/${ORIGINALS_BUCKET}/${key}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','cache-control':'no-store','x-upsert':'false'},body:new Uint8Array(bytes)});await response.body?.cancel();},
    async read(key,maxBytes=config.maxBytes){validateStorageKey(key);await ensurePrivateBucket();const response=await request('object-read',`/object/authenticated/${ORIGINALS_BUCKET}/${key}`);return readBoundedResponse(response,Math.min(maxBytes,config.maxBytes));},
    async remove(key){validateStorageKey(key);const response=await request('object-delete',`/object/${ORIGINALS_BUCKET}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[key]})});await response.body?.cancel();},
    async signUpload(key){validateStorageKey(key);await ensurePrivateBucket();const data=await json('upload-sign',`/object/upload/sign/${ORIGINALS_BUCKET}/${key}`,{});return signedURL(data?.url,'upload/sign',key).toString();},
    async signDownload(key,filename){validateStorageKey(key);await ensurePrivateBucket();const data=await json('download-sign',`/object/sign/${ORIGINALS_BUCKET}/${key}`,{expiresIn:60});const url=signedURL(data?.signedURL,'sign',key);url.searchParams.set('download',safeDownloadName(filename));return url.toString();},
  };
}
let testStorage:PrivateStorage|undefined,cached:PrivateStorage|undefined,cachedConfig='';
/** Internal dependency injection; never selectable through an application request. */
export function setStorageForTests(value:PrivateStorage|undefined){if(process.env.NODE_ENV==='production')throw new Error('Storage injection is unavailable in production');testStorage=value;}
export function privateStorage():PrivateStorage{
  if(testStorage)return testStorage;
  const driver=process.env.STORAGE_DRIVER||'filesystem';
  if(driver==='filesystem')return filesystem;
  if(driver!=='supabase')throw diagnosedError('STORAGE_CONFIG_DRIVER','Unknown private storage driver');
  const url=process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL||'',key=process.env.SUPABASE_SERVICE_ROLE_KEY||'',identity=`${url}\0${key}`;
  if(!cached||identity!==cachedConfig){cached=createSupabaseStorage({url,serviceRoleKey:key});cachedConfig=identity;}
  return cached;
}
export async function readStoredObject(key:string,maxBytes=config.maxBytes){return privateStorage().read(key,maxBytes);}
