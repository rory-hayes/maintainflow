import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {deflateRawSync} from 'node:zlib';
import {decodeOdtSource,inspectOdtPackage,isOdtPackageCandidate,odtLimits,odtMimeType} from '../server/core/odt-engine.js';
import {SourceValidationError} from '../server/core/source-validation.js';

const ns={o:'urn:oasis:names:tc:opendocument:xmlns:office:1.0',t:'urn:oasis:names:tc:opendocument:xmlns:text:1.0',a:'urn:oasis:names:tc:opendocument:xmlns:table:1.0',s:'urn:oasis:names:tc:opendocument:xmlns:style:1.0',m:'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0'};
const attributes=Object.entries(ns).filter(([key])=>key!=='m').map(([key,value])=>`xmlns:${key}="${value}"`).join(' ');
const document=(body:string,version='1.3',styles='')=>`<?xml version="1.0" encoding="UTF-8"?><o:document-content ${attributes} xmlns:xlink="http://www.w3.org/1999/xlink" o:version="${version}">${styles?`<o:automatic-styles>${styles}</o:automatic-styles>`:''}<o:body><o:text>${body}</o:text></o:body></o:document-content>`;
const manifest=(version='1.3',extra='',rootMedia:string=odtMimeType)=>`<?xml version="1.0"?><m:manifest xmlns:m="${ns.m}" m:version="${version}"><m:file-entry m:full-path="/" m:media-type="${rootMedia}" m:version="${version}"/><m:file-entry m:full-path="content.xml" m:media-type="text/xml"/>${extra}</m:manifest>`;
async function packageBytes(body='<t:p>Identifier: 000127</t:p>',options:{version?:string;styles?:string;content?:string;manifest?:string;extra?:Record<string,string|Buffer>;mime?:string;mimeCompression?:'STORE'|'DEFLATE';mimeLast?:boolean}={}){
 const version=options.version??'1.3',zip=new JSZip();
 const addMime=()=>zip.file('mimetype',options.mime??odtMimeType,{compression:options.mimeCompression??'STORE',createFolders:false});
 if(!options.mimeLast)addMime();
 zip.file('META-INF/manifest.xml',options.manifest??manifest(version,Object.keys(options.extra??{}).map(name=>`<m:file-entry m:full-path="${name}" m:media-type="${name.endsWith('.xml')?'text/xml':'application/octet-stream'}"/>`).join('')),{createFolders:false});
 zip.file('content.xml',options.content??document(body,version,options.styles),{createFolders:false});
 for(const [name,value] of Object.entries(options.extra??{}))zip.file(name,value,{createFolders:false});
 if(options.mimeLast)addMime();
 return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
const rejects=(bytes:Buffer,reason:string)=>assert.throws(()=>decodeOdtSource(bytes),(error:unknown)=>error instanceof SourceValidationError&&error.reason===reason);
const text=(bytes:Buffer)=>decodeOdtSource(bytes).pages[0].text;

// A second fixture writer is independent of JSZip and the production ZIP helper.
function crc(bytes:Buffer){let result=0xffffffff;for(const byte of bytes){result^=byte;for(let bit=0;bit<8;bit++)result=(result>>>1)^((result&1)?0xedb88320:0);}return (result^0xffffffff)>>>0;}
function records(files:{name:string;data:Buffer;method?:0|8;flags?:number;size?:number;extra?:Buffer}[]){
 const locals:Buffer[]=[],centrals:Buffer[]=[];let offset=0;
 for(const file of files){const name=Buffer.from(file.name),method=file.method??0,compressed=method?deflateRawSync(file.data):file.data,extra=file.extra??Buffer.alloc(0),local=Buffer.alloc(30),central=Buffer.alloc(46),checksum=crc(file.data),size=file.size??file.data.length;
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(file.flags??0,6);local.writeUInt16LE(method,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(size,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(file.flags??0,8);central.writeUInt16LE(method,10);central.writeUInt32LE(checksum,16);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(size,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  locals.push(local,name,extra,compressed);centrals.push(central,name);offset+=local.length+name.length+extra.length+compressed.length;
 }
 const directory=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end]);
}
const standardRecords=()=>[{name:'mimetype',data:Buffer.from(odtMimeType)},{name:'META-INF/manifest.xml',data:Buffer.from(manifest())},{name:'content.xml',data:Buffer.from(document('<t:p>Identifier: 000127</t:p>'))}];

test('ODT candidate names are merely candidates, and independent STORE/DEFLATE packages retain one logical page',async()=>{
 for(const name of ['mimetype','META-INF/manifest.xml','content.xml'])assert.equal(isOdtPackageCandidate(new Set([name])),true);
 assert.equal(isOdtPackageCandidate(new Set(['ordinary.txt'])),false);assert.equal(isOdtPackageCandidate(new Set(['MIMETYPE'])),false);
 for(const bytes of [await packageBytes(),await packageBytes(undefined,{version:'1.2'}),records(standardRecords())]){
  assert.deepEqual(decodeOdtSource(bytes),{mimeType:odtMimeType,pages:[{page:1,text:'Identifier: 000127'}],pageCount:1});
  assert.ok(inspectOdtPackage(bytes).expandedBytes>=Buffer.byteLength(odtMimeType)+Buffer.byteLength('Identifier: 000127'));
 }
});

test('namespace aliases, escaped Unicode, spans, links and ODF explicit whitespace preserve exact displayed text',async()=>{
 const source='<t:h t:outline-level="1">Résumé &amp; café</t:h><t:p>  Identifier: <t:span>000127</t:span>  </t:p><t:p> A<t:span>   B </t:span>C<t:s t:c="2"/>D<t:tab/>E<t:line-break/>F </t:p><t:p><t:a xlink:href="https://never-fetched.example.test/" xlink:type="simple">Visible &lt;link&gt;</t:a></t:p><t:p><t:s t:c="2"/>end<t:s/></t:p>';
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('No ODT network');};
 try{assert.equal(text(await packageBytes(source)),'Résumé & café\nIdentifier: 000127\nA B C  D\tE\nF\nVisible <link>\n  end ');assert.equal(calls,0);}finally{globalThis.fetch=original;}
 const alternate=document('<t:p>Alternate</t:p>').replace(/(<\/?| )o:/g,'$1office:').replaceAll('xmlns:o=','xmlns:office=').replace(/(<\/?| )t:/g,'$1text:').replaceAll('xmlns:t=','xmlns:text=');
 assert.equal(text(await packageBytes('',{content:alternate})),'Alternate');
});

test('simple rectangular tables preserve literal cells, blank columns, repeats and regional values without using metadata',async()=>{
 const body='<t:p>Invoice: 000042</t:p><a:table a:name="Invoice"><a:table-column a:number-columns-repeated="3"/><a:table-header-rows><a:table-row><a:table-cell><t:p>Code</t:p></a:table-cell><a:table-cell><t:p>Amount</t:p></a:table-cell><a:table-cell><t:p>Note</t:p></a:table-cell></a:table-row></a:table-header-rows><a:table-row a:number-rows-repeated="2"><a:table-cell o:value-type="float" o:value="127"><t:p>000127</t:p></a:table-cell><a:table-cell a:formula="of:=1000+234.56" o:value="99999" o:value-type="float"><t:p>1.234,56</t:p></a:table-cell><t:ignored/></a:table-row></a:table>';
 const valid=body.replace('<t:ignored/>','<a:table-cell><t:p>First | note<t:line-break/>second</t:p><t:p>third</t:p></a:table-cell>');
 assert.equal(text(await packageBytes(valid)),'Invoice: 000042\nCode\tAmount\tNote\n000127\t1.234,56\tFirst | note second third\n000127\t1.234,56\tFirst | note second third');
 const blank='<a:table><a:table-row><a:table-cell><t:p>A</t:p></a:table-cell><a:table-cell a:number-columns-repeated="2"/></a:table-row></a:table>';
 assert.equal(text(await packageBytes(blank)),'A\t\t');
});

test('tables reject ambiguous tabs, merged or covered cells, ragged rows, nested tables and hidden metadata-only values',async()=>{
 for(const cell of ['<a:table-cell><t:p>A<t:tab/>B</t:p></a:table-cell>','<a:table-cell a:number-columns-spanned="2"><t:p>A</t:p></a:table-cell>','<a:covered-table-cell/>','<a:table-cell><a:table/></a:table-cell>','<a:table-cell o:value="123"/>','<a:table-cell a:formula="of:=1+1"/>'])rejects(await packageBytes(`<a:table><a:table-row>${cell}</a:table-row></a:table>`),'odt_unsupported');
 rejects(await packageBytes('<a:table><a:table-row><a:table-cell><t:p>A</t:p></a:table-cell></a:table-row><a:table-row><a:table-cell/><a:table-cell/></a:table-row></a:table>'),'odt_unsupported');
});

test('lists use exact declared decimal/bullet styles or literal source labels, including nested and restarted items',async()=>{
 const styles='<t:list-style s:name="Ordered"><t:list-level-style-number t:level="1" s:num-format="1" s:num-prefix="(" s:num-suffix=")" t:start-value="3"/><t:list-level-style-bullet t:level="2" t:bullet-char="•"/></t:list-style>';
 const body='<t:list t:style-name="Ordered"><t:list-header><t:p>Tasks</t:p></t:list-header><t:list-item><t:p>First</t:p><t:list><t:list-item><t:p>Nested</t:p></t:list-item></t:list></t:list-item><t:list-item t:start-value="7"><t:p>Second</t:p><t:p>Continuation</t:p></t:list-item></t:list><t:list><t:list-item><t:number>IV.</t:number><t:p>Literal Roman label</t:p></t:list-item></t:list>';
 assert.equal(text(await packageBytes(body,{styles})),'Tasks\n(3) First\n• Nested\n(7) Second\nContinuation\nIV. Literal Roman label');
 const external=`<o:document-styles ${attributes} o:version="1.3"><o:styles>${styles}</o:styles></o:document-styles>`;
 assert.equal(text(await packageBytes('<t:list t:style-name="Ordered"><t:list-item><t:p>External style</t:p></t:list-item></t:list>',{extra:{'styles.xml':external}})),'(3) External style');
});

test('unresolved, continued and unsupported numbering cannot silently drop or invent labels',async()=>{
 for(const body of ['<t:list><t:list-item><t:p>Unknown marker</t:p></t:list-item></t:list>','<t:list t:continue-numbering="true"><t:list-item><t:p>Unknown continuation</t:p></t:list-item></t:list>','<t:numbered-paragraph><t:p>Unsupported</t:p></t:numbered-paragraph>'])rejects(await packageBytes(body),'odt_unsupported');
 rejects(await packageBytes('<t:list t:style-name="Roman"><t:list-item><t:p>Uncached Roman</t:p></t:list-item></t:list>',{styles:'<t:list-style s:name="Roman"><t:list-level-style-number t:level="1" s:num-format="I"/></t:list-style>'}),'odt_unsupported');
});

test('unsupported body objects, annotations, changes, forms, hidden sections and namespace lookalikes fail visibly',async()=>{
 for(const body of ['<t:p>Before<t:note><t:note-body><t:p>Important footnote</t:p></t:note-body></t:note>After</t:p>','<t:tracked-changes/>','<o:forms/>','<t:p><t:hidden-text>Hidden</t:hidden-text></t:p>','<t:section t:name="Hidden" t:display="none"><t:p>Hidden</t:p></t:section>','<t:p xmlns:t="urn:unknown">Lookalike</t:p>','<t:p><foreign xmlns="urn:unknown">Unknown</foreign></t:p>','<t:p xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><draw:frame><draw:image/></draw:frame></t:p>'])rejects(await packageBytes(body),'odt_unsupported');
 const footer=`<o:document-styles ${attributes} o:version="1.3"><o:master-styles><s:master-page s:name="Standard"><s:footer><t:p>Material footer</t:p></s:footer></s:master-page></o:master-styles></o:document-styles>`;
 rejects(await packageBytes(undefined,{extra:{'styles.xml':footer}}),'odt_unsupported');
});

test('DTD, external/general entities, XML instructions and malformed namespace XML are rejected without resolution',async()=>{
 const base=document('<t:p>Safe</t:p>');
 for(const content of [base.replace('<o:document-content','<!DOCTYPE o:document-content SYSTEM "https://never-fetched.example.test/evil.dtd"><o:document-content'),base.replace('<o:document-content','<!DOCTYPE o:document-content [<!ENTITY evil "EXPANDED">]><o:document-content'),base.replace('<o:body>','<?fetch href="https://never-fetched.example.test"?><o:body>')])rejects(await packageBytes('',{content}),'odt_unsupported');
 for(const content of [base.replace('Safe','&unregistered;'),base.replace('Safe','\u0000'),base.replace('</t:p>','</wrong:p>'),base.replace('<t:p>','<unknown:p>').replace('</t:p>','</unknown:p>'),base.replace('<t:p>','<t:p t:style-name="A" t:style-name="B">')])rejects(await packageBytes('',{content}),'odt_invalid');
 rejects(await packageBytes('',{content:base.replace('version="1.0"','version="1.1"')}),'odt_unsupported');
});

test('manifest and MIME identity must agree, include every actual file once, and reject unsafe or duplicate entries',async()=>{
 for(const altered of [manifest().replace('m:full-path="/"','m:full-path="missing"'),manifest().replace('content.xml','missing.xml'),manifest().replace('</m:manifest>','<m:file-entry m:full-path="content.xml" m:media-type="text/xml"/></m:manifest>'),manifest().replace('</m:manifest>','<m:file-entry m:full-path="mimetype" m:media-type="text/plain"/></m:manifest>'),manifest().replace('</m:manifest>','<m:file-entry m:full-path="META-INF/manifest.xml" m:media-type="text/xml"/></m:manifest>'),manifest().replace('</m:manifest>','<m:file-entry m:full-path="../unsafe" m:media-type="text/plain"/></m:manifest>'),manifest().replace('m:media-type="text/xml"','m:media-type="image/png"'),manifest('1.3','',odtMimeType+'-wrong')])rejects(await packageBytes(undefined,{manifest:altered}),'odt_invalid');
 rejects(await packageBytes(undefined,{extra:{'unlisted.bin':'data'},manifest:manifest()}),'odt_invalid');
 rejects(await packageBytes(undefined,{mime:odtMimeType+'\n'}),'odt_unsupported');rejects(await packageBytes(undefined,{mime:'application/vnd.oasis.opendocument.spreadsheet'}),'odt_unsupported');
 rejects(await packageBytes(undefined,{version:'1.4'}),'odt_unsupported');rejects(await packageBytes(undefined,{manifest:manifest('1.2')}),'odt_invalid');
 for(const options of [{mimeLast:true},{mimeCompression:'DEFLATE' as const}])rejects(await packageBytes(undefined,options),'odt_invalid');
});

test('ODF manifest encryption and ZIP encrypted flags return the explicit encrypted reason',async()=>{
 const encrypted=manifest().replace('<m:file-entry m:full-path="content.xml" m:media-type="text/xml"/>','<m:file-entry m:full-path="content.xml" m:media-type="text/xml"><m:encryption-data/></m:file-entry>');
 rejects(await packageBytes(undefined,{manifest:encrypted}),'odt_encrypted');
 const files=standardRecords();rejects(records(files.map((file,index)=>index===2?{...file,flags:1}:file)),'odt_encrypted');
});

test('physical ZIP corruption, duplicate names, local extra MIME data and falsely declared expansion are typed source failures',()=>{
 const files=standardRecords();rejects(records([...files,files[2]]),'odt_invalid');
 const extra=Buffer.from([0xfe,0xca,0,0]);rejects(records(files.map((file,index)=>index?file:{...file,extra})),'odt_invalid');
 const bad=records(files);bad[30+'mimetype'.length]^=1;rejects(bad,'odt_invalid');
 const wrongLocal=records(files);wrongLocal.writeUInt32LE(0,14);rejects(wrongLocal,'odt_invalid');
 rejects(Buffer.from('not zip'),'odt_invalid');
 const bomb=Buffer.alloc(odtLimits.maxEntryBytes+1,65);rejects(records([...files,{name:'bomb.bin',data:bomb,method:8,size:100}]),'odt_structure_limit');
});

test('actual expansion reports all package entries including unused assets',async()=>{
 const extra={'Pictures/unused.bin':Buffer.alloc(100_000,65)},bytes=await packageBytes(undefined,{extra});
 const zip=await JSZip.loadAsync(bytes);let expected=0;for(const file of Object.values(zip.files))if(!file.dir)expected+=(await file.async('nodebuffer')).length;
 assert.equal(inspectOdtPackage(bytes).expandedBytes,expected);assert.equal(text(bytes),'Identifier: 000127');
});

test('XML depth, attributes, nodes, paragraph count and explicit-space bounds reject before unrestricted projection',async()=>{
 for(const body of [Array(odtLimits.maxDepth+1).fill('<t:section t:name="Deep">').join('')+'<t:p>End</t:p>'+Array(odtLimits.maxDepth+1).fill('</t:section>').join(''),'<t:p>A<t:s t:c="10001"/>B</t:p>','<t:p>A<t:s t:c="999999999"/>B</t:p>',Array(odtLimits.maxParagraphs+1).fill('<t:p>A</t:p>').join('')])rejects(await packageBytes(body),'odt_structure_limit');
 const manyAttributes='<t:p '+Array.from({length:65},(_,i)=>`attr${i}="x"`).join(' ')+'>A</t:p>';rejects(await packageBytes(manyAttributes),'odt_structure_limit');
 rejects(await packageBytes('<t:p>'+Array(odtLimits.maxNodes+1).fill('<t:span/>').join('')+'</t:p>'),'odt_structure_limit');
 for(const c of ['0','-1','1.5','NaN'])rejects(await packageBytes(`<t:p>A<t:s t:c="${c}"/></t:p>`),'odt_invalid');
});

test('row/column repeats and emitted text have independent bounds, including empty repeated cells',async()=>{
 const row=(repeat:string)=>`<a:table><a:table-row a:number-rows-repeated="${repeat}"><a:table-cell><t:p>A</t:p></a:table-cell></a:table-row></a:table>`;
 rejects(await packageBytes(row('1001')),'odt_structure_limit');
 rejects(await packageBytes('<a:table><a:table-row><a:table-cell a:number-columns-repeated="1001"/></a:table-row></a:table>'),'odt_structure_limit');
 const rows=Array(11).fill('<a:table-row a:number-rows-repeated="1000"><a:table-cell><t:p>A</t:p></a:table-cell></a:table-row>').join('');rejects(await packageBytes('<a:table>'+rows+'</a:table>'),'odt_structure_limit');
 const long='é'.repeat(odtLimits.maxTextBytes/2+1);rejects(await packageBytes('<t:p>'+long+'</t:p>'),'odt_text_limit');
 const hugeCell=`<a:table><a:table-row><a:table-cell a:number-columns-repeated="1000"><t:p>${'x'.repeat(200_000)}</t:p></a:table-cell></a:table-row></a:table>`;rejects(await packageBytes(hugeCell),'odt_text_limit');
 const repeated=`<a:table><a:table-row a:number-rows-repeated="1000"><a:table-cell><t:p>${'x'.repeat(3000)}</t:p></a:table-cell></a:table-row></a:table>`;rejects(await packageBytes(repeated),'odt_text_limit');
});

test('empty or whitespace-only text is actionable, and original bytes remain unchanged after both passes',async()=>{
 for(const body of ['', '<t:p>   </t:p>','<t:p><t:s t:c="2"/><t:tab/><t:line-break/></t:p>'])rejects(await packageBytes(body),'odt_empty');
 const bytes=await packageBytes(),copy=Buffer.from(bytes);inspectOdtPackage(bytes);decodeOdtSource(bytes);assert.deepEqual(bytes,copy);
});

test('unexpected operational exceptions remain operational instead of becoming input rejections',()=>{
 const bytes=records(standardRecords()),error=new Error('Synthetic operational failure');
 bytes.readUInt32LE=()=>{throw error;};assert.throws(()=>decodeOdtSource(bytes),value=>value===error);
});
