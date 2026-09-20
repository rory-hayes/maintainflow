import {createHash} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {canonicalPdfSplitSpec,pdfSplitLimits,type PdfSplitSpec,type PdfSplitReceipt,type PdfSplitRootLineage,type StoredPdfSplitBatches,type StoredPdfSplitUndo} from '../../shared/pdf-split.js';
import {adminPool,transaction,badRequest,notFound,audit} from './db.js';
import {hashToken,editors} from './auth.js';
import {addSplitDocuments,type StoredPdfSplitContext} from './pdf-split-intake.js';
import {findPdfSplitByRequest,pdfSplitDetail,readPdfSplitReceipt} from './pdf-split-records.js';
import {readStoredObject,validateStorageKey} from './storage.js';
import {purgePdfSplit} from './retention.js';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const digest=z.string().regex(/^[0-9a-f]{64}$/);
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const conflict=()=>badRequest('This split request was already used for a different source or page selection.',409);
export type StoredPdfAuthorization={actor:Actor;tokenHash:string};
/** Hash the already authenticated credential once; plaintext never enters a DTO or DB row. */
export function storedPdfAuthorization(request:FastifyRequest,actor:Actor):StoredPdfAuthorization{
 const token=actor.authType==='api'?request.headers.authorization?.slice(7):request.cookies?.folio_session;
 if(!token)badRequest('Sign in to continue',401);
 return {actor,tokenHash:hashToken(token)};
}

/** Short authorization fences only. File reads, decoding and writes run outside locks. */
export async function withStoredPdfAuthorization<T>(authorization:StoredPdfAuthorization,fn:(c:PoolClient)=>Promise<T>,write=true):Promise<T>{
 const {actor,tokenHash}=authorization;
 try{return await transaction(adminPool,async c=>{
  await c.query("select set_config('app.workspace_id',$1,true)",[actor.workspaceId]);
  // Existing reset/invitation transactions lock users before deleting credentials.
  // Nonblocking auth locks avoid the reverse issuer-membership/user invitation case.
  const user=(await c.query('select id from users where id=$1 for key share nowait',[actor.userId])).rows[0];
  if(!user)badRequest('Your access has expired. Sign in again.',401);
  const member=(await c.query('select role from memberships where workspace_id=$1 and user_id=$2 for share nowait',[actor.workspaceId,actor.userId])).rows[0];
  if(!member||write&&!editors.includes(member.role))badRequest('Your workspace role does not allow this action',403);
  const credential=actor.authType==='api'
   ?(await c.query('select id from api_keys where token_hash=$1 and user_id=$2 and workspace_id=$3 for share nowait',[tokenHash,actor.userId,actor.workspaceId])).rows[0]
   :(await c.query('select id from sessions where token_hash=$1 and user_id=$2 for share nowait',[tokenHash,actor.userId])).rows[0];
  if(!credential)badRequest('Your access has expired or been revoked. Sign in again.',401);
  const valid=async()=>{
   const rows=actor.authType==='api'
    ?await c.query(`select k.scopes from api_keys k join users u on u.id=k.user_id where k.id=$1 and k.revoked_at is null
      and (k.expires_at is null or k.expires_at>clock_timestamp()) and (not u.email_verification_required or u.email_verified_at is not null)`,[credential.id])
    :await c.query(`select s.id from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>clock_timestamp()
      and (not u.email_verification_required or u.email_verified_at is not null)`,[credential.id]);
   if(!rows.rowCount)badRequest('Your access has expired or been revoked. Sign in again.',401);
   if(actor.authType==='api'&&!rows.rows[0].scopes.includes(write?'documents:write':'documents:read'))badRequest('API key does not allow this action',403);
  };
  await valid();const result=await fn(c);await valid();return result;
 });}catch(error){
  if((error as {code?:string}).code==='55P03')badRequest('Workspace access is changing. Retry the same request shortly.',503);
  throw error;
 }
}

