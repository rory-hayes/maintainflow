import path from 'node:path';
import type {PageText} from '../../shared/types.js';
import {decoderError as badRequest,decoderLimits as config} from './decoder-limits.js';
type SourceFormat = 'pdf'|'png'|'jpeg'|'docx'|'xlsx'|'txt'|'csv'|'eml'|'html';
const textExtensions:Record<string,SourceFormat>={'.txt':'txt','.csv':'csv','.eml':'eml','.html':'html','.htm':'html'};
const binaryExtensions:Record<string,SourceFormat>={'.pdf':'pdf','.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.docx':'docx','.xlsx':'xlsx'};
const begins=(bytes:Buffer,signature:number[]|string)=>{const prefix=typeof signature==='string'?Buffer.from(signature):Buffer.from(signature);return bytes.subarray(0,prefix.length).equals(prefix);};

/** Read bounded directory metadata without inflating or writing archive entries. */
function officeEntries(bytes:Buffer):Set<string>{
  let end=-1;
  for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65_557);offset--){
    if(bytes.readUInt32LE(offset)===0x06054b50&&offset+22+bytes.readUInt16LE(offset+20)===bytes.length){end=offset;break;}
  }
  if(end<0)badRequest('Invalid office archive');
  const count=bytes.readUInt16LE(end+10),directoryBytes=bytes.readUInt32LE(end+12),directoryOffset=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==count||count===0xffff||directoryOffset===0xffffffff)badRequest('Split and ZIP64 office archives are not supported');
  if(count>2000)badRequest('Office archive contains too many entries');
  if(directoryOffset+directoryBytes!==end)badRequest('Invalid office archive directory');
  let cursor=directoryOffset,total=0;
  const names=new Set<string>();
  for(let index=0;index<count;index++){
    if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)badRequest('Invalid office archive');
    const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),compressed=bytes.readUInt32LE(cursor+20);
    const nameLength=bytes.readUInt16LE(cursor+28),extraLength=bytes.readUInt16LE(cursor+30),commentLength=bytes.readUInt16LE(cursor+32),local=bytes.readUInt32LE(cursor+42);
    const next=cursor+46+nameLength+extraLength+commentLength;
    if(!nameLength||next>end||bytes.readUInt16LE(cursor+34)||flags&1||![0,8].includes(method))badRequest('Unsupported or invalid office archive entry');
    total+=bytes.readUInt32LE(cursor+24);
    if(total>40*1024*1024)badRequest('Expanded office file exceeds the 40 MB limit');
    const rawName=bytes.subarray(cursor+46,cursor+46+nameLength);
    let name:string;
    try{name=new TextDecoder('utf-8',{fatal:true}).decode(rawName);}catch{badRequest('Office archive entry names must use UTF-8');}
    if(name!.includes('\\')||name!.includes('\0')||name!.startsWith('/')||/^[A-Za-z]:/.test(name!)||name!.split('/').some(part=>part==='.'||part==='..')||names.has(name!))badRequest('Invalid or duplicate office archive entry');
    if(local+30>directoryOffset||bytes.readUInt32LE(local)!==0x04034b50)badRequest('Invalid office archive local entry');
    const localNameLength=bytes.readUInt16LE(local+26),localExtraLength=bytes.readUInt16LE(local+28);
    const dataOffset=local+30+localNameLength+localExtraLength;
    if(localNameLength!==nameLength||dataOffset+compressed>directoryOffset||bytes.readUInt16LE(local+6)!==flags||bytes.readUInt16LE(local+8)!==method||!bytes.subarray(local+30,local+30+localNameLength).equals(rawName))badRequest('Office archive entry metadata does not match');
    names.add(name!);cursor=next;
  }
  if(cursor!==end)badRequest('Invalid office archive directory size');
  return names;
}
export function validateZipExpansion(bytes:Buffer){officeEntries(bytes);}
function officeFormat(bytes:Buffer):SourceFormat{
  const names=officeEntries(bytes);
  const word=names.has('word/document.xml'),sheet=names.has('xl/workbook.xml');
  if(!names.has('[Content_Types].xml')||!names.has('_rels/.rels')||word===sheet)badRequest('The archive is not a supported unambiguous DOCX or XLSX document');
  return word?'docx':'xlsx';
}
function binaryFormat(bytes:Buffer):SourceFormat|undefined{
  // A recognizable header cannot be downgraded to text by its filename.
  if(begins(bytes,'%PDF-'))return 'pdf';
  if(begins(bytes,[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))return 'png';
  if(begins(bytes,[0xff,0xd8,0xff]))return 'jpeg';
  if([[0x50,0x4b,3,4],[0x50,0x4b,5,6],[0x50,0x4b,7,8]].some(signature=>begins(bytes,signature)))return officeFormat(bytes);
  const unsupported=(['GIF87a','GIF89a','OggS','fLaC','ID3','%!PS-Adobe','SQLite format 3'].some(signature=>begins(bytes,signature)))||
    [[0x1f,0x8b],[0x37,0x7a,0xbc,0xaf,0x27,0x1c],[0x52,0x61,0x72,0x21,0x1a,0x07],[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1],[0x7f,0x45,0x4c,0x46],[0,0x61,0x73,0x6d],[0x49,0x49,0x2a,0],[0x4d,0x4d,0,0x2a],[0x49,0x49,0x2b,0],[0x4d,0x4d,0,0x2b],[0xfe,0xed,0xfa,0xce],[0xce,0xfa,0xed,0xfe],[0xfe,0xed,0xfa,0xcf],[0xcf,0xfa,0xed,0xfe],[0xca,0xfe,0xba,0xbe]].some(signature=>begins(bytes,signature))||
    begins(bytes,'RIFF')||bytes.subarray(4,8).equals(Buffer.from('ftyp'));
  if(unsupported)badRequest('This binary file type is not supported, regardless of its filename');
}
function strongTextFormat(text:string):'html'|'eml'|undefined{
  // Full HTML documents are recognizable; isolated fragments can also be ordinary text.
  let prefix=text.trimStart(),declarationSeen=false;
  // Each iteration consumes a complete preamble item within the input bound.
  // Comments may surround the optional XML declaration in an HTML document.
  while(prefix.length){
    if(prefix.startsWith('<!--')){const end=prefix.indexOf('-->');if(end<0)break;prefix=prefix.slice(end+3).trimStart();continue;}
    if(!declarationSeen&&/^<\?xml\b/i.test(prefix)){const end=prefix.indexOf('?>');if(end<0)break;declarationSeen=true;prefix=prefix.slice(end+2).trimStart();continue;}
    break;
  }
  if(/^<!doctype\s+html(?:\s|>)/i.test(prefix)||/^<html(?:\s|>)/i.test(prefix))return 'html';
  const separator=text.search(/\r?\n\r?\n/);
  if(separator<0)return;
  // Scan linearly within the existing 10 MiB input bound, retaining only header
  // recognition flags. From/Date labels alone are also ordinary document text,
  // so only explicit MIME markers may override a non-EML filename.
  let current:string|undefined,cursor=0,contentType=false,mime=false;
  while(cursor<separator){
    const newline=text.indexOf('\n',cursor),end=newline<0||newline>separator?separator:newline;
    const line=text.slice(cursor,end).replace(/\r$/,'');cursor=end+1;
    let value:string;
    if(/^[ \t]/.test(line)&&current)value=line.trim();
    else{
      const match=line.match(/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/);
      if(!match)return;
      current=match[1].toLowerCase();value=match[2];
    }
    if(current==='content-type'&&value.trim())contentType=true;
    if(current==='mime-version'&&/^1\.0(?:\s|$)/.test(value))mime=true;
  }
  if(mime&&contentType){if(separator>65_536)badRequest('Email headers exceed the supported 64 KB limit');return 'eml';}
}
function classifySource(bytes:Buffer,filename:string):{format:SourceFormat;text?:string}{
  const binary=binaryFormat(bytes);
  if(binary)return {format:binary};
  const ext=path.extname(filename).toLowerCase();
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{badRequest('Text files must use UTF-8 encoding or a supported binary format');}
  if(/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text!))badRequest('Binary control content is not accepted as text');
  // A PDF header preceded only by whitespace/BOM remains recognizable and must
  // never fall through to a text policy. The PDF decoder below validates it.
  if(/^\s*%PDF-/.test(text!))return {format:'pdf'};
  const recognized=strongTextFormat(text!);
  const format=recognized||textExtensions[ext]||binaryExtensions[ext];
  if(!format)badRequest('Supported formats: PDF, PNG, JPG, TXT, EML, CSV, XLSX, DOCX and HTML');
  return {format,text:text!};
}
async function htmlSourceText(html:string):Promise<string>{
  // The converter is already used by mailparser. Extraction disables presentation
  // wrapping, heading case conversion and added link/image URLs.
  const {createRequire}=await import('node:module');
  const {convert}=createRequire(import.meta.url)('html-to-text');
  return convert(html,{
    wordwrap:false,
    selectors:[
      ...['h1','h2','h3','h4','h5','h6'].map(selector=>({selector,options:{uppercase:false}})),
      {selector:'a',options:{ignoreHref:true}},
      {selector:'img',format:'skip'},
      {selector:'script',format:'skip'},
      {selector:'style',format:'skip'},
      {selector:'table',format:'extractionTable'},
    ],
    formatters:{
      extractionTable(element:any,walk:any,builder:any){
        builder.openTable();
        const rows=(nodes:any[])=>{for(const node of nodes){
          if(node.type!=='tag')continue;
          if(['thead','tbody','tfoot'].includes(node.name)){rows(node.children);continue;}
          if(node.name!=='tr')continue;
          builder.openTableRow();
          for(const cell of node.children){
            if(cell.type!=='tag'||!['td','th'].includes(cell.name))continue;
            builder.openTableCell();walk(cell.children,builder);builder.closeTableCell();
          }
          builder.closeTableRow();
        }};
        rows(element.children);
        builder.closeTable({
          tableToString:(rows:{text:string}[][])=>rows.map(row=>row.map(cell=>cell.text.replace(/\s*\n\s*/g,' ')).join(' | ')).join('\n'),
          leadingLineBreaks:2,trailingLineBreaks:2,
        });
      },
    },
  });
}
export async function decodeSource(bytes:Buffer,filename:string):Promise<{mimeType:string;pages:PageText[];pageCount:number}>{
if(!bytes.length)badRequest('The file is empty');if(bytes.length>config.maxBytes)badRequest('Files must be 10 MB or smaller',413);const classified=classifySource(bytes,filename),format=classified.format;
if(format==='pdf'){if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))badRequest('The file does not contain a valid PDF');try{const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const loading=getDocument({data:new Uint8Array(bytes),useSystemFonts:true,stopAtErrors:true});const doc=await loading.promise;try{if(doc.numPages>config.maxPages)badRequest(`PDFs must be ${config.maxPages} pages or fewer`,413);const pages:PageText[]=[];for(let p=1;p<=doc.numPages;p++){const page=await doc.getPage(p),content=await page.getTextContent();let prevY:number|undefined;const lines:string[]=[];for(const item of content.items){if(!('str' in item))continue;const y=item.transform[5];if(prevY!==undefined&&Math.abs(y-prevY)>3)lines.push('\n');else if(lines.length&&!lines.at(-1)?.endsWith('\n'))lines.push(' ');lines.push(item.str);if(item.hasEOL)lines.push('\n');prevY=y;}pages.push({page:p,text:lines.join('').replace(/\n\s*\n/g,'\n')});}return {mimeType:'application/pdf',pages,pageCount:doc.numPages};}finally{await loading.destroy();}}catch(e){if((e as any).statusCode)throw e;badRequest('The PDF is malformed, encrypted, or cannot be read');}}
if(['png','jpeg'].includes(format)){try{const sharp=(await import('sharp')).default;const meta=await sharp(bytes,{limitInputPixels:40000000}).metadata();if(!['jpeg','png'].includes(meta.format||''))badRequest('Only PNG and JPEG image content is supported');return {mimeType:meta.format==='png'?'image/png':'image/jpeg',pages:[{page:1,text:''}],pageCount:1};}catch(e){if((e as any).statusCode)throw e;badRequest('Invalid image or image exceeds 40 megapixels');}}
if(format==='docx'){validateZipExpansion(bytes);try{const mammoth=(await import('mammoth')).default;const result=await mammoth.extractRawText({buffer:bytes});return {mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pages:[{page:1,text:result.value}],pageCount:1};}catch{badRequest('The DOCX file could not be read');}}
if(format==='xlsx'){validateZipExpansion(bytes);try{const ExcelJS=(await import('exceljs')).default;const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes as any);if(!wb.worksheets.length)badRequest('The XLSX file does not contain a worksheet');if(wb.worksheets.length>config.maxPages)badRequest('Spreadsheets must contain 30 sheets or fewer');const pages=wb.worksheets.map((sheet,i)=>{const rows:string[]=[];if(sheet.rowCount>10000||sheet.columnCount>200)badRequest('Spreadsheet dimensions exceed the supported limit');sheet.eachRow(row=>{const cells=(row.values as any[]).slice(1).map(v=>v&&typeof v==='object'?(v.text??v.result??''):v??'');rows.push(cells.join(' | '));});return {page:i+1,text:rows.join('\n')};});return {mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pages,pageCount:Math.max(pages.length,1)};}catch(e){if((e as any).statusCode)throw e;badRequest('The XLSX file could not be read');}}
let text=classified.text!;
if(format==='eml'){
  const {simpleParser}=await import('mailparser');
  const mail=await simpleParser(bytes,{skipHtmlToText:true,skipTextToHtml:true,maxHtmlLengthToParse:2*1024*1024});
  const body=mail.text||(typeof mail.html==='string'?await htmlSourceText(mail.html):'');
  text=`Subject: ${mail.subject||''}\nFrom: ${mail.from?.text||''}\n${body}`;
}
if(format==='html')text=await htmlSourceText(text!);
return {mimeType:format==='eml'?'message/rfc822':format==='csv'?'text/csv':format==='html'?'text/html':'text/plain',pages:[{page:1,text:text!}],pageCount:1};
}
