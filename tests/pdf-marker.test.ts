import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {canonicalPdfSplitSpec,findPdfMarkerRanges,nativePdfPageText,normalizePdfMarkerText,planPdfSplit,pdfSplitLimits,PdfSplitValidationError,verifyPdfMarkerRanges,type PdfSplitSpec} from '../shared/pdf-split.js';
import {decodeSplitInput,encodeSplitInput,maxSplitInputBytes} from '../server/core/decoder-input.js';
import {decoderLaunchSpec,inspectSource,splitPdfSource} from '../server/core/source.js';
const failure=(reason:string)=>(error:unknown)=>error instanceof PdfSplitValidationError&&error.reason===reason;
const markerSpec=(marker:string,ranges=[{start:1,end:1}]):PdfSplitSpec=>({mode:'marker',marker,ranges});
async function pdfWithText(texts:string[]){
 const document=await PDFDocument.create({updateMetadata:false}),font=await document.embedFont(StandardFonts.Helvetica);
 for(const text of texts){const page=document.addPage([400,500]);if(text)page.drawText(text,{x:20,y:450,size:12,font,lineHeight:18});}
 return Buffer.from(await document.save());
}

test('literal marker boundaries preserve prefixes, consecutive matches, repeated text and textless pages',()=>{
 const found=findPdfMarkerRanges('  Invoice\tstart  ',['Cover page','','Invoice\nstart Invoice start','Invoice  start','Trailing detail']);
 assert.deepEqual(found,{marker:'Invoice start',matchedPages:[3,4],textlessPages:[2],selectedPages:5,ranges:[{start:1,end:2},{start:3,end:3},{start:4,end:5}]});
 assert.deepEqual(findPdfMarkerRanges('[.*]', ['[.*] first','second','[.*] last']).ranges,[{start:1,end:2},{start:3,end:3}]);
 assert.deepEqual(findPdfMarkerRanges('Invoice', ['Invoice one','trailing']).ranges,[{start:1,end:2}]);
 assert.throws(()=>findPdfMarkerRanges('Invoice',['invoice']),failure('marker_not_found'));
 assert.throws(()=>findPdfMarkerRanges('Invoice start',['Invoice','start']),failure('marker_not_found'));
 assert.throws(()=>findPdfMarkerRanges('invoice',['','\t \n']),failure('marker_no_text'));
 assert.throws(()=>findPdfMarkerRanges('x',Array(21).fill('x')),failure('document_limit'));
 assert.equal(findPdfMarkerRanges('x',Array(20).fill('x')).ranges.length,20);
 assert.throws(()=>findPdfMarkerRanges('x',Array(31).fill('x')),failure('page_bounds'));
});

test('marker canonicalization bounds raw input, rejects unsupported JSON text and binds all ranges',()=>{
 const ranges=[{start:1,end:2},{start:3,end:4}];
 assert.equal(canonicalPdfSplitSpec(markerSpec('Invoice \n start',ranges)),canonicalPdfSplitSpec(markerSpec(' Invoice\tstart ',ranges)));
 for(const marker of ['', ' '.repeat(200),'x'.repeat(201),' '.repeat(201)+'x','\0','\ud800','\udc00'])assert.throws(()=>canonicalPdfSplitSpec(markerSpec(marker)),failure('invalid_spec'));
 for(const marker of ['x'.repeat(200),'😀'.repeat(100),'\u0001'.repeat(200)])assert.ok(Buffer.byteLength(canonicalPdfSplitSpec(markerSpec(marker)))<pdfSplitLimits.maxSpecBytes);
 const valid=markerSpec('Invoice',ranges);
 assert.deepEqual(planPdfSplit(valid,4),{ranges,selectedPages:4});
 for(const incomplete of [[{start:2,end:4}],[{start:1,end:3}],[{start:1,end:1},{start:3,end:4}]])assert.throws(()=>planPdfSplit(markerSpec('Invoice',incomplete),4),failure('marker_plan_mismatch'));
 assert.throws(()=>verifyPdfMarkerRanges(valid,['Invoice','','','Invoice']),failure('marker_plan_mismatch'));
 assert.notEqual(canonicalPdfSplitSpec(valid),canonicalPdfSplitSpec(markerSpec('invoice',ranges)));
 assert.notEqual(canonicalPdfSplitSpec(valid),canonicalPdfSplitSpec(markerSpec('Invoice',[{start:1,end:4}])));
});

