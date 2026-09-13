import {useEffect,useRef,useState} from 'react';
import type {PDFDocumentProxy} from 'pdfjs-dist';
import {Notice} from '../../components/ui';
import {pdfSplitLimits} from '../../../shared/pdf-split';

/** Shared local/stored PDF renderer. PDF.js owns a copy so its worker cannot detach caller bytes. */
export default function PdfCanvas({bytes,page,label,onReady,onRendered,onError}:{bytes:Uint8Array;page:number;label:string;onReady?:(count:number)=>void;onRendered?:(page:number)=>void;onError?:(message:string)=>void}){
  const target=useRef<HTMLCanvasElement>(null),callbacks=useRef({onReady,onRendered,onError});callbacks.current={onReady,onRendered,onError};
  const [loaded,setLoaded]=useState<{bytes:Uint8Array;pdf:PDFDocumentProxy}|null>(null),[error,setError]=useState('');
  const [rendered,setRendered]=useState<{bytes:Uint8Array;page:number}|null>(null);
  const pdf=loaded?.bytes===bytes?loaded.pdf:null,ready=rendered?.bytes===bytes&&rendered.page===page;
  useEffect(()=>{
    let disposed=false;let task:ReturnType<typeof import('pdfjs-dist')['getDocument']>|undefined;
    setLoaded(null);setRendered(null);setError('');
    void(async()=>{try{
      const pdfjs=await import('pdfjs-dist');const worker=(await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      if(disposed)return;pdfjs.GlobalWorkerOptions.workerSrc=worker;task=pdfjs.getDocument({data:bytes.slice(),stopAtErrors:true,maxImageSize:16_000_000,canvasMaxAreaInBytes:16_000_000});
      task.onPassword=()=>{if(!disposed){const message='Password-protected PDFs cannot be previewed here. Choose an unlocked PDF.';setError(message);callbacks.current.onError?.(message);}void task?.destroy();};
      const document=await task.promise;if(disposed)return;
      if(document.numPages<1||document.numPages>pdfSplitLimits.maxPages){const message=`Choose a PDF with 1 to ${pdfSplitLimits.maxPages} pages.`;setError(message);callbacks.current.onError?.(message);void task.destroy();return;}
      setLoaded({bytes,pdf:document});callbacks.current.onReady?.(document.numPages);
    }catch{if(!disposed){const message='The PDF could not be opened. Choose an unlocked, readable PDF.';setError(message);callbacks.current.onError?.(message);}}})();
    return()=>{disposed=true;void task?.destroy();};
  },[bytes]);
  useEffect(()=>{
    setRendered(null);if(!pdf)return;let disposed=false;let rendering:ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']>|undefined;
    if(target.current)target.current.getContext('2d')?.clearRect(0,0,target.current.width,target.current.height);
    void(async()=>{try{
      const source=await pdf.getPage(page);if(disposed||!target.current)return;
      const natural=source.getViewport({scale:1});
      if(!Number.isFinite(natural.width)||!Number.isFinite(natural.height)||natural.width<=0||natural.height<=0)throw new Error('Invalid page dimensions');
      // Bound canvas memory even when an untrusted PDF declares an enormous page.
      const scale=Math.min(1.3,2048/Math.max(natural.width,natural.height),Math.sqrt(4_000_000/natural.width/natural.height));
      const viewport=source.getViewport({scale});target.current.width=Math.max(1,Math.floor(viewport.width));target.current.height=Math.max(1,Math.floor(viewport.height));
      rendering=source.render({canvas:target.current,viewport});await rendering.promise;if(!disposed){setRendered({bytes,page});callbacks.current.onRendered?.(page);}
    }catch{if(!disposed){
      if(target.current){target.current.width=1;target.current.height=1;}setRendered(null);
      const message='This page exceeds PDF preview limits or could not be rendered. Open the original PDF to inspect it.';setError(message);callbacks.current.onError?.(message);
    }}})();
    return()=>{disposed=true;rendering?.cancel();};
  },[pdf,bytes,page]);
  return <div className="pdf-canvas" aria-busy={!ready&&!error}><Notice error={error}/>{!pdf&&!error&&<p className="small muted" role="status">Reading PDF…</p>}<canvas ref={target} role="img" aria-label={label} data-render-state={error?'error':ready?'ready':'loading'} data-rendered-page={ready?String(page):undefined} hidden={!pdf||Boolean(error)}/></div>;
}
