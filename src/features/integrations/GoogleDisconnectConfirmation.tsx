import type {ComponentProps,RefObject} from 'react';
import {Button,Modal} from '../../components/ui';
import {api,workspaceId} from '../../lib/api';

type RunAction=<T>(action:()=>Promise<T>,success?:string)=>Promise<T|undefined>;
export type GoogleDisconnectResult={disconnected:true;providerRevoked:boolean;reason:string|null};
export function googleDisconnectMessage(result:GoogleDisconnectResult){
  return result.providerRevoked
    ? 'This connection is disconnected. Google confirmed the revocation request. Other connections using the same Google account may need to reconnect.'
    : 'This connection is disconnected locally, but Google revocation could not be confirmed. Review MaintainFlow’s access in your Google account to remove it.';
}

/** Each opened confirmation permits one request, before any busy-state render. */
export function createGoogleDisconnectRequest(integration:{id:string;name:string},run:RunAction,onResult:(result:GoogleDisconnectResult)=>void){
  const selectedWorkspace=workspaceId();
  let phase:'ready'|'pending'|'closed'='ready';
  return {
    name:integration.name,
    cancel(){if(phase==='pending')return false;phase='closed';return true;},
    async confirm(){
      if(phase!=='ready')return false;
      phase='pending';
      try{
        const result=await run(()=>{
          if(!selectedWorkspace)throw new Error('Select a workspace and open the disconnect confirmation again.');
          if(workspaceId()!==selectedWorkspace)throw new Error('The workspace changed. Open the disconnect confirmation again in the intended workspace.');
          return api<GoogleDisconnectResult>(`/api/google/${encodeURIComponent(integration.id)}/disconnect`,{method:'POST',body:'{}'},selectedWorkspace);
        },'');
        if(result)onResult(result);
      }finally{phase='closed';}
      return true;
    },
  };
}

export default function GoogleDisconnectConfirmation({open,name,busy,onCancel,onConfirm,returnFocusRef,fallbackFocusRef}:{open:boolean;name:string;busy:boolean;onCancel:()=>void;onConfirm:()=>void;returnFocusRef:RefObject<HTMLButtonElement|null>;fallbackFocusRef:RefObject<HTMLElement|null>}){
  const restoreFocus:ComponentProps<typeof Modal>['onCloseAutoFocus']=event=>{
    const invoker=returnFocusRef.current;
    const target=invoker?.isConnected&&!invoker.disabled?invoker:fallbackFocusRef.current;
    if(target?.isConnected){event.preventDefault();target.focus({preventScroll:true});}
  };
  return <Modal title={`Disconnect “${name}”?`} description="Future deliveries through this connection will stop. Removing Google access may also stop other MaintainFlow connections using the same Google account, including connections in other workspaces. You may need to reconnect them." open={open} onOpenChange={value=>{if(!value)onCancel();}} onCloseAutoFocus={restoreFocus}>
    <p>Existing spreadsheet data remains. Writes already submitted may finish.</p>
    <div className="actions">
      <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button type="button" variant="danger" disabled={busy} onClick={onConfirm}>{busy?'Disconnecting…':'Disconnect and revoke Google access'}</Button>
    </div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{busy?'Disconnecting. Please wait.':''}</span>
  </Modal>;
}
