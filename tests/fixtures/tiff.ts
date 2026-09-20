import {deflateSync} from 'node:zlib';
export type SyntheticTiffPage={width:number;height:number;orientation?:number;pixels?:Buffer;color?:[number,number,number];compression?:'none'|'deflate'};
/** Synthetic RGB fixtures only; builds true classic/BigTIFF IFD chains without image-library inference. */
export function makeTiff(pages:SyntheticTiffPage[],options:{bigTiff?:boolean;byteOrder?:'II'|'MM'}={}){
 const big=options.bigTiff??false,le=(options.byteOrder??'II')==='II',header=big?16:8,countBytes=big?8:2,entryBytes=big?20:12,offsetBytes=big?8:4,inlineBytes=big?8:4,alignment=big?8:2;
 const chunks:Buffer[]=[],ifdOffsets:number[]=[];let offset=header;
 const put=(b:Buffer,n:number,v:number,size:number)=>{if(size===8)le?b.writeBigUInt64LE(BigInt(v),n):b.writeBigUInt64BE(BigInt(v),n);else if(size===4)le?b.writeUInt32LE(v,n):b.writeUInt32BE(v,n);else le?b.writeUInt16LE(v,n):b.writeUInt16BE(v,n);};
 const align=(n:number)=>Math.ceil(n/alignment)*alignment;
 for(const p of pages){
  const raw=p.pixels??Buffer.alloc(p.width*p.height*3);if(!p.pixels){const color=p.color??[255,255,255];for(let i=0;i<raw.length;i+=3){raw[i]=color[0];raw[i+1]=color[1];raw[i+2]=color[2];}}
  if(raw.length!==p.width*p.height*3)throw new Error('Invalid synthetic TIFF pixel count');
  const compressed=p.compression==='deflate'?deflateSync(raw):raw;
  const tags:Array<[number,number,number,number|number[]]>=[[256,4,1,p.width],[257,4,1,p.height],[258,3,3,[8,8,8]],[259,3,1,p.compression==='deflate'?8:1],[262,3,1,2],[273,big?16:4,1,0],[274,3,1,p.orientation??1],[277,3,1,3],[278,4,1,p.height],[279,big?16:4,1,compressed.length],[284,3,1,1]];
  const ifdSize=countBytes+tags.length*entryBytes+offsetBytes,bitsOffset=offset+ifdSize,pixelOffset=align(bitsOffset+(big?0:6)),nextOffset=align(pixelOffset+compressed.length),block=Buffer.alloc(nextOffset-offset);
  ifdOffsets.push(offset);put(block,0,tags.length,countBytes);
  for(const [i,[tag,type,count,value]]of tags.entries()){
   const start=countBytes+i*entryBytes;put(block,start,tag,2);put(block,start+2,type,2);put(block,start+4,count,big?8:4);const field=start+(big?12:8);
   if(tag===273)put(block,field,pixelOffset,offsetBytes);
   else if(Array.isArray(value)){if(value.length*2<=inlineBytes)for(const [j,v]of value.entries())put(block,field+j*2,v,2);else{put(block,field,bitsOffset,offsetBytes);for(const [j,v]of value.entries())put(block,bitsOffset-offset+j*2,v,2);}}
   else put(block,field,value,type===3?2:type===16?8:4);
  }
  compressed.copy(block,pixelOffset-offset);chunks.push(block);offset=nextOffset;
 }
 const result=Buffer.alloc(header);result.write(le?'II':'MM',0,'ascii');put(result,2,big?43:42,2);if(big){put(result,4,8,2);put(result,6,0,2);}put(result,big?8:4,ifdOffsets[0]??0,offsetBytes);
 for(let i=0;i<chunks.length;i++)put(chunks[i],countBytes+11*entryBytes,ifdOffsets[i+1]??0,offsetBytes);
 return Buffer.concat([result,...chunks]);
}
