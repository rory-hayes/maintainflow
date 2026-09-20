import {useState} from 'react';
import {Link} from 'react-router-dom';
import {Button,Notice,dateTime} from '../../components/ui';
import {useData} from '../../lib/api';
import type {PdfSplitReceipt} from '../../../shared/pdf-split';
import UndoPdfSplit from './UndoPdfSplit';

export default function StoredPdfSplitHistory({documentId}:{documentId:string}){
 const [before,setBefore]=useState('');
 const result=useData<{batches:PdfSplitReceipt[];nextCursor:string|null;sourceAvailable:boolean}>(`/api/documents/${documentId}/pdf-splits${before?`?before=${before}`:''}`);
 if(result.isPending)return null;
 if(result.error)return <aside className="pdf-stored-history" aria-label="Splits from this PDF"><Notice error="Split history could not be loaded."/><Button variant="ghost" onClick={()=>void result.refetch()}>Retry split history</Button></aside>;
 if(!result.data?.batches.length)return null;
 return <aside className="pdf-stored-history" aria-label="Splits from this PDF"><details><summary>Splits from this PDF</summary><p className="small muted">Each split is a separate batch. This source and its earlier review history are preserved.</p><ol>{result.data.batches.map(receipt=><li key={receipt.split.id}><div><strong>{receipt.split.childCount} documents · {receipt.split.selectedPages} page credits</strong><span className="small muted"> · {dateTime(receipt.split.createdAt)}</span><p className="small">{receipt.split.undoneAt?'Undone':`${receipt.documents.filter(child=>child.available).length} documents retained`}</p><div className="pdf-stored-child-links">{receipt.documents.map(child=>child.available?<Link className="link small" key={child.id} to={`/app/documents/${child.id}`}>{child.name||`Document ${child.index}`} · source pages {child.originalPageStart}–{child.originalPageEnd}</Link>:<span className="small muted" key={child.id}>Document {child.index} · removed</span>)}</div></div><UndoPdfSplit receipt={receipt}/></li>)}</ol><div className="actions">{before&&<Button variant="ghost" onClick={()=>setBefore('')}>Latest splits</Button>}{result.data.nextCursor&&<Button variant="ghost" onClick={()=>setBefore(result.data!.nextCursor!)}>Older splits</Button>}</div></details></aside>;
}
