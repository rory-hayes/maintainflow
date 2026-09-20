import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import type {ChildProcessWithoutNullStreams} from 'node:child_process';import {PDFDocument} from 'pdf-lib';
import JSZip from 'jszip';
import {makeTiff} from './fixtures/tiff.js';import {inspectTiffStructure} from '../server/core/tiff-engine.js';import {inspectSource,renderTiffPage,convertTiffForAI,decoderLaunchSpec,previewArchiveSource,importArchiveSource} from '../server/core/source.js';import {detectSourceFormat} from '../server/core/decoder-engine.js';import {SourceValidationError} from '../server/core/source-validation.js';import {tiffRenderVersion,tiffLimits} from '../shared/tiff.js';
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),typed=(reason:string)=>(error:unknown)=>error instanceof SourceValidationError&&error.reason===reason;
const pages=[{width:80,height:120,color:[30,80,150] as [number,number,number]},{width:96,height:64,orientation:6,color:[200,60,20] as [number,number,number]}];
test('isolated classic/BigTIFF in both endian orders remains TIFF despite filename and preserves real page count',async()=>{
 for(const bigTiff of [false,true])for(const byteOrder of ['II','MM']as const){const bytes=makeTiff(pages,{bigTiff,byteOrder});assert.equal(detectSourceFormat(bytes,'misleading.pdf'),'tiff');assert.equal(detectSourceFormat(bytes,'wrong.txt'),'tiff');const result=await inspectSource(bytes,'wrong.jpg');assert.deepEqual(result,{mimeType:'image/tiff',pageCount:2,pages:[{page:1,text:''},{page:2,text:''}]});}
});
test('preview binds original bytes, oriented page geometry and render version while derived PDF retains all pages',async()=>{
 const bytes=makeTiff(pages),original=hash(bytes),page=await renderTiffPage(bytes,2),first=await convertTiffForAI(bytes),second=await convertTiffForAI(bytes);
 assert.equal(page.page,2);assert.equal(page.pageCount,2);assert.equal(page.width,64);assert.equal(page.height,96);assert.equal(page.sourceSha256,original);assert.equal(page.renderVersion,tiffRenderVersion);assert.equal(page.mimeType,'image/jpeg');
 assert.equal(first.mimeType,'application/pdf');assert.equal(first.sourceSha256,original);assert.equal(first.renderVersion,tiffRenderVersion);assert.equal(first.pageCount,2);assert.equal(hash(first.bytes),hash(second.bytes));assert.equal(hash(bytes),original);
 const doc=await PDFDocument.load(first.bytes);assert.equal(doc.getPageCount(),2);assert.deepEqual(doc.getPages().map(p=>p.getSize()),[{width:80,height:120},{width:64,height:96}]);assert.ok(page.bytes.length<=tiffLimits.maxJpegBytes&&first.bytes.length<=tiffLimits.maxPdfBytes);
});
test('full intake proves native decoding of every page while preview only renders its selected structurally valid page',async()=>{
 const bytes=makeTiff(pages.map(p=>({...p,compression:'deflate'}))),structure=inspectTiffStructure(bytes),ifd=structure.pages[1].ifdOffset;
 let offset=0,count=0;for(let i=0;i<bytes.readUInt16LE(ifd);i++){const entry=ifd+2+i*12,tag=bytes.readUInt16LE(entry);if(tag===273)offset=bytes.readUInt32LE(entry+8);if(tag===279)count=bytes.readUInt32LE(entry+8);}
 bytes.fill(0,offset,offset+count);assert.equal(inspectTiffStructure(bytes).pages.length,2);assert.equal((await renderTiffPage(bytes,1)).page,1);
 for(const run of [()=>inspectSource(bytes,'corrupt-later.tiff'),()=>convertTiffForAI(bytes),()=>renderTiffPage(bytes,2)])await assert.rejects(run(),(error:any)=>!(error instanceof SourceValidationError)&&error.statusCode===503);
});
test('30 real TIFF pages are accepted and 31 are rejected before native conversion',async()=>{
 const input=Array.from({length:30},(_,i)=>({width:16,height:24,color:[i*5,80,100]as[number,number,number]}));assert.equal((await inspectSource(makeTiff(input),'thirty.tif')).pageCount,30);await assert.rejects(inspectSource(makeTiff([...input,input[0]]),'too-many.tiff'),typed('tiff_page_limit'));
});
test('invalid page requests and original file limits reject before any child starts',async()=>{
 let started=false;const options={spawnChild:()=>{started=true;throw new Error('Must not start');}},bytes=makeTiff(pages);
 for(const page of [0,3,1.5,NaN])await assert.rejects(renderTiffPage(bytes,page,options),typed('tiff_page_bounds'));
 await assert.rejects(convertTiffForAI(Buffer.alloc(tiffLimits.maxBytes+1),options),typed('file_too_large'));assert.equal(started,false);
});
function fake(reply?:unknown,onSpawn?:(child:ChildProcessWithoutNullStreams)=>void){const child=new EventEmitter()as ChildProcessWithoutNullStreams;Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});child.kill=()=>{queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;};onSpawn?.(child);if(reply)queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify(reply)));child.emit('close',0);});return child;}
test('TIFF IPC refuses wrong source, page, version, geometry, MIME and noncanonical derived bytes',async()=>{
 const bytes=makeTiff(pages),reply=()=>({ok:true,tiff:{mimeType:'image/jpeg',page:1,pageCount:2,width:80,height:120,sourceSha256:hash(bytes),renderVersion:tiffRenderVersion,data:Buffer.from([255,216,255,0]).toString('base64')}});
 const mutations=[(r:any)=>r.tiff.sourceSha256='0'.repeat(64),(r:any)=>r.tiff.page=2,(r:any)=>r.tiff.pageCount=1,(r:any)=>r.tiff.renderVersion='wrong',(r:any)=>r.tiff.width=100,(r:any)=>r.tiff.mimeType='image/tiff',(r:any)=>r.tiff.data+='!',(r:any)=>r.tiff.extra='hidden'];
 for(const mutate of mutations){const changed=reply();mutate(changed);await assert.rejects(renderTiffPage(bytes,1,{spawnChild:()=>fake(changed)}),(e:any)=>e.statusCode===422);}
 const launch=decoderLaunchSpec('private-original-name.tif',undefined,undefined,{page:1});assert.equal(launch.args.includes('private-original-name.tif'),false);assert.ok(launch.args.includes('source.tiff'));assert.ok(!('PATH'in launch.options.env));
});
test('abort kills decoder and holds its concurrency slot until close, including abort during spawn',async()=>{
 const bytes=makeTiff(pages),controller=new AbortController();let child:ChildProcessWithoutNullStreams|undefined,kill=false;
 const pending=convertTiffForAI(bytes,{signal:controller.signal,spawnChild:()=>fake(undefined,c=>{child=c;c.kill=()=>{kill=true;return true;};})});controller.abort();assert.equal(kill,true);let done=false;void pending.catch(()=>{done=true;});await Promise.resolve();assert.equal(done,false);child!.emit('close',null,'SIGKILL');await assert.rejects(pending,(e:any)=>e.name==='AbortError');
 const during=new AbortController();await assert.rejects(convertTiffForAI(bytes,{signal:during.signal,spawnChild:()=>fake(undefined,()=>during.abort())}),(e:any)=>e.name==='AbortError');
 let started=false;await assert.rejects(convertTiffForAI(bytes,{signal:during.signal,spawnChild:()=>{started=true;return fake();}}),(e:any)=>e.name==='AbortError');assert.equal(started,false);
});


