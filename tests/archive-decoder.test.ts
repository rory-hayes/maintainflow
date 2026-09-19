import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import JSZip from 'jszip';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import {archiveImportLimits,archiveEntryReasons,ArchiveImportValidationError,canonicalArchiveImportSpec,type ArchiveImportSpec} from '../shared/archive-import.js';
import {decodeArchive} from '../server/core/archive-engine.js';
import {previewArchiveSource,importArchiveSource,decoderLaunchSpec,runDecoder,splitPdfSource} from '../server/core/source.js';
import {encodeArchiveInput,decodeArchiveInput} from '../server/core/decoder-input.js';
import {scanZip,inflateZipEntry,zipCrc32} from '../server/core/zip-reader.js';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const failure=(reason:string)=>(error:unknown)=>error instanceof ArchiveImportValidationError&&error.reason===reason;
const options=(bytes:Buffer,entries:number[]):ArchiveImportSpec=>({mode:'zip',version:1,sourceSha256:hash(bytes),entries});
async function zip(files:Array<[string,Buffer|string]>,streamFiles=false):Promise<Buffer>{
  const z=new JSZip();for(const [name,data] of files)z.file(name,data,{createFolders:false});
  return z.generateAsync({type:'nodebuffer',compression:'DEFLATE',streamFiles});
}
async function docx(padding=0):Promise<Buffer>{
  const files:Array<[string,string]>=[
    ['[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Reference DOCX-1</w:t></w:r></w:p></w:body></w:document>'],
  ];if(padding)files.push(['unused-padding.bin','x'.repeat(padding)]);
  return zip(files);
}
async function pdf(count=2):Promise<Buffer>{
  const p=await PDFDocument.create(),font=await p.embedFont(StandardFonts.Helvetica);
  for(let i=1;i<=count;i++)p.addPage().drawText(`Reference PDF-${i}`,{x:40,y:600,font});
  return Buffer.from(await p.save());
}

test('ZIP selection identity is strict, source-bound, ordered and private in stdin',()=>{
  const bytes=Buffer.from('fixture'),spec=options(bytes,[2,4]);
  assert.equal(canonicalArchiveImportSpec({entries:[2,4],sourceSha256:hash(bytes),version:1,mode:'zip'}),canonicalArchiveImportSpec(spec));
  for(const entries of [[],[1,1],[4,2],[0],[257],[1.5],Array.from({length:21},(_,i)=>i+1)])assert.throws(()=>canonicalArchiveImportSpec({...spec,entries}),failure('invalid_spec'));
  for(const value of [{...spec,version:2},{...spec,extra:true},{...spec,sourceSha256:'wrong'}])assert.throws(()=>canonicalArchiveImportSpec(value),failure('invalid_spec'));
  assert.deepEqual(decodeArchiveInput(encodeArchiveInput(bytes,spec)),{bytes,spec});
  assert.deepEqual(decodeArchiveInput(encodeArchiveInput(bytes)),{bytes});
  const launch=decoderLaunchSpec('/private/customer.zip',undefined,{spec});
  assert.ok(launch.args.includes('--zip-import'));assert.ok(!launch.args.join(' ').includes(spec.sourceSha256));
  assert.ok(!launch.args.join(' ').includes('customer.zip'));
  assert.deepEqual(Object.keys(launch.options.env).sort(),['LANG','NODE_ENV','TSX_DISABLE_CACHE','TZ']);
  const malformed=encodeArchiveInput(bytes,spec);malformed.writeUInt32BE(4097);
  assert.throws(()=>decodeArchiveInput(malformed),error=>!(error instanceof ArchiveImportValidationError));
});

