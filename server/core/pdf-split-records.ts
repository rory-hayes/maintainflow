import type {PoolClient} from 'pg';
import {notFound,badRequest} from './db.js';
import {ParserFormatNotAllowedError,SourceIntakeRejectedError} from './intake-policy.js';
import {isSourceValidationReason} from './source-validation.js';
import {canonicalPdfSplitSpec,PdfSplitValidationError,isPdfSplitValidationReason,type PdfSplitReceipt,type PdfSplitRootLineage,type StoredPdfSplitRejected} from '../../shared/pdf-split.js';
export type {PdfSplitReceipt} from '../../shared/pdf-split.js';

/** Raw receipt is server-only. Call the explicit DTO reader before responding. */
export async function findPdfSplitByRequest(c:PoolClient,workspaceId:string,requestId:string){
 return (await c.query('select * from pdf_splits where workspace_id=$1 and request_id=$2',[workspaceId,requestId])).rows[0];
}

export function splitRootPages(row:any,start:number,end:number):PdfSplitRootLineage{
 const offset=row.root_page_start??1;
 return {kind:row.root_kind??'pdf-split',id:row.root_id??row.id,sha256:row.root_sha256??row.source_sha256,
  pageCount:row.root_page_count??row.source_page_count,pageStart:offset+start-1,pageEnd:offset+end-1};
}

/** Reconstruct only finite application-owned errors; never persist error messages. */
export function splitReceiptError(row:any):Error{
 if(row.rejection_code==='parser_format_not_allowed'&&['pdf','tiff'].includes(row.rejection_reason))return new ParserFormatNotAllowedError(row.parser_id,row.rejection_reason);
 if(row.rejection_code==='source_validation_failed'&&isSourceValidationReason(row.rejection_reason))return new SourceIntakeRejectedError(row.parser_id,row.rejection_reason);
 if(row.rejection_code==='pdf_split_validation_failed'&&isPdfSplitValidationReason(row.rejection_reason))return new PdfSplitValidationError(row.rejection_reason);
 return new Error('The PDF split receipt could not be read.');
}

/** A successful read of an authoritative terminal outcome, bound to its exact request. */
export function storedPdfSplitRejection(row:any):StoredPdfSplitRejected{
 if(row.state!=='rejected'||!row.source_document_id)throw new Error('Expected a stored PDF rejection');
 const error=splitReceiptError(row);
 return {rejected:{id:row.id,requestId:row.request_id,parserId:row.parser_id,sourceDocumentId:row.source_document_id,
  sourceSha256:row.source_sha256,...(row.ai_suggestion?{aiSuggestion:row.ai_suggestion}:{}),...(row.source_mime_type==='image/tiff'?{sourceMimeType:'image/tiff' as const}:{}),options:JSON.parse(canonicalPdfSplitSpec(row.canonical_spec)),code:row.rejection_code,reason:row.rejection_reason,message:error.message}};
}

export async function readPdfSplitReceipt(c:PoolClient,workspaceId:string,splitId:string,replayed=false):Promise<PdfSplitReceipt>{
 const row=(await c.query(`select s.*,exists(select 1 from documents d where d.id=s.source_document_id
  and d.workspace_id=s.workspace_id and d.parser_id=s.parser_id) source_document_available
  from pdf_splits s where s.id=$1 and s.workspace_id=$2`,[splitId,workspaceId])).rows[0];
 if(!row)notFound('PDF split not found');
 if(row.state==='rejected')throw splitReceiptError(row);
 const children=(await c.query(`select m.*,d.id live_id from pdf_split_children m
  left join documents d on d.id=m.document_id and d.workspace_id=m.workspace_id and d.parser_id=m.parser_id
   and d.pdf_split_id=m.split_id and d.pdf_split_index=m.child_index
  where m.split_id=$1 and m.workspace_id=$2 order by m.child_index`,[splitId,workspaceId])).rows;
 return {
  split:{id:row.id,requestId:row.request_id,parserId:row.parser_id,sourceName:row.source_name,
   ...(row.ai_suggestion?{aiSuggestion:row.ai_suggestion}:{}),
   ...(row.source_mime_type==='image/tiff'?{sourceMimeType:'image/tiff' as const}:{}),sourcePageCount:row.source_page_count,selectedPages:row.selected_pages,childCount:row.child_count,
   sourceAvailable:Boolean(row.source_storage_key)&&children.some(child=>Boolean(child.live_id)),createdAt:new Date(row.created_at).toISOString(),
   ...(row.source_document_id?{origin:'stored' as const,sourceDocumentId:row.source_document_id,
   sourceDocumentAvailable:row.source_document_available,sourceSha256:row.source_sha256,
   undoneAt:row.undone_at?new Date(row.undone_at).toISOString():null}:{})},
  documents:children.map(child=>({id:child.document_id,jobId:child.job_id,name:child.live_id?child.document_name:null,
   pageCount:child.end_page-child.start_page+1,originalPageStart:child.start_page,originalPageEnd:child.end_page,
   index:child.child_index,available:Boolean(child.live_id),...(row.source_document_id?{root:splitRootPages(row,child.start_page,child.end_page)}:{})})),replayed,
 };
}

