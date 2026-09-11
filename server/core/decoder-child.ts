import { decodeSource } from './decoder-engine.js';
import { decoderLimits } from './decoder-limits.js';

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
    if (size > decoderLimits.maxBytes) throw Object.assign(new Error('Files must be 10 MB or smaller'), { statusCode: 413 });
    chunks.push(bytes);
  }
  const source = await decodeSource(Buffer.concat(chunks), process.argv[2] || 'document');
  if (source.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0) > decoderLimits.maxTextBytes) {
    throw Object.assign(new Error('Decoded document text exceeds the 2 MB limit'), { statusCode: 413 });
  }
  const json = JSON.stringify({ ok: true, source });
  if (Buffer.byteLength(json) > decoderLimits.maxOutputBytes) throw Object.assign(new Error('Decoded source response exceeds the limit'), { statusCode: 413 });
  process.stdout.write(json);
} catch (error) {
  const statusCode = (error as { statusCode?: number }).statusCode;
  // Unexpected dependency details are not returned across the process boundary.
  process.stdout.write(JSON.stringify({ ok: false, error: statusCode ? (error as Error).message : 'The document could not be decoded', statusCode: statusCode || 400 }));
}
