import {useLayoutEffect,useRef,useState} from 'react';
import {Button} from '../../components/ui';
import {readTiffSplitPreview,type TiffSplitPreviewBinding} from '../../lib/pdf-split';

type Props={binding:TiffSplitPreviewBinding;file?:File;documentId?:string;expectedPages?:number;page:number;onReady:(count:number)=>void;onRendered:(page:number)=>void;onError:(message:string)=>void};
export default function TiffSplitPreview(props:Props){
 const {binding,file,documentId,expectedPages,page}=props;
 const [media,setMedia]=useState<{page:number;request:number;url:string}|null>(null),[retry,setRetry]=useState(0),[failed,setFailed]=useState(false);
 const callbacks=useRef(props),version=useRef(0),panel=useRef<HTMLDivElement>(null);
 useLayoutEffect(()=>{callbacks.current=props;});
 useLayoutEffect(()=>{
  const request=++version.current,controller=new AbortController();let disposed=false,url='';setMedia(null);setFailed(false);
  void(async()=>{try{
   const result=await readTiffSplitPreview(binding,page,()=>!disposed,controller.signal,file,documentId,expectedPages);if(disposed)return;
   url=URL.createObjectURL(result.blob);const image=new Image();image.src=url;try{await image.decode();}catch{throw new Error('This TIFF page could not be previewed. Try again.');}if(disposed)return;
   setMedia({page,request,url});callbacks.current.onReady(result.pageCount);callbacks.current.onRendered(page);
  }catch(cause){if(!disposed){if(url){URL.revokeObjectURL(url);url='';}setFailed(true);callbacks.current.onError(cause instanceof Error?cause.message:'This TIFF page could not be previewed. Try again.');}}})();
  return()=>{disposed=true;version.current++;controller.abort();if(url)URL.revokeObjectURL(url);};
 },[binding.userId,binding.workspaceId,binding.parserId,binding.requestId,binding.sha256,binding.uploadId,binding.suggestionId,file,documentId,expectedPages,page,retry]);
 const current=media?.page===page?media:null;
 return <div className="tiff-split-preview" ref={panel} tabIndex={-1} aria-busy={!current&&!failed}>
  <p className="small muted">TIFF page preview · Source page {page}</p>
  {current?<img key={current.url} src={current.url} alt={`TIFF page preview, source page ${page}`} data-render-state="ready" onError={()=>{if(version.current===current.request){setMedia(null);setFailed(true);callbacks.current.onError('This TIFF page could not be previewed. Try again.');}}}/>:failed?<Button variant="secondary" onClick={()=>{panel.current?.focus({preventScroll:true});setRetry(value=>value+1);}}>Retry TIFF preview</Button>:<p className="small" role="status">Loading TIFF page {page}…</p>}
 </div>;
}
