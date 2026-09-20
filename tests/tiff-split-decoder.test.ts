import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import sharp from 'sharp';
import {decodeSplitTiffSource} from '../server/core/tiff-split-engine.js';
import {inspectTiffGraph,inspectTiffStructure} from '../server/core/tiff-engine.js';
import {PdfSplitValidationError,pdfSplitLimits} from '../shared/pdf-split.js';
import {SourceValidationError} from '../server/core/source-validation.js';
import {splitPdfSource} from '../server/core/source.js';
import {makePrecisionTiff,precisionPixels,type PrecisionTiffPage} from './fixtures/tiff-split.js';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const reason=(expected:string)=>(error:unknown)=>error instanceof PdfSplitValidationError&&error.reason===expected;
const one=(page:number)=>({mode:'ranges',ranges:[{start:page,end:page}]});
const fieldSizes:Record<number,number>={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,13:4,16:8,17:8,18:8};
function blocks(bytes:Buffer,page:number){
 const {directory,nodes}=inspectTiffGraph(bytes),node=nodes.get(directory.pages[page-1].ifdOffset)!;
 const uint=(offset:number,size:number)=>size===8?Number(directory.littleEndian?bytes.readBigUInt64LE(offset):bytes.readBigUInt64BE(offset)):size===4?(directory.littleEndian?bytes.readUInt32LE(offset):bytes.readUInt32BE(offset)):(directory.littleEndian?bytes.readUInt16LE(offset):bytes.readUInt16BE(offset));
 return [[273,279],[324,325],[513,514]].flatMap(([tag,countTag])=>{const offsets=node.fields.get(tag),counts=node.fields.get(countTag);if(!offsets||!counts)return[];return Array.from({length:offsets.count},(_,i)=>{const offset=uint(offsets.offset+i*fieldSizes[offsets.type],fieldSizes[offsets.type]),length=uint(counts.offset+i*fieldSizes[counts.type],fieldSizes[counts.type]);return bytes.subarray(offset,offset+length);});});
}
async function pixels(bytes:Buffer,page:number,depth:8|16){
 let pipeline=sharp(bytes,{page:page-1,pages:1,failOn:'warning'});
 if(depth===16)pipeline=pipeline.pipelineColourspace('rgb16').toColourspace('rgb16');
 return pipeline.raw({depth:depth===16?'ushort':'uchar'}).toBuffer({resolveWithObject:true});
}
async function equalPage(source:Buffer,sourcePage:number,child:Buffer,childPage:number,depth:8|16){
 const [before,after]=await Promise.all([pixels(source,sourcePage,depth),pixels(child,childPage,depth)]);
 assert.deepEqual(after.info,before.info);assert.deepEqual(after.data,before.data);
 assert.deepEqual(blocks(child,childPage).map(hash),blocks(source,sourcePage).map(hash));
 const sourceMeta=await sharp(source,{page:sourcePage-1,pages:1}).metadata(),childMeta=await sharp(child,{page:childPage-1,pages:1}).metadata();
 for(const key of ['depth','orientation','channels','width','height','hasAlpha','space']as const)assert.deepEqual(childMeta[key],sourceMeta[key]);
}

