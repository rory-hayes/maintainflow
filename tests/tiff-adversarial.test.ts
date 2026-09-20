import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {createHash} from 'node:crypto';
import {PDFDocument,PDFDict,PDFName,PDFRawStream} from 'pdf-lib';
import {inspectTiffStructure} from '../server/core/tiff-engine.js';
import {renderTiffPage,convertTiffForAI} from '../server/core/source.js';
import {SourceValidationError} from '../server/core/source-validation.js';
import {tiffLimits} from '../shared/tiff.js';

type PageSpec={width?:number;height?:number;orientation?:number;pixels?:Buffer;pointerTags?:number[]};
/** Independent TIFF6/BigTIFF RGB writer; does not reuse production or other test fixtures. */
function rawTiff(specs:PageSpec[],{big=false,little=true,extraBytes=0}={}){
 const header=big?16:8,countBytes=big?8:2,entryBytes=big?20:12,offsetBytes=big?8:4,alignment=big?8:2;
 let cursor=header;
 const pages=specs.map(spec=>{
  const width=spec.width??3,height=spec.height??2;
  const pixels=spec.pixels??Buffer.from(Array.from({length:width*height*3},(_,i)=>Math.floor(i/3)*30+(i%3)*7));
  const entryCount=11+(spec.pointerTags?.length??0);
  const p={...spec,width,height,pixels,entryCount,ifdOffset:cursor,bitsOffset:0,stripOffset:0,nextOffset:0,tags:{} as Record<number,number>};cursor+=countBytes+entryCount*entryBytes+offsetBytes;
  p.bitsOffset=cursor;if(!big)cursor+=6;cursor=Math.ceil(cursor/alignment)*alignment;p.stripOffset=cursor;cursor+=pixels.length;
  cursor=Math.ceil(cursor/alignment)*alignment;return p;
 });
 const bytes=Buffer.alloc(cursor+extraBytes);
 const u16=(v:number,o:number)=>little?bytes.writeUInt16LE(v,o):bytes.writeUInt16BE(v,o);
 const u32=(v:number,o:number)=>little?bytes.writeUInt32LE(v,o):bytes.writeUInt32BE(v,o);
 const u64=(v:number|bigint,o:number)=>little?bytes.writeBigUInt64LE(BigInt(v),o):bytes.writeBigUInt64BE(BigInt(v),o);
 const off=(v:number|bigint,o:number)=>big?u64(v,o):u32(Number(v),o);
 bytes.write(little?'II':'MM');u16(big?43:42,2);if(big){u16(8,4);u16(0,6);u64(header,8);}else u32(header,4);
 pages.forEach((p,index)=>{
  big?u64(p.entryCount,p.ifdOffset):u16(p.entryCount,p.ifdOffset);
  const tags=[[256,4,1,p.width],[257,4,1,p.height],[258,3,3,p.bitsOffset],[259,3,1,1],[262,3,1,2],[273,big?16:4,1,p.stripOffset],[274,3,1,p.orientation??1],[277,3,1,3],[278,4,1,p.height],[279,big?16:4,1,p.pixels.length],[284,3,1,1],...(p.pointerTags??[]).map(tag=>[tag,big?18:4,1,0])].sort((a,b)=>a[0]-b[0]);
  tags.forEach(([tag,type,count,value],i)=>{
   const entry=p.ifdOffset+countBytes+i*entryBytes;p.tags[tag]=entry;u16(tag,entry);u16(type,entry+2);big?u64(count,entry+4):u32(count,entry+4);const field=entry+(big?12:8);
   if(tag===258&&big){u16(8,field);u16(8,field+2);u16(8,field+4);}else if(type===3&&count===1)u16(value,field);else if(type===16||type===18)u64(value,field);else u32(value,field);
  });
  p.nextOffset=p.ifdOffset+countBytes+p.entryCount*entryBytes;off(pages[index+1]?.ifdOffset??0,p.nextOffset);
  if(!big){u16(8,p.bitsOffset);u16(8,p.bitsOffset+2);u16(8,p.bitsOffset+4);}p.pixels.copy(bytes,p.stripOffset);
 });
 return {bytes,pages,big,little,u16,u32,u64,off,valueOffset:big?12:8};
}
function rejectsStructure(bytes:Buffer){
 const original=Buffer.from(bytes);
 assert.throws(()=>inspectTiffStructure(bytes),error=>error instanceof SourceValidationError);
 assert.deepEqual(bytes,original);
}

