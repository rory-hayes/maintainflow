import type {PoolClient} from 'pg';
import {notFound} from './db.js';
import {ParserFormatNotAllowedError,SourceIntakeRejectedError} from './intake-policy.js';
import {isSourceValidationReason} from './source-validation.js';
import {PdfSplitValidationError,isPdfSplitValidationReason,type PdfSplitReceipt} from '../../shared/pdf-split.js';
export type {PdfSplitReceipt} from '../../shared/pdf-split.js';

/** Raw receipt is server-only. Call the explicit DTO reader before responding. */
export async function findPdfSplitByRequest(c:PoolClient,workspaceId:string,requestId:string){
 return (await c.query('select * from pdf_splits where workspace_id=$1 and request_id=$2',[workspaceId,requestId])).rows[0];
}

/** Reconstruct only finite application-owned errors; never persist error messages. */
export function splitReceiptError(row:any):Error{
 if(row.rejection_code==='parser_format_not_allowed'&&row.rejection_reason==='pdf')return new ParserFormatNotAllowedError(row.parser_id,'pdf');
 if(row.rejection_code==='source_validation_failed'&&isSourceValidationReason(row.rejection_reason))return new SourceIntakeRejectedError(row.parser_id,row.rejection_reason);
 if(row.rejection_code==='pdf_split_validation_failed'&&isPdfSplitValidationReason(row.rejection_reason))return new PdfSplitValidationError(row.rejection_reason);
 return new Error('The PDF split receipt could not be read.');
}

export async function readPdfSplitReceipt(c:PoolClient,workspaceId:string,splitId:string,replayed=false):Promise<PdfSplitReceipt>{
 const row=(await c.query('select * from pdf_splits where id=$1 and workspace_id=$2',[splitId,workspaceId])).rows[0];
 if(!row)notFound('PDF split not found');
 if(row.state==='rejected')throw splitReceiptError(row);
 const children=(await c.query(`select m.*,d.id live_id from pdf_split_children m
  left join documents d on d.id=m.document_id and d.workspace_id=m.workspace_id and d.parser_id=m.parser_id
   and d.pdf_split_id=m.split_id and d.pdf_split_index=m.child_index
  where m.split_id=$1 and m.workspace_id=$2 order by m.child_index`,[splitId,workspaceId])).rows;
 return {
  split:{id:row.id,requestId:row.request_id,parserId:row.parser_id,sourceName:row.source_name,
   sourcePageCount:row.source_page_count,selectedPages:row.selected_pages,childCount:row.child_count,
   sourceAvailable:Boolean(row.source_storage_key)&&children.some(child=>Boolean(child.live_id)),createdAt:new Date(row.created_at).toISOString()},
  documents:children.map(child=>({id:child.document_id,jobId:child.job_id,name:child.live_id?child.document_name:null,
   pageCount:child.end_page-child.start_page+1,originalPageStart:child.start_page,originalPageEnd:child.end_page,
   index:child.child_index,available:Boolean(child.live_id)})),replayed,
 };
}

export async function pdfSplitDetail(c:PoolClient,workspaceId:string,documentId:string){
 const row=(await c.query(`select s.id,s.child_count,s.source_page_count,s.source_name,s.source_storage_key,
  m.child_index,m.start_page,m.end_page,
  (select count(*)::int from documents siblings where siblings.pdf_split_id=s.id and siblings.workspace_id=s.workspace_id) retained_documents
  from documents d join pdf_split_children m on m.document_id=d.id and m.workspace_id=d.workspace_id
   and m.parser_id=d.parser_id and m.split_id=d.pdf_split_id and m.child_index=d.pdf_split_index
  join pdf_splits s on s.id=m.split_id and s.workspace_id=m.workspace_id and s.parser_id=m.parser_id
  where d.id=$1 and d.workspace_id=$2 and s.state='accepted'`,[documentId,workspaceId])).rows[0];
 return row?{id:row.id,index:row.child_index,childCount:row.child_count,originalPageStart:row.start_page,originalPageEnd:row.end_page,
  sourcePageCount:row.source_page_count,sourceName:row.source_name,sourceAvailable:Boolean(row.source_storage_key),retainedDocuments:row.retained_documents}:null;
}

/** Internal storage descriptor, available only through a currently live owned child. */
export async function retainedPdfSource(c:PoolClient,workspaceId:string,documentId:string):Promise<{storage_key:string;name:string}|undefined>{
 return (await c.query(`select s.source_storage_key storage_key,s.source_name name from documents d
  join pdf_split_children m on m.document_id=d.id and m.workspace_id=d.workspace_id and m.parser_id=d.parser_id
   and m.split_id=d.pdf_split_id and m.child_index=d.pdf_split_index
  join pdf_splits s on s.id=m.split_id and s.workspace_id=m.workspace_id and s.parser_id=m.parser_id
  where d.id=$1 and d.workspace_id=$2 and s.state='accepted' and s.source_storage_key is not null`,[documentId,workspaceId])).rows[0];
}

/** All original-object adopters participate in the same owned reference check. */
export async function storedObjectReferenced(c:PoolClient,workspaceId:string,storageKey:string):Promise<boolean>{
 return Boolean((await c.query(`select 1 from documents where workspace_id=$1 and storage_key=$2
  union all select 1 from pdf_splits where workspace_id=$1 and source_storage_key=$2 limit 1`,[workspaceId,storageKey])).rowCount);
}
