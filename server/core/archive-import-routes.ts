import '@fastify/multipart';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {canonicalArchiveImportSpec,type ArchiveImportSpec} from '../../shared/archive-import.js';
import {requireActor,editors} from './auth.js';
import {withWorkspace,badRequest,notFound,audit} from './db.js';
import {config} from './config.js';
import {addArchiveDocuments,previewArchiveDocuments} from './archive-import-intake.js';
import {findArchiveImportByRequest,readArchiveImportReceipt,retainedArchiveSource} from './archive-import-records.js';
import {purgeArchiveImport} from './retention.js';
import {privateStorage,safeDownloadName,validateStorageKey} from './storage.js';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const idFrom=(params:unknown)=>z.object({id:uuid}).parse(params).id;
async function multipart(request:FastifyRequest,preview:boolean){
 let file:{bytes:Buffer;filename:string}|undefined,requestId:string|undefined,spec:ArchiveImportSpec|undefined;
 const seen=new Set<string>();
 try{for await(const part of request.parts({limits:{fileSize:config.maxBytes,files:1,fields:preview?1:2,parts:preview?2:3,fieldSize:4096}})){
  if(seen.has(part.fieldname))badRequest('Each ZIP import field may only be supplied once.');seen.add(part.fieldname);
  if(part.type==='file'){
   if(part.fieldname!=='file'||file)badRequest('Select exactly one ZIP file.');
   const bytes=await part.toBuffer();if(part.file.truncated)badRequest('File exceeds 10 MB limit',413);file={bytes,filename:part.filename};
  }else{
   if(part.valueTruncated||typeof part.value!=='string')badRequest('The ZIP import request field is too large or invalid.');
   if(part.fieldname==='requestId')requestId=uuid.parse(part.value);
   else if(!preview&&part.fieldname==='options'){
    let value:unknown;try{value=JSON.parse(part.value);}catch{badRequest('ZIP import options must be valid JSON.');}
    spec=JSON.parse(canonicalArchiveImportSpec(value));
   }else badRequest('The ZIP import request contains an unsupported field.');
  }
 }}catch(error){if((error as NodeJS.ErrnoException).code==='ERR_STREAM_PREMATURE_CLOSE')badRequest('The ZIP upload was incomplete or exceeded request limits. Select one ZIP and retry.');throw error;}
 if(!file||!requestId||(!preview&&!spec))badRequest('Select one ZIP and supply its import request ID and selected files.');
 return {file,requestId,spec};
}
export async function registerArchiveImportRoutes(app:FastifyInstance){
 app.post('/api/parsers/:id/archive-imports/preview',async request=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'}),parserId=idFrom(request.params),body=await multipart(request,true);
  return previewArchiveDocuments(actor,parserId,body.file.bytes,body.file.filename,body.requestId);
 });
 app.post('/api/parsers/:id/archive-imports',async(request,reply)=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'}),parserId=idFrom(request.params),body=await multipart(request,false);
  const receipt=await addArchiveDocuments(actor,parserId,body.file.bytes,body.file.filename,body.requestId,body.spec!);reply.code(202);return receipt;
 });
 app.get('/api/parsers/:id/archive-imports/requests/:requestId',async request=>{
  const actor=await requireActor(request,{scope:'documents:read'}),params=z.object({id:uuid,requestId:uuid}).parse(request.params);
  return withWorkspace(actor.workspaceId,async c=>{const row=await findArchiveImportByRequest(c,actor.workspaceId,params.requestId);if(!row||row.parser_id!==params.id)notFound('ZIP import request not found');return readArchiveImportReceipt(c,actor.workspaceId,row.id,true);});
 });
 app.delete('/api/archive-imports/:id',async request=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'}),id=idFrom(request.params);
  const result=await withWorkspace(actor.workspaceId,async c=>{
   const result=await purgeArchiveImport(c,actor.workspaceId,id);if(!result)notFound('ZIP import not found');
   if(result.removedDocuments)await audit(c,actor.workspaceId,actor.userId,'document.archive_deleted',id,{documents:result.removedDocuments});
   const pending=(await c.query(`select status from file_deletions where workspace_id=$1 and storage_key in (
    select workspace_id::text||'/'||document_id::text from archive_import_entries where workspace_id=$1 and archive_id=$2
    union all select workspace_id::text||'/'||id::text from archive_imports where workspace_id=$1 and id=$2
   )`,[actor.workspaceId,id])).rows;
   return {removedDocuments:result.removedDocuments,storageDeletion:pending.some(row=>row.status==='failed')?'failed':pending.length?'pending':'complete'};
  });return {ok:true,...result};
 });
 app.get('/api/documents/:id/archive-original',async(request,reply)=>{
  const actor=await requireActor(request,{scope:'documents:read'}),id=idFrom(request.params),source=await withWorkspace(actor.workspaceId,c=>retainedArchiveSource(c,actor.workspaceId,id));
  if(!source)notFound('The original ZIP archive is unavailable');validateStorageKey(source.storage_key,actor.workspaceId);
  const storage=privateStorage();reply.header('Cache-Control','private, no-store').header('Referrer-Policy','no-referrer');
  if(storage.signDownload)return reply.redirect(await storage.signDownload(source.storage_key,source.name));
  const bytes=await storage.read(source.storage_key).catch(()=>notFound('The original ZIP archive is unavailable'));
  reply.header('Content-Type','application/zip').header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(safeDownloadName(source.name))}`).header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"sandbox; default-src 'none'");return reply.send(bytes);
 });
 app.get('/api/documents/:id/archive-original-url',async request=>{
  const actor=await requireActor(request,{scope:'documents:read'}),id=idFrom(request.params),source=await withWorkspace(actor.workspaceId,c=>retainedArchiveSource(c,actor.workspaceId,id));
  if(!source)notFound('The original ZIP archive is unavailable');validateStorageKey(source.storage_key,actor.workspaceId);const storage=privateStorage();
  return storage.signDownload?{url:await storage.signDownload(source.storage_key,source.name),external:true}:{url:`/api/documents/${id}/archive-original`,external:false};
 });
}
