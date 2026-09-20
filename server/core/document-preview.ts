import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {requireActor} from './auth.js';
import {withWorkspace,badRequest,notFound} from './db.js';
import {readStoredObject,validateStorageKey} from './storage.js';
import {renderTiffPage} from './source.js';
import {tiffLimits,tiffRenderVersion} from '../../shared/tiff.js';

/** The TIFF itself remains the immutable original; previews are ephemeral images. */
export function registerDocumentPreview(app:FastifyInstance,renderPage=renderTiffPage){
 app.get('/api/documents/:id/preview',async(req,reply)=>{
  const actor=await requireActor(req,{scope:'documents:read'});
  const {id}=z.object({id:z.string().uuid()}).parse(req.params);
  const {page}=z.object({page:z.coerce.number().int().min(1).max(tiffLimits.maxPages).default(1)}).strict().parse(req.query);
  const read=()=>withWorkspace(actor.workspaceId,async c=>(await c.query('select storage_key,sha256,mime_type,page_count from documents where id=$1 and workspace_id=$2',[id,actor.workspaceId])).rows[0]);
  const document=await read();if(!document)notFound();
  if(document.mime_type!=='image/tiff')badRequest('Page previews are available for TIFF documents.',415);
  if(page>document.page_count)badRequest('This page is outside the document.',400);
  validateStorageKey(document.storage_key,actor.workspaceId);
  const controller=new AbortController();const disconnect=()=>{if(!reply.raw.writableEnded)controller.abort();};
  req.raw.once('aborted',disconnect);reply.raw.once('close',disconnect);
  try{
   if(req.raw.aborted||reply.raw.destroyed)controller.abort();controller.signal.throwIfAborted();
   const bytes=await readStoredObject(document.storage_key).catch(()=>notFound('Original file is unavailable'));controller.signal.throwIfAborted();
   if(createHash('sha256').update(bytes).digest('hex')!==document.sha256)badRequest('The original could not be verified. Upload it again to preview its pages.',409);
   const result=await renderPage(bytes,page,{signal:controller.signal});controller.signal.throwIfAborted();
   if(result.mimeType!=='image/jpeg'||result.page!==page||result.pageCount!==document.page_count||result.sourceSha256!==document.sha256||result.renderVersion!==tiffRenderVersion
    ||!Buffer.isBuffer(result.bytes)||!result.bytes.length||result.bytes.length>tiffLimits.maxJpegBytes||result.bytes[0]!==0xff||result.bytes[1]!==0xd8
    ||!Number.isInteger(result.width)||result.width<1||result.width>tiffLimits.maxEdge||!Number.isInteger(result.height)||result.height<1||result.height>tiffLimits.maxEdge)throw new Error('Invalid TIFF preview response');
   // A slow conversion must not outlive document deletion or access revocation.
   const currentActor=await requireActor(req,{scope:'documents:read'});
   if(currentActor.workspaceId!==actor.workspaceId||currentActor.userId!==actor.userId)notFound();
   const current=await read();if(!current||current.storage_key!==document.storage_key||current.sha256!==document.sha256||current.page_count!==document.page_count||current.mime_type!=='image/tiff')notFound();
   return reply.header('Content-Type','image/jpeg').header('Content-Length',result.bytes.length).header('Cache-Control','private, no-store')
    .header('Content-Disposition','inline').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
    .header('Content-Security-Policy',"sandbox; default-src 'none'").header('X-Folio-Page-Count',String(result.pageCount)).header('X-Folio-Preview-Page',String(page)).header('X-Folio-Source-Sha256',document.sha256).send(result.bytes);
  }finally{req.raw.off('aborted',disconnect);reply.raw.off('close',disconnect);}
 });
}
