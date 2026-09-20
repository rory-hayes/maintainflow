import {api,ApiError,fetchOriginalFile,workspaceId} from './api';
import {confirmPdfSplitReceipt,pdfSha256,type PendingPdfSplit} from './pdf-split';
import {canonicalPdfSplitSpec,pdfSplitSpecSchema,pdfSplitLimits,type PdfSplitReceipt,type StoredPdfSplitRejected} from '../../shared/pdf-split';

export type StoredPdfSource={id:string;name:string;sha256:string;pageCount:number};
export type StoredPendingPdfSplit=PendingPdfSplit&{userId:string;sourceDocumentId:string;savedAt:number};
export type StoredSplitScope={userId:string;workspaceId:string;parserId:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key=(scope:StoredSplitScope,sourceId:string)=>`folio.stored-pdf-split.v1:${scope.userId}:${scope.workspaceId}:${scope.parserId}:${sourceId}`;
export function readStoredPdfSplit(scope:StoredSplitScope,sourceId:string):StoredPendingPdfSplit|null{
 try{const value=JSON.parse(localStorage.getItem(key(scope,sourceId))||'null');
  if(!value||value.version!==1||value.userId!==scope.userId||value.workspaceId!==scope.workspaceId||value.parserId!==scope.parserId||value.sourceDocumentId!==sourceId||!uuid.test(value.requestId)||!Number.isSafeInteger(value.savedAt)||value.savedAt<1||!uuid.test(sourceId)||!/^[a-f0-9]{64}$/.test(value.sha256))return null;
  return{version:1,userId:scope.userId,workspaceId:scope.workspaceId,parserId:scope.parserId,sourceDocumentId:sourceId,requestId:value.requestId,sha256:value.sha256,savedAt:value.savedAt,options:pdfSplitSpecSchema.parse(value.options)};
 }catch{return null;}
}
export function saveStoredPdfSplit(value:StoredPendingPdfSplit){
 const current=readStoredPdfSplit(value,value.sourceDocumentId);
 if(current&&(current.requestId!==value.requestId||current.sha256!==value.sha256||current.savedAt!==value.savedAt||canonicalPdfSplitSpec(current.options)!==canonicalPdfSplitSpec(value.options)))throw new Error('Another saved split exists for this document. Reopen the split dialog to check that request.');
 // Persist only the binding. Source bytes, names, URLs and result data stay out of storage.
 const record:StoredPendingPdfSplit={version:1,userId:value.userId,workspaceId:value.workspaceId,parserId:value.parserId,sourceDocumentId:value.sourceDocumentId,requestId:value.requestId,sha256:value.sha256,savedAt:value.savedAt,options:pdfSplitSpecSchema.parse(value.options)};
 try{localStorage.setItem(key(value,value.sourceDocumentId),JSON.stringify(record));}catch{throw new Error('Recovery information could not be saved. Enable browser storage before splitting this document.');}
}
export function clearStoredPdfSplit(scope:StoredSplitScope,sourceId:string,requestId:string){
 const current=readStoredPdfSplit(scope,sourceId);if(current&&current.requestId!==requestId)throw new Error('A newer saved split exists. Reopen this dialog before starting another request.');
 localStorage.removeItem(key(scope,sourceId));
}
function current(scope:StoredSplitScope,isCurrent:()=>boolean){if(!isCurrent())throw new Error('The document view changed. Reopen it to resume the saved split.');const selected=workspaceId();if(selected&&selected!==scope.workspaceId)throw new Error('Return to the original workspace to resume this split.');}
async function assertActor(scope:StoredSplitScope,isCurrent:()=>boolean,signal?:AbortSignal,write=false){
 current(scope,isCurrent);const session=await api<{user:{id:string};workspace:{id:string;role:string}}>('/api/auth/me',{signal,headers:{'X-Workspace-Id':scope.workspaceId}});current(scope,isCurrent);
 if(session.user.id!==scope.userId||session.workspace.id!==scope.workspaceId||write&&!['owner','admin','editor'].includes(session.workspace.role))throw new Error('Your account or permissions changed. Reopen this document before continuing.');
}
export async function readStoredPdfSource(scope:StoredSplitScope,source:StoredPdfSource,isCurrent:()=>boolean,signal:AbortSignal){
 await assertActor(scope,isCurrent,signal);const response=await fetchOriginalFile(source.id,signal);if(!response.ok)throw new Error('The source PDF is unavailable. Check your access or reopen this document.');
 const bytes=await response.arrayBuffer();current(scope,isCurrent);
 if(!bytes.byteLength||bytes.byteLength>pdfSplitLimits.maxBytes||await pdfSha256(bytes)!==source.sha256)throw new Error('The source PDF could not be verified. Reopen this document before splitting it.');current(scope,isCurrent);return new Uint8Array(bytes);
}
export async function findStoredPdfSplit(value:StoredPendingPdfSplit,isCurrent:()=>boolean,signal?:AbortSignal){
 await assertActor(value,isCurrent,signal);
 try{const receipt=await api<PdfSplitReceipt|StoredPdfSplitRejected>(`/api/parsers/${value.parserId}/pdf-splits/requests/${value.requestId}`,{signal,headers:{'X-Workspace-Id':value.workspaceId}});current(value,isCurrent);
  if('rejected' in receipt){const rejected=receipt.rejected;if(!rejected||!uuid.test(rejected.id)||rejected.requestId!==value.requestId||rejected.parserId!==value.parserId||rejected.sourceDocumentId!==value.sourceDocumentId||rejected.sourceSha256!==value.sha256||canonicalPdfSplitSpec(rejected.options)!==canonicalPdfSplitSpec(value.options)||typeof rejected.message!=='string'||rejected.message.length>1000)throw new Error('This result does not match the saved source PDF. Check the request again.');return receipt;}
  const result=confirmPdfSplitReceipt(value,receipt);if(result.split.origin!=='stored'||result.split.sourceDocumentId!==value.sourceDocumentId||result.split.sourceSha256!==value.sha256)throw new Error('This result does not match the saved source PDF. Check the request again.');return result;
 }catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}
}
export async function submitStoredPdfSplit(value:StoredPendingPdfSplit,isCurrent:()=>boolean,signal?:AbortSignal){
 const existing=await findStoredPdfSplit(value,isCurrent,signal);if(existing)return existing;
 await assertActor(value,isCurrent,signal,true);current(value,isCurrent);
 const receipt=await api<PdfSplitReceipt>(`/api/documents/${value.sourceDocumentId}/pdf-splits`,{method:'POST',signal,headers:{'X-Workspace-Id':value.workspaceId},body:JSON.stringify({requestId:value.requestId,sourceSha256:value.sha256,options:value.options})});current(value,isCurrent);
 const result=confirmPdfSplitReceipt(value,receipt);if(result.split.origin!=='stored'||result.split.sourceDocumentId!==value.sourceDocumentId||result.split.sourceSha256!==value.sha256)throw new Error('The split result could not be confirmed for this source. Check the saved request.');return result;
}
export async function checkStoredBatch(scope:StoredSplitScope,receipt:PdfSplitReceipt,isCurrent:()=>boolean,signal?:AbortSignal){
 await assertActor(scope,isCurrent,signal);const latest=await api<PdfSplitReceipt>(`/api/parsers/${scope.parserId}/pdf-splits/requests/${receipt.split.requestId}`,{signal,headers:{'X-Workspace-Id':scope.workspaceId}});current(scope,isCurrent);
 if(latest.split.id!==receipt.split.id||latest.split.requestId!==receipt.split.requestId||latest.split.origin!=='stored'||latest.split.sourceDocumentId!==receipt.split.sourceDocumentId)throw new Error('The split result could not be confirmed. Try checking again.');return latest;
}
export async function undoStoredBatch(scope:StoredSplitScope,receipt:PdfSplitReceipt,isCurrent:()=>boolean,signal?:AbortSignal){
 await assertActor(scope,isCurrent,signal,true);const result=await api<{ok:true;removedDocuments:number;storageDeletion:string;receipt:PdfSplitReceipt}>(`/api/pdf-splits/${receipt.split.id}/undo`,{method:'POST',signal,headers:{'X-Workspace-Id':scope.workspaceId},body:'{}'});current(scope,isCurrent);
 if(!result.ok||result.receipt.split.id!==receipt.split.id||!result.receipt.split.undoneAt)throw new Error('Undo could not be confirmed. Check the split result.');return result.receipt;
}
