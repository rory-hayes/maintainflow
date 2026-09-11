import {keepPreviousData,useQuery,useQueryClient} from '@tanstack/react-query';
import {useRef,useState} from 'react';

export class ApiError extends Error {constructor(message:string,public status:number){super(message);}}
export function workspaceId(){return sessionStorage.getItem('folio.workspace')||'';}
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T> {
  const headers=new Headers(options.headers);
  if(workspaceId())headers.set('X-Workspace-Id',workspaceId());
  if(options.body&&!(options.body instanceof FormData))headers.set('Content-Type','application/json');
  const response=await fetch(path,{...options,headers,credentials:'same-origin'});
  if(!response.ok){const detail=await response.json().catch(()=>({message:'The request could not be completed.'}));throw new ApiError(detail.message||detail.error||'The request failed.',response.status);}
  if(response.status===204)return undefined as T;
  return response.json();
}
export const post=<T=any>(path:string,body:unknown={})=>api<T>(path,{method:'POST',body:JSON.stringify(body)});
export const patch=<T=any>(path:string,body:unknown)=>api<T>(path,{method:'PATCH',body:JSON.stringify(body)});
export function useData<T=any>(path:string,poll=false,retainPrevious=false){return useQuery<T>({queryKey:[workspaceId(),path],queryFn:({signal})=>api<T>(path,{signal}),refetchInterval:poll?1800:false,placeholderData:retainPrevious?keepPreviousData:undefined});}
export function useAction(){
  const client=useQueryClient();const running=useRef(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [message,setMessage]=useState('');
  async function run<T>(action:()=>Promise<T>,success='Saved.'):Promise<T|undefined>{if(running.current)return undefined;running.current=true;setBusy(true);setError('');setMessage('');try{const result=await action();await client.invalidateQueries();setMessage(success);return result;}catch(e){setError(e instanceof Error?e.message:'Something went wrong.');return undefined;}finally{running.current=false;setBusy(false);}}
  return {run,busy,error,message,setError,setMessage};
}
type UploadResult={document?:{id:string};duplicate?:boolean;name?:string;error?:string;jobId?:string|null};
export async function uploadDocuments(parserId:string,files:File[]):Promise<UploadResult&{results:UploadResult[]}>{
  const configuration=await api<{strategy:'signed'|'multipart';maxBytes:number}>('/api/uploads/config');
  if(configuration.strategy==='multipart'){
    const form=new FormData();files.forEach(file=>form.append('files',file));
    return api(`/api/parsers/${parserId}/documents`,{method:'POST',body:form,headers:{'Idempotency-Key':crypto.randomUUID()}});
  }
  const results:UploadResult[]=[];
  for(const file of files){
    try{
      if(file.size<1||file.size>configuration.maxBytes)throw new Error('Each file must contain data and be 10 MB or smaller.');
      const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
      const sha256=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
      const reservation=await post<{uploadId:string;uploadUrl:string}>(`/api/parsers/${parserId}/uploads`,{filename:file.name,size:file.size,sha256});
      const destination=new URL(reservation.uploadUrl);
      if(destination.protocol!=='https:'||!destination.hostname.endsWith('.supabase.co'))throw new Error('The private upload destination is invalid.');
      const uploaded=await fetch(destination,{method:'PUT',body:file,headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},credentials:'omit',redirect:'error',referrerPolicy:'no-referrer'});
      if(!uploaded.ok)throw new Error('The file could not be uploaded. Please retry.');
      await uploaded.body?.cancel();
      results.push(await post<UploadResult>(`/api/uploads/${reservation.uploadId}/finalize`));
    }catch(error){results.push({name:file.name,error:error instanceof Error?error.message:'Upload failed.'});}
  }
  return {...(results.length===1?results[0]:{}),results};
}
/** Fetch the scoped URL first so workspace headers are never forwarded across origins. */
export async function fetchOriginalFile(documentId:string,signal?:AbortSignal){
  const location=await api<{url:string;external:boolean}>(`/api/documents/${documentId}/original-url`,{signal});
  if(location.external){
    const url=new URL(location.url);
    if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co'))throw new Error('The private download destination is invalid.');
    return fetch(url,{signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store'});
  }
  if(location.url!==`/api/documents/${documentId}/original`)throw new Error('The private download destination is invalid.');
  return fetch(location.url,{signal,headers:{'X-Workspace-Id':workspaceId()},credentials:'same-origin',cache:'no-store'});
}
export async function downloadFile(path:string,filename:string){
  const original=/^\/api\/documents\/([a-f0-9-]{36})\/original$/.exec(path);
  const response=original?await fetchOriginalFile(original[1]):await fetch(path,{headers:{'X-Workspace-Id':workspaceId()},credentials:'same-origin'});
  if(!response.ok)throw new Error('The download could not be completed.');
  const href=URL.createObjectURL(await response.blob());const anchor=document.createElement('a');anchor.href=href;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(href),5000);
}
