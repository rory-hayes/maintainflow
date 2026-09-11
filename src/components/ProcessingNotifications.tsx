import {useState} from 'react';
import {Link} from 'react-router-dom';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import {Bell,Check,CircleCheck,AlertCircle,X} from 'lucide-react';
import {api,post} from '../lib/api';
import {Button,ErrorState,Loading,Notice,dateTime} from './ui';
import './notifications.css';

type Notification={id:string;documentId:string;documentName:string;kind:'ready_for_review'|'processing_failed';occurredAt:string;read:boolean};
type NotificationData={enabled:boolean;unreadCount:number;notifications:Notification[]};
export default function ProcessingNotifications({workspaceId,userId}:{workspaceId:string;userId:string}){
 const [open,setOpen]=useState(false),client=useQueryClient();
 const queryKey=[workspaceId,userId,'processing-notifications'];
 const query=useQuery<NotificationData>({queryKey,queryFn:({signal})=>api('/api/workspace/notifications',{signal}),refetchInterval:15_000});
 const mark=useMutation({mutationFn:(jobIds?:string[])=>post('/api/workspace/notifications/read',jobIds?{jobIds}:{}),onSuccess:()=>client.invalidateQueries({queryKey})});
 const unread=query.data?.unreadCount||0;
 return <Dialog.Root open={open} onOpenChange={setOpen}>
  <Dialog.Trigger asChild><button type="button" className="icon-button processing-notifications-trigger" aria-label={`Processing notifications${unread?`, ${unread} unread`:''}`}><Bell size={19}/>{unread>0&&<span className="notification-count" aria-hidden="true">{unread>99?'99+':unread}</span>}</button></Dialog.Trigger>
  <Dialog.Portal><Dialog.Overlay className="modal-overlay"/><Dialog.Content className="modal notification-dialog">
   <Dialog.Title>Processing notifications</Dialog.Title>
   <Dialog.Description>Completed and failed jobs in this workspace. Read status is saved for your account.</Dialog.Description>
   <Dialog.Close asChild><button type="button" className="icon-button modal-close" aria-label="Close notifications"><X size={20}/></button></Dialog.Close>
   <div className="notification-body">
    {query.isPending?<Loading/>:query.error?<ErrorState error={query.error} retry={()=>void query.refetch()}/>:!query.data?.enabled?<div className="notification-empty"><Bell size={25}/><h3>Processing notifications are off.</h3><p>A workspace administrator can enable this inbox in Settings. Document status remains available on each document.</p><Link className="link" to="/app/settings?tab=notifications" onClick={()=>setOpen(false)}>Notification settings</Link></div>:<>
     <div className="notification-toolbar"><span className="small muted">{unread} unread · Latest 50 jobs</span><Button type="button" variant="ghost" disabled={!unread||mark.isPending} onClick={()=>mark.mutate(undefined)}>Mark all read</Button></div>
     <Notice error={mark.error instanceof Error?mark.error.message:undefined}/>
     {query.data.notifications.length?<ol className="notification-list">{query.data.notifications.map(item=><li key={item.id} className={item.read?'':'unread'}>
      {item.kind==='processing_failed'?<AlertCircle size={21} className="notification-failure"/>:<CircleCheck size={21} className="notification-complete"/>}
      <div className="notification-copy"><strong>{item.kind==='processing_failed'?'Processing failed':'Extraction ready to review'}</strong><Link to={`/app/documents/${item.documentId}`} onClick={()=>{if(!item.read)mark.mutate([item.id]);setOpen(false);}}>{item.documentName}</Link><span>{dateTime(item.occurredAt)}</span></div>
      {!item.read?<button type="button" className="icon-button" aria-label={`Mark notification read for ${item.documentName}`} disabled={mark.isPending} onClick={()=>mark.mutate([item.id])}><Check size={17}/></button>:<span className="small muted notification-read">Read</span>}
     </li>)}</ol>:<div className="notification-empty"><CircleCheck size={27}/><h3>No completed or failed jobs yet.</h3><p>Processing results will appear here when the worker finishes.</p></div>}
    </>}
   </div>
   <p className="small muted notification-footer">In-app updates only. No notification emails are sent.</p>
  </Dialog.Content></Dialog.Portal>
 </Dialog.Root>;
}
