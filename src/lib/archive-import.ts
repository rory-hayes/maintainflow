import {api,ApiError,workspaceId} from './api';
import {pdfSha256} from './pdf-split';
import {archiveImportLimits,archiveImportSpecSchema,canonicalArchiveImportSpec,type ArchiveImportSpec,type ArchivePreview,type ArchiveImportReceipt} from '../../shared/archive-import';
import {sourceFormats} from '../../shared/source-formats';

export type PendingArchiveImport={version:1;userId:string;workspaceId:string;parserId:string;requestId:string;sha256:string;byteSize:number;uploadId?:string;options?:ArchiveImportSpec;selectedPages?:number};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,digest=/^[a-f0-9]{64}$/;
const key=(user:string,workspace:string,parser:string)=>`folio.archive-import.v1:${user}:${workspace}:${parser}`;
export function readPendingArchiveImport(user:string,workspace:string,parser:string):PendingArchiveImport|null{
  try{
    const value=JSON.parse(sessionStorage.getItem(key(user,workspace,parser))||'null');
    if(!value||value.version!==1||value.userId!==user||value.workspaceId!==workspace||value.parserId!==parser||!uuid.test(value.requestId)||!digest.test(value.sha256)||!Number.isInteger(value.byteSize)||value.byteSize<1||value.byteSize>archiveImportLimits.maxBytes||value.uploadId&&!uuid.test(value.uploadId))return null;
    const options=value.options?archiveImportSpecSchema.parse(value.options):undefined;
    if(options&&(options.sourceSha256!==value.sha256||!Number.isInteger(value.selectedPages)||value.selectedPages<options.entries.length||value.selectedPages>options.entries.length*archiveImportLimits.maxPagesPerDocument))return null;
    return {version:1,userId:user,workspaceId:workspace,parserId:parser,requestId:value.requestId,sha256:value.sha256,byteSize:value.byteSize,...(value.uploadId?{uploadId:value.uploadId}:{}),...(options?{options,selectedPages:value.selectedPages}:{})};
  }catch{return null;}
}
export function savePendingArchiveImport(value:PendingArchiveImport){
  // Recovery keeps request identity and selection; file bytes, paths and signed URLs stay out of storage.
  try{sessionStorage.setItem(key(value.userId,value.workspaceId,value.parserId),JSON.stringify(value));}
  catch{throw new Error('Recovery information could not be saved. Enable browser session storage before uploading.');}
}
export function saveMatchingArchiveImport(value:PendingArchiveImport){
  const current=readPendingArchiveImport(value.userId,value.workspaceId,value.parserId);
  if(current?.requestId===value.requestId&&current.sha256===value.sha256&&current.byteSize===value.byteSize&&(!current.options&&!value.options||current.options&&value.options&&canonicalArchiveImportSpec(current.options)===canonicalArchiveImportSpec(value.options)))savePendingArchiveImport(value);
}
export function clearPendingArchiveImport(user:string,workspace:string,parser:string){sessionStorage.removeItem(key(user,workspace,parser));}
function assertScope(value:PendingArchiveImport,isCurrent:()=>boolean){if(!isCurrent())throw new Error('The import view changed. Resume its saved request to continue.');const current=workspaceId();if(current&&current!==value.workspaceId)throw new Error('The workspace changed. Return to the original workspace to resume this import.');}
function scoped<T>(value:PendingArchiveImport,isCurrent:()=>boolean,path:string,options:RequestInit={}){assertScope(value,isCurrent);const headers=new Headers(options.headers);headers.set('X-Workspace-Id',value.workspaceId);return api<T>(path,{...options,headers});}
const post=<T>(value:PendingArchiveImport,current:()=>boolean,path:string,body:unknown={})=>scoped<T>(value,current,path,{method:'POST',body:JSON.stringify(body)});
const path=(value:PendingArchiveImport)=>`/api/parsers/${value.parserId}/archive-imports`;
function invalidPreview():never{throw new Error('The ZIP preview could not be confirmed. Preview the same file again.');}
export function confirmArchivePreview(value:PendingArchiveImport,preview:ArchivePreview):ArchivePreview{
  if(!preview||preview.requestId!==value.requestId||preview.parserId!==value.parserId||preview.sourceSha256!==value.sha256||preview.sourceByteSize!==value.byteSize||!Array.isArray(preview.entries)||preview.entries.length>archiveImportLimits.maxRecords)return invalidPreview();
  let previous=0,pages=0;const paths=new Set<string>();
  for(const entry of preview.entries){
    if(!entry||!Number.isInteger(entry.index)||entry.index<=previous||entry.index>archiveImportLimits.maxRecords||typeof entry.path!=='string'||!entry.path||new TextEncoder().encode(entry.path).byteLength>archiveImportLimits.maxPathBytes||paths.has(entry.path)||!digest.test(entry.sha256)||!Number.isInteger(entry.byteSize)||entry.byteSize<0||entry.byteSize>archiveImportLimits.maxBytes||!['ready','unsupported','metadata'].includes(entry.status)||entry.format!==null&&!sourceFormats.some(format=>format.id===entry.format)||entry.reason!==null&&(typeof entry.reason!=='string'||entry.reason.length>1000))return invalidPreview();
    if(entry.status==='ready'){if(!entry.format||!Number.isInteger(entry.pageCount)||entry.pageCount!<1||entry.pageCount!>archiveImportLimits.maxPagesPerDocument||entry.reason!==null)return invalidPreview();pages+=entry.pageCount!;}
    else if(entry.pageCount!==null&&(!Number.isInteger(entry.pageCount)||entry.pageCount<1||entry.pageCount>archiveImportLimits.maxPagesPerDocument))return invalidPreview();
    paths.add(entry.path);previous=entry.index;
  }
  if(preview.totalPages!==pages)return invalidPreview();return preview;
}
function confirmReceipt(value:PendingArchiveImport,receipt:ArchiveImportReceipt):ArchiveImportReceipt{
  const fail=()=>{throw new Error('The import result could not be confirmed. Check this saved request before starting another import.');};
  if(!value.options||!receipt?.archive||receipt.archive.requestId!==value.requestId||receipt.archive.parserId!==value.parserId||!uuid.test(receipt.archive.id)||receipt.archive.childCount!==value.options.entries.length||receipt.archive.totalPages!==value.selectedPages||typeof receipt.archive.sourceAvailable!=='boolean'||typeof receipt.replayed!=='boolean'||!Array.isArray(receipt.documents)||receipt.documents.length!==value.options.entries.length)return fail();
  const ids=new Set<string>();let pages=0;
  for(const [index,document]of receipt.documents.entries()){
    if(!document||document.index!==value.options.entries[index]||!uuid.test(document.id)||ids.has(document.id)||!uuid.test(document.jobId)||!Number.isInteger(document.pageCount)||document.pageCount<1||document.pageCount>archiveImportLimits.maxPagesPerDocument||typeof document.available!=='boolean'||document.path!==null&&(typeof document.path!=='string'||new TextEncoder().encode(document.path).byteLength>archiveImportLimits.maxPathBytes))return fail();
    if(document.available&&(!document.path||typeof document.name!=='string'))return fail();ids.add(document.id);pages+=document.pageCount;
  }
  if(pages!==value.selectedPages)return fail();return receipt;
}
export async function findArchiveImportReceipt(value:PendingArchiveImport,current:()=>boolean=()=>true):Promise<ArchiveImportReceipt|null>{
  if(!value.options)return null;
  try{return confirmReceipt(value,await scoped<ArchiveImportReceipt>(value,current,path(value)+`/requests/${value.requestId}`));}
  catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}
}
async function verifyFile(value:PendingArchiveImport,file:File,current:()=>boolean){assertScope(value,current);if(file.size!==value.byteSize||await pdfSha256(await file.arrayBuffer())!==value.sha256)throw new Error('Choose the same ZIP used for this request. Its contents must match the original archive.');assertScope(value,current);}
async function configuration(value:PendingArchiveImport,current:()=>boolean){const result=await scoped<{strategy:'signed'|'multipart';maxBytes:number}>(value,current,'/api/uploads/config');assertScope(value,current);if(value.byteSize>result.maxBytes)throw new Error('This ZIP exceeds the workspace’s upload limit.');return result;}
async function stage(value:PendingArchiveImport,file:File,save:(value:PendingArchiveImport)=>void,current:()=>boolean){
  const reservation=await post<{uploadId:string;uploadUrl:string}>(value,current,`/api/parsers/${value.parserId}/uploads`,{filename:file.name,size:file.size,sha256:value.sha256,archiveImport:{requestId:value.requestId,...(value.options?{options:value.options}:{})}});
  const destination=new URL(reservation.uploadUrl);
  if(!uuid.test(reservation.uploadId)||destination.protocol!=='https:'||!destination.hostname.endsWith('.supabase.co'))throw new Error('The private upload destination is invalid.');
  const staged={...value,uploadId:reservation.uploadId};save(staged);assertScope(value,current);
  const response=await fetch(destination,{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
  if(!response.ok){await response.body?.cancel();throw new Error('The ZIP transfer could not be confirmed. Retry with the same file.');}await response.body?.cancel();assertScope(value,current);return staged;
}
export async function previewArchiveImport(value:PendingArchiveImport,file:File,save:(value:PendingArchiveImport)=>void,current:()=>boolean=()=>true):Promise<ArchivePreview>{
  await verifyFile(value,file,current);const settings=await configuration(value,current);
  if(settings.strategy==='multipart'){const form=new FormData();form.append('requestId',value.requestId);form.append('file',file);return confirmArchivePreview(value,await scoped<ArchivePreview>(value,current,path(value)+'/preview',{method:'POST',body:form}));}
  if(value.uploadId){try{return confirmArchivePreview(value,await post<ArchivePreview>(value,current,`/api/uploads/${value.uploadId}/archive-preview`));}catch(error){if(!(error instanceof ApiError)||![404,410].includes(error.status))throw error;}}
  const staged=await stage(value,file,save,current);return confirmArchivePreview(value,await post<ArchivePreview>(staged,current,`/api/uploads/${staged.uploadId}/archive-preview`));
}
export async function uploadArchiveImport(value:PendingArchiveImport,file:File,save:(value:PendingArchiveImport)=>void,current:()=>boolean=()=>true):Promise<ArchiveImportReceipt>{
  if(!value.options)throw new Error('Preview the ZIP and choose files before importing.');await verifyFile(value,file,current);const existing=await findArchiveImportReceipt(value,current);if(existing)return existing;const settings=await configuration(value,current);
  if(settings.strategy==='multipart'){const form=new FormData();form.append('requestId',value.requestId);form.append('options',JSON.stringify(value.options));form.append('file',file);return confirmReceipt(value,await scoped<ArchiveImportReceipt>(value,current,path(value),{method:'POST',body:form}));}
  async function finalize(staged:PendingArchiveImport){await post(staged,current,`/api/uploads/${staged.uploadId}/archive-confirm`,{options:value.options});return confirmReceipt(value,await post<ArchiveImportReceipt>(staged,current,`/api/uploads/${staged.uploadId}/finalize`));}
  if(value.uploadId){try{return await finalize(value);}catch(error){const receipt=await findArchiveImportReceipt(value,current);if(receipt)return receipt;if(!(error instanceof ApiError)||![404,410].includes(error.status))throw error;}}
  return finalize(await stage(value,file,save,current));
}
