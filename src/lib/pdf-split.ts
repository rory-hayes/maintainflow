import type {PDFDocumentProxy} from 'pdfjs-dist';
import {api,ApiError,workspaceId} from './api';
import {pdfSplitSpecSchema,planPdfSplit,nativePdfPageText,canonicalPdfSplitSpec,isPdfSplitValidationReason,pdfSplitValidationReasons,type PdfSplitSpec,type PdfSplitReceipt} from '../../shared/pdf-split';

export type PendingPdfSplit={version:1;workspaceId:string;parserId:string;requestId:string;sha256:string;options:PdfSplitSpec;uploadId?:string;userId?:string;sourceMimeType?:'image/tiff'|'application/pdf'};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key=(workspace:string,parser:string,userId?:string)=>`folio.pdf-split.v1:${workspace}:${parser}${userId?`:${userId}`:''}`;
export function readPendingPdfSplit(workspace:string,parser:string,userId?:string):PendingPdfSplit|null{
  try{
    const value=JSON.parse((userId?sessionStorage.getItem(key(workspace,parser,userId)):null)||sessionStorage.getItem(key(workspace,parser))||'null');
    if(!value||value.version!==1||value.userId!==undefined&&(!uuid.test(value.userId)||value.userId!==userId)||value.workspaceId!==workspace||value.parserId!==parser||!uuid.test(value.requestId)||!(/^[a-f0-9]{64}$/).test(value.sha256)||value.uploadId&&!uuid.test(value.uploadId)||value.sourceMimeType!==undefined&&!['application/pdf','image/tiff'].includes(value.sourceMimeType))return null;
    return {version:1,workspaceId:workspace,parserId:parser,requestId:value.requestId,sha256:value.sha256,options:pdfSplitSpecSchema.parse(value.options),...(value.uploadId?{uploadId:value.uploadId}:{}),...(value.sourceMimeType?{sourceMimeType:value.sourceMimeType}:{}),...(value.userId?{userId:value.userId}:{})};
  }catch{return null;}
}
export function savePendingPdfSplit(value:PendingPdfSplit){
  // Deliberately exclude file bytes, filenames, signed URLs and receipt contents.
  try{sessionStorage.setItem(key(value.workspaceId,value.parserId,value.userId),JSON.stringify(value));}
  catch{throw new Error('Recovery information could not be saved. Enable browser session storage before uploading.');}
}
/** A late staging response may only enrich its own saved request, never replace a newer split. */
export function saveMatchingPendingPdfSplit(value:PendingPdfSplit){
  const current=readPendingPdfSplit(value.workspaceId,value.parserId,value.userId);
  if(current?.requestId===value.requestId&&current.sha256===value.sha256&&(current.sourceMimeType||'application/pdf')===(value.sourceMimeType||'application/pdf')&&canonicalPdfSplitSpec(current.options)===canonicalPdfSplitSpec(value.options))savePendingPdfSplit(value);
}
/** Same PDF.js item assembly as the isolated decoder; text is held only in this page's memory. */
export async function readPdfSplitNativeText(pdf:PDFDocumentProxy,isCurrent:()=>boolean):Promise<string[]>{
  const pages:string[]=[],encoder=new TextEncoder();let total=0;
  for(let number=1;number<=pdf.numPages;number++){
    if(!isCurrent())throw new Error('PDF selection changed');
    let content;
    try{const page=await pdf.getPage(number);content=await page.getTextContent();}
    catch{throw new Error('Searchable text could not be read. Use custom page ranges.');}
    if(!isCurrent())throw new Error('PDF selection changed');
    const text=nativePdfPageText(content.items);total+=encoder.encode(text).byteLength;
    if(total>2*1024*1024)throw new Error('The PDF contains more text than the supported 2 MB limit.');
    pages.push(text);
  }
  return pages;
}
export function clearPendingPdfSplit(workspace:string,parser:string,userId?:string){sessionStorage.removeItem(userId&&sessionStorage.getItem(key(workspace,parser,userId))?key(workspace,parser,userId):key(workspace,parser));}
export async function pdfSha256(bytes:ArrayBuffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');}
export type TiffSplitPreviewBinding={userId:string;workspaceId:string;parserId:string;requestId:string;sha256:string;uploadId?:string;options?:PdfSplitSpec};
/** Magic identifies the preview format; the server still validates the full source. */
export function isTiffSplitSource(bytes:ArrayBuffer){const head=new Uint8Array(bytes,0,Math.min(4,bytes.byteLength));return head.length===4&&(head[0]===73&&head[1]===73&&(head[2]===42||head[2]===43)&&head[3]===0||head[0]===77&&head[1]===77&&head[2]===0&&(head[3]===42||head[3]===43));}
async function assertPreviewActor(value:TiffSplitPreviewBinding,isCurrent:()=>boolean,signal:AbortSignal){
  assertWorkspace(value,isCurrent);
  const actor=await api<{user:{id:string};workspace:{id:string;role:string}}>('/api/auth/me',{signal,headers:{'X-Workspace-Id':value.workspaceId}});
  assertWorkspace(value,isCurrent);
  if(actor.user.id!==value.userId||actor.workspace.id!==value.workspaceId||!['owner','admin','editor'].includes(actor.workspace.role))throw new Error('Your account or permissions changed. Reopen this document before continuing.');
}
/** Staging is not admission: no options, document or charge exists until submit. */
export async function prepareTiffSplitPreview(value:TiffSplitPreviewBinding,file:File,isCurrent:()=>boolean,signal:AbortSignal):Promise<TiffSplitPreviewBinding>{
  await assertPreviewActor(value,isCurrent,signal);
  if(await pdfSha256(await file.arrayBuffer())!==value.sha256)throw new Error('Choose the same TIFF for this preview.');assertWorkspace(value,isCurrent);
  const config=await api<{strategy:'signed'|'multipart';maxBytes:number}>('/api/uploads/config',{signal,headers:{'X-Workspace-Id':value.workspaceId}});
  assertWorkspace(value,isCurrent);
  if(file.size<1||file.size>config.maxBytes)throw new Error('The TIFF exceeds this workspace’s upload limit.');
  if(config.strategy==='multipart')return value;
  const reservation=await api<{uploadId:string;uploadUrl:string}>(`/api/parsers/${value.parserId}/uploads`,{method:'POST',signal,headers:{'X-Workspace-Id':value.workspaceId},body:JSON.stringify({filename:file.name,size:file.size,sha256:value.sha256,pdfSplit:{requestId:value.requestId,...(value.options?{options:value.options}:{})}})});
  assertWorkspace(value,isCurrent);
  const url=new URL(reservation.uploadUrl);
  if(!uuid.test(reservation.uploadId)||url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co'))throw new Error('The private upload destination is invalid.');
  const response=await fetch(url,{method:'PUT',body:file,signal,headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  await response.body?.cancel();assertWorkspace(value,isCurrent);
  if(!response.ok)throw new Error('The TIFF preview transfer could not be confirmed. Retry the preview with the same file.');
  return {...value,uploadId:reservation.uploadId};
}
/** Authenticated JPEG derivatives are checked against the exact source and page. */
export async function readTiffSplitPreview(value:TiffSplitPreviewBinding,page:number,isCurrent:()=>boolean,signal:AbortSignal,file?:File,documentId?:string,expectedPages?:number){
  await assertPreviewActor(value,isCurrent,signal);
  const headers={'X-Workspace-Id':value.workspaceId};let path:string,options:RequestInit;
  if(documentId){path=`/api/documents/${documentId}/preview?page=${page}`;options={headers};}
  else if(value.uploadId){path=`/api/uploads/${value.uploadId}/split-preview`;options={method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({page})};}
  else{if(!file)throw new Error('Reselect the same TIFF to preview its pages.');const form=new FormData();form.append('page',String(page));form.append('file',file);path=`/api/parsers/${value.parserId}/pdf-splits/preview`;options={method:'POST',headers,body:form};}
  const response=await fetch(path,{...options,signal,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
  assertWorkspace(value,isCurrent);
  if(!response.ok){
    const detail=await response.json().catch(()=>null),reason:unknown=detail?.reason;assertWorkspace(value,isCurrent);
    const message=detail?.code==='parser_format_not_allowed'?'This parser does not accept TIFF files. Enable TIFF in parser settings before previewing.':detail?.code==='pdf_split_validation_failed'&&isPdfSplitValidationReason(reason)?pdfSplitValidationReasons[reason].message:response.status===413?'This TIFF exceeds the supported preview limits. Choose a TIFF up to 10 MB and 30 pages.':response.status===401||response.status===403?'Your access changed. Reopen the document before previewing.':'This TIFF page could not be previewed. Try again or choose another TIFF.';
    throw new ApiError(message,response.status);
  }
  if((response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!=='image/jpeg'){await response.body?.cancel();throw new Error('This TIFF page could not be previewed. Try again or choose another TIFF.');}
  const pageCount=Number(response.headers.get('X-Folio-Page-Count'));
  if(response.headers.get('X-Folio-Source-Sha256')!==value.sha256||response.headers.get('X-Folio-Preview-Page')!==String(page)||!Number.isInteger(pageCount)||pageCount<1||pageCount>30||expectedPages!==undefined&&pageCount!==expectedPages){await response.body?.cancel();throw new Error('The TIFF preview did not match this source and page. Reopen the document or reselect the file.');}
  const bytes=await response.arrayBuffer();assertWorkspace(value,isCurrent);
  if(!bytes.byteLength||bytes.byteLength>2*1024*1024)throw new Error('This TIFF page could not be previewed. Try again or choose another TIFF.');
  return{blob:new Blob([bytes],{type:'image/jpeg'}),pageCount};
}
function assertWorkspace(value:{workspaceId:string},isCurrent:()=>boolean=()=>true){if(!isCurrent())throw new Error('The split view changed. Resume the saved request to continue.');const current=workspaceId();if(current&&current!==value.workspaceId)throw new Error('The workspace changed. Return to the original workspace to resume this split.');}
function scopedRequest<T>(value:PendingPdfSplit,path:string,options:RequestInit={}){
  assertWorkspace(value);const headers=new Headers(options.headers);headers.set('X-Workspace-Id',value.workspaceId);
  return api<T>(path,{...options,headers});
}
const scopedPost=<T>(value:PendingPdfSplit,path:string,body:unknown={})=>scopedRequest<T>(value,path,{method:'POST',body:JSON.stringify(body)});
export function confirmPdfSplitReceipt(value:PendingPdfSplit,receipt:PdfSplitReceipt):PdfSplitReceipt{
  const fail=()=>{throw new Error('The split result could not be confirmed. Check this saved request again before starting another split.');};
  if(!receipt?.split||!Array.isArray(receipt.documents)||receipt.split.requestId!==value.requestId||receipt.split.parserId!==value.parserId||!uuid.test(receipt.split.id)||typeof receipt.replayed!=='boolean'||(receipt.split.sourceMimeType||'application/pdf')!==(value.sourceMimeType||'application/pdf'))return fail();
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
export async function findPdfSplitReceipt(value:PendingPdfSplit,isCurrent:()=>boolean=()=>true):Promise<PdfSplitReceipt|null>{
  assertWorkspace(value,isCurrent);
  try{return confirmPdfSplitReceipt(value,await scopedRequest<PdfSplitReceipt>(value,`/api/parsers/${value.parserId}/pdf-splits/requests/${value.requestId}`));}
  catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}
}
/** Every retry retains the original request binding, even if a new staging reservation is needed. */
export async function uploadPdfSplit(value:PendingPdfSplit,file:File,save:(value:PendingPdfSplit)=>void,isCurrent:()=>boolean=()=>true):Promise<PdfSplitReceipt>{
  assertWorkspace(value,isCurrent);
  if(value.userId)await assertPreviewActor({...value,userId:value.userId},isCurrent,new AbortController().signal);
  if(await pdfSha256(await file.arrayBuffer())!==value.sha256)throw new Error('Choose the same file used for this split. Its contents must match the original file.');
  assertWorkspace(value,isCurrent);
  const receipt=await findPdfSplitReceipt(value,isCurrent);if(receipt)return receipt;
  assertWorkspace(value,isCurrent);
  const configuration=await scopedRequest<{strategy:'signed'|'multipart';maxBytes:number}>(value,'/api/uploads/config');
  if(file.size<1||file.size>configuration.maxBytes)throw new Error('The file exceeds this workspace’s upload limit.');
  assertWorkspace(value,isCurrent);
  if(configuration.strategy==='multipart'){
    const form=new FormData();form.append('requestId',value.requestId);form.append('options',JSON.stringify(value.options));form.append('file',file);
    return confirmPdfSplitReceipt(value,await scopedRequest<PdfSplitReceipt>(value,`/api/parsers/${value.parserId}/pdf-splits`,{method:'POST',body:form}));
  }
  // A saved staging ID can already contain a complete upload. A missing or
  // incomplete transfer is recovered using fresh staging, never a fresh split ID.
  if(value.uploadId){
    try{await scopedPost(value,`/api/uploads/${value.uploadId}/split-confirm`,{options:value.options});assertWorkspace(value,isCurrent);return confirmPdfSplitReceipt(value,await scopedPost<PdfSplitReceipt>(value,`/api/uploads/${value.uploadId}/finalize`));}
    catch(error){
      const completed=await findPdfSplitReceipt(value,isCurrent);if(completed)return completed;
      if(error instanceof ApiError&&![404,410,500,502,503,504].includes(error.status))throw error;
    }
  }
  assertWorkspace(value,isCurrent);
  const reservation=await scopedPost<{uploadId:string;uploadUrl:string}>(value,`/api/parsers/${value.parserId}/uploads`,{filename:file.name,size:file.size,sha256:value.sha256,pdfSplit:{requestId:value.requestId,options:value.options}});
  const destination=new URL(reservation.uploadUrl);
  if(!uuid.test(reservation.uploadId)||destination.protocol!=='https:'||!destination.hostname.endsWith('.supabase.co'))throw new Error('The private upload destination is invalid.');
  save({...value,uploadId:reservation.uploadId});assertWorkspace(value,isCurrent);
  const uploaded=await fetch(destination,{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  if(!uploaded.ok){await uploaded.body?.cancel();throw new Error('The file transfer could not be confirmed. Check the split result or retry with the same file.');}
  await uploaded.body?.cancel();assertWorkspace(value,isCurrent);
  return confirmPdfSplitReceipt(value,await scopedPost<PdfSplitReceipt>(value,`/api/uploads/${reservation.uploadId}/finalize`));
}