test('TIFF structure preserves distinct page geometry, byte orders and all orientation values',()=>{
 for(const big of [false,true])for(const little of [false,true]){
  const file=rawTiff(Array.from({length:8},(_,i)=>({width:i+1,height:2,orientation:i+1})),{big,little});
  const before=Buffer.from(file.bytes),parsed=inspectTiffStructure(file.bytes);
  assert.equal(parsed.bigTiff,big);assert.equal(parsed.littleEndian,little);
  assert.equal(parsed.totalPixels,72);
  assert.deepEqual(parsed.pages,file.pages.map((p,index)=>({page:index+1,ifdOffset:p.ifdOffset,width:p.width,height:p.height,orientation:index+1})));
  assert.deepEqual(file.bytes,before);
 }
});

test('TIFF rejects truncated headers/directories and missing first IFD for both layouts',()=>{
 for(const big of [false,true])for(const little of [false,true]){
  const file=rawTiff([{}],{big,little});
  for(const end of [0,1,2,3,4,7,...(big?[8,12,15]:[]),file.pages[0].ifdOffset+1,file.pages[0].nextOffset+1])rejectsStructure(file.bytes.subarray(0,end));
  file.off(0,big?8:4);rejectsStructure(file.bytes);
 }
});

test('TIFF rejects main IFD cycles and invalid later IFD without silently accepting page one',()=>{
 for(const big of [false,true])for(const little of [false,true])for(const kind of ['self','previous','oob'] as const){
  const file=rawTiff([{},{}],{big,little});
  file.off(kind==='self'?file.pages[1].ifdOffset:kind==='previous'?file.pages[0].ifdOffset:file.bytes.length+64,file.pages[1].nextOffset);
  rejectsStructure(file.bytes);
 }
});

test('BigTIFF rejects unsupported offset width, reserved bits and unsafe 64-bit offset/count values',()=>{
 for(const little of [false,true])for(const kind of ['width','reserved','offset','count','value','strip'] as const){
  const file=rawTiff([{}],{big:true,little});
  if(kind==='width')file.u16(4,4);else if(kind==='reserved')file.u16(1,6);
  else if(kind==='offset')file.u64(2n**63n+1n,8);
  else if(kind==='count')file.u64(2n**63n+1n,file.pages[0].ifdOffset);
  else if(kind==='value')file.u64(2n**63n+1n,file.pages[0].tags[258]+4);
  else file.u64(2n**63n+1n,file.pages[0].tags[273]+12);
  rejectsStructure(file.bytes);
 }
});

test('TIFF rejects later-page out-of-bounds strips and external field values before native decoding',()=>{
 for(const big of [false,true])for(const little of [false,true])for(const kind of ['strip-start','strip-size','bits-values'] as const){
  const file=rawTiff([{},{}],{big,little}),page=file.pages[1];
  if(kind==='strip-start')file.off(file.bytes.length+8,page.tags[273]+file.valueOffset);
  else if(kind==='strip-size')file.off(file.bytes.length+8,page.tags[279]+file.valueOffset);
  else{big?file.u64(5,page.tags[258]+4):file.u32(5,page.tags[258]+4);file.off(file.bytes.length+8,page.tags[258]+file.valueOffset);}
  rejectsStructure(file.bytes);
 }
});

test('TIFF rejects invalid orientation, duplicate tags and zero or overflowing dimensions',()=>{
 for(const big of [false,true])for(const little of [false,true])for(const kind of ['orientation-zero','orientation-nine','duplicate','width-zero','height-zero','huge-width'] as const){
  const file=rawTiff([{}],{big,little}),page=file.pages[0];
  if(kind==='orientation-zero'||kind==='orientation-nine')file.u16(kind==='orientation-zero'?0:9,page.tags[274]+file.valueOffset);
  else if(kind==='duplicate')file.u16(273,page.tags[274]);
  else file.u32(kind==='huge-width'?0xffffffff:0,page.tags[kind==='height-zero'?257:256]+file.valueOffset);
  rejectsStructure(file.bytes);
 }
});

