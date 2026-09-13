import {useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {useQueryClient} from '@tanstack/react-query';
import {Download,Trash2} from 'lucide-react';
import {Button,Modal,Notice} from '../../components/ui';
import {api,downloadFile} from '../../lib/api';
import type {PdfSplitLineage} from '../../../shared/pdf-split';

export default function SplitLineage({split,documentId,parserId,canEdit}:{split:PdfSplitLineage;documentId:string;parserId:string;canEdit:boolean}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const running=useRef(false),navigate=useNavigate(),client=useQueryClient();
  async function remove(){
    if(running.current||!canEdit)return;running.current=true;setBusy(true);setError('');
    try{await api(`/api/pdf-splits/${split.id}`,{method:'DELETE'});void client.invalidateQueries();navigate(`/app/parsers/${parserId}`);}
    catch(cause){setError(cause instanceof Error?cause.message:'The batch could not be deleted.');}
    finally{running.current=false;setBusy(false);}
  }
  return <aside className="pdf-split-lineage" aria-label="Original PDF batch"><div><strong>From {split.sourceName||'an original PDF'} · original pages {split.originalPageStart===split.originalPageEnd?split.originalPageStart:`${split.originalPageStart}–${split.originalPageEnd}`} of {split.sourcePageCount}</strong><p className="small">Document {split.index} of {split.childCount} · {split.retainedDocuments} retained. {split.sourceAvailable?'The full original includes omitted pages and pages from deleted documents while any document in this batch remains.':'The full original is no longer available.'}</p></div><div className="actions">{split.sourceAvailable&&<Button type="button" variant="ghost" onClick={()=>void downloadFile(`/api/documents/${documentId}/bundle-original`,split.sourceName||'original-bundle.pdf').catch(cause=>setError(cause instanceof Error?cause.message:'The original PDF could not be downloaded.'))}><Download/>Download full original PDF</Button>}{canEdit&&<Button type="button" variant="ghost" onClick={()=>{setError('');setOpen(true);}}><Trash2/>Delete whole batch</Button>}</div>{!open&&<Notice error={error}/>}<Modal title="Delete this PDF batch?" description={`This deletes all ${split.retainedDocuments} retained documents in the batch, their extraction results and saved exports. Deletion of their files and the full original PDF is queued. This cannot be undone.`} open={open} onOpenChange={value=>{if(!running.current)setOpen(value);}}><Notice error={error}/><div className="actions"><Button type="button" variant="danger" disabled={busy} onClick={()=>void remove()}>{busy?'Deleting…':'Delete whole batch'}</Button><Button type="button" variant="ghost" disabled={busy} onClick={()=>setOpen(false)}>Keep batch</Button></div></Modal></aside>;
}
