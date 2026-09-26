import {SaxesParser,type SaxesTagNS} from 'saxes';
import {ArchiveImportValidationError} from '../../shared/archive-import.js';
import {decoderLimits} from './decoder-limits.js';
import {SourceValidationError,type SourceValidationReason} from './source-validation.js';
import {scanZip,inflateZipEntry,safeArchivePath} from './zip-reader.js';

export const odtMimeType='application/vnd.oasis.opendocument.text' as const;
export const odtLimits=Object.freeze({maxEntries:2000,maxExpandedBytes:40*1024*1024,maxEntryBytes:10*1024*1024,maxDepth:64,maxNodes:100_000,maxAttributes:64,maxAttributeBytes:65_536,maxParagraphs:20_000,maxRows:10_000,maxCells:100_000,maxColumns:1000,maxRepeat:1000,maxSpaces:10_000,maxTextBytes:decoderLimits.maxTextBytes});
const ns={office:'urn:oasis:names:tc:opendocument:xmlns:office:1.0',text:'urn:oasis:names:tc:opendocument:xmlns:text:1.0',table:'urn:oasis:names:tc:opendocument:xmlns:table:1.0',style:'urn:oasis:names:tc:opendocument:xmlns:style:1.0',manifest:'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',xlink:'http://www.w3.org/1999/xlink',xml:'http://www.w3.org/XML/1998/namespace',xmlns:'http://www.w3.org/2000/xmlns/'} as const;
const key=(uri:string,local:string)=>`${uri}|${local}`;
const fail=(reason:SourceValidationReason):never=>{throw new SourceValidationError(reason);};
interface XmlNode{uri:string;local:string;attributes:Record<string,string>;children:(XmlNode|string)[];}
interface Budget{nodes:number;}
const is=(node:XmlNode,uri:string,local:string)=>node.uri===uri&&node.local===local;
const attr=(node:XmlNode,uri:string,local:string)=>node.attributes[key(uri,local)];
function elements(node:XmlNode){return node.children.filter((child):child is XmlNode=>typeof child!=='string');}
function elementContent(node:XmlNode){if(node.children.some(child=>typeof child==='string'&&/[^\t\r\n ]/.test(child)))fail('odt_invalid');return elements(node);}
function empty(node:XmlNode){if(node.children.length)fail('odt_invalid');}
function count(value:string|undefined,maximum:number,defaultValue=1){if(value===undefined)return defaultValue;if(!/^[1-9]\d{0,8}$/.test(value))fail('odt_invalid');const n=Number(value);if(n>maximum)fail('odt_structure_limit');return n;}
function version(value:string|undefined){if(!value)fail('odt_invalid');if(value!=='1.2'&&value!=='1.3')fail('odt_unsupported');return value;}

/** A candidate test is intentionally not a validity or trust decision. */
export function isOdtPackageCandidate(names:ReadonlySet<string>):boolean{return names.has('mimetype')||names.has('META-INF/manifest.xml')||names.has('content.xml');}

function xml(bytes:Buffer,budget:Budget):XmlNode{
 let text:string;
 try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(error){if(error instanceof TypeError)fail('odt_invalid');throw error;}
 let root:XmlNode|undefined;const stack:XmlNode[]=[];
 const parser=new SaxesParser({xmlns:true,defaultXMLVersion:'1.0',forceXMLVersion:true});
 parser.on('error',()=>fail('odt_invalid'));
 parser.on('doctype',()=>fail('odt_unsupported'));
 parser.on('processinginstruction',()=>fail('odt_unsupported'));
 parser.on('xmldecl',declaration=>{if(declaration.version!=='1.0'||declaration.encoding&&!/^utf-8$/i.test(declaration.encoding))fail('odt_unsupported');});
 parser.on('opentag',(tag:SaxesTagNS)=>{
  if(++budget.nodes>odtLimits.maxNodes||stack.length>=odtLimits.maxDepth)fail('odt_structure_limit');
  const attributes:Record<string,string>=Object.create(null),source=Object.values(tag.attributes);
  if(source.length>odtLimits.maxAttributes||source.reduce((sum,item)=>sum+Buffer.byteLength(item.value),0)>odtLimits.maxAttributeBytes)fail('odt_structure_limit');
  for(const item of source)if(item.uri!==ns.xmlns)attributes[key(item.uri,item.local)]=item.value;
  const node:XmlNode={uri:tag.uri,local:tag.local,attributes,children:[]};
  if(stack.length)stack.at(-1)!.children.push(node);else{if(root)fail('odt_invalid');root=node;}stack.push(node);
 });
 const addText=(value:string)=>{if(!value)return;if(++budget.nodes>odtLimits.maxNodes)fail('odt_structure_limit');if(stack.length)stack.at(-1)!.children.push(value);else if(/[^\t\r\n ]/.test(value))fail('odt_invalid');};
 parser.on('text',addText);parser.on('cdata',addText);parser.on('closetag',()=>{stack.pop();});
 // Small chunks keep SAX token processing cooperative with its bounded source.
 for(let index=0;index<text.length;index+=16_384)parser.write(text.slice(index,index+16_384));parser.close();
 if(!root||stack.length)fail('odt_invalid');return root!;
}

