import {api,ApiError,workspaceId} from './api';
import {pdfSplitSpecSchema,planPdfSplit,type PdfSplitSpec,type PdfSplitReceipt} from '../../shared/pdf-split';

export type PendingPdfSplit={version:1;workspaceId:string;parserId:string;requestId:string;sha256:string;options:PdfSplitSpec;uploadId?:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key=(workspace:string,parser:string)=>`folio.pdf-split.v1:${workspace}:${parser}`;
export function readPendingPdfSplit(workspace:string,parser:string):PendingPdfSplit|null{
  try{
    const value=JSON.parse(sessionStorage.getItem(key(workspace,parser))||'null');
    if(!value||value.version!==1||value.workspaceId!==workspace||value.parserId!==parser||!uuid.test(value.requestId)||!(/^[a-f0-9]{64}$/).test(value.sha256)||value.uploadId&&!uuid.test(value.uploadId))return null;
    return {version:1,workspaceId:workspace,parserId:parser,requestId:value.requestId,sha256:value.sha256,options:pdfSplitSpecSchema.parse(value.options),...(value.uploadId?{uploadId:value.uploadId}:{})};
  }catch{return null;}
}
export function savePendingPdfSplit(value:PendingPdfSplit){
  // Deliberately exclude file bytes, filenames, signed URLs and receipt contents.
  try{sessionStorage.setItem(key(value.workspaceId,value.parserId),JSON.stringify(value));}
  catch{throw new Error('Recovery information could not be saved. Enable browser session storage before uploading.');}
}
export function clearPendingPdfSplit(workspace:string,parser:string){sessionStorage.removeItem(key(workspace,parser));}
export async function pdfSha256(bytes:ArrayBuffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');}
function assertWorkspace(value:PendingPdfSplit){const current=workspaceId();if(current&&current!==value.workspaceId)throw new Error('The workspace changed. Return to the original workspace to resume this split.');}
function scopedRequest<T>(value:PendingPdfSplit,path:string,options:RequestInit={}){
  assertWorkspace(value);const headers=new Headers(options.headers);headers.set('X-Workspace-Id',value.workspaceId);
  return api<T>(path,{...options,headers});
}
const scopedPost=<T>(value:PendingPdfSplit,path:string,body:unknown={})=>scopedRequest<T>(value,path,{method:'POST',body:JSON.stringify(body)});
function confirmReceipt(value:PendingPdfSplit,receipt:PdfSplitReceipt):PdfSplitReceipt{
  const fail=()=>{throw new Error('The split result could not be confirmed. Check this saved request again before starting another split.');};
  if(!receipt?.split||!Array.isArray(receipt.documents)||receipt.split.requestId!==value.requestId||receipt.split.parserId!==value.parserId||!uuid.test(receipt.split.id)||typeof receipt.replayed!=='boolean')return fail();
  let plan:ReturnType<typeof planPdfSplit>;
  try{plan=planPdfSplit(value.options,receipt.split.sourcePageCount);}catch{return fail();}
  if(receipt.split.selectedPages!==plan.selectedPages||receipt.split.childCount!==plan.ranges.length||receipt.documents.length!==plan.ranges.length||typeof receipt.split.sourceAvailable!=='boolean')return fail();
  const ids=new Set<string>();
  for(let index=0;index<plan.ranges.length;index++){
    const document=receipt.documents[index],range=plan.ranges[index];
    if(!document||!uuid.test(document.id)||ids.has(document.id)||!uuid.test(document.jobId)||document.index!==index+1||document.originalPageStart!==range.start||document.originalPageEnd!==range.end||document.pageCount!==range.end-range.start+1||typeof document.available!=='boolean')return fail();
    ids.add(document.id);
  }
  return receipt;
}
export async function findPdfSplitReceipt(value:PendingPdfSplit):Promise<PdfSplitReceipt|null>{
  assertWorkspace(value);
  try{return confirmReceipt(value,await scopedRequest<PdfSplitReceipt>(value,`/api/parsers/${value.parserId}/pdf-splits/requests/${value.requestId}`));}
  catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}
}
/** Every retry retains the original request binding, even if a new staging reservation is needed. */
export async function uploadPdfSplit(value:PendingPdfSplit,file:File,save:(value:PendingPdfSplit)=>void):Promise<PdfSplitReceipt>{
  assertWorkspace(value);
  if(await pdfSha256(await file.arrayBuffer())!==value.sha256)throw new Error('Choose the same PDF used for this split. Its contents must match the original file.');
  const receipt=await findPdfSplitReceipt(value);if(receipt)return receipt;
  assertWorkspace(value);
  const configuration=await scopedRequest<{strategy:'signed'|'multipart';maxBytes:number}>(value,'/api/uploads/config');
  if(file.size<1||file.size>configuration.maxBytes)throw new Error('The PDF exceeds this workspace’s upload limit.');
  assertWorkspace(value);
  if(configuration.strategy==='multipart'){
    const form=new FormData();form.append('requestId',value.requestId);form.append('options',JSON.stringify(value.options));form.append('file',file);
    return confirmReceipt(value,await scopedRequest<PdfSplitReceipt>(value,`/api/parsers/${value.parserId}/pdf-splits`,{method:'POST',body:form}));
  }
  // A saved staging ID can already contain a complete upload. A missing or
  // incomplete transfer is recovered using fresh staging, never a fresh split ID.
  if(value.uploadId){
    try{return confirmReceipt(value,await scopedPost<PdfSplitReceipt>(value,`/api/uploads/${value.uploadId}/finalize`));}
    catch(error){
      const completed=await findPdfSplitReceipt(value);if(completed)return completed;
      if(error instanceof ApiError&&![404,410,500,502,503,504].includes(error.status))throw error;
    }
  }
  assertWorkspace(value);
  const reservation=await scopedPost<{uploadId:string;uploadUrl:string}>(value,`/api/parsers/${value.parserId}/uploads`,{filename:file.name,size:file.size,sha256:value.sha256,pdfSplit:{requestId:value.requestId,options:value.options}});
  const destination=new URL(reservation.uploadUrl);
  if(!uuid.test(reservation.uploadId)||destination.protocol!=='https:'||!destination.hostname.endsWith('.supabase.co'))throw new Error('The private upload destination is invalid.');
  save({...value,uploadId:reservation.uploadId});assertWorkspace(value);
  const uploaded=await fetch(destination,{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  if(!uploaded.ok){await uploaded.body?.cancel();throw new Error('The PDF transfer could not be confirmed. Check the split result or retry with the same file.');}
  await uploaded.body?.cancel();assertWorkspace(value);
  return confirmReceipt(value,await scopedPost<PdfSplitReceipt>(value,`/api/uploads/${reservation.uploadId}/finalize`));
}