export async function pdfSplitDetail(c:PoolClient,workspaceId:string,documentId:string,includeUploadRoot=false){
 const row=(await c.query(`select s.id,s.child_count,s.source_page_count,s.source_name,s.source_storage_key,
  s.source_mime_type,s.source_sha256,s.source_document_id,s.request_id,s.parser_id,s.undone_at,s.ai_suggestion,
  s.root_kind,s.root_id,s.root_sha256,s.root_page_count,s.root_page_start,
  exists(select 1 from documents origin where origin.id=s.source_document_id and origin.workspace_id=s.workspace_id and origin.parser_id=s.parser_id) source_document_available,
  m.child_index,m.start_page,m.end_page,
  (select count(*)::int from documents siblings where siblings.pdf_split_id=s.id and siblings.workspace_id=s.workspace_id) retained_documents
  from documents d join pdf_split_children m on m.document_id=d.id and m.workspace_id=d.workspace_id
   and m.parser_id=d.parser_id and m.split_id=d.pdf_split_id and m.child_index=d.pdf_split_index
  join pdf_splits s on s.id=m.split_id and s.workspace_id=m.workspace_id and s.parser_id=m.parser_id
  where d.id=$1 and d.workspace_id=$2 and s.state='accepted'`,[documentId,workspaceId])).rows[0];
 return row?{id:row.id,index:row.child_index,childCount:row.child_count,originalPageStart:row.start_page,originalPageEnd:row.end_page,
  ...(row.ai_suggestion?{aiSuggestion:row.ai_suggestion}:{}),
  ...(row.source_mime_type==='image/tiff'?{sourceMimeType:'image/tiff' as const}:{}),sourcePageCount:row.source_page_count,sourceName:row.source_name,sourceAvailable:Boolean(row.source_storage_key),retainedDocuments:row.retained_documents,
  ...(row.source_document_id||includeUploadRoot?{origin:row.source_document_id?'stored':'upload',sourceDocumentId:row.source_document_id??null,
  sourceDocumentAvailable:row.source_document_available,requestId:row.request_id,parserId:row.parser_id,
  undoneAt:row.undone_at?new Date(row.undone_at).toISOString():null,root:splitRootPages(row,row.start_page,row.end_page)}:{})}:null;
}

/** Internal storage descriptor, available only through a currently live owned child. */
export async function retainedPdfSource(c:PoolClient,workspaceId:string,documentId:string):Promise<{storage_key:string;name:string;mime_type:string}|undefined>{
 return (await c.query(`select s.source_storage_key storage_key,s.source_name name,s.source_mime_type mime_type from documents d
  join pdf_split_children m on m.document_id=d.id and m.workspace_id=d.workspace_id and m.parser_id=d.parser_id
   and m.split_id=d.pdf_split_id and m.child_index=d.pdf_split_index
  join pdf_splits s on s.id=m.split_id and s.workspace_id=m.workspace_id and s.parser_id=m.parser_id
  where d.id=$1 and d.workspace_id=$2 and s.state='accepted' and s.source_storage_key is not null`,[documentId,workspaceId])).rows[0];
}

/** All original-object adopters participate in the same owned reference check. */
export async function storedObjectReferenced(c:PoolClient,workspaceId:string,storageKey:string):Promise<boolean>{
 return Boolean((await c.query(`select 1 from documents where workspace_id=$1 and storage_key=$2
  union all select 1 from pdf_splits where workspace_id=$1 and source_storage_key=$2
  union all select 1 from archive_imports where workspace_id=$1 and source_storage_key=$2
  union all select 1 from split_suggestions where workspace_id=$1 and (source_storage_key=$2 or staging_storage_key=$2) limit 1`,[workspaceId,storageKey])).rowCount);
}

/** A nonce bound to an AI draft cannot be adopted through a manual split route. */
export async function assertSplitSuggestionBinding(c:PoolClient,workspaceId:string,requestId:string,suggestionId?:string){
 const rows=(await c.query('select id from split_suggestions where workspace_id=$1 and confirmed_request_id=$2',[workspaceId,requestId])).rows;
 const receipt=await findPdfSplitByRequest(c,workspaceId,requestId);
 if(rows.some(row=>row.id!==suggestionId)||suggestionId&&!rows.some(row=>row.id===suggestionId)||receipt&&(receipt.ai_suggestion?.suggestionId??undefined)!==suggestionId)badRequest('This split request belongs to a different creation flow. Retry its original request.',409);
}

/** All upload reservations for a request share one source and one confirmed plan.
 * Call only while holding the workspace admission lock, including multipart intake.
 */
export async function assertUploadedSplitBinding(c:PoolClient,workspaceId:string,parserId:string,requestId:string,sha256:string,canonical?:string,suggestionId?:string){
 await assertSplitSuggestionBinding(c,workspaceId,requestId,suggestionId);
 const conflict=()=>badRequest('This split request already belongs to a different source or page selection. Retry its original request.',409);
 if((await c.query('select 1 from stored_pdf_split_requests where workspace_id=$1 and request_id=$2',[workspaceId,requestId])).rowCount)conflict();
 const prior=await findPdfSplitByRequest(c,workspaceId,requestId);
 if(prior&&(prior.source_document_id||prior.parser_id!==parserId||prior.source_sha256!==sha256||canonical!==undefined&&canonicalPdfSplitSpec(prior.canonical_spec)!==canonical))conflict();
 const reservations=(await c.query('select parser_id,expected_sha256,pdf_split_spec from direct_uploads where workspace_id=$1 and pdf_split_request_id=$2',[workspaceId,requestId])).rows;
 for(const row of reservations)if(row.parser_id!==parserId||row.expected_sha256!==sha256||canonical!==undefined&&row.pdf_split_spec&&canonicalPdfSplitSpec(row.pdf_split_spec)!==canonical)conflict();
 return prior;
}
