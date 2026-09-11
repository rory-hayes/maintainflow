import path from 'node:path';
import type {PageText} from '../../shared/types.js';
import {decoderError as badRequest,decoderLimits as config} from './decoder-limits.js';
export function validateZipExpansion(bytes:Buffer){const end=bytes.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));if(end<0||end+22>bytes.length)badRequest('Invalid office archive');let cursor=bytes.readUInt32LE(end+16),total=0;const count=bytes.readUInt16LE(end+10);if(count>2000)badRequest('Office archive contains too many entries');for(let i=0;i<count;i++){if(cursor+46>bytes.length||bytes.readUInt32LE(cursor)!==0x02014b50)badRequest('Invalid office archive');total+=bytes.readUInt32LE(cursor+24);if(total>40*1024*1024)badRequest('Expanded office file exceeds the 40 MB limit');cursor+=46+bytes.readUInt16LE(cursor+28)+bytes.readUInt16LE(cursor+30)+bytes.readUInt16LE(cursor+32);}}
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
if(!bytes.length)badRequest('The file is empty');if(bytes.length>config.maxBytes)badRequest('Files must be 10 MB or smaller',413);const ext=path.extname(filename).toLowerCase();
if(ext==='.pdf'){if(!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))badRequest('The file does not contain a valid PDF');try{const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const loading=getDocument({data:new Uint8Array(bytes),useSystemFonts:true,stopAtErrors:true});const doc=await loading.promise;try{if(doc.numPages>config.maxPages)badRequest(`PDFs must be ${config.maxPages} pages or fewer`,413);const pages:PageText[]=[];for(let p=1;p<=doc.numPages;p++){const page=await doc.getPage(p),content=await page.getTextContent();let prevY:number|undefined;const lines:string[]=[];for(const item of content.items){if(!('str' in item))continue;const y=item.transform[5];if(prevY!==undefined&&Math.abs(y-prevY)>3)lines.push('\n');else if(lines.length&&!lines.at(-1)?.endsWith('\n'))lines.push(' ');lines.push(item.str);if(item.hasEOL)lines.push('\n');prevY=y;}pages.push({page:p,text:lines.join('').replace(/\n\s*\n/g,'\n')});}return {mimeType:'application/pdf',pages,pageCount:doc.numPages};}finally{await loading.destroy();}}catch(e){if((e as any).statusCode)throw e;badRequest('The PDF is malformed, encrypted, or cannot be read');}}
if(['.png','.jpg','.jpeg'].includes(ext)){try{const sharp=(await import('sharp')).default;const meta=await sharp(bytes,{limitInputPixels:40000000}).metadata();if(!['jpeg','png'].includes(meta.format||''))badRequest('Only PNG and JPEG image content is supported');return {mimeType:meta.format==='png'?'image/png':'image/jpeg',pages:[{page:1,text:''}],pageCount:1};}catch(e){if((e as any).statusCode)throw e;badRequest('Invalid image or image exceeds 40 megapixels');}}
if(ext==='.docx'){validateZipExpansion(bytes);try{const mammoth=(await import('mammoth')).default;const result=await mammoth.extractRawText({buffer:bytes});return {mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',pages:[{page:1,text:result.value}],pageCount:1};}catch{badRequest('The DOCX file could not be read');}}
if(ext==='.xlsx'){validateZipExpansion(bytes);try{const ExcelJS=(await import('exceljs')).default;const wb=new ExcelJS.Workbook();await wb.xlsx.load(bytes as any);if(!wb.worksheets.length)badRequest('The XLSX file does not contain a worksheet');if(wb.worksheets.length>config.maxPages)badRequest('Spreadsheets must contain 30 sheets or fewer');const pages=wb.worksheets.map((sheet,i)=>{const rows:string[]=[];if(sheet.rowCount>10000||sheet.columnCount>200)badRequest('Spreadsheet dimensions exceed the supported limit');sheet.eachRow(row=>{const cells=(row.values as any[]).slice(1).map(v=>v&&typeof v==='object'?(v.text??v.result??''):v??'');rows.push(cells.join(' | '));});return {page:i+1,text:rows.join('\n')};});return {mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',pages,pageCount:Math.max(pages.length,1)};}catch(e){if((e as any).statusCode)throw e;badRequest('The XLSX file could not be read');}}
if(!['.txt','.csv','.eml','.html','.htm'].includes(ext))badRequest('Supported formats: PDF, PNG, JPG, TXT, EML, CSV, XLSX, DOCX and HTML');
let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{badRequest('Text files must use UTF-8 encoding');}if(text!.includes('\0'))badRequest('Binary content is not accepted as text');
if(ext==='.eml'){
  const {simpleParser}=await import('mailparser');
  const mail=await simpleParser(bytes,{skipHtmlToText:true,skipTextToHtml:true,maxHtmlLengthToParse:2*1024*1024});
  const body=mail.text||(typeof mail.html==='string'?await htmlSourceText(mail.html):'');
  text=`Subject: ${mail.subject||''}\nFrom: ${mail.from?.text||''}\n${body}`;
}
if(['.html','.htm'].includes(ext))text=await htmlSourceText(text!);
return {mimeType:ext==='.eml'?'message/rfc822':ext==='.csv'?'text/csv':ext.startsWith('.ht')?'text/html':'text/plain',pages:[{page:1,text:text!}],pageCount:1};
}
