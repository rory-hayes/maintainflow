import {useLayoutEffect,useRef,useState} from 'react';
import {ChevronLeft,ChevronRight,Minus,Plus,Download} from 'lucide-react';
import {Button,Notice} from '../../components/ui';
import {fetchOriginalFile,fetchDocumentPagePreview,downloadFile} from '../../lib/api';
import {useSession} from '../../lib/session';
import type {PageText,Evidence} from '../../../shared/types';
import type {PdfSplitLineage} from '../../../shared/pdf-split';
import PdfCanvas from './PdfCanvas';
import {pdfGeometryVersion,pdfRegionRectSchema} from '../../../shared/pdf-regions';
import {pdfSha256} from '../../lib/pdf-split';

type Props={document:any;split?:PdfSplitLineage|null;archiveChild?:boolean;evidence?:Evidence|null;page:number;setPage:(n:number)=>void};
type Media={page:number;request:number;url?:string;bytes?:Uint8Array;sha256?:string;error?:string};
const tiffError='This TIFF page could not be previewed. Try again or download the original TIFF.';

export default function DocumentPreview(props:Props){
  const session=useSession()?.data,doc=props.document;
  return <PreviewContent key={`${doc.id}:${doc.mimeType}:${doc.sha256||''}:${session?.user.id}:${session?.workspace.id}`} {...props}/>;
}
function PreviewContent({document:doc,split,archiveChild=false,page,setPage,evidence}:Props){
  const [zoom,setZoom]=useState(100),[media,setMedia]=useState<Media|null>(null),[retry,setRetry]=useState(0),[downloadError,setDownloadError]=useState('');
  const preview=useRef<HTMLElement>(null),mounted=useRef(false),requestVersion=useRef(0),pages:PageText[]=doc.sourceText||[],isTiff=doc.mimeType==='image/tiff',isOdt=doc.mimeType==='application/vnd.oasis.opendocument.text',isPdf=doc.mimeType==='application/pdf',isImage=doc.mimeType.startsWith('image/');
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
      if(isPdf){const sha256=await pdfSha256(data);if(disposed)return;if(doc.sha256&&sha256!==doc.sha256)throw new Error('Original source mismatch');setMedia({page:mediaPage,request,bytes:new Uint8Array(data),sha256});return;}
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
      {isOdt&&<p className="small muted tiff-preview-label">ODT text preview · One extraction page. Original page layout is not reproduced.</p>}
      {isTiff&&<p className="small muted tiff-preview-label">TIFF page preview · Original page {page}</p>}
      {error&&<div className="preview-error"><Notice error={error}/><Button variant="secondary" onClick={()=>{preview.current?.focus({preventScroll:true});setRetry(value=>value+1);}}>Retry preview</Button></div>}
      <div className="preview-paper" style={{width:`${zoom}%`,minWidth:zoom>100?`${zoom}%`:undefined}}>
        {isPdf?(current?.bytes?<PdfWithRegion bytes={current.bytes} sourceSha256={current.sha256!} evidence={evidence} page={page} label={`Original PDF, page ${page}${originalPage!==null?`, ${originalLabel.toLowerCase()} ${originalPage}`:''}`}/>:!error&&<p className="small muted" role="status">Loading PDF…</p>):isImage?(current?.url?<img key={current.url} src={current.url} alt={isTiff?`TIFF page preview, original page ${page}`:doc.name} onError={()=>{if(mounted.current&&requestVersion.current===current.request)setMedia({page:mediaPage,request:current.request,error:isTiff?tiffError:'The original could not be previewed. Try again or download it to inspect the file.'});}}/>:!error&&<p className="small muted" role="status">{isTiff?`Loading TIFF page ${page}…`:'Loading image…'}</p>):<div className="text-document"><div className="text-doc-caption">{isOdt?'ODT BODY TEXT':'ORIGINAL TEXT'}</div><pre>{pages.find(p=>p.page===page)?.text||'No readable text on this page.'}</pre></div>}
      </div>
    </div>
    <div className="preview-footer"><Button variant="ghost" onClick={()=>{setDownloadError('');void downloadFile(`/api/documents/${doc.id}/original`,doc.name).catch(()=>{if(mounted.current)setDownloadError('The download could not be completed. Try again.');});}}><Download/>{split||archiveChild?'Download this document':'Download original'}</Button></div>
  </section>;
}

/** Historical regions overlay only the exact source bytes and fully rendered page. */
function PdfWithRegion({bytes,sourceSha256,page,label,evidence}:{bytes:Uint8Array;sourceSha256:string;page:number;label:string;evidence?:Evidence|null}){
 const [rendered,setRendered]=useState<{bytes:Uint8Array;page:number}|null>(null);
 const region=evidence?.source==='matched-region'&&evidence.page===page&&evidence.region?.version===pdfGeometryVersion&&evidence.region.sourceSha256===sourceSha256&&pdfRegionRectSchema.safeParse(evidence.region.rect).success&&pdfRegionRectSchema.safeParse(evidence.region.anchor.rect).success?evidence.region:null;
 const ready=rendered?.bytes===bytes&&rendered.page===page;
 return <><div className="review-native-pdf-sheet"><PdfCanvas bytes={bytes} page={page} label={label} onRendered={()=>setRendered({bytes,page})} onError={()=>setRendered(null)}/>{ready&&region&&<svg className="review-region-overlay" viewBox="0 0 1 1" preserveAspectRatio="none" aria-label="Recorded native source region"><rect {...region.anchor.rect} className="recorded-anchor" vectorEffect="non-scaling-stroke"/><rect {...region.rect} className="recorded-value" vectorEffect="non-scaling-stroke"/></svg>}</div>{ready&&region&&<p className="recorded-region-caption">Native source region from this run. Green: complete anchor block “{region.anchor.capturedText}”. Dashed: captured value blocks. {evidence?.text}</p>}{evidence?.source==='matched-region'&&!region&&<p className="recorded-region-caption">The recorded region does not match this source page. The saved quote remains available in the extraction result.</p>}</>;
}
