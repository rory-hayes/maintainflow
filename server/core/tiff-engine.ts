import {createHash} from 'node:crypto';
import {tiffLimits,tiffRenderVersion,type TiffDirectory,type TiffPageDescriptor,type TiffPageRenderMetadata,type TiffAiDocumentMetadata} from '../../shared/tiff.js';
import {SourceValidationError,type SourceValidationReason} from './source-validation.js';
function invalid(reason:SourceValidationReason='tiff_invalid'):never{throw new SourceValidationError(reason);}
const sizes:Record<number,number>={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,13:4,16:8,17:8,18:8};
export function isTiffHeader(bytes:Buffer){return bytes.length>=4&&((bytes[0]===0x49&&bytes[1]===0x49&&[42,43].includes(bytes[2])&&bytes[3]===0)||(bytes[0]===0x4d&&bytes[1]===0x4d&&bytes[2]===0&&[42,43].includes(bytes[3])));}
export type TiffField={type:number;count:number;offset:number};
export type TiffIfd={offset:number;next:number;fields:Map<number,TiffField>;edges:number[];image?:Omit<TiffPageDescriptor,'page'>};
type Field=TiffField;type Ifd=TiffIfd;
/** Validates every referenced IFD/value/data extent before native image code sees the bytes. */
export function inspectTiffGraph(bytes:Buffer):{directory:TiffDirectory;nodes:Map<number,TiffIfd>}{
 if(!bytes.length)invalid('empty');if(bytes.length>tiffLimits.maxBytes)invalid('file_too_large');if(!isTiffHeader(bytes))invalid();
 const littleEndian=bytes[0]===0x49,bigTiff=(littleEndian?bytes[2]:bytes[3])===43,header=bigTiff?16:8,alignment=2,countSize=bigTiff?8:2,entrySize=bigTiff?20:12,offsetSize=bigTiff?8:4,inlineSize=bigTiff?8:4;
 const range=(offset:number,size:number)=>{if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(size)||offset<0||size<0||offset>bytes.length-size)invalid();};
 const uint=(offset:number,size:number,max=Number.MAX_SAFE_INTEGER)=>{range(offset,size);const n=size===8?(littleEndian?bytes.readBigUInt64LE(offset):bytes.readBigUInt64BE(offset)):BigInt(size===4?(littleEndian?bytes.readUInt32LE(offset):bytes.readUInt32BE(offset)):size===2?(littleEndian?bytes.readUInt16LE(offset):bytes.readUInt16BE(offset)):bytes[offset]);if(n>BigInt(max))invalid();return Number(n);};
 range(0,header);if(bigTiff&&(uint(4,2)!==8||uint(6,2)!==0))invalid('tiff_unsupported');
 // libtiff itself emits word-aligned BigTIFF directories/values; bounds checks do not depend on 8-byte alignment.
 const first=uint(bigTiff?8:4,offsetSize,bytes.length);if(!first)invalid();
 const fieldsInteger=(field:Field|undefined,maxCount=1)=>{
  if(!field||![1,3,4,13,16,18].includes(field.type)||field.count<1||field.count>maxCount)invalid();
  return Array.from({length:field.count},(_,i)=>uint(field.offset+i*sizes[field.type],sizes[field.type]));
 };
 const single=(fields:Map<number,Field>,tag:number,defaultValue?:number)=>fields.has(tag)?fieldsInteger(fields.get(tag))[0]:defaultValue;
 const nodes=new Map<number,Ifd>(),pending=[first],ifdRanges:Array<[number,number]>=[[0,header]],blocks:Array<[number,number]>=[];let dataBlocks=0,totalPixels=0;
 while(pending.length){
  const offset=pending.pop()!;if(nodes.has(offset))continue;if(nodes.size>=tiffLimits.maxIfds)invalid('tiff_structure_limit');
  if(offset<header||offset%alignment)invalid();range(offset,countSize);
  const count=uint(offset,countSize,tiffLimits.maxIfdEntries);if(count<1)invalid();const length=countSize+count*entrySize+offsetSize;range(offset,length);ifdRanges.push([offset,offset+length]);
  const fields=new Map<number,Field>();let previous=-1;
  for(let i=0;i<count;i++){
   const position=offset+countSize+i*entrySize,tag=uint(position,2),type=uint(position+2,2),unit=sizes[type];if(tag<=previous||!unit||(!bigTiff&&type>=16))invalid();previous=tag;
   const number=uint(position+4,bigTiff?8:4,bytes.length);if(number<1)invalid();const size=number*unit;if(!Number.isSafeInteger(size)||size>bytes.length)invalid();
   const valuePosition=position+(bigTiff?12:8),valueOffset=size<=inlineSize?valuePosition:uint(valuePosition,offsetSize,bytes.length);
   if(size>inlineSize&&(valueOffset<header||valueOffset%alignment))invalid();range(valueOffset,size);fields.set(tag,{type,count:number,offset:valueOffset});
  }
  const next=uint(offset+countSize+count*entrySize,offsetSize,bytes.length),edges=next?[next]:[];
  for(const tag of [330,34665,34853,40965])if(fields.has(tag)){const f=fields.get(tag)!;if(![4,13,16,18].includes(f.type))invalid();edges.push(...fieldsInteger(f,tag===330?tiffLimits.maxIfds:1).filter(Boolean));}
  const node:Ifd={offset,next,fields,edges};nodes.set(offset,node);pending.push(...edges);
  const width=single(fields,256),height=single(fields,257);
  if(width!==undefined||height!==undefined){
   if(!width||!height||!Number.isSafeInteger(width*height))invalid();const pixels=width*height;if(pixels>tiffLimits.maxPagePixels)invalid('tiff_pixel_limit');totalPixels+=pixels;if(totalPixels>tiffLimits.maxTotalPixels)invalid('tiff_pixel_limit');
   for(const tag of [256,257,278,322,323])if(fields.has(tag)&&![3,4,16].includes(fields.get(tag)!.type))invalid();
   if(fields.has(258)&&fields.get(258)!.type!==3)invalid();
   const samples=single(fields,277,1)!,bits=fields.has(258)?fieldsInteger(fields.get(258),4):[1],orientation=single(fields,274,1)!;
   if(samples<1||samples>4||bits.length!==samples||bits.some(b=>![1,2,4,8,16].includes(b)))invalid('tiff_unsupported');
   if(pixels*samples*Math.max(1,Math.max(...bits)/8)>tiffLimits.maxDecodedPageBytes)invalid('tiff_pixel_limit');
   if(orientation<1||orientation>8)invalid();const planar=single(fields,284,1)!;if(![1,2].includes(planar))invalid();
   for(const tag of [259,262,274,277,284])if(fields.has(tag)&&fields.get(tag)!.type!==3)invalid();
   if(fields.has(339)){if(fields.get(339)!.type!==3)invalid();const formats=fieldsInteger(fields.get(339),4);if(formats.length!==samples||formats.some(f=>![1,2].includes(f)))invalid('tiff_unsupported');}
   const strip=fields.has(273)||fields.has(279),tile=fields.has(324)||fields.has(325),oldJpeg=fields.has(513)||fields.has(514);if(!strip&&!tile&&!oldJpeg||strip&&tile)invalid();
   for(const [offsetTag,countTag]of [[273,279],[324,325],[513,514]]){
    if(!fields.has(offsetTag)&&!fields.has(countTag))continue;
    const offsetsField=fields.get(offsetTag),countsField=fields.get(countTag);if(!offsetsField||!countsField||offsetsField.count!==countsField.count)invalid();
    if(![3,4,16].includes(offsetsField.type)||![3,4,16].includes(countsField.type))invalid();
    dataBlocks+=offsetsField.count;if(dataBlocks>tiffLimits.maxDataBlocks)invalid('tiff_structure_limit');
    if(offsetTag===273){const rows=single(fields,278,0xffffffff)!;if(rows<1||offsetsField.count!==Math.ceil(height/rows)*(planar===2?samples:1))invalid();}
    if(offsetTag===324){const tw=single(fields,322),th=single(fields,323);if(!tw||!th||tw%16||th%16)invalid();if(!Number.isSafeInteger(tw*th)||tw*th>tiffLimits.maxPagePixels||tw*th*samples*Math.max(1,Math.max(...bits)/8)>tiffLimits.maxDecodedPageBytes)invalid('tiff_pixel_limit');if(offsetsField.count!==Math.ceil(width/tw)*Math.ceil(height/th)*(planar===2?samples:1))invalid();}
    const offsets=fieldsInteger(offsetsField,tiffLimits.maxDataBlocks),lengths=fieldsInteger(countsField,tiffLimits.maxDataBlocks);
    for(let i=0;i<offsets.length;i++){
     if(offsets[i]<header||lengths[i]<1)invalid();range(offsets[i],lengths[i]);
     if(single(fields,259,1)===1&&(offsetTag===273||offsetTag===324)){
      const rows=offsetTag===273?single(fields,278,0xffffffff)!:single(fields,323)!,blockWidth=offsetTag===273?width:single(fields,322)!;
      const perPlane=offsets.length/(planar===2?samples:1),bitSum=planar===2?bits[Math.floor(i/perPlane)]:bits.reduce((a,b)=>a+b,0);
      const blockRows=offsetTag===273?Math.min(rows,height-(i%perPlane)*rows):rows;
      if(lengths[i]<Math.ceil(blockWidth*bitSum/8)*blockRows)invalid();
     }
     blocks.push([offsets[i],offsets[i]+lengths[i]]);
    }
   }
   node.image={ifdOffset:offset,width,height,orientation};
  }
 }
 // The graph can share metadata IFDs, but must not contain an actual cycle.
 const colors=new Map<number,number>();const visit=(offset:number)=>{if(colors.get(offset)===1)invalid();if(colors.get(offset)===2)return;colors.set(offset,1);for(const next of nodes.get(offset)!.edges)visit(next);colors.set(offset,2);};visit(first);
 const pages:TiffPageDescriptor[]=[];let cursor=first;
 while(cursor){const node=nodes.get(cursor)!;if(!node.image)invalid();if(pages.length>=tiffLimits.maxPages)invalid('tiff_page_limit');pages.push({page:pages.length+1,...node.image});cursor=node.next;}
 ifdRanges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ifdRanges.length;i++)if(ifdRanges[i][0]<ifdRanges[i-1][1])invalid();
 for(const [start,end]of blocks)for(const [ifdStart,ifdEnd]of ifdRanges){if(ifdStart>=end)break;if(ifdEnd>start)invalid();}
 return {directory:{bigTiff,littleEndian,pages,totalPixels},nodes};
}
export function inspectTiffStructure(bytes:Buffer):TiffDirectory{return inspectTiffGraph(bytes).directory;}

