import {useEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight,Minus,Plus,Download} from 'lucide-react';
import {Button,Notice} from '../../components/ui';
import {fetchOriginalFile,downloadFile} from '../../lib/api';
import type {PageText} from '../../../shared/types';
export default function DocumentPreview({document:doc,page,setPage}:{document:any;page:number;setPage:(n:number)=>void}){
  const [zoom,setZoom]=useState(100),[imageUrl,setImageUrl]=useState(''),[error,setError]=useState('');const canvas=useRef<HTMLCanvasElement>(null);const pages:PageText[]=doc.sourceText||[];
  useEffect(()=>{
    setImageUrl('');setError('');
    if(doc.mimeType!=='application/pdf'&&!doc.mimeType.startsWith('image/'))return;
    let cancelled=false;let objectUrl='';let task:any;const controller=new AbortController();
    void(async()=>{try{setError('');const response=await fetchOriginalFile(doc.id,controller.signal);if(!response.ok)throw new Error('Could not load the original file.');const bytes=await response.arrayBuffer();if(cancelled)return;
      if(doc.mimeType==='application/pdf'){
        const pdfjs=await import('pdfjs-dist');const worker=(await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;pdfjs.GlobalWorkerOptions.workerSrc=worker;task=pdfjs.getDocument({data:new Uint8Array(bytes)});const pdf=await task.promise;if(cancelled)return;const pdfPage=await pdf.getPage(page);const viewport=pdfPage.getViewport({scale:1.3});const target=canvas.current;if(!target||cancelled)return;target.width=viewport.width;target.height=viewport.height;await pdfPage.render({canvas:target,viewport}).promise;
      }else{objectUrl=URL.createObjectURL(new Blob([bytes],{type:doc.mimeType}));setImageUrl(objectUrl);}
    }catch(e){if(!cancelled)setError(e instanceof Error?e.message:'Preview unavailable.');}})();
    return()=>{cancelled=true;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);void task?.destroy();};
  },[doc.id,doc.mimeType,page]);
  return <section className="document-preview" aria-label="Original document"><div className="preview-toolbar"><div className="actions"><button className="icon-button" aria-label="Previous page" disabled={page<=1} onClick={()=>setPage(page-1)}><ChevronLeft size={17}/></button><span>Page {page} of {doc.pageCount}</span><button className="icon-button" aria-label="Next page" disabled={page>=doc.pageCount} onClick={()=>setPage(page+1)}><ChevronRight size={17}/></button></div><div className="actions"><button className="icon-button" aria-label="Zoom out" disabled={zoom<=50} onClick={()=>setZoom(zoom-10)}><Minus size={17}/></button><span>{zoom}%</span><button className="icon-button" aria-label="Zoom in" disabled={zoom>=180} onClick={()=>setZoom(zoom+10)}><Plus size={17}/></button></div></div><Notice error={error}/><div className="preview-scroll"><div className="preview-paper" style={{width:`${zoom}%`,minWidth:zoom>100?`${zoom}%`:undefined}}>{doc.mimeType==='application/pdf'?<canvas ref={canvas} role="img" aria-label={`Original PDF, page ${page}`}/>:doc.mimeType.startsWith('image/')?<img src={imageUrl||undefined} alt={doc.name}/>:<div className="text-document"><div className="text-doc-caption">ORIGINAL TEXT</div><pre>{pages.find(p=>p.page===page)?.text||'No readable text on this page.'}</pre></div>}</div></div><div className="preview-footer"><Button variant="ghost" onClick={()=>void downloadFile(`/api/documents/${doc.id}/original`,doc.name).catch(error=>setError(error instanceof Error?error.message:'The download could not be completed.'))}><Download/>Download original</Button></div></section>;
}