test('ZIP aggregate TIFF preflight rejects over 300MP before any corrupt native payload is decoded, including unselected leaves',async()=>{
 const large=makeTiff(Array.from({length:30},()=>({width:1,height:1,compression:'deflate'})));let cursor=large.readUInt32LE(4);
 while(cursor){const count=large.readUInt16LE(cursor);for(let i=0;i<count;i++){const entry=cursor+2+i*12,tag=large.readUInt16LE(entry);if(tag===256)large.writeUInt32LE(2500,entry+8);if(tag===257||tag===278)large.writeUInt32LE(4000,entry+8);}cursor=large.readUInt32LE(cursor+2+count*12);}
 assert.equal(inspectTiffStructure(large).totalPixels,tiffLimits.maxTotalPixels);
 const exact=new JSZip();exact.file('exact.tiff',large);const exactBytes=await exact.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 // The declared exact boundary passes structural preflight, then the deliberately
 // truncated compressed pixels fail operationally at native decoding.
 await assert.rejects(previewArchiveSource(exactBytes,'exact.zip'),(error:any)=>error.statusCode===503&&!(error instanceof SourceValidationError));
 exact.file('one-more-pixel.tiff',makeTiff([{width:1,height:1}]));const excess=await exact.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
 await assert.rejects(previewArchiveSource(excess,'over.zip'),typed('tiff_pixel_limit'));
 await assert.rejects(importArchiveSource(excess,'over.zip',{mode:'zip',version:1,sourceSha256:hash(excess),entries:[2]}),typed('tiff_pixel_limit'));
});