test('TIFF enforces page, per-page pixel and aggregate pixel limits before pixel allocation',()=>{
 for(const big of [false,true]){
  const tooMany=rawTiff(Array.from({length:tiffLimits.maxPages+1},()=>({width:1,height:1})),{big});rejectsStructure(tooMany.bytes);
  const tooWide=rawTiff([{width:1,height:1}],{big});tooWide.u32(tiffLimits.maxPagePixels+1,tooWide.pages[0].tags[256]+tooWide.valueOffset);rejectsStructure(tooWide.bytes);
  const aggregate=rawTiff(Array.from({length:Math.floor(tiffLimits.maxTotalPixels/tiffLimits.maxPagePixels)+1},()=>({width:1,height:1})),{big});
  for(const page of aggregate.pages)aggregate.u32(tiffLimits.maxPagePixels,page.tags[256]+aggregate.valueOffset);
  rejectsStructure(aggregate.bytes);
 }
});

test('TIFF follows auxiliary metadata pointers, allowing shared metadata but rejecting actual cycles',()=>{
 for(const big of [false,true])for(const little of [false,true])for(const tag of [330,34665,34853,40965]){
  const file=rawTiff([{pointerTags:[tag]},{pointerTags:[tag]}],{big,little,extraBytes:big?40:24}),aux=file.bytes.length-(big?40:24);
  // A valid one-field auxiliary IFD shared by two main pages.
  big?file.u64(1,aux):file.u16(1,aux);const entry=aux+(big?8:2);
  file.u16(270,entry);file.u16(2,entry+2);big?file.u64(2,entry+4):file.u32(2,entry+4);
  file.bytes[entry+file.valueOffset]=88;file.bytes[entry+file.valueOffset+1]=0;
  for(const page of file.pages)file.off(aux,page.tags[tag]+file.valueOffset);
  assert.equal(inspectTiffStructure(file.bytes).pages.length,2);
  // Replacing the field with another IFD pointer makes an actual self-cycle.
  file.u16(40965,entry);file.u16(big?18:4,entry+2);big?file.u64(1,entry+4):file.u32(1,entry+4);file.off(aux,entry+file.valueOffset);
  rejectsStructure(file.bytes);
 }
});

test('TIFF rejects image data overlapping a main IFD and native-byte expansion beyond the page limit',()=>{
 for(const big of [false,true]){
  const overlap=rawTiff([{},{}],{big}),page=overlap.pages[1];overlap.off(page.ifdOffset,page.tags[273]+overlap.valueOffset);rejectsStructure(overlap.bytes);
  const depth=rawTiff([{width:1,height:1}],{big});depth.u32(40_000_000,depth.pages[0].tags[256]+depth.valueOffset);
  const bits=big?depth.pages[0].tags[258]+depth.valueOffset:depth.pages[0].bitsOffset;
  for(let i=0;i<3;i++)depth.u16(16,bits+i*2);rejectsStructure(depth.bytes);
 }
});

test('TIFF JPEG conversion preserves all eight pixel orientations, including reflected quarter turns',async()=>{
 const width=48,height=32,cell=16,pixels=Buffer.alloc(width*height*3);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let channel=0;channel<3;channel++)pixels[(y*width+x)*3+channel]=20+40*(Math.floor(y/cell)*3+Math.floor(x/cell));
 const expected=[[0,1,2,3,4,5],[2,1,0,5,4,3],[5,4,3,2,1,0],[3,4,5,0,1,2],[0,3,1,4,2,5],[3,0,4,1,5,2],[5,2,4,1,3,0],[2,5,1,4,0,3]];
 for(let orientation=1;orientation<=8;orientation++){
  const source=rawTiff([{width,height,pixels,orientation}],{big:orientation%2===0,little:orientation%3===0});
  const rendered=await renderTiffPage(source.bytes,1),{data,info}=await sharp(rendered.bytes).raw().toBuffer({resolveWithObject:true});
  const actual:number[]=[];for(let y=cell/2;y<info.height;y+=cell)for(let x=cell/2;x<info.width;x+=cell){const value=data[(y*info.width+x)*info.channels];const index=Math.round((value-20)/40);assert.ok(Math.abs(value-(20+40*index))<=4);actual.push(index);}
  assert.deepEqual(actual,expected[orientation-1],`Orientation ${orientation} must preserve actual page content`);
 }
});

