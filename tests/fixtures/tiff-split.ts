import {deflateSync} from 'node:zlib';

export type PrecisionTiffPage={width:number;height:number;depth?:8|16;channels?:3|4;orientation?:number;seed?:number;compression?:'none'|'deflate';description?:string;extraFields?:Array<{tag:number;type:number;count:number;bytes:Buffer}>};
/** Owned synthetic integer samples; 16-bit values deliberately use both bytes. */
export function precisionPixels(page:PrecisionTiffPage,littleEndian=true){
 const depth=page.depth??8,channels=page.channels??3,result=Buffer.alloc(page.width*page.height*channels*(depth/8));
 let state=((page.seed??0)+1)*2654435761;
 for(let i=0;i<page.width*page.height*channels;i++){
  state^=state<<13;state^=state>>>17;state^=state<<5;const value=depth===16?(state>>>0)%65536:(state>>>0)%256;
  if(depth===16)littleEndian?result.writeUInt16LE(value,i*2):result.writeUInt16BE(value,i*2);else result[i]=value;
 }
 return result;
}
export function makePrecisionTiff(pages:PrecisionTiffPage[],options:{bigTiff?:boolean;littleEndian?:boolean}={}){
 const big=options.bigTiff??false,le=options.littleEndian??true,header=big?16:8,countSize=big?8:2,entrySize=big?20:12,offsetSize=big?8:4,inlineSize=big?8:4;
 const put=(b:Buffer,offset:number,value:number,size:number)=>{if(size===8)le?b.writeBigUInt64LE(BigInt(value),offset):b.writeBigUInt64BE(BigInt(value),offset);else if(size===4)le?b.writeUInt32LE(value,offset):b.writeUInt32BE(value,offset);else if(size===2)le?b.writeUInt16LE(value,offset):b.writeUInt16BE(value,offset);else b[offset]=value;};
 const numbers=(values:number[],size:number)=>{const result=Buffer.alloc(values.length*size);values.forEach((v,i)=>put(result,i*size,v,size));return result;};
 type Field={tag:number;type:number;count:number;bytes:Buffer;offset?:number};
 const plans:Array<{offset:number;fields:Field[];block:Buffer;pixelOffset:number}>=[];let length=header;
 const reserve=(size:number)=>{const offset=Math.ceil(length/2)*2;length=offset+size;return offset;};
 for(const page of pages){
  const depth=page.depth??8,channels=page.channels??3,raw=precisionPixels(page,le),block=page.compression==='deflate'?deflateSync(raw):raw;
  const field=(tag:number,type:number,values:number[],size=type===3?2:type===16?8:4):Field=>({tag,type,count:values.length,bytes:numbers(values,size)});
  const fields:Field[]=[field(256,4,[page.width]),field(257,4,[page.height]),field(258,3,Array(channels).fill(depth)),field(259,3,[page.compression==='deflate'?8:1]),field(262,3,[2]),field(273,big?16:4,[0]),field(274,3,[page.orientation??1]),field(277,3,[channels]),field(278,4,[page.height]),field(279,big?16:4,[block.length]),field(284,3,[1])];
  if(channels===4)fields.push(field(338,3,[2]));
  if(page.description){const bytes=Buffer.from(`${page.description}\0`);fields.push({tag:270,type:2,count:bytes.length,bytes});}
  fields.push(...(page.extraFields??[]));fields.sort((a,b)=>a.tag-b.tag);
  const offset=reserve(countSize+fields.length*entrySize+offsetSize);
  for(const f of fields)if(f.bytes.length>inlineSize)f.offset=reserve(f.bytes.length);
  const pixelOffset=reserve(block.length);fields.find(f=>f.tag===273)!.bytes=numbers([pixelOffset],offsetSize);
  plans.push({offset,fields,block,pixelOffset});
 }
 const result=Buffer.alloc(length);result.write(le?'II':'MM',0,'ascii');put(result,2,big?43:42,2);if(big)put(result,4,8,2);put(result,big?8:4,plans[0]?.offset??0,offsetSize);
 for(const [index,plan]of plans.entries()){
  put(result,plan.offset,plan.fields.length,countSize);
  for(const [i,f]of plan.fields.entries()){
   const entry=plan.offset+countSize+i*entrySize,value=entry+(big?12:8);put(result,entry,f.tag,2);put(result,entry+2,f.type,2);put(result,entry+4,f.count,big?8:4);
   if(f.offset!==undefined)put(result,value,f.offset,offsetSize);f.bytes.copy(result,f.offset??value);
  }
  put(result,plan.offset+countSize+plan.fields.length*entrySize,plans[index+1]?.offset??0,offsetSize);plan.block.copy(result,plan.pixelOffset);
 }
 return result;
}
