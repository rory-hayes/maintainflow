import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {pdfGeometrySchema,pdfRegionLimits,PdfGeometryError,type PdfGeometry} from '../../shared/pdf-regions.js';
import {canonicalTemplateDefinition,type TemplateDefinition} from '../../shared/template-definitions.js';
import {badRequest,notFound} from './db.js';
import {readStoredObject,validateStorageKey} from './storage.js';
import {readPdfGeometry} from './source.js';
import {SourceValidationError} from './source-validation.js';
import {templateDefinitionInput} from './template-input.js';
import {selectCurrentTemplateExtraction,previewTemplateDefinition} from './template-region-selection.js';
import {templateAuthorization,withTemplateAuthorization,lockTemplateParser,requireNativeTemplateParser,templateUuid,type TemplateAuthorization} from './template-mutations.js';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const sourceBinding=z.object({documentId:templateUuid,sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),baseSchemaId:templateUuid}).strict();
const draftInput=sourceBinding.extend({definition:templateDefinitionInput}).strict();
const unavailable=()=>Object.assign(new Error('Native PDF preview could not finish. Retry the same preview.'),{statusCode:503});
export type TemplateRegionOptions={signal?:AbortSignal;timeoutMs?:number;readSource?:typeof readStoredObject;readGeometry?:typeof readPdfGeometry};
type BoundSource=z.infer<typeof sourceBinding>;
type Operation=ReturnType<typeof operation>;

function operation(options:TemplateRegionOptions){
 const timeoutMs=options.timeoutMs??45_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>45_000)throw new Error('Native PDF preview deadline must be positive and at most 45 seconds');
 const controller=new AbortController(),deadline=Date.now()+timeoutMs;
 const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 const timer=setTimeout(abort,timeoutMs);timer.unref();
 const check=()=>{if(controller.signal.aborted||Date.now()>=deadline)throw unavailable();};
 const bounded=<T>(work:Promise<T>)=>new Promise<T>((resolve,reject)=>{
  const stop=()=>reject(unavailable());controller.signal.addEventListener('abort',stop,{once:true});
  work.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',stop));
  if(controller.signal.aborted)stop();
 });
 return {check,bounded,signal:controller.signal,remaining(){check();return deadline-Date.now();},close(){clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}};
}
function requestSignal(request:FastifyRequest,reply:FastifyReply){
 const controller=new AbortController(),abort=()=>{if(!reply.raw.writableEnded)controller.abort();};
 request.raw.once('aborted',abort);reply.raw.once('close',abort);if(request.raw.aborted||reply.raw.destroyed)abort();
 return {signal:controller.signal,close(){request.raw.off('aborted',abort);reply.raw.off('close',abort);}};
}
function privateResponse(reply:FastifyReply){return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');}

async function snapshot(c:PoolClient,auth:TemplateAuthorization,parserId:string,documentId:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[auth.actor.workspaceId]);
 const parser=await lockTemplateParser(c,auth.actor.workspaceId,parserId);
 const document=(await c.query('select id,name,storage_key,sha256,mime_type,byte_size,page_count,source_text from documents where id=$1 and parser_id=$2 and workspace_id=$3',[documentId,parserId,auth.actor.workspaceId])).rows[0];
 if(!document)notFound('Document not found in this parser');
 const templates=(await c.query('select * from templates where parser_id=$1 and workspace_id=$2 order by created_at,id',[parserId,auth.actor.workspaceId])).rows;
 return {parser,document,templates};
}
function signature(value:Awaited<ReturnType<typeof snapshot>>){
 const {parser,document,templates}=value;
 return JSON.stringify({schema:parser.active_schema_id,locale:parser.locale,mode:parser.mode,archived:parser.archived,setup:parser.field_setup_state,allowedFormats:parser.allowed_formats,document,templates});
}
async function scope<T>(auth:TemplateAuthorization,op:Operation,write:boolean,fn:(c:PoolClient)=>Promise<T>){
 op.check();return op.bounded(withTemplateAuthorization(auth,write?['parsers:read','parsers:write','documents:read']:['parsers:read','documents:read'],write,async c=>{
  op.check();await c.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",[String(Math.min(10_000,op.remaining())),String(Math.min(5_000,op.remaining()))]);
  const result=await fn(c);op.check();return result;
 }));
}
function validateSource(value:Awaited<ReturnType<typeof snapshot>>,binding?:BoundSource){
 const {parser,document}=value;
 requireNativeTemplateParser(parser,binding?.baseSchemaId);
 if(binding&&document.sha256!==binding.sourceSha256)badRequest('The selected document changed. Reload its original before editing regions.',409);
 if(document.mime_type!=='application/pdf')badRequest('Native region templates require a stored PDF document.',415);
 const size=Number(document.byte_size);
 if(!Number.isSafeInteger(size)||size<1||size>pdfRegionLimits.maxBytes||!Number.isInteger(document.page_count)||document.page_count<1||document.page_count>pdfRegionLimits.maxPages)badRequest('Choose a PDF of at most 10 MB and 30 pages.',413);
}
async function geometryFor(value:Awaited<ReturnType<typeof snapshot>>,auth:TemplateAuthorization,op:Operation,options:TemplateRegionOptions):Promise<PdfGeometry>{
 const document=value.document;validateStorageKey(document.storage_key,auth.actor.workspaceId);
 let bytes:Buffer;
 try{bytes=await op.bounded((options.readSource??readStoredObject)(document.storage_key));}
 catch(error){op.check();if((error as {statusCode?:number;code?:string}).statusCode===404||(error as {code?:string}).code==='ENOENT')notFound('Original file is unavailable');throw unavailable();}
 op.check();
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(document.byte_size)||bytes.length>pdfRegionLimits.maxBytes||sha(bytes)!==document.sha256)badRequest('The original PDF could not be verified. Reload or upload it again.',409);
 if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))badRequest('Native region templates require actual PDF bytes.',415);
 let result:PdfGeometry;
 try{result=await op.bounded((options.readGeometry??readPdfGeometry)(bytes,{signal:op.signal,timeoutMs:Math.min(30_000,op.remaining())}));}
 catch(error){op.check();if(error instanceof SourceValidationError||error instanceof PdfGeometryError)throw error;throw unavailable();}
 op.check();const parsed=pdfGeometrySchema.safeParse(result);
 if(!parsed.success||result.sourceSha256!==document.sha256||result.pageCount!==document.page_count||Buffer.byteLength(JSON.stringify(result))>pdfRegionLimits.maxOutputBytes)throw unavailable();
 return parsed.data;
}
function sourceMetadata(document:any){return {documentId:document.id,sha256:document.sha256,mimeType:'application/pdf' as const,pageCount:document.page_count,size:Number(document.byte_size),name:document.name};}