test('isolated mixed ZIP preserves all nine formats, bytes, entry paths and child-local pages',async()=>{
  const workbook=new ExcelJS.Workbook();workbook.addWorksheet('First').addRow(['Reference','XLSX-1']);workbook.addWorksheet('Second').addRow(['Reference','XLSX-2']);
  const png=await sharp({create:{width:8,height:8,channels:3,background:'#fff'}}).png().toBuffer();
  const jpeg=await sharp(png).jpeg().toBuffer();
  const apple=Buffer.alloc(26);apple.writeUInt32BE(0x00051607);apple.writeUInt32BE(0x00020000,4);
  const files:Array<[string,Buffer|string]>=[
    ['invoices/a.pdf',await pdf()],['images/a.png',png],['images/a.jpeg',jpeg],
    ['a.txt','Reference TXT-1'],['a.csv','Reference,CSV-1'],['a.html','<!DOCTYPE html><html><body><p>Reference HTML-1</p></body></html>'],
    ['a.eml','MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nSubject: Reference EML-1\r\n\r\nReference EML-1'],
    ['word-renamed.bin',await docx()],['excel-renamed.txt',Buffer.from(await workbook.xlsx.writeBuffer())],
    ['nested.zip',await zip([['inside.txt','Nested']])],['unsupported.gif','GIF89a unsupported'],
    ['__MACOSX/._a.pdf',apple],['._invoice.txt','Reference REAL-DOT-1'],['résumé/帳票.txt','Reference UNICODE-1'],
  ];
  const bytes=await zip(files,true),result=await previewArchiveSource(bytes,'invoices.zip');
  assert.equal(result.sourceSha256,hash(bytes));assert.equal(result.sourceByteSize,bytes.length);
  assert.deepEqual(new Set(result.parts.map(part=>part.format)),new Set(['pdf','png','jpeg','txt','csv','html','eml','docx','xlsx']));
  assert.equal(result.entries.length,files.length);assert.equal(result.parts.length,11);assert.equal(result.totalPages,13);
  for(const part of result.parts){
    assert.deepEqual(part.bytes,Buffer.from(files[part.index-1][1]));
    assert.equal(part.path,files[part.index-1][0]);assert.equal(part.sha256,hash(part.bytes));
    assert.deepEqual(part.source.pages.map(page=>page.page),Array.from({length:part.source.pageCount},(_,i)=>i+1));
  }
  assert.equal(result.entries[9].reason,archiveEntryReasons.nested_archive);
  assert.equal(result.entries[10].status,'unsupported');assert.equal(result.entries[11].status,'metadata');
  assert.equal(result.entries[12].status,'ready');
  const selected=await importArchiveSource(bytes,'invoices.zip',options(bytes,[1,8,9]));
  assert.deepEqual(selected.parts.map(part=>part.index),[1,8,9]);assert.equal(selected.totalPages,5);
  assert.deepEqual(selected.entries,result.entries);
  await assert.rejects(importArchiveSource(bytes,'invoices.zip',options(bytes,[10])),failure('selection_mismatch'));
  await assert.rejects(importArchiveSource(bytes,'invoices.zip',options(bytes,[12])),failure('selection_mismatch'));
  assert.throws(()=>importArchiveSource(bytes,'invoices.zip',{...options(bytes,[1]),sourceSha256:'a'.repeat(64)}),failure('source_mismatch'));
});

test('same leaf bytes and basenames in different folders remain independent central-record identities',async()=>{
  const bytes=await zip([['a/invoice.txt','Reference SAME'],['b/invoice.txt','Reference SAME']]);
  const result=await importArchiveSource(bytes,'duplicates.zip',options(bytes,[1,2]));
  assert.equal(result.parts.length,2);assert.equal(result.parts[0].sha256,result.parts[1].sha256);
  assert.notEqual(result.parts[0].index,result.parts[1].index);assert.notEqual(result.parts[0].path,result.parts[1].path);
});

test('Office packages cannot be imported as outer ZIPs and incomplete packages are visibly unavailable',async()=>{
  await assert.rejects(previewArchiveSource(await docx(),'renamed.zip'),failure('office_package'));
  const broken=await zip([['[Content_Types].xml','<Types/>'],['word/document.xml','<document/>']]);
  const result=await previewArchiveSource(await zip([['broken.docx',broken],['valid.txt','Reference VALID']]),'mixed.zip');
  assert.equal(result.entries[0].status,'unsupported');assert.equal(result.entries[0].reason,archiveEntryReasons.invalid_document);
  assert.equal(result.parts.length,1);
});

test('explicit ZIP identity depends on bytes and selected entries, not a renamed outer extension',async()=>{
  const bytes=await zip([['invoice.txt','Reference RENAMED']]),spec=options(bytes,[1]);
  const preview=await previewArchiveSource(bytes,'source.zip'),accepted=await importArchiveSource(bytes,'source.zip',spec);
  for(const name of ['renamed.docx','renamed.xlsx']){
    assert.deepEqual(await previewArchiveSource(bytes,name),preview);
    assert.deepEqual(await importArchiveSource(bytes,name,spec),accepted);
  }
  await assert.rejects(previewArchiveSource(await zip([['_rels/.rels','<Relationships/>']]),'incomplete.zip'),failure('office_package'));
});

test('all outer records, including unselected bytes, must have intact CRC and geometry',async()=>{
  const bytes=await zip([['good.txt','Good'],['excluded.bin','Unknown']]);
  const entries=scanZip(bytes),bad=Buffer.from(bytes);bad[entries[1].dataOffset]^=0x80;
  await assert.rejects(importArchiveSource(bad,'bad.zip',options(bad,[1])),failure('invalid_archive'));
  const central=bytes.readUInt32LE(bytes.length-6),forged=Buffer.from(bytes);
  forged.writeUInt32LE(0x12345678,central+16);
  assert.throws(()=>scanZip(forged),failure('invalid_archive'));
});

