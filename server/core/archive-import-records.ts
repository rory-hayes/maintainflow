import type {PoolClient} from 'pg';
import {notFound} from './db.js';
import {ParserFormatNotAllowedError,SourceIntakeRejectedError} from './intake-policy.js';
import {isSourceValidationReason} from './source-validation.js';
import {sourceFormats} from '../../shared/source-formats.js';
import {ArchiveImportValidationError,isArchiveImportValidationReason,canonicalArchiveImportSpec,type ArchiveImportReceipt,type ArchiveImportLineage} from '../../shared/archive-import.js';

export async function findArchiveImportByRequest(c:PoolClient,workspaceId:string,requestId:string){
 return (await c.query('select * from archive_imports where workspace_id=$1 and request_id=$2',[workspaceId,requestId])).rows[0];
}
export function archiveReceiptError(row:any):Error{
 if(row.rejection_code==='archive_import_validation_failed'&&isArchiveImportValidationReason(row.rejection_reason))return new ArchiveImportValidationError(row.rejection_reason);
 if(row.rejection_code==='source_validation_failed'&&isSourceValidationReason(row.rejection_reason))return new SourceIntakeRejectedError(row.parser_id,row.rejection_reason);
 const format=sourceFormats.find(item=>item.id===row.rejection_reason)?.id;
 if(row.rejection_code==='parser_format_not_allowed'&&format)return new ParserFormatNotAllowedError(row.parser_id,format);
 return new Error('The ZIP import receipt could not be read.');
}
export async function readArchiveImportReceipt(c:PoolClient,workspaceId:string,archiveId:string,replayed=false):Promise<ArchiveImportReceipt>{
 const row=(await c.query('select * from archive_imports where id=$1 and workspace_id=$2',[archiveId,workspaceId])).rows[0];
 if(!row)notFound('ZIP import not found');
 if(row.state==='rejected')throw archiveReceiptError(row);
 const entries=(await c.query(`select m.*,d.id live_id from archive_import_entries m
  left join documents d on d.id=m.document_id and d.workspace_id=m.workspace_id and d.parser_id=m.parser_id
   and d.archive_import_id=m.archive_id and d.archive_entry_index=m.entry_index
  where m.archive_id=$1 and m.workspace_id=$2 order by m.entry_index`,[archiveId,workspaceId])).rows;
 return {archive:{id:row.id,requestId:row.request_id,parserId:row.parser_id,sourceName:row.source_name,
  childCount:row.child_count,totalPages:row.total_pages,sourceAvailable:Boolean(row.source_storage_key)&&entries.some(entry=>Boolean(entry.live_id)),createdAt:new Date(row.created_at).toISOString()},
  documents:entries.map(entry=>({id:entry.document_id,jobId:entry.job_id,index:entry.entry_index,path:entry.live_id?entry.entry_path:null,
   name:entry.live_id?entry.document_name:null,pageCount:entry.page_count,available:Boolean(entry.live_id)})),replayed};
}
export async function archiveImportDetail(c:PoolClient,workspaceId:string,documentId:string):Promise<ArchiveImportLineage|null>{
 const row=(await c.query(`select a.id,a.child_count,a.total_pages,a.source_name,a.source_storage_key,m.entry_index,m.entry_path,
  (select count(*)::int from documents siblings where siblings.archive_import_id=a.id and siblings.workspace_id=a.workspace_id) retained_documents
  from documents d join archive_import_entries m on m.document_id=d.id and m.workspace_id=d.workspace_id and m.parser_id=d.parser_id
   and m.archive_id=d.archive_import_id and m.entry_index=d.archive_entry_index
  join archive_imports a on a.id=m.archive_id and a.workspace_id=m.workspace_id and a.parser_id=m.parser_id
  where d.id=$1 and d.workspace_id=$2 and a.state='accepted'`,[documentId,workspaceId])).rows[0];
 return row?{id:row.id,index:row.entry_index,path:row.entry_path,childCount:row.child_count,totalPages:row.total_pages,sourceName:row.source_name,sourceAvailable:Boolean(row.source_storage_key),retainedDocuments:row.retained_documents}:null;
}
/** A full ZIP can only be downloaded through a currently live owned child. */
export async function retainedArchiveSource(c:PoolClient,workspaceId:string,documentId:string):Promise<{storage_key:string;name:string}|undefined>{
 return (await c.query(`select a.source_storage_key storage_key,a.source_name name from documents d
  join archive_import_entries m on m.document_id=d.id and m.workspace_id=d.workspace_id and m.parser_id=d.parser_id
   and m.archive_id=d.archive_import_id and m.entry_index=d.archive_entry_index
  join archive_imports a on a.id=m.archive_id and a.workspace_id=m.workspace_id and a.parser_id=m.parser_id
  where d.id=$1 and d.workspace_id=$2 and a.state='accepted' and a.source_storage_key is not null`,[documentId,workspaceId])).rows[0];
}

/** Staged requests freeze their source; receipts and first confirmation freeze selection. */
export async function assertArchiveRequestBinding(c:PoolClient,workspaceId:string,parserId:string,requestId:string,sourceSha:string,canonical?:string){
 const conflict=()=>{throw Object.assign(new Error('This ZIP import request was already used for a different file, parser or selection.'),{statusCode:409});};
 const prior=await findArchiveImportByRequest(c,workspaceId,requestId);
 if(prior&&(prior.parser_id!==parserId||prior.source_sha256!==sourceSha||(canonical!==undefined&&canonicalArchiveImportSpec(prior.canonical_spec)!==canonical)))return conflict();
 const rows=(await c.query('select parser_id,expected_sha256,archive_spec from direct_uploads where workspace_id=$1 and archive_request_id=$2',[workspaceId,requestId])).rows;
 for(const row of rows){
  if(row.parser_id!==parserId||row.expected_sha256!==sourceSha)return conflict();
  if(canonical!==undefined&&row.archive_spec){
   if(canonicalArchiveImportSpec(row.archive_spec)!==canonical)return conflict();
  }
 }
}