test('lossless mixed-size/depth/orientation groups preserve exact pixels and encoded strips in classic/BigTIFF and both byte orders',async()=>{
 const pages:PrecisionTiffPage[]=[{width:12,height:8,depth:8,seed:1,orientation:6},{width:7,height:11,depth:16,seed:2,orientation:3,compression:'deflate'},{width:10,height:6,depth:16,channels:4,seed:3,orientation:8}];
 for(const bigTiff of [false,true])for(const littleEndian of [false,true]){
  const original=makePrecisionTiff(pages,{bigTiff,littleEndian}),before=hash(original),result=await decodeSplitTiffSource(original,{mode:'every',pagesPerDocument:2});
  assert.equal(result.sourcePageCount,3);assert.equal(result.selectedPages,3);assert.deepEqual(result.parts.map(p=>p.range),[{start:1,end:2},{start:3,end:3}]);
  for(const part of result.parts){const {directory,nodes}=inspectTiffGraph(part.bytes);assert.equal(directory.bigTiff,bigTiff);assert.equal(directory.littleEndian,littleEndian);if(bigTiff)for(const node of nodes.values()){assert.equal(node.offset%8,0);for(const field of node.fields.values())if(field.count*fieldSizes[field.type]>8)assert.equal(field.offset%8,0);}assert.equal(part.source.mimeType,'image/tiff');assert.deepEqual(part.source.pages,Array.from({length:part.source.pageCount},(_,i)=>({page:i+1,text:''})));for(let page=part.range.start;page<=part.range.end;page++)await equalPage(original,page,part.bytes,page-part.range.start+1,pages[page-1].depth??8);}
  for(let page=1;page<=3;page++)assert.deepEqual((await pixels(original,page,pages[page-1].depth??8)).data,precisionPixels(pages[page-1],true));
  assert.equal(hash(original),before);
 }
});

test('custom selection physically excludes other page pixels, descriptions and unreachable auxiliary metadata',async()=>{
 const pages:PrecisionTiffPage[]=[{width:37,height:31,seed:1,description:'KEEP ONE metadata'},{width:53,height:29,seed:2,description:'EXCLUDED private metadata'},{width:43,height:41,seed:3,description:'KEEP THREE metadata'}];
 const original=makePrecisionTiff(pages),result=await decodeSplitTiffSource(original,{mode:'ranges',ranges:[{start:1,end:1},{start:3,end:3}]});
 assert.equal(result.selectedPages,2);for(const part of result.parts){assert.equal(part.bytes.includes(Buffer.from('EXCLUDED private metadata')),false);assert.equal(part.bytes.includes(blocks(original,2)[0]),false);for(const other of [1,3])if(other!==part.range.start){assert.equal(part.bytes.includes(blocks(original,other)[0]),false);assert.equal(part.bytes.includes(Buffer.from(pages[other-1].description!)),false);}await equalPage(original,part.range.start,part.bytes,1,8);}
});

test('all eight orientations remain metadata-identical and sample-identical without normalizing archival pixels',async()=>{
 const original=makePrecisionTiff(Array.from({length:8},(_,i)=>({width:18,height:10,orientation:i+1,seed:i,depth:16}))),result=await decodeSplitTiffSource(original,{mode:'every',pagesPerDocument:1});
 for(const [index,part]of result.parts.entries()){assert.equal(inspectTiffStructure(part.bytes).pages[0].orientation,index+1);await equalPage(original,index+1,part.bytes,1,16);}
});

test('native lossless compression and JPEG/CCITT strip/tile encodings retain exact encoded blocks',async()=>{
 const raw=Buffer.alloc(32*24);for(let y=0;y<24;y++)for(let x=0;x<32;x++)raw[y*32+x]=(x<16)=== (y<12)?0:255;
 for(const compression of ['lzw','packbits','deflate','jpeg','ccittfax4']as const)for(const tile of [false,true]){
  const original=await sharp(raw,{raw:{width:32,height:24,channels:1}}).toColourspace('b-w').tiff({compression,tile,tileWidth:16,tileHeight:16,bigtiff:tile,...(compression==='ccittfax4'?{bitdepth:1 as const}:{})}).toBuffer();
  const result=await decodeSplitTiffSource(original,one(1));await equalPage(original,1,result.parts[0].bytes,1,8);
 }
});

