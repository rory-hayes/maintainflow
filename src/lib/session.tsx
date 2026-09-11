import {createContext,useContext,useState,type ReactNode} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api,post,workspaceId} from './api';
import type {Role} from '../../shared/types';
export type Workspace={id:string;name:string;role:Role;settings:Record<string,unknown>;plan:{name:string;monthlyPages:number;maxParsers:number;maxConcurrent:number}};
export type Session={user:{id:string;name:string;email:string};workspace:Workspace;workspaces:Workspace[]};
type SessionValue={data?:Session;loading:boolean;refresh:()=>Promise<void>;select:(id:string)=>Promise<void>;logout:()=>Promise<void>};
const Context=createContext<SessionValue>(null!);
export function SessionProvider({children}:{children:ReactNode}){
  const client=useQueryClient();
  const [selectedWorkspace,setSelectedWorkspace]=useState(workspaceId);
  const query=useQuery<Session>({queryKey:['session',selectedWorkspace],queryFn:()=>api('/api/auth/me'),retry:false,staleTime:30_000});
  async function refresh(){
    const id=workspaceId();
    if(id!==selectedWorkspace){
      const session=await api<Session>('/api/auth/me');
      await client.cancelQueries();client.clear();
      client.setQueryData(['session',id],session);setSelectedWorkspace(id);
    }else await client.invalidateQueries({queryKey:['session']});
  }
  async function select(id:string){
    const session=await post<Session>(`/api/workspaces/${id}/select`);
    await client.cancelQueries();sessionStorage.setItem('folio.workspace',id);client.clear();
    client.setQueryData(['session',id],session);setSelectedWorkspace(id);
  }
  async function logout(){await post('/api/auth/logout');sessionStorage.removeItem('folio.workspace');client.clear();window.location.assign('/sign-in');}
  return <Context.Provider value={{data:query.data,loading:query.isPending,refresh,select,logout}}>{children}</Context.Provider>;
}
export const useSession=()=>useContext(Context);
