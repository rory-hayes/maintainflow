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
export async function downloadFile(path:string,filename:string){
  const response=await fetch(path,{headers:{'X-Workspace-Id':workspaceId()},credentials:'same-origin'});
  if(!response.ok)throw new Error('The download could not be completed.');
  const href=URL.createObjectURL(await response.blob());const anchor=document.createElement('a');anchor.href=href;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(href),5000);
}
