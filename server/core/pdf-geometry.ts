import {createHash} from 'node:crypto';
import {pdfGeometryVersion,pdfRegionLimits,pdfGeometrySchema,PdfGeometryError,normalizePdfRegionText,type PdfGeometry,type PdfGeometryItem,type PdfPageGeometry,type PdfRegionRect} from '../../shared/pdf-regions.js';
import {SourceValidationError} from './source-validation.js';

type Matrix=[number,number,number,number,number,number];
type NativeItem={str:string;transform:number[];width:number;height:number;fontName:string;dir:string;hasEOL:boolean};
type NativeStyle={ascent?:number;descent?:number;vertical?:boolean};
const finite=(values:unknown):values is number[]=>Array.isArray(values)&&values.every(value=>typeof value==='number'&&Number.isFinite(value));
const transform=(m:Matrix,x:number,y:number)=>({x:m[0]*x+m[2]*y+m[4],y:m[1]*x+m[3]*y+m[5]});
const invalid=():never=>{throw new PdfGeometryError('geometry_invalid');};
const limit=():never=>{throw new PdfGeometryError('geometry_limit');};

/** Font-metric block boxes, not glyph or ink bounds. Crop and rotation come from
 * the canonical PDF.js viewport, while independent text rotation/skew is rejected.
 */
export function nativePdfItemRect(item:NativeItem,style:NativeStyle,viewport:{width:number;height:number;transform:number[]}):PdfRegionRect|null{
 if(!finite(item.transform)||item.transform.length!==6||!finite(viewport.transform)||viewport.transform.length!==6||![viewport.width,viewport.height].every(value=>Number.isFinite(value)&&value>0)||!Number.isFinite(item.width)||item.width<0||!Number.isFinite(item.height)||item.height<0)return invalid();
 const [a,b,c,d,e,f]=item.transform;
 if(style.vertical||item.dir!=='ltr'||a<=0||d<=0||Math.abs(b)>Math.abs(a)*1e-7||Math.abs(c)>Math.abs(d)*1e-7)return null;
 const ascent=style.ascent,descent=style.descent;
 if(!Number.isFinite(ascent)||!Number.isFinite(descent)||ascent!<=0||ascent!>2||descent!>0||descent!< -2||ascent!-descent!<=0||item.width<=0)return null;
 const matrix=viewport.transform as Matrix;
 const corners=[transform(matrix,e,f+d*ascent!),transform(matrix,e+item.width,f+d*ascent!),transform(matrix,e,f+d*descent!),transform(matrix,e+item.width,f+d*descent!)];
 const xs=corners.map(point=>point.x),ys=corners.map(point=>point.y),x=Math.min(...xs),y=Math.min(...ys),right=Math.max(...xs),bottom=Math.max(...ys);
 if(![x,y,right,bottom].every(Number.isFinite))return invalid();
 return{x:x/viewport.width,y:y/viewport.height,width:(right-x)/viewport.width,height:(bottom-y)/viewport.height};
}

/** Native reading order is PDF.js item order. Touching split word items join
 * without invented spaces; explicit whitespace/gaps and baseline changes remain.
 */
function separator(previous:NativeItem|undefined,item:NativeItem,breakBefore:boolean):PdfGeometryItem['separator']{
 if(!previous)return '';
 if(breakBefore||previous.hasEOL||Math.abs(previous.transform[5]-item.transform[5])>Math.max(previous.height,item.height)*0.5)return '\n';
 if(/\s$/u.test(previous.str)||/^\s/u.test(item.str))return '';
 const gap=item.transform[4]-(previous.transform[4]+previous.width);
 return Math.abs(gap)<=Math.max(0.1,Math.min(previous.height,item.height)*0.05)?'':' ';
}