function extraPointer(tag:number){return {tag,type:4,count:1,bytes:Buffer.alloc(4)};}
function appendExif(source:Buffer,rootPages:number[],text:string,makerNote=false){
 const graph=inspectTiffGraph(source),offset=Math.ceil(source.length/2)*2,value=Buffer.from(`${text}\0`),result=Buffer.alloc(offset+18+value.length);source.copy(result);
 result.writeUInt16LE(1,offset);result.writeUInt16LE(makerNote?37500:36867,offset+2);result.writeUInt16LE(makerNote?7:2,offset+4);result.writeUInt32LE(value.length,offset+6);result.writeUInt32LE(offset+18,offset+10);value.copy(result,offset+18);
 for(const page of rootPages)result.writeUInt32LE(offset,graph.nodes.get(graph.directory.pages[page-1].ifdOffset)!.fields.get(34665)!.offset);
 return result;
}
test('shared Exif metadata is relocated once, retained unchanged, and unselected-only metadata is absent',async()=>{
 const page={width:10,height:10,extraFields:[extraPointer(34665)]};
 let source=makePrecisionTiff([page,{...page,seed:2},{...page,seed:3}]);source=appendExif(source,[1,2],'2026:09:20 13:45:59');source=appendExif(source,[3],'EXCLUDED AUXILIARY DATA');
 const result=await decodeSplitTiffSource(source,{mode:'ranges',ranges:[{start:1,end:2}]}),child=result.parts[0].bytes,graph=inspectTiffGraph(child);
 assert.equal(graph.nodes.size,3);assert.equal(child.includes(Buffer.from('EXCLUDED AUXILIARY DATA')),false);assert.equal(child.includes(Buffer.from('2026:09:20 13:45:59')),true);assert.equal(graph.directory.pages.length,2);
 const pointers=graph.directory.pages.map(page=>child.readUInt32LE(graph.nodes.get(page.ifdOffset)!.fields.get(34665)!.offset));assert.equal(pointers[0],pointers[1]);
});

test('standard GPS tag zero and selected thumbnail SubIFDs are preserved with relocated references',async()=>{
 const original=makePrecisionTiff([{width:10,height:10,extraFields:[extraPointer(34853)]}]),graph=inspectTiffGraph(original),offset=Math.ceil(original.length/2)*2,withGps=Buffer.alloc(offset+18);original.copy(withGps);withGps.writeUInt32LE(offset,graph.nodes.get(graph.directory.pages[0].ifdOffset)!.fields.get(34853)!.offset);
 withGps.writeUInt16LE(1,offset);withGps.writeUInt16LE(0,offset+2);withGps.writeUInt16LE(1,offset+4);withGps.writeUInt32LE(4,offset+6);Buffer.from([2,3,0,0]).copy(withGps,offset+10);
 const gpsChild=(await decodeSplitTiffSource(withGps,one(1))).parts[0].bytes,gpsGraph=inspectTiffGraph(gpsChild),gpsRoot=gpsGraph.nodes.get(gpsGraph.directory.pages[0].ifdOffset)!,gpsOffset=gpsChild.readUInt32LE(gpsRoot.fields.get(34853)!.offset),version=gpsGraph.nodes.get(gpsOffset)!.fields.get(0)!;assert.deepEqual(gpsChild.subarray(version.offset,version.offset+4),Buffer.from([2,3,0,0]));
 const thumbnail=makePrecisionTiff([{width:16,height:12,extraFields:[extraPointer(330)]},{width:4,height:3,seed:8}]),thumbGraph=inspectTiffGraph(thumbnail),root=thumbGraph.nodes.get(thumbGraph.directory.pages[0].ifdOffset)!;thumbnail.writeUInt32LE(thumbGraph.directory.pages[1].ifdOffset,root.fields.get(330)!.offset);thumbnail.writeUInt32LE(0,root.offset+2+root.fields.size*12);const child=(await decodeSplitTiffSource(thumbnail,one(1))).parts[0].bytes,childGraph=inspectTiffGraph(child);assert.equal(childGraph.nodes.size,2);assert.equal(childGraph.directory.pages.length,1);assert.equal(childGraph.directory.totalPixels,16*12+4*3);assert.equal(child.includes(precisionPixels({width:4,height:3,seed:8})),true);
});

