import {useLayoutEffect,useRef,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {Undo2} from 'lucide-react';
import {Button,Modal,Notice} from '../../components/ui';
import {useSession} from '../../lib/session';
import {useData} from '../../lib/api';
import {checkStoredBatch,undoStoredBatch,type StoredSplitScope} from '../../lib/stored-pdf-split';
import type {PdfSplitReceipt} from '../../../shared/pdf-split';

export default function UndoPdfSplit({receipt,onChanged}:{receipt:PdfSplitReceipt;onChanged?:(receipt:PdfSplitReceipt)=>void}){
 const session=useSession().data;
 if(!session||!['owner','admin','editor'].includes(session.workspace.role)||receipt.split.origin!=='stored')return null;
 const scope={userId:session.user.id,workspaceId:session.workspace.id,parserId:receipt.split.parserId};
 return <UndoAction key={`${scope.userId}:${scope.workspaceId}:${session.workspace.role}:${receipt.split.id}:${receipt.split.undoneAt||''}`} scope={scope} receipt={receipt} onChanged={onChanged}/>;
}
function UndoAction({scope,receipt,onChanged}:{scope:StoredSplitScope;receipt:PdfSplitReceipt;onChanged?:(receipt:PdfSplitReceipt)=>void}){
 const kind=receipt.split.sourceMimeType==='image/tiff'?'TIFF':'PDF';
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[latest,setLatest]=useState(receipt);
 const mounted=useRef(false),running=useRef(false),controller=useRef(new AbortController()),client=useQueryClient();
 useLayoutEffect(()=>{mounted.current=true;controller.current=new AbortController();return()=>{mounted.current=false;controller.current.abort();};},[]);
 function applied(value:PdfSplitReceipt){if(!mounted.current)return;setLatest(value);setUncertain(false);setError('');if(value.split.undoneAt)setOpen(false);void client.invalidateQueries();onChanged?.(value);}
 async function act(checkOnly=false){
  if(running.current)return;running.current=true;setBusy(true);setError('');
  try{applied(await(checkOnly?checkStoredBatch(scope,latest,()=>mounted.current,controller.current.signal):undoStoredBatch(scope,latest,()=>mounted.current,controller.current.signal)));}
  catch{if(!mounted.current)return;if(!checkOnly){try{const found=await checkStoredBatch(scope,latest,()=>mounted.current,controller.current.signal);if(found.split.undoneAt){applied(found);return;}}catch{/* Preserve the same batch for recovery. */}}if(mounted.current){setUncertain(true);setError('Undo could not be confirmed. Check this split’s status before trying again. The source document is preserved.');}}
  finally{running.current=false;if(mounted.current)setBusy(false);}
 }
 if(latest.split.undoneAt)return <p className="small pdf-split-undone" role="status">Split undone · source and used page credits unchanged</p>;
 return <><Button type="button" variant="ghost" onClick={()=>setOpen(true)}><Undo2/>Undo this split</Button><Modal title="Undo this split?" description={`This removes this batch’s created documents, their results, and exports containing those documents. The source ${kind}, its earlier original-only exports, sibling splits and nested batches remain. Used page credits are unchanged. File deletion is queued.`} open={open} onOpenChange={value=>{if(!running.current)setOpen(value);}}><Notice error={error}/><div className="actions"><Button type="button" variant={uncertain?'secondary':'danger'} disabled={busy} onClick={()=>void act(uncertain)}>{busy?'Checking split…':uncertain?'Check undo status':'Undo this split'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setOpen(false)}>Keep split</Button></div></Modal></>;
}

export function StoredBatchUndo({parserId,requestId,onChanged}:{parserId:string;requestId:string;onChanged?:(receipt:PdfSplitReceipt)=>void}){
 const result=useData<PdfSplitReceipt>(`/api/parsers/${parserId}/pdf-splits/requests/${requestId}`);
 if(result.isPending)return null;
 if(result.error)return <div><Notice error="Split status could not be loaded."/><Button variant="ghost" onClick={()=>void result.refetch()}>Retry split status</Button></div>;
 return result.data?<UndoPdfSplit receipt={result.data} onChanged={onChanged}/>:null;
}
