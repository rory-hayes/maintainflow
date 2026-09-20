import {useLayoutEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight,Minus,Plus,Download} from 'lucide-react';
import {Button,Notice} from '../../components/ui';
import {fetchOriginalFile,fetchDocumentPagePreview,downloadFile} from '../../lib/api';
import {useSession} from '../../lib/session';
import type {PageText} from '../../../shared/types';
import type {PdfSplitLineage} from '../../../shared/pdf-split';
import PdfCanvas from './PdfCanvas';

type Props={document:any;split?:PdfSplitLineage|null;archiveChild?:boolean;page:number;setPage:(n:number)=>void};
type Media={page:number;request:number;url?:string;bytes?:Uint8Array;error?:string};
const tiffError='This TIFF page could not be previewed. Try again or download the original TIFF.';

export default function DocumentPreview(props:Props){
  const session=useSession()?.data,doc=props.document;
  return <PreviewContent key={`${doc.id}:${doc.mimeType}:${doc.sha256||''}:${session?.user.id}:${session?.workspace.id}`} {...props}/>;
}
function PreviewContent({document:doc,split,archiveChild=false,page,setPage}:Props){
  const [zoom,setZoom]=useState(100),[media,setMedia]=useState<Media|null>(null),[retry,setRetry]=useState(0),[downloadError,setDownloadError]=useState('');
  const preview=useRef<HTMLElement>(null),mounted=useRef(false),requestVersion=useRef(0),pages:PageText[]=doc.sourceText||[],isTiff=doc.mimeType==='image/tiff',isPdf=doc.mimeType==='application/pdf',isImage=doc.mimeType.startsWith('image/');
  const mediaPage=isTiff?page:0,current=media?.page===mediaPage?media:null;
  useLayoutEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  // Cancel during commit: old responses must not paint a replacement page or account.
  useLayoutEffect(()=>{
    setMedia(null);if(!isPdf&&!isImage)return;
    const request=++requestVersion.current;let disposed=false,objectUrl='';const controller=new AbortController();
    void(async()=>{try{
      const response=isTiff?await fetchDocumentPagePreview(doc.id,mediaPage,controller.signal):await fetchOriginalFile(doc.id,controller.signal);
      if(!response.ok)throw new Error('Could not load the original file.');
      const data=await response.arrayBuffer();if(disposed)return;
      if(isPdf){setMedia({page:mediaPage,request,bytes:new Uint8Array(data)});return;}
      if(isTiff&&data.byteLength>2*1024*1024)throw new Error('Preview size exceeded');
      objectUrl=URL.createObjectURL(new Blob([data],{type:isTiff?'image/jpeg':doc.mimeType}));
      const image=new Image();image.src=objectUrl;await image.decode();if(disposed)return;
      setMedia({page:mediaPage,request,url:objectUrl});
    }catch{if(!disposed){if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl='';}setMedia({page:mediaPage,request,error:isTiff?tiffError:'The original could not be previewed. Try again or download it to inspect the file.'});}}})();
    return()=>{disposed=true;requestVersion.current++;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[doc.id,doc.mimeType,isPdf,isImage,isTiff,mediaPage,retry]);
  const originalPage=split?split.originalPageStart+page-1:isTiff?page:null,originalLabel=split?.origin==='stored'?`Source ${isTiff?'TIFF':'PDF'} page`:'Original page';
  const error=current?.error||'',loading=(isPdf||isImage)&&!current;
  return <section ref={preview} tabIndex={-1} className="document-preview" aria-label="Original document">
    <div className="preview-toolbar"><div className="actions"><button className="icon-button" aria-label="Previous page" disabled={page<=1} onClick={()=>setPage(page-1)}><ChevronLeft size={17}/></button><span>Page {page} of {doc.pageCount}{originalPage!==null&&<span className="pdf-original-page"> · {originalLabel} {originalPage}</span>}</span><button className="icon-button" aria-label="Next page" disabled={page>=doc.pageCount} onClick={()=>setPage(page+1)}><ChevronRight size={17}/></button></div><div className="actions"><button className="icon-button" aria-label="Zoom out" disabled={zoom<=50} onClick={()=>setZoom(zoom-10)}><Minus size={17}/></button><span>{zoom}%</span><button className="icon-button" aria-label="Zoom in" disabled={zoom>=180} onClick={()=>setZoom(zoom+10)}><Plus size={17}/></button></div></div>
    <Notice error={downloadError}/>
    <div className="preview-scroll" aria-busy={loading}>
      {isTiff&&<p className="small muted tiff-preview-label">TIFF page preview · Original page {page}</p>}
      {error&&<div className="preview-error"><Notice error={error}/><Button variant="secondary" onClick={()=>{preview.current?.focus({preventScroll:true});setRetry(value=>value+1);}}>Retry preview</Button></div>}
      <div className="preview-paper" style={{width:`${zoom}%`,minWidth:zoom>100?`${zoom}%`:undefined}}>
        {isPdf?(current?.bytes?<PdfCanvas bytes={current.bytes} page={page} label={`Original PDF, page ${page}${originalPage!==null?`, ${originalLabel.toLowerCase()} ${originalPage}`:''}`}/>:!error&&<p className="small muted" role="status">Loading PDF…</p>):isImage?(current?.url?<img key={current.url} src={current.url} alt={isTiff?`TIFF page preview, original page ${page}`:doc.name} onError={()=>{if(mounted.current&&requestVersion.current===current.request)setMedia({page:mediaPage,request:current.request,error:isTiff?tiffError:'The original could not be previewed. Try again or download it to inspect the file.'});}}/>:!error&&<p className="small muted" role="status">{isTiff?`Loading TIFF page ${page}…`:'Loading image…'}</p>):<div className="text-document"><div className="text-doc-caption">ORIGINAL TEXT</div><pre>{pages.find(p=>p.page===page)?.text||'No readable text on this page.'}</pre></div>}
      </div>
    </div>
    <div className="preview-footer"><Button variant="ghost" onClick={()=>{setDownloadError('');void downloadFile(`/api/documents/${doc.id}/original`,doc.name).catch(()=>{if(mounted.current)setDownloadError('The download could not be completed. Try again.');});}}><Download/>{split||archiveChild?'Download this document':'Download original'}</Button></div>
  </section>;
}
