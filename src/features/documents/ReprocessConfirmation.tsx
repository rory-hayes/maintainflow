import type {ComponentProps,RefObject} from 'react';
import {Button,Modal} from '../../components/ui';
import {post} from '../../lib/api';

type RunAction=<T>(action:()=>Promise<T>,success?:string)=>Promise<T|undefined>;

/** One opened confirmation permits one request, even before React renders busy state. */
export function createReprocessRequest(documentId:string,pageCount:number,run:RunAction){
  if(!Number.isSafeInteger(pageCount)||pageCount<1)throw new Error('The document page count is unavailable. Reload before reprocessing.');
  let phase:'ready'|'pending'|'closed'='ready';
  return {
    pageCount,
    cancel(){if(phase==='pending')return false;phase='closed';return true;},
    async confirm(){
      if(phase!=='ready')return false;
      phase='pending';
      try{await run(()=>post(`/api/documents/${encodeURIComponent(documentId)}/reprocess`),'Reprocessing queued. Approved output remains available.');}
      finally{phase='closed';}
      return true;
    },
  };
}

export default function ReprocessConfirmation({open,pageCount,busy,onCancel,onConfirm,returnFocusRef,fallbackFocusRef}:{open:boolean;pageCount:number;busy:boolean;onCancel:()=>void;onConfirm:()=>void;returnFocusRef:RefObject<HTMLButtonElement|null>;fallbackFocusRef?:RefObject<HTMLElement|null>}){
  const cost=`${pageCount} additional page credit${pageCount===1?'':'s'}`;
  const restoreFocus:ComponentProps<typeof Modal>['onCloseAutoFocus']=event=>{
    const invoker=returnFocusRef.current;
    const target=invoker?.isConnected&&!invoker.disabled?invoker:fallbackFocusRef?.current;
    if(target?.isConnected){event.preventDefault();target.focus({preventScroll:true});}
  };
  return <Modal title="Reprocess this document?" description={`This uses ${cost} and starts a new extraction with the parser’s current saved settings. Existing results and approved output remain available. Cancel uses no page credits.`} open={open} onOpenChange={value=>{if(!value)onCancel();}} onCloseAutoFocus={restoreFocus}>
    <div className="actions">
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      <Button type="button" disabled={busy} onClick={onConfirm}>{busy?'Queuing…':`Reprocess · ${pageCount} page${pageCount===1?'':'s'}`}</Button>
    </div>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{busy?'Queuing reprocessing. Please wait.':''}</span>
  </Modal>;
}