test('TIFF preview derives each distinct page with its own orientation and source binding',async()=>{
 const rgb=Buffer.from([255,0,0,0,255,0,0,0,255,255,255,0,255,0,255,0,255,255]);
 const source=rawTiff([{pixels:rgb,orientation:6},{width:2,height:3,pixels:rgb,orientation:1}],{big:true,little:false});
 const before=Buffer.from(source.bytes);
 for(const page of [1,2]){
  const preview=await renderTiffPage(source.bytes,page);
  assert.equal(preview.mimeType,'image/jpeg');assert.equal(preview.page,page);assert.equal(preview.pageCount,2);
  assert.equal(preview.sourceSha256,createHash('sha256').update(source.bytes).digest('hex'));
  assert.equal(preview.width,2);assert.equal(preview.height,3);assert.ok(preview.bytes.length<=tiffLimits.maxJpegBytes);
  const metadata=await sharp(preview.bytes).metadata();assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,2);assert.equal(metadata.height,3);assert.equal(metadata.orientation,undefined);
 }
 assert.deepEqual(source.bytes,before);
 for(const page of [0,-1,3,1.5,NaN,Infinity])await assert.rejects(renderTiffPage(source.bytes,page));
});

test('TIFF AI derivative is a real ordered PDF with one page per original and no original mutation',async()=>{
 const source=rawTiff([{width:9,height:6,orientation:6},{width:4,height:8,orientation:8}],{big:false,little:true}),before=Buffer.from(source.bytes);
 const result=await convertTiffForAI(source.bytes);
 assert.equal(result.mimeType,'application/pdf');assert.equal(result.pageCount,2);assert.ok(result.bytes.length<=tiffLimits.maxPdfBytes);
 assert.equal(result.sourceSha256,createHash('sha256').update(source.bytes).digest('hex'));
 const pdf=await PDFDocument.load(result.bytes,{updateMetadata:false});assert.equal(pdf.getPageCount(),2);
 const sizes=pdf.getPages().map(page=>page.getSize());assert.ok(Math.abs(sizes[0].width/sizes[0].height-6/9)<0.001);assert.ok(Math.abs(sizes[1].width/sizes[1].height-8/4)<0.001);
 for(const [index,page]of pdf.getPages().entries()){
  const objects=page.node.Resources()!.lookup(PDFName.of('XObject'),PDFDict);assert.equal(objects.keys().length,1);
  const stream=pdf.context.lookup(objects.get(objects.keys()[0]));assert.ok(stream instanceof PDFRawStream);const preview=await renderTiffPage(source.bytes,index+1);
  assert.deepEqual(Buffer.from(stream.getContents()),preview.bytes,`AI page ${index+1} must contain exactly that original page's preview pixels`);
 }
 assert.deepEqual(source.bytes,before);
});

test('TIFF preserves colour for 8/16-bit RGB and composites alpha against white',async()=>{
 for(const depth of [8,16])for(const alpha of [false,true]){
  let input=sharp({create:{width:32,height:24,channels:alpha?4:3,background:{r:200,g:20,b:40,alpha:0.5}}});
  if(depth===16)input=input.toColourspace('rgb16');
  const bytes=await input.tiff({compression:'deflate'}).toBuffer(),before=Buffer.from(bytes),metadata=await sharp(bytes).metadata();
  assert.equal(metadata.bitsPerSample,depth);assert.equal(metadata.channels,alpha?4:3);
  const preview=await renderTiffPage(bytes,1),{data,info}=await sharp(preview.bytes).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.channels,3);
  const expected=alpha?[227,137,147]:[200,20,40];
  for(let channel=0;channel<3;channel++)assert.ok(Math.abs(data[channel]-expected[channel])<=3,`${depth}-bit alpha=${alpha} channel${channel} preserves its colour`);
  assert.deepEqual(bytes,before);
 }
});

test('TIFF renders actual LZW, PackBits, Deflate, JPEG and one-bit fax pages in strips or tiles',async()=>{
 const raw=Buffer.from(Array.from({length:32*24},(_,i)=>i%32<16?0:255));
 for(const compression of ['lzw','packbits','deflate','jpeg','ccittfax4'] as const)for(const tile of [false,true]){
  const input=sharp(raw,{raw:{width:32,height:24,channels:1}}).toColourspace('b-w');
  const bytes=await input.tiff({compression,...(compression==='ccittfax4'?{bitdepth:1 as const}:{}),tile,tileWidth:16,tileHeight:16,bigtiff:tile}).toBuffer();
  const metadata=await sharp(bytes).metadata();if(compression==='ccittfax4')assert.equal(metadata.bitsPerSample,1);
  const preview=await renderTiffPage(bytes,1),{data,info}=await sharp(preview.bytes).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,32);assert.equal(info.height,24);
  assert.ok(data[(12*32+8)*info.channels]<=4,`${compression} tile=${tile} black content remains black`);
  assert.ok(data[(12*32+24)*info.channels]>=251,`${compression} tile=${tile} white content remains white`);
 }
});