/** Reads only the existing private original; no sample copy, job or page charge. */
export async function readTemplateRegionSource(auth:TemplateAuthorization,parserId:string,binding:BoundSource,options:TemplateRegionOptions={}){
 const input=sourceBinding.parse(binding),op=operation(options);
 try{
  const first=await scope(auth,op,true,async c=>{const found=await snapshot(c,auth,parserId,input.documentId);validateSource(found,input);return found;});
  const geometry=await geometryFor(first,auth,op,options);
  await scope(auth,op,true,async c=>{const current=await snapshot(c,auth,parserId,input.documentId);validateSource(current,input);if(signature(current)!==signature(first))badRequest('The parser, template settings or original changed during this preview. Reload and preview again.',409);});
  op.check();return {source:sourceMetadata(first.document),schemaId:first.parser.active_schema_id,geometry};
 }finally{op.close();}
}

export async function previewTemplateDraft(auth:TemplateAuthorization,parserId:string,input:BoundSource&{definition:TemplateDefinition},options:TemplateRegionOptions={}){
 const body=draftInput.parse(input),op=operation(options);
 try{
  const first=await scope(auth,op,true,async c=>{const found=await snapshot(c,auth,parserId,body.documentId);validateSource(found,body);return found;});
  const geometry=await geometryFor(first,auth,op,options);
  const checked=previewTemplateDefinition(first.document.source_text,first.parser.schema,first.parser.locale,body.definition,geometry);
  await scope(auth,op,true,async c=>{const current=await snapshot(c,auth,parserId,body.documentId);validateSource(current,body);if(signature(current)!==signature(first))badRequest('The parser, template settings or original changed during this preview. Reload and preview again.',409);});
  op.check();return {source:sourceMetadata(first.document),schemaId:first.parser.active_schema_id,definitionDigest:sha(canonicalTemplateDefinition(body.definition)),evaluatedWhileDisabled:!body.definition.enabled,...checked,result:checked.result??null};
 }finally{op.close();}
}

/** Current saved settings only; retain the historical selection-only public DTO. */
export async function checkSavedTemplates(auth:TemplateAuthorization,parserId:string,documentId:string,options:TemplateRegionOptions={}){
 const op=operation(options);
 try{
  const first=await scope(auth,op,false,c=>snapshot(c,auth,parserId,documentId));
  let geometry:PdfGeometry|undefined;
  if(first.document.mime_type==='application/pdf'&&first.templates.some(template=>template.enabled&&template.kind==='native-pdf-region-v1')){
   validateSource(first);geometry=await geometryFor(first,auth,op,options);
  }
  const {selection,candidates,availableSourceText}=selectCurrentTemplateExtraction(first.document.source_text,first.parser.schema,first.parser.locale,first.templates,first.parser.mode,geometry);
  await scope(auth,op,false,async c=>{const current=await snapshot(c,auth,parserId,documentId);if(signature(current)!==signature(first))badRequest('Saved settings or the original changed during this check. Check templates again.',409);});
  op.check();return {selection,candidates,availableSourceText};
 }finally{op.close();}
}

export function registerTemplateRegionRoutes(app:FastifyInstance,options:TemplateRegionOptions={}){
 const params=z.object({id:templateUuid});
 app.post('/api/parsers/:id/templates/geometry',async(request,reply)=>{
  const lifetime=requestSignal(request,reply);
  try{const auth=await templateAuthorization(request,['parsers:read','parsers:write','documents:read'],true),{id}=params.parse(request.params),body=sourceBinding.parse(request.body);return privateResponse(reply).send(await readTemplateRegionSource(auth,id,body,{...options,signal:lifetime.signal}));}finally{lifetime.close();}
 });
 app.post('/api/parsers/:id/templates/preview',async(request,reply)=>{
  const lifetime=requestSignal(request,reply);
  try{const auth=await templateAuthorization(request,['parsers:read','parsers:write','documents:read'],true),{id}=params.parse(request.params),body=draftInput.parse(request.body);return privateResponse(reply).send(await previewTemplateDraft(auth,id,body,{...options,signal:lifetime.signal}));}finally{lifetime.close();}
 });
 app.post('/api/parsers/:id/templates/check',async(request,reply)=>{
  const lifetime=requestSignal(request,reply);
  try{const auth=await templateAuthorization(request,['parsers:read','documents:read'],false),{id}=params.parse(request.params),{documentId}=z.object({documentId:templateUuid}).strict().parse(request.body);return privateResponse(reply).send(await checkSavedTemplates(auth,id,documentId,{...options,signal:lifetime.signal}));}finally{lifetime.close();}
 });
}