async function renderPage(bytes:Buffer,descriptor:TiffPageDescriptor,pageCount:number){
 // Native imports/initialization remain operational failures, never permanent input rejections.
 const sharp=(await import('sharp')).default;sharp.cache(false);sharp.concurrency(1);
 const input=sharp(bytes,{page:descriptor.page-1,pages:1,failOn:'warning',limitInputPixels:tiffLimits.maxPagePixels,limitInputChannels:4});
 const metadata=await input.metadata();
 if(metadata.format!=='tiff'||metadata.width!==descriptor.width||metadata.height!==descriptor.height||metadata.pages!==pageCount||(metadata.orientation??1)!==descriptor.orientation)throw new Error('TIFF native metadata mismatch');
 // Materialize the entire selected page first; a resize alone can skip corrupt strips.
 const decoded=await input.flatten({background:'#ffffff'}).toColourspace('srgb').removeAlpha().raw({depth:'uchar'}).toBuffer({resolveWithObject:true});
 if(decoded.info.width!==descriptor.width||decoded.info.height!==descriptor.height||decoded.info.channels!==3||decoded.data.length>tiffLimits.maxDecodedPageBytes)throw new Error('TIFF native pixels exceeded the verified shape');
 let image=sharp(decoded.data,{raw:{width:decoded.info.width,height:decoded.info.height,channels:3}});
 // Apply the already validated per-IFD orientation to raw pixels, independently of metadata carry-over.
 switch(descriptor.orientation){case 2:image=image.flop();break;case 3:image=image.rotate(180);break;case 4:image=image.flip();break;case 5:image=image.rotate(90).flip();break;case 6:image=image.rotate(90);break;case 7:image=image.rotate(90).flop();break;case 8:image=image.rotate(270);break;}
 const result=await image.resize({width:tiffLimits.maxEdge,height:tiffLimits.maxEdge,fit:'inside',withoutEnlargement:true}).jpeg({quality:tiffLimits.jpegQuality,chromaSubsampling:'4:4:4'}).toBuffer({resolveWithObject:true});
 if(result.data.length>tiffLimits.maxJpegBytes)invalid('tiff_derived_limit');
 return {bytes:result.data,width:result.info.width,height:result.info.height};
}
export async function decodeTiffPage(bytes:Buffer,page:number):Promise<TiffPageRenderMetadata&{bytes:Buffer}>{
 const directory=inspectTiffStructure(bytes);if(!Number.isInteger(page)||page<1||page>directory.pages.length)invalid('tiff_page_bounds');
 const rendered=await renderPage(bytes,directory.pages[page-1],directory.pages.length);
 return {...rendered,mimeType:'image/jpeg',page,pageCount:directory.pages.length,sourceSha256:createHash('sha256').update(bytes).digest('hex'),renderVersion:tiffRenderVersion};
}
export async function decodeTiffForAI(bytes:Buffer):Promise<TiffAiDocumentMetadata&{bytes:Buffer}>{
 const directory=inspectTiffStructure(bytes),{PDFDocument}=await import('pdf-lib'),pdf=await PDFDocument.create({updateMetadata:false});
 let renderedBytes=0;
 for(const page of directory.pages){const rendered=await renderPage(bytes,page,directory.pages.length);renderedBytes+=rendered.bytes.length;if(renderedBytes>tiffLimits.maxPdfBytes)invalid('tiff_derived_limit');const image=await pdf.embedJpg(rendered.bytes);pdf.addPage([rendered.width,rendered.height]).drawImage(image,{x:0,y:0,width:rendered.width,height:rendered.height});}
 const result=Buffer.from(await pdf.save({useObjectStreams:true}));if(result.length>tiffLimits.maxPdfBytes)invalid('tiff_derived_limit');
 return {bytes:result,mimeType:'application/pdf',pageCount:directory.pages.length,sourceSha256:createHash('sha256').update(bytes).digest('hex'),renderVersion:tiffRenderVersion};
}
export async function decodeTiffSource(bytes:Buffer){const converted=await decodeTiffForAI(bytes);return {mimeType:'image/tiff',pageCount:converted.pageCount,pages:Array.from({length:converted.pageCount},(_,index)=>({page:index+1,text:''}))};}
