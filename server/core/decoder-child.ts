import { decodeSource } from './decoder-engine.js';
import {tiffLimits} from '../../shared/tiff.js';
import { decoderLimits } from './decoder-limits.js';
import { SourceValidationError, isSourceValidationReason } from './source-validation.js';
import { pdfSplitLimits, PdfSplitValidationError, isPdfSplitValidationReason } from '../../shared/pdf-split.js';
import {decodeSplitInput,maxSplitInputBytes,decodeArchiveInput,maxArchiveInputBytes} from './decoder-input.js';
import {archiveImportLimits,ArchiveImportValidationError,isArchiveImportValidationReason} from '../../shared/archive-import.js';

// stdout contains one bounded JSON response. Decoder-library diagnostics cannot mix with it.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const chunks: Buffer[] = [];
let size = 0;
const splitting = process.argv[3] === '--pdf-split';
const archiving = process.argv[3] === '--zip-import';
const tiff=process.argv[3]==='--tiff-page'||process.argv[3]==='--tiff-pdf';
try {
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (splitting && size > maxSplitInputBytes) throw new Error('Invalid decoder input envelope');
    if (archiving && size > maxArchiveInputBytes) throw new Error('Invalid decoder input envelope');
    if (!splitting && !archiving && size > decoderLimits.maxBytes) throw new SourceValidationError('file_too_large');
    chunks.push(bytes);
  }
  let json: string;
  if (splitting) {
    const {bytes,spec} = decodeSplitInput(Buffer.concat(chunks));
    const { decodePdfSplit } = await import('./pdf-split-engine.js');
    json = JSON.stringify({ ok: true, split: await decodePdfSplit(bytes, process.argv[2] || 'document.pdf', spec) });
  } else if (archiving) {
    const {bytes,spec} = decodeArchiveInput(Buffer.concat(chunks));
    const {decodeArchive} = await import('./archive-engine.js');
    json = JSON.stringify({ok:true,archive:await decodeArchive(bytes,process.argv[2] || 'archive.zip',spec)});
  } else if(tiff){
    const {decodeTiffPage,decodeTiffForAI}=await import('./tiff-engine.js');
    const rendered=process.argv[3]==='--tiff-page'?await decodeTiffPage(Buffer.concat(chunks),Number(process.argv[4])):await decodeTiffForAI(Buffer.concat(chunks));
    const {bytes,...metadata}=rendered;json=JSON.stringify({ok:true,tiff:{...metadata,data:bytes.toString('base64')}});
  } else {
    const source = await decodeSource(Buffer.concat(chunks), process.argv[2] || 'document');
    if (source.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0) > decoderLimits.maxTextBytes) {
      throw Object.assign(new Error('Decoded document text exceeds the 2 MB limit'), { statusCode: 413 });
    }
    json = JSON.stringify({ ok: true, source });
  }
  if (Buffer.byteLength(json) > (splitting ? pdfSplitLimits.maxOutputBytes : archiving ? archiveImportLimits.maxOutputBytes : tiff&&process.argv[3]==='--tiff-pdf'?tiffLimits.maxOutputBytes:decoderLimits.maxOutputBytes)) throw Object.assign(new Error('Decoded source response exceeds the limit'), { statusCode: 413 });
  process.stdout.write(json);
} catch (error) {
  // Neither arbitrary statuses nor dependency diagnostics can authorize a
  // durable rejection. The parent reconstructs fixed messages from this code.
  const result = error instanceof SourceValidationError && isSourceValidationReason(error.reason)
    ? { ok: false, code: 'source_validation_failed', reason: error.reason }
    : error instanceof PdfSplitValidationError && isPdfSplitValidationReason(error.reason)
      ? { ok: false, code: 'pdf_split_validation_failed', reason: error.reason }
      : error instanceof ArchiveImportValidationError && isArchiveImportValidationReason(error.reason)
        ? {ok:false,code:'archive_import_validation_failed',reason:error.reason}
        : { ok: false, code: 'decoder_failed' };
  process.stdout.write(JSON.stringify(result));
}
