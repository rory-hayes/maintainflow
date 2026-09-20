import {workspaceId} from './api';
import {confirmPdfSplitReceipt,pdfSha256,type PendingPdfSplit} from './pdf-split';
import {pdfSplitSpecSchema,type PdfSplitReceipt} from '../../shared/pdf-split';
import {splitSuggestionLimits,splitSuggestionRanges,type SplitSuggestion,type SplitSuggestionMime} from '../../shared/split-suggestions';

export type SuggestionScope={userId:string;workspaceId:string;parserId:string};
export type SavedSplitSuggestion=SuggestionScope&{version:1;requestId:string;sourceDocumentId:string|null;sha256:string;mimeType:SplitSuggestionMime;suggestionId?:string};
export type SuggestionAvailability={available:boolean;limits:typeof splitSuggestionLimits;suggestions:SplitSuggestion[]};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const key=(scope:SuggestionScope,documentId:string|null)=>`folio.split-suggestion.v1:${scope.userId}:${scope.workspaceId}:${scope.parserId}:${documentId||'upload'}`;
export function readSavedSplitSuggestion(scope:SuggestionScope,documentId:string|null):SavedSplitSuggestion|null{
 try{const value=JSON.parse(localStorage.getItem(key(scope,documentId))||'null');
  if(!value||value.version!==1||value.userId!==scope.userId||value.workspaceId!==scope.workspaceId||value.parserId!==scope.parserId||value.sourceDocumentId!==documentId||!uuid.test(value.requestId)||!(/^[a-f0-9]{64}$/).test(value.sha256)||!['application/pdf','image/tiff'].includes(value.mimeType)||value.suggestionId!==undefined&&!uuid.test(value.suggestionId))return null;
  return{version:1,...scope,requestId:value.requestId,sourceDocumentId:documentId,sha256:value.sha256,mimeType:value.mimeType,...(value.suggestionId?{suggestionId:value.suggestionId}:{})};
 }catch{return null;}
}
export function saveSplitSuggestion(value:SavedSplitSuggestion){
 const current=readSavedSplitSuggestion(value,value.sourceDocumentId);
 if(current&&(current.requestId!==value.requestId||current.sha256!==value.sha256||current.mimeType!==value.mimeType||current.suggestionId&&value.suggestionId&&value.suggestionId!==current.suggestionId))throw new Error('Another saved AI request exists. Check it before starting a new suggestion.');
 const record:SavedSplitSuggestion={version:1,userId:value.userId,workspaceId:value.workspaceId,parserId:value.parserId,requestId:value.requestId,sourceDocumentId:value.sourceDocumentId,sha256:value.sha256,mimeType:value.mimeType,...(value.suggestionId||current?.suggestionId?{suggestionId:value.suggestionId||current?.suggestionId}:{})};
 try{localStorage.setItem(key(value,value.sourceDocumentId),JSON.stringify(record));}catch{throw new Error('Recovery information could not be saved. Enable browser storage before requesting AI suggestions.');}return record;
}
export function clearSplitSuggestion(value:SavedSplitSuggestion){const current=readSavedSplitSuggestion(value,value.sourceDocumentId);if(current&&current.requestId!==value.requestId)throw new Error('A newer AI request is saved. Reopen the dialog to check it.');localStorage.removeItem(key(value,value.sourceDocumentId));}
export class SplitSuggestionError extends Error{constructor(message:string,public status:number,public code:string){super(message);}}
const messages:Record<string,string>={
 split_suggestions_unavailable:'AI split suggestions are unavailable. You can still choose page ranges manually.',
 split_suggestion_expired:'This AI suggestion has expired. Review the source and start a new suggestion, or choose ranges manually.',
 split_suggestion_not_ready:'This AI suggestion is not ready yet. Check its status before continuing.',
 split_suggestion_request_conflict:'This saved AI request belongs to another source. Reopen the original request before continuing.',
 parser_format_not_allowed:'This parser does not allow this file format. Update its accepted formats before continuing.',
};
function current(scope:SuggestionScope,isCurrent:()=>boolean){let selected='';try{selected=workspaceId();}catch{/* Fresh actor lookup still verifies this explicit scope. */}if(!isCurrent()||selected&&selected!==scope.workspaceId)throw new Error('The account, workspace or source changed. Reopen the split dialog to continue.');}
async function request<T>(scope:SuggestionScope,path:string,isCurrent:()=>boolean,signal:AbortSignal,options:RequestInit={}):Promise<T>{
 current(scope,isCurrent);const headers=new Headers(options.headers);headers.set('X-Workspace-Id',scope.workspaceId);if(options.body&&!(options.body instanceof FormData))headers.set('Content-Type','application/json');
 let response:Response;try{response=await fetch(path,{...options,signal,headers,credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});}catch(error){if(signal.aborted)throw error;throw new Error('AI suggestions could not be checked. Check your connection and retry the saved request.');}
 current(scope,isCurrent);const body=await response.json().catch(()=>null);current(scope,isCurrent);
 if(!response.ok){const code=typeof body?.code==='string'?body.code:'';throw new SplitSuggestionError((body?.message==='Monthly page quota reached. Update the plan before uploading more documents.'?'This workspace does not have enough monthly page credits. Check usage before retrying the same split.':messages[code])||(response.status===401||response.status===403?'Your access changed. Reopen the split dialog before continuing.':response.status===402?'This workspace does not have enough page credits. Check usage before retrying this split.':response.status===429?'The AI request limit is reached. Wait for pending requests to finish or try again later.':response.status===410?'This AI source is no longer available. Start a new suggestion with the original file or use manual ranges.':response.status===413?'Choose one PDF or TIFF up to 10 MB and 30 pages.':'AI suggestions could not be completed. Check the saved request or try again.'),response.status,code);}
 return body as T;
}
export async function assertSuggestionActor(scope:SuggestionScope,isCurrent:()=>boolean,signal:AbortSignal){const actor=await request<{user:{id:string};workspace:{id:string;role:string}}>(scope,'/api/auth/me',isCurrent,signal);if(actor?.user?.id!==scope.userId||actor?.workspace?.id!==scope.workspaceId||!['owner','admin','editor'].includes(actor.workspace.role))throw new Error('Your account or permissions changed. Reopen the split dialog before continuing.');}
export function confirmSplitSuggestion(scope:SuggestionScope,value:SplitSuggestion,binding?:Partial<SavedSplitSuggestion>):SplitSuggestion{
 const fail=()=>{throw new Error('The AI result does not match this saved source. Check the original request before continuing.');};
 if(!value||!uuid.test(value.id)||!uuid.test(value.requestId)||value.parserId!==scope.parserId||value.sourceDocumentId!==null&&!uuid.test(value.sourceDocumentId)||!(/^[a-f0-9]{64}$/).test(value.sourceSha256)||!['application/pdf','image/tiff'].includes(value.sourceMimeType)||!['uploading','queued','processing','ready','failed','cancelled'].includes(value.state)||!Number.isFinite(Date.parse(value.expiresAt))||value.pageCount!==null&&(!Number.isInteger(value.pageCount)||value.pageCount<1||value.pageCount>30))return fail();
 if(binding&&(binding.requestId&&value.requestId!==binding.requestId||binding.suggestionId&&value.id!==binding.suggestionId||binding.sha256&&value.sourceSha256!==binding.sha256||binding.mimeType&&value.sourceMimeType!==binding.mimeType||binding.sourceDocumentId!==undefined&&value.sourceDocumentId!==binding.sourceDocumentId))return fail();
 if(value.state==='ready'){try{const ranges=splitSuggestionRanges(value.startPages,value.pageCount!);if(!Array.isArray(value.ranges)||ranges.length!==value.ranges.length||ranges.some((range,index)=>range.start!==value.ranges![index]?.start||range.end!==value.ranges![index]?.end))return fail();}catch{return fail();}}
 if(typeof value.creationClosed!=='boolean'||value.confirmedRequestId!==null&&!uuid.test(value.confirmedRequestId)||value.acceptedSplitId!==null&&(!uuid.test(value.acceptedSplitId)||!value.confirmedRequestId||!value.confirmedOptions||value.creationClosed))return fail();if(value.confirmedOptions)pdfSplitSpecSchema.parse(value.confirmedOptions);return value;
}
const base=(scope:SuggestionScope)=>`/api/parsers/${scope.parserId}/split-suggestions`;
export async function listSplitSuggestions(scope:SuggestionScope,isCurrent:()=>boolean,signal:AbortSignal){await assertSuggestionActor(scope,isCurrent,signal);const result=await request<SuggestionAvailability>(scope,base(scope),isCurrent,signal);if(typeof result?.available!=='boolean'||!Array.isArray(result.suggestions))throw new Error('AI availability could not be checked. Try again.');return{...result,suggestions:result.suggestions.map(value=>confirmSplitSuggestion(scope,value))};}
export async function findSplitSuggestion(value:SavedSplitSuggestion,isCurrent:()=>boolean,signal:AbortSignal){await assertSuggestionActor(value,isCurrent,signal);try{const result=await request<{suggestion:SplitSuggestion}>(value,`${base(value)}/requests/${value.requestId}`,isCurrent,signal);return confirmSplitSuggestion(value,result.suggestion,value);}catch(error){if(error instanceof SplitSuggestionError&&error.status===404)return null;throw error;}}
export async function getSplitSuggestion(scope:SuggestionScope,id:string,isCurrent:()=>boolean,signal:AbortSignal,binding?:Partial<SavedSplitSuggestion>){if(!uuid.test(id))throw new Error('The saved AI request is invalid.');await assertSuggestionActor(scope,isCurrent,signal);const result=await request<{suggestion:SplitSuggestion}>(scope,`${base(scope)}/${id}`,isCurrent,signal);return confirmSplitSuggestion(scope,result.suggestion,{...binding,suggestionId:id});}
/** This explicit request is the only action that sends a new source to AI. Preview/status reads never enqueue work. */
export async function requestSplitSuggestion(value:SavedSplitSuggestion,file:File|null,isCurrent:()=>boolean,signal:AbortSignal):Promise<SplitSuggestion>{
 current(value,isCurrent);value=saveSplitSuggestion(value);await assertSuggestionActor(value,isCurrent,signal);const existing=await findSplitSuggestion(value,isCurrent,signal);if(existing&&existing.state!=='uploading')return existing;
 let body:BodyInit;
 if(value.sourceDocumentId)body=JSON.stringify({requestId:value.requestId,documentId:value.sourceDocumentId,sourceSha256:value.sha256});
 else{
  if(!file||file.size<1||file.size>splitSuggestionLimits.maxBytes||await pdfSha256(await file.arrayBuffer())!==value.sha256)throw new Error('Reselect the same PDF or TIFF to resume this AI request.');current(value,isCurrent);
  const config=await request<{strategy:'signed'|'multipart';maxBytes:number}>(value,'/api/uploads/config',isCurrent,signal);
  if(config.strategy==='signed')body=JSON.stringify({requestId:value.requestId,filename:file.name,size:file.size,sourceSha256:value.sha256,mimeType:value.mimeType});
  else{const form=new FormData();form.append('requestId',value.requestId);form.append('sourceSha256',value.sha256);form.append('file',file);body=form;}
 }
 await assertSuggestionActor(value,isCurrent,signal);
 const result=await request<{suggestion:SplitSuggestion;upload?:{url:string;method:'PUT';headers:Record<string,string>;expiresAt:string}}>(value,base(value),isCurrent,signal,{method:'POST',body});
 let suggestion=confirmSplitSuggestion(value,result.suggestion,value);saveSplitSuggestion({...value,suggestionId:suggestion.id});
 if(result.upload&&suggestion.state==='uploading'){
  const destination=new URL(result.upload.url);if(!file||result.upload.method!=='PUT'||destination.protocol!=='https:'||!destination.hostname.endsWith('.supabase.co')||destination.username||destination.password)throw new Error('The private upload destination is invalid.');
  const headers=new Headers();for(const [name,header]of Object.entries(result.upload.headers||{})){if(!['content-type','x-upsert'].includes(name.toLowerCase()))throw new Error('The private upload headers are invalid.');headers.set(name,header);}
  await assertSuggestionActor(value,isCurrent,signal);let uploaded:Response;try{uploaded=await fetch(destination,{method:'PUT',body:file,headers,signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});}catch(error){if(signal.aborted)throw error;throw new Error('The AI source transfer could not be confirmed. Retry the saved request with the same file.');}await uploaded.body?.cancel();current(value,isCurrent);
  // A lost prior PUT may be complete even if its repeated PUT is rejected. Finalize verifies the immutable bytes.
  await assertSuggestionActor(value,isCurrent,signal);const finalized=await request<{suggestion:SplitSuggestion}>(value,`${base(value)}/${suggestion.id}/finalize`,isCurrent,signal,{method:'POST',body:'{}'});suggestion=confirmSplitSuggestion(value,finalized.suggestion,{...value,suggestionId:suggestion.id});
 }
 return suggestion;
}
export async function cancelSplitSuggestion(value:SavedSplitSuggestion,id:string,isCurrent:()=>boolean,signal:AbortSignal){await assertSuggestionActor(value,isCurrent,signal);const result=await request<{suggestion:SplitSuggestion}>(value,`${base(value)}/${id}/cancel`,isCurrent,signal,{method:'POST',body:'{}'});return confirmSplitSuggestion(value,result.suggestion,{...value,suggestionId:id});}
export async function readSplitSuggestionSource(scope:SuggestionScope,suggestion:SplitSuggestion,isCurrent:()=>boolean,signal:AbortSignal){
 confirmSplitSuggestion(scope,suggestion);await assertSuggestionActor(scope,isCurrent,signal);let response:Response;try{response=await fetch(`${base(scope)}/${suggestion.id}/source`,{signal,headers:{'X-Workspace-Id':scope.workspaceId},credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});}catch(error){if(signal.aborted)throw error;throw new Error('The saved AI source could not be loaded. Check your connection and retry.');}current(scope,isCurrent);
 if(!response.ok)throw new SplitSuggestionError('The saved AI source could not be loaded. Reselect the original file or continue with manual ranges.',response.status,'source_unavailable');
 if(response.headers.get('X-Folio-Source-Sha256')!==suggestion.sourceSha256){await response.body?.cancel();throw new Error('The saved AI source could not be verified. Reselect the original file.');}
 const bytes=await response.arrayBuffer();current(scope,isCurrent);if(!bytes.byteLength||bytes.byteLength>splitSuggestionLimits.maxBytes||await pdfSha256(bytes)!==suggestion.sourceSha256)throw new Error('The saved AI source could not be verified. Reselect the original file.');current(scope,isCurrent);
 const mime=(response.headers.get('content-type')||'').split(';')[0];if(mime!==suggestion.sourceMimeType&&mime!=='application/octet-stream')throw new Error('The saved AI source format could not be verified.');
 return{bytes:new Uint8Array(bytes),file:new File([bytes],suggestion.sourceName||`source.${suggestion.sourceMimeType==='image/tiff'?'tiff':'pdf'}`,{type:suggestion.sourceMimeType})};
}
export async function createSuggestedSplit(value:PendingPdfSplit&{userId:string;suggestionId:string;sourceDocumentId?:string},isCurrent:()=>boolean,signal:AbortSignal){
 await assertSuggestionActor(value,isCurrent,signal);const result=await request<PdfSplitReceipt>(value,`${base(value)}/${value.suggestionId}/create`,isCurrent,signal,{method:'POST',body:JSON.stringify({requestId:value.requestId,options:value.options})});
 const confirmed=confirmPdfSplitReceipt(value,result);if(value.sourceDocumentId&&(confirmed.split.origin!=='stored'||confirmed.split.sourceDocumentId!==value.sourceDocumentId))throw new Error('This split did not match the saved source. Check its result before continuing.');return confirmed;
}