test('private offset-bearing metadata, cross-main auxiliary references, and ambiguous extents reject without returning children',async()=>{
 const unknown=makePrecisionTiff([{width:8,height:8,extraFields:[{tag:65000,type:7,count:12,bytes:Buffer.from('PRIVATE DATA')}]}]);await assert.rejects(decodeSplitTiffSource(unknown,one(1)),reason('tiff_repack_unsupported'));
 const maker=appendExif(makePrecisionTiff([{width:8,height:8,extraFields:[extraPointer(34665)]}]),[1],'PRIVATE MAKER OFFSETS',true);await assert.rejects(decodeSplitTiffSource(maker,one(1)),reason('tiff_repack_unsupported'));
 const cross=makePrecisionTiff([{width:8,height:8,extraFields:[extraPointer(330)]},{width:8,height:8,seed:2}]);let graph=inspectTiffGraph(cross);cross.writeUInt32LE(graph.directory.pages[1].ifdOffset,graph.nodes.get(graph.directory.pages[0].ifdOffset)!.fields.get(330)!.offset);assert.equal(inspectTiffStructure(cross).pages.length,2);await assert.rejects(decodeSplitTiffSource(cross,one(1)),reason('tiff_repack_unsupported'));
 const overlap=makePrecisionTiff([{width:8,height:8,compression:'deflate'},{width:8,height:8,compression:'deflate'}]);graph=inspectTiffGraph(overlap);const first=graph.nodes.get(graph.directory.pages[0].ifdOffset)!.fields.get(273)!,second=graph.nodes.get(graph.directory.pages[1].ifdOffset)!.fields.get(273)!;overlap.writeUInt32LE(overlap.readUInt32LE(first.offset)+1,second.offset);assert.equal(inspectTiffStructure(overlap).pages.length,2);await assert.rejects(decodeSplitTiffSource(overlap,one(1)),reason('tiff_repack_unsupported'));
 const valueOverlap=makePrecisionTiff([{width:8,height:8,description:'SELECTED description'},{width:8,height:8,seed:2}]);graph=inspectTiffGraph(valueOverlap);const root=graph.nodes.get(graph.directory.pages[0].ifdOffset)!,description=root.fields.get(270)!,other=graph.nodes.get(graph.directory.pages[1].ifdOffset)!;const entry=root.offset+2+[...root.fields.keys()].indexOf(270)*12;valueOverlap.writeUInt32LE(valueOverlap.readUInt32LE(other.fields.get(273)!.offset),entry+8);assert.ok(description.count>4);await assert.rejects(decodeSplitTiffSource(valueOverlap,one(1)),reason('tiff_repack_unsupported'));
});

test('marker, invalid/overlapping/out-of-bounds plans and more than 20 groups fail with finite safe reasons',async()=>{
 const source=makePrecisionTiff(Array.from({length:30},(_,i)=>({width:2,height:2,seed:i})));
 for(const [options,error]of [[{mode:'marker',marker:'SENSITIVE MARKER',ranges:[{start:1,end:30}]},'tiff_marker_unsupported'],[{mode:'ranges',ranges:[{start:2,end:4},{start:3,end:5}]},'invalid_ranges'],[{mode:'ranges',ranges:[{start:31,end:31}]},'invalid_spec'],[{mode:'every',pagesPerDocument:1},'document_limit'],[{mode:'every',pagesPerDocument:0},'invalid_spec']]as const)await assert.rejects(decodeSplitTiffSource(source,options),reason(error));
 await assert.rejects(decodeSplitTiffSource(makePrecisionTiff([{width:1,height:1}]),one(2)),reason('page_bounds'));
 const accepted=await decodeSplitTiffSource(source,{mode:'every',pagesPerDocument:2});assert.equal(accepted.parts.length,15);assert.equal(accepted.selectedPages,30);
});

