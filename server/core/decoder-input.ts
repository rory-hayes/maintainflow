import {canonicalPdfSplitSpec,pdfSplitLimits,type PdfSplitSpec} from '../../shared/pdf-split.js';
import {decoderLimits} from './decoder-limits.js';
import {canonicalArchiveImportSpec, archiveImportLimits, type ArchiveImportSpec} from '../../shared/archive-import.js';

// The specification may contain customer text. Send it over the existing private
// stdin pipe, never argv. A four-byte unsigned size bounds the UTF-8 JSON prefix.
export const maxSplitInputBytes=4+pdfSplitLimits.maxSpecBytes+decoderLimits.maxBytes;
export function encodeSplitInput(bytes:Buffer,spec:PdfSplitSpec):Buffer{
 const json=Buffer.from(canonicalPdfSplitSpec(spec));
 if(json.length>pdfSplitLimits.maxSpecBytes||bytes.length>decoderLimits.maxBytes)throw new Error('Invalid decoder input envelope');
 const size=Buffer.alloc(4);size.writeUInt32BE(json.length);
 return Buffer.concat([size,json,bytes]);
}
export function decodeSplitInput(input:Buffer):{bytes:Buffer;spec:PdfSplitSpec}{
 // Malformed IPC is operational, not a durable rejection of a customer's PDF.
 const invalid=()=>{throw new Error('Invalid decoder input envelope');};
 if(input.length<4||input.length>maxSplitInputBytes)return invalid();
 const size=input.readUInt32BE(0);
 if(size<1||size>pdfSplitLimits.maxSpecBytes||input.length<=4+size||input.length-4-size>decoderLimits.maxBytes)return invalid();
 try{
  const json=new TextDecoder('utf-8',{fatal:true}).decode(input.subarray(4,4+size));
  const canonical=canonicalPdfSplitSpec(JSON.parse(json));
  if(canonical!==json)return invalid();
  return {bytes:input.subarray(4+size),spec:JSON.parse(canonical)};
 }catch{return invalid();}
}

export const maxArchiveInputBytes=4+archiveImportLimits.maxSpecBytes+decoderLimits.maxBytes;
export function encodeArchiveInput(bytes:Buffer,spec?:ArchiveImportSpec):Buffer{
 const json=Buffer.from(spec?canonicalArchiveImportSpec(spec):'null');
 if(json.length>archiveImportLimits.maxSpecBytes||bytes.length>decoderLimits.maxBytes)throw new Error('Invalid decoder input envelope');
 const size=Buffer.alloc(4);size.writeUInt32BE(json.length);
 return Buffer.concat([size,json,bytes]);
}
export function decodeArchiveInput(input:Buffer):{bytes:Buffer;spec?:ArchiveImportSpec}{
 const invalid=():never=>{throw new Error('Invalid decoder input envelope');};
 if(input.length<4||input.length>maxArchiveInputBytes)return invalid();
 const size=input.readUInt32BE(0);
 if(size<1||size>archiveImportLimits.maxSpecBytes||input.length<=4+size||input.length-4-size>decoderLimits.maxBytes)return invalid();
 try{
  const json=new TextDecoder('utf-8',{fatal:true}).decode(input.subarray(4,4+size));
  const canonical=json==='null'?'null':canonicalArchiveImportSpec(JSON.parse(json));
  if(canonical!==json)return invalid();
  return {bytes:input.subarray(4+size),...(json==='null'?{}:{spec:JSON.parse(canonical)})};
 }catch{return invalid();}
}