export async function decodePdfGeometry(bytes:Buffer):Promise<PdfGeometry>{
 if(!bytes.length)throw new SourceValidationError('empty');
 if(bytes.length>pdfRegionLimits.maxBytes)throw new SourceValidationError('file_too_large');
 if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw new PdfGeometryError('pdf_required');
 const {getDocument,InvalidPDFException,PasswordException}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const loading=getDocument({data:new Uint8Array(bytes),useSystemFonts:true,stopAtErrors:true});
 let totalItems=0,totalText=0;
 try{
  const doc=await loading.promise;
  if(doc.numPages>pdfRegionLimits.maxPages)throw new SourceValidationError('pdf_page_limit');
  const pages:PdfPageGeometry[]=[];
  for(let number=1;number<=doc.numPages;number++){
   const page=await doc.getPage(number),viewport=page.getViewport({scale:1});
   if(![0,90,180,270].includes(viewport.rotation)||!finite(viewport.transform)||viewport.transform.length!==6||![viewport.width,viewport.height].every(value=>Number.isFinite(value)&&value>0))return invalid();
   if(viewport.width>pdfRegionLimits.maxPageDimension||viewport.height>pdfRegionLimits.maxPageDimension)return limit();
   const items:PdfGeometryItem[]=[],styles:Record<string,NativeStyle>=Object.create(null);
   let pageItems=0,unsupported=false,previous:NativeItem|undefined,breakBefore=false;
   const reader=page.streamTextContent().getReader();
   try{while(true){
    const {value,done}=await reader.read();if(done)break;
    Object.assign(styles,value.styles);
    for(const candidate of value.items){
     if(!('str' in candidate))continue;
     const item=candidate as NativeItem;
     if(++pageItems>pdfRegionLimits.maxItemsPerPage||++totalItems>pdfRegionLimits.maxItems)return limit();
     if(typeof item.str!=='string'||item.str.includes('\0'))return invalid();
     if(item.str.length>pdfRegionLimits.maxItemText||(totalText+=Buffer.byteLength(item.str))>pdfRegionLimits.maxTextBytes)return limit();
     if(!normalizePdfRegionText(item.str)){if(item.hasEOL)breakBefore=true;continue;}
     // A zero font size can emit nonempty PDF.js items with a fully collapsed
     // transform. They have no visible extent and cannot form a source block.
     // Require every metric and translation to be finite; partially collapsed,
     // rotated, skewed and mirrored text still follows the strict path below.
     if(item.width===0&&item.height===0&&finite(item.transform)&&item.transform.length===6&&item.transform.slice(0,4).every(value=>value===0)){if(item.hasEOL)breakBefore=true;continue;}
     const style=styles[item.fontName];if(!style){unsupported=true;continue;}
     const rect=nativePdfItemRect(item,style,viewport);if(!rect){unsupported=true;continue;}
     // Text completely beyond the displayed crop is not a visible source block.
     if(rect.x+rect.width<=0||rect.y+rect.height<=0||rect.x>=1||rect.y>=1)continue;
     const epsilon=pdfRegionLimits.coordinateTolerance;
     if(rect.x<0||rect.y<0||rect.x+rect.width>1+epsilon||rect.y+rect.height>1+epsilon){unsupported=true;continue;}
     items.push({id:pageItems,text:item.str,rect,separator:separator(previous,item,breakBefore)});previous=item;breakBefore=false;
    }
   }}finally{
    // The owning loading task is destroyed below on success and failure. Do
    // not also cancel this reader: PDF.js can race a final CLOSE message with
    // ReadableStream.cancel, turning a bounded rejection into an unhandled error.
    reader.releaseLock();page.cleanup();
   }
   pages.push({page:number,width:viewport.width,height:viewport.height,rotation:viewport.rotation,items:unsupported?[]:items,reason:unsupported?'unsupported_text_geometry':items.length?null:'no_native_text'});
  }
  const geometry={version:pdfGeometryVersion,sourceSha256:createHash('sha256').update(bytes).digest('hex'),pageCount:doc.numPages,pages};
  if(Buffer.byteLength(JSON.stringify(geometry))>pdfRegionLimits.maxOutputBytes)return limit();
  const parsed=pdfGeometrySchema.safeParse(geometry);if(!parsed.success)return invalid();
  return parsed.data;
 }catch(error){
  if(error instanceof InvalidPDFException)throw new SourceValidationError('pdf_invalid');
  if(error instanceof PasswordException)throw new SourceValidationError('pdf_encrypted');
  throw error;
 }finally{await loading.destroy();}
}