test('shared PDF.js text assembly preserves extraction text before separate whitespace folding',()=>{
 const item=(str:string,y:number,hasEOL=false)=>({str,transform:[1,0,0,1,20,y],hasEOL});
 const items=[{type:'beginMarkedContent'},item('Invoice',100),item('start',100,true),item('',100,true),item('Second',90),item('line',90),item('Next',60)];
 assert.equal(nativePdfPageText(items),'Invoice start\nSecond line\nNext');
 assert.equal(normalizePdfMarkerText(nativePdfPageText(items)),'Invoice start Second line Next');
});

test('real PDF marker splitting recomputes boundaries, keeps original bytes and rebases every child page',async()=>{
 const bytes=await pdfWithText(['Cover page','','Invoice\nstart Invoice start','Invoice start','Last detail']),original=Buffer.from(bytes);
 const source=await inspectSource(bytes,'owned-marker.pdf'),found=findPdfMarkerRanges('Invoice\tstart',source.pages.map(p=>p.text));
 const result=await splitPdfSource(bytes,'owned-marker.pdf',markerSpec('Invoice\tstart',found.ranges));
 assert.equal(result.selectedPages,5);assert.deepEqual(result.parts.map(p=>p.range),[{start:1,end:2},{start:3,end:3},{start:4,end:5}]);
 for(const part of result.parts){assert.deepEqual(await inspectSource(part.bytes,'owned-child.pdf'),part.source);assert.deepEqual(part.source.pages.map(p=>p.page),Array.from({length:part.source.pageCount},(_,i)=>i+1));}
 assert.deepEqual(result.parts.flatMap(p=>p.source.pages.map(page=>page.text)),source.pages.map(page=>page.text));
 assert.deepEqual(bytes,original);
 await assert.rejects(splitPdfSource(bytes,'owned-marker.pdf',markerSpec('Invoice start',[{start:1,end:5}])),failure('marker_plan_mismatch'));
 await assert.rejects(splitPdfSource(bytes,'owned-marker.pdf',markerSpec('invoice start',found.ranges)),failure('marker_not_found'));
 await assert.rejects(splitPdfSource(await pdfWithText(['','']),'owned-image-only.pdf',markerSpec('Invoice',[{start:1,end:2}])),failure('marker_no_text'));
 await assert.rejects(splitPdfSource(await pdfWithText(['Invoice','start']),'owned-cross-page.pdf',markerSpec('Invoice start',[{start:1,end:2}])),failure('marker_not_found'));
});

test('private bounded stdin envelope carries canonical spec and leaves process arguments free of marker text',()=>{
 const spec=markerSpec('PRIVATE marker'),bytes=Buffer.from('%PDF-owned'),encoded=encodeSplitInput(bytes,spec),decoded=decodeSplitInput(encoded),launch=decoderLaunchSpec('owned.pdf',spec);
 assert.deepEqual(decoded,{bytes,spec});assert.equal(launch.args.at(-1),'--pdf-split');assert.ok(!launch.args.join(' ').includes('PRIVATE'));assert.ok(!launch.args.join(' ').includes('ranges'));
 const header=(size:number)=>{const b=Buffer.alloc(4);b.writeUInt32BE(size);return b;};
 const malformed=[Buffer.alloc(0),Buffer.alloc(3),header(0),header(pdfSplitLimits.maxSpecBytes+1),Buffer.concat([header(100),Buffer.from('{}')]),Buffer.concat([header(1),Buffer.from('x%PDF')]),Buffer.concat([header(1),Buffer.from([0xff,1])]),Buffer.alloc(maxSplitInputBytes+1)];
 for(const value of malformed)assert.throws(()=>decodeSplitInput(value),error=>error instanceof Error&&!(error instanceof PdfSplitValidationError)&&error.message==='Invalid decoder input envelope');
});

test('actual decoder process treats malformed and oversized split envelope as safe retryable IPC failures',async()=>{
 const run=(bytes:Buffer)=>new Promise<unknown>((resolve,reject)=>{
  const launch=decoderLaunchSpec('owned.pdf',markerSpec('PRIVATE marker'));
  const child=spawn(launch.command,launch.args,launch.options),out:Buffer[]=[];let errorBytes=0;
  const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Owned decoder envelope test timed out'));},10_000);
  child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>{errorBytes+=b.length;});child.stdin.on('error',()=>{});child.on('error',reject);
  child.on('close',code=>{clearTimeout(timeout);try{assert.equal(code,0);assert.equal(errorBytes,0);resolve(JSON.parse(Buffer.concat(out).toString()));}catch(error){reject(error);}});child.stdin.end(bytes);
 });
 assert.deepEqual(await run(Buffer.from('PRIVATE malformed')), {ok:false,code:'decoder_failed'});
 assert.deepEqual(await run(Buffer.alloc(maxSplitInputBytes+1)), {ok:false,code:'decoder_failed'});
});