type StoredSource={id:string;parser_id:string;sha256:string;storage_key:string;name:string;byte_size:number|string;page_count:number;mime_type:string;root:PdfSplitRootLineage};
async function sourceDescriptor(c:PoolClient,workspaceId:string,documentId:string):Promise<StoredSource>{
 const parser=(await c.query('select p.id from parsers p join documents d on d.parser_id=p.id and d.workspace_id=p.workspace_id where d.id=$1 and d.workspace_id=$2 for update of p',[documentId,workspaceId])).rows[0];
 if(!parser)notFound('Original document not found');
 const row=(await c.query('select id,parser_id,sha256,storage_key,name,byte_size,page_count,mime_type from documents where id=$1 and workspace_id=$2 for update',[documentId,workspaceId])).rows[0];
 if(!row)notFound('Original document not found');
 if(!['application/pdf','image/tiff'].includes(row.mime_type))badRequest('Choose a stored document or TIFF to split.',415);
 if(Number(row.byte_size)>pdfSplitLimits.maxBytes||row.page_count>pdfSplitLimits.maxPages)badRequest('The stored document exceeds the split file or page limit.',413);
 validateStorageKey(row.storage_key,workspaceId);
 const lineage=await pdfSplitDetail(c,workspaceId,documentId,true);
 return {...row,root:lineage?.root??{kind:'document',id:row.id,sha256:row.sha256,pageCount:row.page_count,pageStart:1,pageEnd:row.page_count}};
}

export type StoredPdfSplitOptions={readSource?:typeof readStoredObject;splitSource?:NonNullable<Parameters<typeof addSplitDocuments>[6]>['splitSource'];timeoutMs?:number};
/** A stored source is identified by its document, never by a caller supplied URL/key. */
export async function splitStoredPdf(authorization:StoredPdfAuthorization,documentId:string,requestId:string,sourceSha256:string,spec:PdfSplitSpec,options:StoredPdfSplitOptions={}):Promise<PdfSplitReceipt>{
 documentId=uuid.parse(documentId);requestId=uuid.parse(requestId);sourceSha256=digest.parse(sourceSha256);
 const canonical=canonicalPdfSplitSpec(spec),specHash=sha(canonical),{actor}=authorization;
 const timeoutMs=options.timeoutMs??120_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new Error('Split deadline must be positive and at most 120 seconds');
 const deadline=Date.now()+timeoutMs,controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref();
 const remaining=()=>{const value=deadline-Date.now();if(controller.signal.aborted||value<=0)badRequest('Document splitting took too long. Retry the same request.',503);return value;};
 const runTransaction=<T>(fn:(c:PoolClient)=>Promise<T>)=>withStoredPdfAuthorization(authorization,async c=>{remaining();const result=await fn(c);remaining();return result;});
 try{
 const admitted=await runTransaction(async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
  const prior=await findPdfSplitByRequest(c,actor.workspaceId,requestId);
  if(prior){
   if(prior.source_document_id!==documentId||prior.source_sha256!==sourceSha256||prior.spec_hash!==specHash)conflict();
   return {receipt:await readPdfSplitReceipt(c,actor.workspaceId,prior.id,true)};
  }
  const bound=(await c.query('select * from stored_pdf_split_requests where workspace_id=$1 and request_id=$2',[actor.workspaceId,requestId])).rows[0];
  if(bound&&(bound.source_document_id!==documentId||bound.source_sha256!==sourceSha256||bound.spec_hash!==specHash))conflict();
  if((await c.query('select 1 from direct_uploads where workspace_id=$1 and pdf_split_request_id=$2 limit 1',[actor.workspaceId,requestId])).rowCount)conflict();
  const source=await sourceDescriptor(c,actor.workspaceId,documentId);
  if(source.sha256!==sourceSha256)badRequest('The original document changed. Reload it before splitting.',409);
  if(bound&&bound.parser_id!==source.parser_id)conflict();
  if(!bound)await c.query('insert into stored_pdf_split_requests(workspace_id,request_id,parser_id,source_document_id,source_sha256,canonical_spec,spec_hash) values($1,$2,$3,$4,$5,$6,$7)',[actor.workspaceId,requestId,source.parser_id,documentId,sourceSha256,canonical,specHash]);
  return {source};
 });
 if(admitted.receipt)return admitted.receipt;
 const source=admitted.source!;
 let bytes:Buffer;
 try{bytes=await new Promise<Buffer>((resolve,reject)=>{
  const abort=()=>reject(Object.assign(new Error('Document splitting took too long. Retry the same request.'),{statusCode:503}));
  controller.signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(()=>{remaining();return (options.readSource??readStoredObject)(source.storage_key,pdfSplitLimits.maxBytes);})
   .then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
  if(controller.signal.aborted)abort();
 });remaining();}
 catch(error){if((error as {code?:string}).code==='ENOENT'||(error as {statusCode?:number}).statusCode===404)notFound('Original file is unavailable');throw error;}
 if(!Buffer.isBuffer(bytes)||bytes.length!==Number(source.byte_size)||sha(bytes)!==source.sha256)badRequest('The stored document could not be verified. Reload the document before retrying.',409);
 const storedSource:StoredPdfSplitContext={documentId,pageCount:source.page_count,mimeType:source.mime_type,root:source.root,transaction:runTransaction,
  async assertSource(c){
   const current=await sourceDescriptor(c,actor.workspaceId,documentId);
   if(current.mime_type!==source.mime_type||current.parser_id!==source.parser_id||current.sha256!==source.sha256||current.storage_key!==source.storage_key||current.page_count!==source.page_count||Number(current.byte_size)!==Number(source.byte_size)||JSON.stringify(current.root)!==JSON.stringify(source.root))badRequest('The original document changed. Reload it before splitting.',409);
  },
 };
 return await addSplitDocuments(actor,source.parser_id,bytes,source.name,requestId,JSON.parse(canonical),{splitSource:options.splitSource,timeoutMs:remaining(),storedSource});
 }finally{clearTimeout(timer);}
}

