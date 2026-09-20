import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {canonicalPdfSplitSpec,pdfSplitSpecSchema,planPdfSplit,type PdfSplitReceipt} from '../../shared/pdf-split.js';
import {splitSuggestionRanges,type SplitSuggestionProvenance} from '../../shared/split-suggestions.js';
import {requireActor,editors} from './auth.js';
import {badRequest,notFound} from './db.js';
import {addSplitDocuments,type SplitSuggestionContext} from './pdf-split-intake.js';
import {findPdfSplitByRequest,readPdfSplitReceipt} from './pdf-split-records.js';
import {storedPdfAuthorization,splitStoredPdf,type StoredPdfAuthorization,type StoredPdfSplitOptions} from './stored-pdf-split.js';
import {withSplitSuggestionAuthorization,readSplitSuggestionSource} from './split-suggestions.js';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const input=z.object({requestId:uuid,options:pdfSplitSpecSchema}).strict();
const conflict=()=>badRequest('This suggestion or split request already belongs to a different confirmed selection. Check its original result.',409);
const closed=()=>badRequest('This suggestion can no longer create documents. Check its result or start a new split.',410);
type Row=Record<string,any>;
type Services=Pick<StoredPdfSplitOptions,'splitSource'|'timeoutMs'>;

/** The same workspace fence orders Create, cancellation, expiry and recovery. */
export async function createSuggestedSplit(auth:StoredPdfAuthorization,parserId:string,suggestionId:string,body:unknown,services:Services={}):Promise<PdfSplitReceipt>{
 parserId=uuid.parse(parserId);suggestionId=uuid.parse(suggestionId);
 const {requestId,options}=input.parse(body),canonical=canonicalPdfSplitSpec(options),{actor}=auth;
 const timeoutMs=services.timeoutMs??120_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new Error('Split deadline must be positive and at most 120 seconds');
 const deadline=Date.now()+timeoutMs;
 const remaining=()=>{const ms=deadline-Date.now();if(ms<=0)badRequest('Document splitting took too long. Retry the same request.',503);return ms;};
 const fence=<T>(fn:(c:PoolClient)=>Promise<T>)=>withSplitSuggestionAuthorization(auth,async c=>{
  remaining();await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
  await c.query('select id from parsers where id=$1 and workspace_id=$2 for update',[parserId,actor.workspaceId]);
  const result=await fn(c);remaining();return result;
 });
 async function owned(c:PoolClient):Promise<Row>{
  const row=(await c.query('select *,expires_at>clock_timestamp() live from split_suggestions where id=$1 and parser_id=$2 and workspace_id=$3 and requested_by=$4 for update',[suggestionId,parserId,actor.workspaceId,actor.userId])).rows[0];
  if(!row)notFound('Split suggestion not found');return row;
 }
 async function assertCurrent(c:PoolClient){
  const row=await owned(c);
  if(row.confirmed_request_id!==requestId||canonicalPdfSplitSpec(row.confirmed_options)!==canonical)conflict();
  const receipt=await findPdfSplitByRequest(c,actor.workspaceId,requestId);
  if(receipt){
   if(receipt.ai_suggestion?.suggestionId!==suggestionId||receipt.parser_id!==parserId||receipt.source_sha256!==row.source_sha256||canonicalPdfSplitSpec(receipt.canonical_spec)!==canonical)conflict();
   // Accepted/rejected receipts remain recoverable after source expiry or Undo.
   return;
  }
  if(row.accepted_split_id)conflict();
  if(row.state!=='ready'||!row.live||!row.source_storage_key||row.source_released_at)closed();
  const parser=(await c.query('select archived,field_setup_state,allowed_formats from parsers where id=$1 and workspace_id=$2',[parserId,actor.workspaceId])).rows[0];
  if(!parser||parser.archived)notFound('Active parser not found');
  if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before splitting a document.',409);
  const format=row.source_mime_type==='image/tiff'?'tiff':'pdf';
  if(parser.allowed_formats!==null&&!parser.allowed_formats.includes(format))badRequest('This parser no longer accepts the source format.',415);
  if(row.source_document_id){
   const doc=(await c.query('select * from documents where id=$1 and workspace_id=$2 and parser_id=$3 for share',[row.source_document_id,actor.workspaceId,parserId])).rows[0];
   if(!doc)notFound('Original document not found');
   if(doc.storage_key!==row.original_source_key||doc.sha256!==row.source_sha256||doc.mime_type!==row.source_mime_type||doc.page_count!==row.original_page_count||Number(doc.byte_size)!==row.expected_bytes)conflict();
  }
 }
 const admitted=await fence(async c=>{
  const row=await owned(c);
  if(row.confirmed_request_id&&(row.confirmed_request_id!==requestId||canonicalPdfSplitSpec(row.confirmed_options)!==canonical))conflict();
  if((await c.query('select 1 from split_suggestions where workspace_id=$1 and confirmed_request_id=$2 and id<>$3',[actor.workspaceId,requestId,suggestionId])).rowCount)conflict();
  const prior=await findPdfSplitByRequest(c,actor.workspaceId,requestId);
  if(prior){
   if(prior.ai_suggestion?.suggestionId!==suggestionId||prior.parser_id!==parserId||prior.source_sha256!==row.source_sha256||canonicalPdfSplitSpec(prior.canonical_spec)!==canonical)conflict();
   return {receipt:await readPdfSplitReceipt(c,actor.workspaceId,prior.id,true)};
  }
  if(!row.confirmed_request_id){
   // Reserve the namespace before any source I/O. A manual upload cannot later
   // adopt this UUID, even after a closed result resolves an uncertain request.
   if((await c.query('select 1 from stored_pdf_split_requests where workspace_id=$1 and request_id=$2 union all select 1 from direct_uploads where workspace_id=$1 and pdf_split_request_id=$2',[actor.workspaceId,requestId])).rowCount)conflict();
   if(row.state!=='ready'||!row.live||row.accepted_split_id)closed();
   await c.query('update split_suggestions set confirmed_request_id=$2,confirmed_options=$3,updated_at=clock_timestamp() where id=$1',[suggestionId,requestId,canonical]);
  }
  await assertCurrent(c);
  const ranges=planPdfSplit(options,row.page_count).ranges;
  splitSuggestionRanges(row.start_pages,row.page_count);
  const provenance:SplitSuggestionProvenance={suggestionId,requestId:row.request_id,sourceSha256:row.source_sha256,sourcePageCount:row.page_count,model:row.model,promptVersion:row.prompt_version,startPages:[...row.start_pages],confirmedRanges:ranges,tokenUsage:row.token_usage,costUsd:Number(row.cost_usd)};
  return {row,provenance};
 });
 if(admitted.receipt)return admitted.receipt;
 const {row,provenance}=admitted as {row:Row;provenance:SplitSuggestionProvenance};
 const suggestion:SplitSuggestionContext={provenance,
  transaction:fn=>fence(async c=>{await assertCurrent(c);const result=await fn(c);await assertCurrent(c);return result;}),
  assertSource:assertCurrent,
  async complete(c,splitId,accepted){
   // Recheck the live proposal before publishing its receipt. Both metadata and
   // documents commit atomically; a lost acknowledgement is safely replayable.
   const current=await owned(c);
   if(current.state!=='ready'||!current.live||current.accepted_split_id||current.confirmed_request_id!==requestId)closed();
   await c.query('update pdf_splits set ai_suggestion=$3 where id=$1 and workspace_id=$2',[splitId,actor.workspaceId,JSON.stringify(provenance)]);
   await c.query("update split_suggestions set accepted_split_id=$2,state=case when $2::uuid is null then 'cancelled' else state end,error=null,updated_at=clock_timestamp() where id=$1",[suggestionId,accepted?splitId:null]);
  },
 };
 if(row.source_document_id)return splitStoredPdf(auth,row.source_document_id,requestId,row.source_sha256,options,{...services,timeoutMs:remaining(),suggestion});
 const {bytes}=await readSplitSuggestionSource(auth,parserId,suggestionId,{timeoutMs:Math.min(90_000,remaining())});
 return addSplitDocuments(actor,parserId,bytes,row.source_name,requestId,options,{...services,timeoutMs:remaining(),suggestion});
}

export async function registerSplitSuggestionCreate(app:FastifyInstance,services:Services={}){
 app.post('/api/parsers/:id/split-suggestions/:suggestionId/create',async(request,reply)=>{
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'});await requireActor(request,{scope:'documents:read'});
  const {id,suggestionId}=z.object({id:uuid,suggestionId:uuid}).parse(request.params);
  return reply.code(202).send(await createSuggestedSplit(storedPdfAuthorization(request,actor),id,suggestionId,request.body,services));
 });
}
