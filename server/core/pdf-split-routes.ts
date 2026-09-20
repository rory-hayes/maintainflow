import '@fastify/multipart';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {canonicalPdfSplitSpec,type PdfSplitSpec} from '../../shared/pdf-split.js';
import {requireActor,editors} from './auth.js';
import {withWorkspace,badRequest,notFound,audit} from './db.js';
import {config} from './config.js';
import {addSplitDocuments} from './pdf-split-intake.js';
import {findPdfSplitByRequest,readPdfSplitReceipt,storedPdfSplitRejection} from './pdf-split-records.js';
import {registerSplitPreview} from './split-preview.js';
import {purgePdfSplit} from './retention.js';
import {storedPdfAuthorization,splitStoredPdf,listStoredPdfSplits,undoStoredPdfSplit,withStoredPdfAuthorization} from './stored-pdf-split.js';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const idFrom=(params:unknown)=>z.object({id:uuid}).parse(params).id;
export async function registerPdfSplitRoutes(app:FastifyInstance){
 registerSplitPreview(app);
 app.post('/api/documents/:id/pdf-splits',async(request,reply)=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'}),documentId=idFrom(request.params);
  const body=z.object({requestId:uuid,sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),options:z.unknown()}).strict().parse(request.body);
  const spec:PdfSplitSpec=JSON.parse(canonicalPdfSplitSpec(body.options));
  const receipt=await splitStoredPdf(storedPdfAuthorization(request,actor),documentId,body.requestId,body.sourceSha256,spec);
  reply.code(202);return receipt;
 });
 app.get('/api/documents/:id/pdf-splits',async request=>{
  const actor=await requireActor(request,{scope:'documents:read'}),documentId=idFrom(request.params);
  const query=z.object({before:uuid.optional()}).strict().parse(request.query);
  return listStoredPdfSplits(storedPdfAuthorization(request,actor),documentId,query.before);
 });
 app.post('/api/pdf-splits/:id/undo',async request=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'}),id=idFrom(request.params);
  z.object({}).strict().parse(request.body??{});
  return undoStoredPdfSplit(storedPdfAuthorization(request,actor),id);
 });
 app.post('/api/parsers/:id/pdf-splits',async(request,reply)=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'}),parserId=idFrom(request.params);
  let file:{bytes:Buffer;filename:string}|undefined,requestId:string|undefined,spec:PdfSplitSpec|undefined;
  const seen=new Set<string>();
  try{for await(const part of request.parts({limits:{fileSize:config.maxBytes,files:1,fields:2,parts:3,fieldSize:4096}})){
   if(seen.has(part.fieldname))badRequest('Each split field may only be supplied once.');seen.add(part.fieldname);
   if(part.type==='file'){
    if(part.fieldname!=='file'||file)badRequest('Select exactly one PDF or TIFF file.');
    const bytes=await part.toBuffer();if(part.file.truncated)badRequest('File exceeds 10 MB limit',413);
    file={bytes,filename:part.filename};
   }else{
    if(part.valueTruncated||typeof part.value!=='string')badRequest('The document split request field is too large or invalid.');
    if(part.fieldname==='requestId')requestId=uuid.parse(part.value);
    else if(part.fieldname==='options'){
     let value:unknown;try{value=JSON.parse(part.value);}catch{badRequest('Split options must be valid JSON.');}
     spec=JSON.parse(canonicalPdfSplitSpec(value));
    }else badRequest('The document split request contains an unsupported field.');
   }
  }}catch(error){
   if((error as NodeJS.ErrnoException).code==='ERR_STREAM_PREMATURE_CLOSE')badRequest('The document upload was incomplete or exceeded request limits. Select one PDF or TIFF and retry.');
   throw error;
  }
  if(!file||!requestId||!spec)badRequest('Select one PDF or TIFF and supply its split request ID and options.');
  const receipt=await addSplitDocuments(actor,parserId,file.bytes,file.filename,requestId,spec);reply.code(202);return receipt;
 });
 app.get('/api/parsers/:id/pdf-splits/requests/:requestId',async request=>{
  const actor=await requireActor(request,{scope:'documents:read'}),params=z.object({id:uuid,requestId:uuid}).parse(request.params);
  const read=async(c:import('pg').PoolClient)=>{
   const row=await findPdfSplitByRequest(c,actor.workspaceId,params.requestId);
   if(!row||row.parser_id!==params.id)notFound('document split request not found');
   if(row.source_document_id&&row.state==='rejected')return storedPdfSplitRejection(row);
   return readPdfSplitReceipt(c,actor.workspaceId,row.id,true);
  };
  // Receipt recovery does not depend on a live source, but still needs live access.
  return withStoredPdfAuthorization(storedPdfAuthorization(request,actor),read,false);
 });
 app.delete('/api/pdf-splits/:id',async request=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'}),id=idFrom(request.params);
  const result=await withWorkspace(actor.workspaceId,async c=>{
   const result=await purgePdfSplit(c,actor.workspaceId,id);if(!result)notFound('PDF split not found');
   if(result.removedDocuments)await audit(c,actor.workspaceId,actor.userId,'document.split_deleted',id,{documents:result.removedDocuments});
   // Durable identities survive purge. Include earlier queued removals on replay,
   // even when this invocation had no live documents left to remove.
   const pending=(await c.query(`select status from file_deletions where workspace_id=$1 and storage_key in (
    select workspace_id::text||'/'||document_id::text from pdf_split_children where workspace_id=$1 and split_id=$2
    union all select workspace_id::text||'/'||id::text from pdf_splits where workspace_id=$1 and id=$2
   )`,[actor.workspaceId,id])).rows;
   return {removedDocuments:result.removedDocuments,storageDeletion:pending.some(row=>row.status==='failed')?'failed':pending.length?'pending':'complete'};
  });
  return {ok:true,...result};
 });
}