export async function listStoredPdfSplits(authorization:StoredPdfAuthorization,documentId:string,before?:string):Promise<StoredPdfSplitBatches>{
 documentId=uuid.parse(documentId);if(before)before=uuid.parse(before);
 const {actor}=authorization;
 return withStoredPdfAuthorization(authorization,async c=>{
  const sourceAvailable=Boolean((await c.query('select 1 from documents where id=$1 and workspace_id=$2',[documentId,actor.workspaceId])).rowCount);
  if(!sourceAvailable&&!(await c.query("select 1 from pdf_splits where workspace_id=$1 and source_document_id=$2 and state='accepted' limit 1",[actor.workspaceId,documentId])).rowCount)notFound('Original document not found');
  const cursor=before?(await c.query("select created_at,id from pdf_splits where id=$1 and workspace_id=$2 and source_document_id=$3 and state='accepted'",[before,actor.workspaceId,documentId])).rows[0]:undefined;
  if(before&&!cursor)notFound('Split history page not found');
  const rows=(await c.query(`select id from pdf_splits where workspace_id=$1 and source_document_id=$2 and state='accepted'
   ${cursor?'and (created_at,id)<(select created_at,id from pdf_splits where id=$3 and workspace_id=$1 and source_document_id=$2)':''}
   order by created_at desc,id desc limit 21`,cursor?[actor.workspaceId,documentId,cursor.id]:[actor.workspaceId,documentId])).rows;
  const batches=[];for(const row of rows.slice(0,20))batches.push(await readPdfSplitReceipt(c,actor.workspaceId,row.id));
  return {batches,nextCursor:rows.length>20?rows[19]!.id:null,sourceAvailable};
 },false);
}

export async function undoStoredPdfSplit(authorization:StoredPdfAuthorization,splitId:string):Promise<StoredPdfSplitUndo>{
 splitId=uuid.parse(splitId);const {actor}=authorization;
 return withStoredPdfAuthorization(authorization,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
  const row=(await c.query("select * from pdf_splits where id=$1 and workspace_id=$2 and state='accepted' for update",[splitId,actor.workspaceId])).rows[0];
  if(!row)notFound('Split not found');
  if(!row.source_document_id)badRequest('Undo is available for batches split from a stored document.',409);
  const result=await purgePdfSplit(c,actor.workspaceId,splitId);if(!result)notFound('Split not found');
  if(!row.undone_at){
   await c.query('update pdf_splits set undone_at=clock_timestamp() where id=$1 and workspace_id=$2',[splitId,actor.workspaceId]);
   await audit(c,actor.workspaceId,actor.userId,'document.split_undone',splitId,{sourceDocumentId:row.source_document_id,documents:result.removedDocuments});
  }
  const pending=(await c.query(`select status from file_deletions where workspace_id=$1 and storage_key in (
   select workspace_id::text||'/'||document_id::text from pdf_split_children where workspace_id=$1 and split_id=$2
   union all select workspace_id::text||'/'||id::text from pdf_splits where workspace_id=$1 and id=$2
  )`,[actor.workspaceId,splitId])).rows;
  return {ok:true,removedDocuments:result.removedDocuments,storageDeletion:pending.some(item=>item.status==='failed')?'failed':pending.length?'pending':'complete',receipt:await readPdfSplitReceipt(c,actor.workspaceId,splitId,Boolean(row.undone_at))};
 });
}
