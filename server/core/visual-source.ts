import {createHash} from 'node:crypto';
import type {PageText,VisualDocument} from '../../shared/types.js';
import {tiffLimits,tiffRenderVersion} from '../../shared/tiff.js';

type Source={bytes:Buffer;mimeType:string;pages:PageText[];visualDocument?:VisualDocument};
const failed=()=>Object.assign(new Error('The TIFF visual pages could not be verified. Upload the original again before using AI.'),{permanent:true});
export function visualRenderingMetadata(document:VisualDocument){return {sourceMimeType:'image/tiff',mimeType:document.mimeType,pageCount:document.pageCount,sourceSha256:document.sourceSha256,renderVersion:document.renderVersion,maxEdge:tiffLimits.maxEdge,jpegQuality:tiffLimits.jpegQuality};}

/** Bind a derivative to the original whose page numbers and provenance are retained. */
export function validatedVisualDocument(input:Source):VisualDocument|undefined{
 if(input.mimeType!=='image/tiff'){
  if(input.visualDocument)throw failed();
  return undefined;
 }
 const visual=input.visualDocument;
 if(!visual||visual.mimeType!=='application/pdf'||visual.renderVersion!==tiffRenderVersion||!Buffer.isBuffer(visual.bytes)
  ||!visual.bytes.length||visual.bytes.length>tiffLimits.maxPdfBytes||!visual.bytes.subarray(0,5).equals(Buffer.from('%PDF-'))
  ||visual.pageCount!==input.pages.length||!visual.pageCount||visual.pageCount>tiffLimits.maxPages
  ||input.pages.some((p,i)=>p.page!==i+1||typeof p.text!=='string')
  ||visual.sourceSha256!==createHash('sha256').update(input.bytes).digest('hex'))throw failed();
 return visual;
}

/** Conversion stays inside the bounded decoder and within the worker's deadline. */
export async function prepareVisualDocument(input:Source,options:{signal?:AbortSignal;expectedSha256:string}):Promise<VisualDocument|undefined>{
 if(input.mimeType!=='image/tiff')return undefined;
 options.signal?.throwIfAborted();
 if(createHash('sha256').update(input.bytes).digest('hex')!==options.expectedSha256)throw failed();
 const {convertTiffForAI}=await import('./source.js');
 const visualDocument=await convertTiffForAI(input.bytes,{signal:options.signal});
 options.signal?.throwIfAborted();
 return validatedVisualDocument({...input,visualDocument});
}