test('full native decoding rejects corruption in selected or excluded later pages and cannot return earlier partial parts',async()=>{
 const source=makePrecisionTiff([{width:20,height:10,compression:'deflate'},{width:30,height:10,compression:'deflate'}]);const graph=inspectTiffGraph(source),fields=graph.nodes.get(graph.directory.pages[1].ifdOffset)!.fields,offset=source.readUInt32LE(fields.get(273)!.offset),length=source.readUInt32LE(fields.get(279)!.offset);source.fill(0,offset,offset+length);
 assert.equal(inspectTiffStructure(source).pages.length,2);await assert.rejects(decodeSplitTiffSource(source,{mode:'every',pagesPerDocument:1}),(error:unknown)=>error instanceof Error&&!(error instanceof PdfSplitValidationError)&&!(error instanceof SourceValidationError));
 await assert.rejects(decodeSplitTiffSource(source,one(1)),(error:unknown)=>error instanceof Error&&!(error instanceof PdfSplitValidationError)&&!(error instanceof SourceValidationError));
});

test('internal mutation after dispatch cannot alter already planned child bytes',async()=>{
 const source=makePrecisionTiff([{width:20,height:10,seed:2},{width:30,height:10,seed:3}]),copy=Buffer.from(source),pending=decodeSplitTiffSource(source,{mode:'every',pagesPerDocument:1});source.fill(0);const result=await pending;for(const [index,part]of result.parts.entries())await equalPage(copy,index+1,part.bytes,1,8);
});

test('shared encoded blocks are copied once per child, while duplicated child output obeys the 20 MiB aggregate cap before decoding',async()=>{
 const page={width:1024,height:700},source=makePrecisionTiff([page]);
 // Construct a compact valid TIFF with ten directories referring to one actual
 // 2.05 MiB image block. Repacking each page separately would exceed 20 MiB.
 const graph=inspectTiffGraph(source),first=graph.nodes.get(graph.directory.pages[0].ifdOffset)!,payload=source.readUInt32LE(first.fields.get(273)!.offset),count=source.readUInt32LE(first.fields.get(279)!.offset);
 // The source generator interleaves directories and blocks; retain directories
 // only plus one block by moving each complete IFD to a compact fresh layout.
 const ifdLength=2+11*12+4,bitsLength=6,start=8,pixelStart=start+10*(ifdLength+bitsLength),compact=Buffer.alloc(pixelStart+count);compact.write('II');compact.writeUInt16LE(42,2);compact.writeUInt32LE(start,4);
 for(let i=0;i<10;i++){const node=first,target=start+i*(ifdLength+bitsLength);source.copy(compact,target,node.offset,node.offset+ifdLength);compact.writeUInt32LE(i===9?0:target+ifdLength+bitsLength,target+2+11*12);const tags=[...node.fields.keys()];compact.writeUInt32LE(target+ifdLength,target+2+tags.indexOf(258)*12+8);source.copy(compact,target+ifdLength,node.fields.get(258)!.offset,node.fields.get(258)!.offset+6);compact.writeUInt32LE(pixelStart,target+2+tags.indexOf(273)*12+8);}
 source.copy(compact,pixelStart,payload,payload+count);compact.fill(240,pixelStart);assert.ok(compact.length<pdfSplitLimits.maxBytes);assert.equal(inspectTiffStructure(compact).pages.length,10);
 await assert.rejects(decodeSplitTiffSource(compact,{mode:'every',pagesPerDocument:1}),reason('derived_size_limit'));
 const grouped=await decodeSplitTiffSource(compact,{mode:'every',pagesPerDocument:10});assert.equal(grouped.parts.length,1);assert.ok(grouped.parts[0].bytes.length<count+4096);assert.equal(grouped.parts[0].source.pageCount,10);
});