test('ZIP limits count files, metadata records, actual inflation, readable text and cumulative Office expansion',async()=>{
  await assert.rejects(previewArchiveSource(await zip(Array.from({length:21},(_,i)=>[`${i}.txt`,'A'])),'many.zip'),failure('document_limit'));
  const directoryZip=new JSZip();for(let i=0;i<257;i++)directoryZip.folder(`folder-${i}`);
  await assert.rejects(previewArchiveSource(await directoryZip.generateAsync({type:'nodebuffer'}),'folders.zip'),failure('record_limit'));
  const excessive=await zip([['large.txt','x'.repeat(archiveImportLimits.maxBytes+1)]]);
  await assert.rejects(previewArchiveSource(excessive,'large.zip'),failure('file_size_limit'));
  const text=await zip([['first.txt','x'.repeat(1024*1024+1)],['second.txt','y'.repeat(1024*1024)]]);
  await assert.rejects(previewArchiveSource(text,'text.zip'),failure('text_limit'));
  const paddedOffice=await docx(21*1024*1024),office=await zip([['a.docx',paddedOffice],['b.docx',paddedOffice]]);
  await assert.rejects(previewArchiveSource(office,'office.zip'),failure('office_expansion_limit'));
  const compressed=await zip([['large.txt','x'.repeat(4096)]]),record=scanZip(compressed)[0];
  assert.throws(()=>inflateZipEntry(compressed,record,1024),failure('expansion_limit'));
  assert.equal(zipCrc32(Buffer.from('123456789')),0xcbf43926);
});

function fakeChild(start?:(child:ChildProcessWithoutNullStreams)=>void):ChildProcessWithoutNullStreams{
  const child=new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false,
    kill(){Object.assign(child,{killed:true});queueMicrotask(()=>child.emit('close',null));return true;}});
  if(start)queueMicrotask(()=>start(child));return child;
}
const respond=(value:unknown)=>()=>fakeChild(child=>{child.stdout.emit('data',Buffer.from(JSON.stringify(value)));child.emit('close',0);});

test('parent checks bytes, digest, order, paths, MIME, text and page totals before trusting archive IPC',async()=>{
  const bytes=await zip([['a.txt','Reference A'],['b.txt','Reference B']]);
  const actual={ok:true,archive:await decodeArchive(bytes,'fixture.zip')};
  for(const mutate of [
    (r:typeof actual)=>{r.archive.sourceSha256='0'.repeat(64);},
    (r:typeof actual)=>{r.archive.entries[0].path='../bad.txt';},
    (r:typeof actual)=>{r.archive.parts.reverse();},
    (r:typeof actual)=>{r.archive.parts[0].data+='!';},
    (r:typeof actual)=>{r.archive.parts[0].sha256='0'.repeat(64);},
    (r:typeof actual)=>{r.archive.parts[0].source.mimeType='application/pdf';},
    (r:typeof actual)=>{r.archive.parts[0].source.pages[0].page=2;},
    (r:typeof actual)=>{r.archive.parts[0].source.pages[0].text='x'.repeat(archiveImportLimits.maxTextBytes+1);},
    (r:typeof actual)=>{r.archive.totalPages=1;},
  ]){
    const value=structuredClone(actual);mutate(value);
    await assert.rejects(previewArchiveSource(bytes,'fixture.zip',{spawnChild:respond(value)}),(error:any)=>error.statusCode===422&&!(error instanceof ArchiveImportValidationError));
  }
  await assert.rejects(previewArchiveSource(bytes,'fixture.zip',{spawnChild:respond({ok:false,code:'archive_import_validation_failed',reason:'secret dependency message'})}),(error:any)=>error.statusCode===422&&!error.message.includes('secret'));
  await assert.rejects(previewArchiveSource(bytes,'fixture.zip',{spawnChild:respond({ok:false,code:'decoder_failed'})}),(error:any)=>error.statusCode===503&&!(error instanceof ArchiveImportValidationError));
});

test('archive decoding shares ordinary/PDF concurrency, kills timeouts and caps output',async()=>{
  const bytes=await zip([['a.txt','A']]),held:ChildProcessWithoutNullStreams[]=[];
  const spawnChild=()=>{const child=fakeChild();held.push(child);return child;};
  const first=previewArchiveSource(bytes,'fixture.zip',{spawnChild});
  const second=runDecoder(Buffer.from('B'),'b.txt',{spawnChild});
  await assert.rejects(splitPdfSource(Buffer.from('C'),'c.pdf',{mode:'every',pagesPerDocument:1},{spawnChild}),(error:any)=>error.statusCode===429);
  await assert.rejects(previewArchiveSource(bytes,'another.zip',{spawnChild}),(error:any)=>error.statusCode===429);
  held[0].stdout.emit('data',Buffer.from(JSON.stringify({ok:true,archive:await decodeArchive(bytes,'fixture.zip')})));held[0].emit('close',0);
  held[1].stdout.emit('data',Buffer.from(JSON.stringify({ok:true,source:{mimeType:'text/plain',pages:[{page:1,text:'B'}],pageCount:1}})));held[1].emit('close',0);
  await Promise.all([first,second]);
  let child!:ChildProcessWithoutNullStreams;
  await assert.rejects(previewArchiveSource(bytes,'fixture.zip',{timeoutMs:10,spawnChild:()=>child=fakeChild()}),(error:any)=>error.statusCode===422&&!(error instanceof ArchiveImportValidationError));assert.equal(child.killed,true);
  await assert.rejects(previewArchiveSource(bytes,'fixture.zip',{spawnChild:()=>child=fakeChild(c=>c.stdout.emit('data',Buffer.alloc(archiveImportLimits.maxOutputBytes+1)))}),(error:any)=>error.statusCode===413&&!(error instanceof ArchiveImportValidationError));assert.equal(child.killed,true);
});