function encryptedZip(bytes:Buffer):boolean{
 // Inspect only bounded, in-range central records for an encryption flag. Full
 // physical validation is still exclusively performed by scanZip below.
 for(let end=bytes.length-22;end>=Math.max(0,bytes.length-65_557);end--){
  if(bytes.readUInt32LE(end)!==0x06054b50||end+22+bytes.readUInt16LE(end+20)!==bytes.length)continue;
  let cursor=bytes.readUInt32LE(end+16);const records=bytes.readUInt16LE(end+10);if(records>odtLimits.maxEntries)return false;
  for(let i=0;i<records;i++){if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)return false;if(bytes.readUInt16LE(cursor+8)&0x41)return true;cursor+=46+bytes.readUInt16LE(cursor+28)+bytes.readUInt16LE(cursor+30)+bytes.readUInt16LE(cursor+32);}
  return false;
 }return false;
}
function archiveError(error:unknown):never{
 if(!(error instanceof ArchiveImportValidationError))throw error;
 if(['record_limit','file_size_limit','expansion_limit'].includes(error.reason))fail('odt_structure_limit');
 if(['unsupported_archive','unsupported_entry'].includes(error.reason))fail('odt_unsupported');
 return fail('odt_invalid');
}
function packageContents(bytes:Buffer){
 if(bytes.length>decoderLimits.maxBytes)fail('file_too_large');
 if(encryptedZip(bytes))fail('odt_encrypted');
 let entries:ReturnType<typeof scanZip>;
 try{entries=scanZip(bytes,{maxRecords:odtLimits.maxEntries,maxExpandedBytes:odtLimits.maxExpandedBytes,maxFileBytes:odtLimits.maxEntryBytes});}catch(error){return archiveError(error);}
 const names=new Set(entries.map(entry=>entry.path));
 if(names.has('word/document.xml')||names.has('xl/workbook.xml'))fail('odt_unsupported');
 const mime=entries.find(entry=>entry.path==='mimetype');
 if(!mime||mime.localOffset!==0||mime.method!==0||mime.directory||bytes.readUInt16LE(mime.localOffset+28)!==0||mime.flags&8||!names.has('content.xml')||!names.has('META-INF/manifest.xml'))fail('odt_invalid');
 const files=new Map<string,Buffer>();let expandedBytes=0;
 for(const entry of entries){
  let data:Buffer;try{data=inflateZipEntry(bytes,entry,Math.min(odtLimits.maxEntryBytes,odtLimits.maxExpandedBytes-expandedBytes));}catch(error){return archiveError(error);}
  expandedBytes+=data.length;if(!entry.directory)files.set(entry.path,data);
 }
 if(!files.get('mimetype')!.equals(Buffer.from(odtMimeType,'ascii')))fail('odt_unsupported');
 const budget:Budget={nodes:0},manifest=xml(files.get('META-INF/manifest.xml')!,budget);
 if(!is(manifest,ns.manifest,'manifest'))fail('odt_invalid');const packageVersion=version(attr(manifest,ns.manifest,'version'));
 const listed=new Map<string,XmlNode>();
 for(const entry of elementContent(manifest)){
  if(entry.uri===ns.manifest&&['encryption-data','encrypted-key'].includes(entry.local))fail('odt_encrypted');
  if(!is(entry,ns.manifest,'file-entry'))fail('odt_unsupported');
  for(const child of elementContent(entry)){if(child.uri===ns.manifest&&['encryption-data','encrypted-key'].includes(child.local))fail('odt_encrypted');fail('odt_unsupported');}
  const path=attr(entry,ns.manifest,'full-path'),media=attr(entry,ns.manifest,'media-type');
  if(!path||media===undefined||listed.has(path)||path==='mimetype'||path==='META-INF/manifest.xml'||path!=='/'&&!safeArchivePath(path))fail('odt_invalid');
  if(path!=='/'&&path.endsWith('/'))fail('odt_unsupported'); // Embedded subdocuments are not projected.
  if(path!=='/'&&!files.has(path))fail('odt_invalid');listed.set(path,entry);
 }
 const root=listed.get('/');if(!root||attr(root,ns.manifest,'media-type')!==odtMimeType)fail('odt_invalid');
 if(attr(root!,ns.manifest,'version')!==undefined&&version(attr(root!,ns.manifest,'version'))!==packageVersion)fail('odt_invalid');
 for(const name of files.keys())if(name!=='mimetype'&&!name.startsWith('META-INF/')&&!listed.has(name))fail('odt_invalid');
 if(attr(listed.get('content.xml')!,ns.manifest,'media-type')!=='text/xml')fail('odt_invalid');
 for(const name of files.keys())if(/^(?:Basic|Scripts)\//i.test(name))fail('odt_unsupported');
 const content=xml(files.get('content.xml')!,budget);
 if(!is(content,ns.office,'document-content')||version(attr(content,ns.office,'version'))!==packageVersion)fail('odt_invalid');
 const styles=files.has('styles.xml')?xml(files.get('styles.xml')!,budget):undefined;
 if(styles&&(!is(styles,ns.office,'document-styles')||version(attr(styles,ns.office,'version'))!==packageVersion))fail('odt_invalid');
 // Parse metadata/settings for XML safety too; neither contributes document text.
 for(const name of ['meta.xml','settings.xml'])if(files.has(name)){const extra=xml(files.get(name)!,budget);if(!is(extra,ns.office,name==='meta.xml'?'document-meta':'document-settings')||version(attr(extra,ns.office,'version'))!==packageVersion)fail('odt_invalid');}
 return {expandedBytes,content,styles};
}

function attrs(node:XmlNode,allowed:string[]){const accepted=new Set([...allowed,key(ns.xml,'id')]);for(const name of Object.keys(node.attributes))if(!accepted.has(name))fail('odt_unsupported');}
const textStyle=[key(ns.text,'style-name'),key(ns.text,'class-names')];
const drawingNamespace='urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
interface ListLevel{kind:'bullet'|'number';bullet?:string;prefix:string;suffix:string;start:number;}
function styleCatalogue(content:XmlNode,styles?:XmlNode){
 const lists=new Map<string,Map<number,ListLevel>>();let numberedOutline=false;
 const visit=(node:XmlNode)=>{
  // Page styles can carry source images/objects outside office:body. Accepting
  // the remaining body text would hide their omission from the extraction.
  if(is(node,ns.style,'background-image')&&(attr(node,ns.xlink,'href')?.trim()||elements(node).length||node.children.some(child=>typeof child==='string'&&child.trim())))fail('odt_unsupported');
  if(node.uri===drawingNamespace&&['frame','image','fill-image','object','object-ole','plugin','floating-frame'].includes(node.local))fail('odt_unsupported');
  if(node.uri===ns.style&&/^(?:header|footer)(?:-|$)/.test(node.local))fail('odt_unsupported');
  if(is(node,ns.office,'scripts')&&elementContent(node).length)fail('odt_unsupported');
  for(const [name,value] of Object.entries(node.attributes)){
   if([key(ns.text,'display'),key(ns.text,'condition'),key(ns.table,'visibility'),key(ns.style,'display')].includes(name)&&!['true','visible','always'].includes(value))fail('odt_unsupported');
  }
  if(is(node,ns.text,'outline-level-style')&&attr(node,ns.style,'num-format'))numberedOutline=true;
  if(is(node,ns.text,'list-style')){
   const name=attr(node,ns.style,'name');if(!name||lists.has(name))fail('odt_invalid');const levels=new Map<number,ListLevel>();
   for(const level of elementContent(node)){
    const depth=count(attr(level,ns.text,'level'),odtLimits.maxDepth);if(levels.has(depth))fail('odt_invalid');
    const kind=is(level,ns.text,'list-level-style-bullet')?'bullet':is(level,ns.text,'list-level-style-number')?'number':null;if(!kind)continue;
    // Unsupported numbering is recorded by absence and rejected only if used.
    if(kind==='number'&&(attr(level,ns.style,'num-format')!=='1'||!['1',undefined].includes(attr(level,ns.text,'display-levels'))))continue;
    const bullet=attr(level,ns.text,'bullet-char');if(kind==='bullet'&&(!bullet||[...bullet].length!==1))continue;
    levels.set(depth,{kind,bullet,prefix:attr(level,ns.style,'num-prefix')??'',suffix:attr(level,ns.style,'num-suffix')??'',start:count(attr(level,ns.text,'start-value'),1_000_000)});
   }lists.set(name,levels);
  }
  for(const child of elements(node))visit(child);
 };
 for(const root of [styles,content])if(root)visit(root);return {lists,numberedOutline};
}

function project(content:XmlNode,styles?:XmlNode){
 const noBodyText=(node:XmlNode)=>{if(node.uri===ns.text&&['p','h','section','list','numbered-paragraph'].includes(node.local))fail('odt_unsupported');for(const child of elements(node))noBodyText(child);};
 const catalogue=styleCatalogue(content,styles),roots=elementContent(content);
 if(styles)noBodyText(styles);for(const child of roots)if(!is(child,ns.office,'body'))noBodyText(child);
 for(const child of roots)if(child.uri!==ns.office||!['body','scripts','font-face-decls','automatic-styles'].includes(child.local))fail('odt_unsupported');
 const bodies=roots.filter(child=>is(child,ns.office,'body'));if(bodies.length!==1)fail('odt_invalid');
 attrs(bodies[0],[]);const body=elementContent(bodies[0]);if(body.length!==1||!is(body[0],ns.office,'text'))fail('odt_unsupported');
 attrs(body[0],[]);
 let textBytes=0,paragraphs=0,rowCount=0,cellCount=0;const lines:string[]=[];
 const emit=(line:string)=>{textBytes+=Buffer.byteLength(line)+(lines.length?1:0);if(textBytes>odtLimits.maxTextBytes)fail('odt_text_limit');lines.push(line);};
 const inline=(node:XmlNode):string=>{
  const tokens:{explicit:boolean;parts:string[]}[]=[];let bytes=0;
  const add=(value:string,explicit=false)=>{bytes+=Buffer.byteLength(value);if(bytes>odtLimits.maxTextBytes)fail('odt_text_limit');if(!explicit&&tokens.at(-1)?.explicit===false)tokens.at(-1)!.parts.push(value);else tokens.push({explicit,parts:[value]});};
  const walk=(parent:XmlNode)=>{for(const child of parent.children){
   if(typeof child==='string'){add(child);continue;}
   if(child.uri!==ns.text)fail('odt_unsupported');
   if(['span','a'].includes(child.local)){attrs(child,child.local==='a'?[...textStyle,key(ns.xlink,'href'),key(ns.xlink,'type'),key(ns.xlink,'show'),key(ns.xlink,'actuate'),key(ns.office,'name'),key(ns.office,'target-frame-name')]:textStyle);walk(child);}
   else if(child.local==='s'){attrs(child,[key(ns.text,'c')]);empty(child);add(' '.repeat(count(attr(child,ns.text,'c'),odtLimits.maxSpaces)),true);}
   else if(child.local==='tab'||child.local==='line-break'){attrs(child,child.local==='tab'?[key(ns.text,'tab-ref')]:[]);empty(child);add(child.local==='tab'?'\t':'\n',true);}
   else if(['bookmark','bookmark-start','bookmark-end','reference-mark','reference-mark-start','reference-mark-end','soft-page-break'].includes(child.local)){attrs(child,child.local==='soft-page-break'?[]:[key(ns.text,'name')]);empty(child);}
   else fail('odt_unsupported');
  }};walk(node);
  // ODF 6.1.2: collapse literal XML whitespace before interpreting explicit s/tab/break elements.
  return tokens.map((token,index)=>{const value=token.parts.join('');return token.explicit?value:value.replace(/[\t\r\n ]+/g,' ').replace(index===0?/^ +/:/$^/,'').replace(index===tokens.length-1?/ +$/:/$^/,'');}).join('');
 };
 const paragraph=(node:XmlNode)=>{
  if(++paragraphs>odtLimits.maxParagraphs)fail('odt_structure_limit');
  attrs(node,[...textStyle,...(node.local==='h'?[key(ns.text,'outline-level'),key(ns.text,'restart-numbering'),key(ns.text,'start-value'),key(ns.text,'is-list-header')]:[])]);
  if(node.local==='h'&&(catalogue.numberedOutline||attr(node,ns.text,'restart-numbering')!==undefined||attr(node,ns.text,'start-value')!==undefined))fail('odt_unsupported');
  return inline(node);
 };
 const table=(node:XmlNode)=>{
  attrs(node,[key(ns.table,'name'),key(ns.table,'style-name'),key(ns.table,'protected'),key(ns.table,'print')]);
  let columns:number|undefined,declaredColumns=0;
  const rows=(parent:XmlNode)=>{for(const child of elementContent(parent)){
   if(is(child,ns.table,'table-column')){attrs(child,[key(ns.table,'style-name'),key(ns.table,'default-cell-style-name'),key(ns.table,'number-columns-repeated')]);empty(child);declaredColumns+=count(attr(child,ns.table,'number-columns-repeated'),odtLimits.maxRepeat);if(declaredColumns>odtLimits.maxColumns)fail('odt_structure_limit');continue;}
   if(child.uri===ns.table&&['table-header-rows','table-rows','table-columns','table-header-columns'].includes(child.local)){attrs(child,[]);rows(child);continue;}
   if(!is(child,ns.table,'table-row'))fail('odt_unsupported');
   attrs(child,[key(ns.table,'style-name'),key(ns.table,'default-cell-style-name'),key(ns.table,'number-rows-repeated')]);const repeat=count(attr(child,ns.table,'number-rows-repeated'),odtLimits.maxRepeat),cells:string[]=[];let rowBytes=0;
   for(const cell of elementContent(child)){
    if(!is(cell,ns.table,'table-cell'))fail('odt_unsupported');
    attrs(cell,[key(ns.table,'style-name'),key(ns.table,'number-columns-repeated'),key(ns.table,'number-columns-spanned'),key(ns.table,'number-rows-spanned'),key(ns.table,'formula'),key(ns.table,'protected'),...['value-type','value','string-value','date-value','time-value','boolean-value','currency'].map(name=>key(ns.office,name))]);
    if(count(attr(cell,ns.table,'number-columns-spanned'),odtLimits.maxRepeat)>1||count(attr(cell,ns.table,'number-rows-spanned'),odtLimits.maxRepeat)>1)fail('odt_unsupported');
    const parts=elementContent(cell).map(part=>{if(part.uri!==ns.text||!['p','h'].includes(part.local))fail('odt_unsupported');return paragraph(part);});
    const value=parts.join(' ').replace(/\n/g,' ');if(value.includes('\t'))fail('odt_unsupported');
    if(!value.trim()&&[key(ns.table,'formula'),...['value','string-value','date-value','time-value','boolean-value'].map(name=>key(ns.office,name))].some(name=>cell.attributes[name]!==undefined&&cell.attributes[name]!==''))fail('odt_unsupported');
    const copies=count(attr(cell,ns.table,'number-columns-repeated'),odtLimits.maxRepeat);if(cells.length+copies>odtLimits.maxColumns)fail('odt_structure_limit');rowBytes+=(Buffer.byteLength(value)+1)*copies;if(rowBytes-1>odtLimits.maxTextBytes-textBytes)fail('odt_text_limit');for(let n=0;n<copies;n++)cells.push(value);
   }
   if(!cells.length)fail('odt_invalid');if(columns===undefined)columns=cells.length;if(columns!==cells.length)fail('odt_unsupported');
   rowCount+=repeat;cellCount+=repeat*cells.length;if(rowCount>odtLimits.maxRows||cellCount>odtLimits.maxCells)fail('odt_structure_limit');
   const line=cells.join('\t');if((Buffer.byteLength(line)+1)*repeat>odtLimits.maxTextBytes-textBytes+1)fail('odt_text_limit');for(let n=0;n<repeat;n++)emit(line);
  }};rows(node);if(columns!==undefined&&declaredColumns&&declaredColumns!==columns)fail('odt_unsupported');
 };
 const blocks=(parent:XmlNode,depth=0,inheritedList?:string)=>{for(const node of elementContent(parent)){
  if(node.uri===ns.text&&['p','h'].includes(node.local))emit(paragraph(node));
  else if(is(node,ns.table,'table'))table(node);
  else if(is(node,ns.text,'section')){attrs(node,[key(ns.text,'name'),key(ns.text,'style-name'),key(ns.text,'protected')]);blocks(node,depth,inheritedList);}
  else if(is(node,ns.text,'soft-page-break')){attrs(node,[]);empty(node);}
  else if(is(node,ns.text,'list')){
   attrs(node,[key(ns.text,'style-name')]);const style=attr(node,ns.text,'style-name')??inheritedList,level=style?catalogue.lists.get(style)?.get(depth+1):undefined;let sequence=level?.start??1;
   for(const item of elementContent(node)){
    if(item.uri!==ns.text||!['list-item','list-header'].includes(item.local))fail('odt_unsupported');attrs(item,[key(ns.text,'start-value')]);
    const children=elementContent(item),numbers=children.filter(child=>is(child,ns.text,'number'));if(numbers.length>1)fail('odt_invalid');
    let marker='';
    if(item.local==='list-item'){
     sequence=count(attr(item,ns.text,'start-value'),1_000_000,sequence);
     if(numbers.length){attrs(numbers[0],[]);if(elements(numbers[0]).length)fail('odt_invalid');marker=numbers[0].children.join('');if(marker.length>200||/[\r\n\t]/.test(marker))fail('odt_unsupported');}
     else{if(!level)fail('odt_unsupported');marker=level!.kind==='bullet'?level!.bullet!:level!.prefix+String(sequence)+level!.suffix;}
     sequence++;
    }else if(numbers.length)fail('odt_unsupported');
    let first=true;
    for(const child of children){if(is(child,ns.text,'number'))continue;
     if(child.uri===ns.text&&['p','h'].includes(child.local)){const value=paragraph(child);emit((first&&marker?marker+' ':'')+value);first=false;}
     else if(is(child,ns.text,'list')){if(first)fail('odt_unsupported');blocks({uri:'',local:'',attributes:{},children:[child]},depth+1,style);}
     else fail('odt_unsupported');
    }if(first)fail('odt_invalid');
   }
  }else fail('odt_unsupported');
 }};
 blocks(body[0]);const text=lines.join('\n');if(!/\S/u.test(text))fail('odt_empty');return text;
}

export function inspectOdtPackage(bytes:Buffer):{expandedBytes:number}{const loaded=packageContents(bytes);project(loaded.content,loaded.styles);return {expandedBytes:loaded.expandedBytes};}
export function decodeOdtSource(bytes:Buffer):{mimeType:typeof odtMimeType;pages:[{page:1;text:string}];pageCount:1}{const loaded=packageContents(bytes),text=project(loaded.content,loaded.styles);return {mimeType:odtMimeType,pages:[{page:1,text}],pageCount:1};}
