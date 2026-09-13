import { decodeSource } from './decoder-engine.js';
import { decoderLimits } from './decoder-limits.js';
import { SourceValidationError, isSourceValidationReason } from './source-validation.js';
import { canonicalPdfSplitSpec, pdfSplitLimits, PdfSplitValidationError, isPdfSplitValidationReason } from '../../shared/pdf-split.js';

// stdout contains one bounded JSON response. Decoder-library diagnostics cannot mix with it.
console.log = () => {};
console.warn = () => {};
console.error = () => {};

const chunks: Buffer[] = [];
let size = 0;
try {
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > decoderLimits.maxBytes) throw new SourceValidationError('file_too_large');
    chunks.push(bytes);
  }
  const splitting = process.argv[3] === '--pdf-split';
  let json: string;
  if (splitting) {
    const spec = JSON.parse(canonicalPdfSplitSpec(JSON.parse(process.argv[4] || 'null')));
    const { decodePdfSplit } = await import('./pdf-split-engine.js');
    json = JSON.stringify({ ok: true, split: await decodePdfSplit(Buffer.concat(chunks), process.argv[2] || 'document.pdf', spec) });
  } else {
    const source = await decodeSource(Buffer.concat(chunks), process.argv[2] || 'document');
    if (source.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0) > decoderLimits.maxTextBytes) {
      throw Object.assign(new Error('Decoded document text exceeds the 2 MB limit'), { statusCode: 413 });
    }
    json = JSON.stringify({ ok: true, source });
  }
  if (Buffer.byteLength(json) > (splitting ? pdfSplitLimits.maxOutputBytes : decoderLimits.maxOutputBytes)) throw Object.assign(new Error('Decoded source response exceeds the limit'), { statusCode: 413 });
  process.stdout.write(json);
} catch (error) {
  // Neither arbitrary statuses nor dependency diagnostics can authorize a
  // durable rejection. The parent reconstructs fixed messages from this code.
  const result = error instanceof SourceValidationError && isSourceValidationReason(error.reason)
    ? { ok: false, code: 'source_validation_failed', reason: error.reason }
    : error instanceof PdfSplitValidationError && isPdfSplitValidationReason(error.reason)
      ? { ok: false, code: 'pdf_split_validation_failed', reason: error.reason }
      : { ok: false, code: 'decoder_failed' };
  process.stdout.write(JSON.stringify(result));
}