test('relocating legal SHORT strip arrays enforces the child byte limit before allocation or native decoding',async()=>{
 // A 10 MiB source uses low SHORT offsets and a long ASCII description after its
 // image data. Repacking needs LONG offsets, increasing the child above 10 MiB.
 const tags=[256,257,258,259,262,270,273,277,278,279,284],ifd=8,ifdEnd=ifd+2+tags.length*12+4,bits=ifdEnd,offsets=bits+6,counts=offsets+6,pixelsStart=counts+6,descriptionStart=Math.ceil((pixelsStart+9)/2)*2;
 const bytes=Buffer.alloc(pdfSplitLimits.maxBytes);bytes.write('II');bytes.writeUInt16LE(42,2);bytes.writeUInt32LE(ifd,4);bytes.writeUInt16LE(tags.length,ifd);
 const values=new Map<number,[number,number,number]>([[256,[4,1,1]],[257,[4,1,3]],[258,[3,3,bits]],[259,[3,1,1]],[262,[3,1,2]],[270,[2,bytes.length-descriptionStart,descriptionStart]],[273,[3,3,offsets]],[277,[3,1,3]],[278,[4,1,1]],[279,[3,3,counts]],[284,[3,1,1]]]);
 for(const [index,tag]of tags.entries()){const entry=ifd+2+index*12,[type,count,value]=values.get(tag)!;bytes.writeUInt16LE(tag,entry);bytes.writeUInt16LE(type,entry+2);bytes.writeUInt32LE(count,entry+4);if(type===3&&count===1)bytes.writeUInt16LE(value,entry+8);else bytes.writeUInt32LE(value,entry+8);}
 for(let i=0;i<3;i++){bytes.writeUInt16LE(8,bits+i*2);bytes.writeUInt16LE(pixelsStart+i*3,offsets+i*2);bytes.writeUInt16LE(3,counts+i*2);}bytes.fill(100,pixelsStart,pixelsStart+9);bytes.fill(65,descriptionStart,bytes.length-1);
 assert.equal(inspectTiffStructure(bytes).pages.length,1);await assert.rejects(decodeSplitTiffSource(bytes,one(1)),reason('child_size_limit'));
});

test('TIFF split IPC rejects forged format, bytes, source/child counts, ranges, geometry, orientation and text',async()=>{
 const source=makePrecisionTiff([{width:10,height:8,seed:2}]),valid=await decodeSplitTiffSource(source,one(1));
 const reply=()=>({ok:true,split:{...valid,parts:valid.parts.map(({bytes,...part})=>({...part,source:{...part.source,pages:part.source.pages.map(p=>({...p}))},data:bytes.toString('base64')}))}});
 const fake=(response:unknown)=>{const child=new EventEmitter()as ChildProcessWithoutNullStreams;Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});child.kill=()=>{queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;};queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify(response)));child.emit('close',0);});return child;};
 assert.equal((await splitPdfSource(source,'misleading.pdf',one(1)as any,{spawnChild:()=>fake(reply())})).parts[0].source.mimeType,'image/tiff');
 const changes:Array<(r:ReturnType<typeof reply>)=>void>=[
  r=>{r.split.parts[0].source.mimeType='application/pdf';},
  r=>{r.split.parts[0].data=Buffer.from('%PDF-1.7\n').toString('base64');},
  r=>{r.split.parts[0].data=source.subarray(0,20).toString('base64');},
  r=>{r.split.parts[0].data+='!';},
  r=>{r.split.sourcePageCount=2;},r=>{r.split.selectedPages=2;},
  r=>{r.split.parts[0].source.pageCount=2;r.split.parts[0].source.pages.push({page:2,text:''});},
  r=>{r.split.parts[0].range={start:2,end:2};},r=>{r.split.parts.push(r.split.parts[0]);},
  r=>{r.split.parts[0].data=makePrecisionTiff([{width:11,height:8}]).toString('base64');},
  r=>{r.split.parts[0].data=makePrecisionTiff([{width:10,height:8,orientation:2}]).toString('base64');},
  r=>{r.split.parts[0].source.pages[0].text='untrusted text';},r=>{r.split.parts[0].source.pages[0].page=2;},
 ];
 for(const change of changes){const response=reply();change(response);await assert.rejects(splitPdfSource(source,'source.tif',one(1)as any,{spawnChild:()=>fake(response)}),(error:any)=>error.statusCode===422);}
});
