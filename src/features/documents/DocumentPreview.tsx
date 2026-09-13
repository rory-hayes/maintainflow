import {useEffect,useState} from 'react';
import {ChevronLeft,ChevronRight,Minus,Plus,Download} from 'lucide-react';
import {Button,Notice} from '../../components/ui';
import {fetchOriginalFile,downloadFile} from '../../lib/api';
import type {PageText} from '../../../shared/types';
import type {PdfSplitLineage} from '../../../shared/pdf-split';
import PdfCanvas from './PdfCanvas';
export default function DocumentPreview({document:doc,split,page,setPage}:{document:any;split?:PdfSplitLineage|null;page:number;setPage:(n:number)=>void}){
  const [zoom,setZoom]=useState(100),[imageUrl,setImageUrl]=useState(''),[bytes,setBytes]=useState<Uint8Array|null>(null),[error,setError]=useState('');const pages:PageText[]=doc.sourceText||[];
  useEffect(()=>{
    setImageUrl('');setBytes(null);setError('');
    if(doc.mimeType!=='application/pdf'&&!doc.mimeType.startsWith('image/'))return;
    let cancelled=false;let objectUrl='';const controller=new AbortController();
    void(async()=>{try{const response=await fetchOriginalFile(doc.id,controller.signal);if(!response.ok)throw new Error('Could not load the original file.');const data=await response.arrayBuffer();if(cancelled)return;
      if(doc.mimeType==='application/pdf')setBytes(new Uint8Array(data));
      else{objectUrl=URL.createObjectURL(new Blob([data],{type:doc.mimeType}));setImageUrl(objectUrl);}
    }catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:'Preview unavailable.');}})();
    return()=>{cancelled=true;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[doc.id,doc.mimeType]);
  const originalPage=split?split.originalPageStart+page-1:null;
  return <section className="document-preview" aria-label="Original document"><div className="preview-toolbar"><div className="actions"><button className="icon-button" aria-label="Previous page" disabled={page<=1} onClick={()=>setPage(page-1)}><ChevronLeft size={17}/></button><span>Page {page} of {doc.pageCount}{originalPage!==null&&<span className="pdf-original-page"> · Original page {originalPage}</span>}</span><button className="icon-button" aria-label="Next page" disabled={page>=doc.pageCount} onClick={()=>setPage(page+1)}><ChevronRight size={17}/></button></div><div className="actions"><button className="icon-button" aria-label="Zoom out" disabled={zoom<=50} onClick={()=>setZoom(zoom-10)}><Minus size={17}/></button><span>{zoom}%</span><button className="icon-button" aria-label="Zoom in" disabled={zoom>=180} onClick={()=>setZoom(zoom+10)}><Plus size={17}/></button></div></div><Notice error={error}/><div className="preview-scroll"><div className="preview-paper" style={{width:`${zoom}%`,minWidth:zoom>100?`${zoom}%`:undefined}}>{doc.mimeType==='application/pdf'?(bytes?<PdfCanvas bytes={bytes} page={page} label={`Original PDF, page ${page}${originalPage!==null?`, original page ${originalPage}`:''}`}/>:!error&&<p className="small muted" role="status">Loading PDF…</p>):doc.mimeType.startsWith('image/')?<img src={imageUrl||undefined} alt={doc.name}/>:<div className="text-document"><div className="text-doc-caption">ORIGINAL TEXT</div><pre>{pages.find(p=>p.page===page)?.text||'No readable text on this page.'}</pre></div>}</div></div><div className="preview-footer"><Button variant="ghost" onClick={()=>void downloadFile(`/api/documents/${doc.id}/original`,doc.name).catch(cause=>setError(cause instanceof Error?cause.message:'The download could not be completed.'))}><Download/>{split?'Download this document':'Download original'}</Button></div></section>;
}
