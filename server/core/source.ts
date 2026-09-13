import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { decoderLimits, decoderError } from './decoder-limits.js';
import { SourceValidationError, isSourceValidationReason, type SourceValidationReason } from './source-validation.js';
import type { PageText } from '../../shared/types.js';
import { canonicalPdfSplitSpec, planPdfSplit, pdfSplitLimits, PdfSplitValidationError, isPdfSplitValidationReason, type PdfSplitValidationReason, type PdfSplitSpec, type PdfPageRange } from '../../shared/pdf-split.js';
export { validateZipExpansion } from './decoder-engine.js';

const sourceSchema = z.object({
  mimeType: z.string().max(150),
  pages: z.array(z.object({ page: z.number().int().min(1).max(decoderLimits.maxPages), text: z.string() })).max(decoderLimits.maxPages),
  pageCount: z.number().int().min(1).max(decoderLimits.maxPages),
});
const failureSchema = z.union([
  z.object({ ok: z.literal(false), code: z.literal('source_validation_failed'), reason: z.custom<SourceValidationReason>(isSourceValidationReason) }).strict(),
  z.object({ ok: z.literal(false), code: z.literal('pdf_split_validation_failed'), reason: z.custom<PdfSplitValidationReason>(isPdfSplitValidationReason) }).strict(),
  z.object({ ok: z.literal(false), code: z.literal('decoder_failed') }).strict(),
]);
const responseSchema = z.union([z.object({ ok: z.literal(true), source: sourceSchema }).strict(), failureSchema]);
const splitResponseSchema = z.union([
  z.object({ ok: z.literal(true), split: z.object({
    sourcePageCount: z.number().int().min(1).max(pdfSplitLimits.maxPages),
    selectedPages: z.number().int().min(1).max(pdfSplitLimits.maxPages),
    parts: z.array(z.object({
      range: z.object({ start: z.number().int(), end: z.number().int() }).strict(),
      data: z.string().min(1).max(4 * Math.ceil(pdfSplitLimits.maxBytes / 3)),
      source: sourceSchema.extend({ mimeType: z.literal('application/pdf') }).strict(),
    }).strict()).min(1).max(pdfSplitLimits.maxDocuments),
  }).strict() }).strict(), failureSchema,
]);
const compiledChild = fileURLToPath(new URL('./decoder-child.js', import.meta.url));
const childFilename = existsSync(compiledChild) ? compiledChild : fileURLToPath(new URL('./decoder-child.ts', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
let activeDecoders = 0;

/** This subprocess is a resource boundary, not an OS-level security sandbox. */
export function decoderLaunchSpec(filename: string, split?: PdfSplitSpec) {
  return {
    command: process.execPath,
    args: [`--max-old-space-size=${decoderLimits.heapMb}`, ...(childFilename.endsWith('.ts') ? ['--import', 'tsx'] : []), childFilename, path.basename(filename), ...(split ? ['--pdf-split', canonicalPdfSplitSpec(split)] : [])],
    options: {
      cwd: runtimeRoot,
      env: { NODE_ENV: 'production', TZ: 'UTC', LANG: 'en_US.UTF-8', TSX_DISABLE_CACHE: '1' },
      stdio: 'pipe' as const,
    },
  };
}

type DecoderSpawn = (command: string, args: string[], options: ReturnType<typeof decoderLaunchSpec>['options']) => ChildProcessWithoutNullStreams;
type DecoderOptions = { spawnChild?: DecoderSpawn; timeoutMs?: number };
async function runIsolated<T>(
  bytes: Buffer,
  filename: string,
  decodeResponse: (value: unknown) => T,
  options: DecoderOptions,
  split?: PdfSplitSpec,
): Promise<T> {
  if (!bytes.length) throw new SourceValidationError('empty');
  if (bytes.length > decoderLimits.maxBytes) throw new SourceValidationError('file_too_large');
  if (activeDecoders >= decoderLimits.concurrency) decoderError('Document decoding is busy. Retry shortly.', 429);
  activeDecoders++;
  try {
    return await new Promise((resolve, reject) => {
      const spec = decoderLaunchSpec(filename, split);
      let child: ChildProcessWithoutNullStreams;
      try { child = (options.spawnChild || spawn)(spec.command, spec.args, spec.options); }
      catch { reject(Object.assign(new Error('The isolated document decoder could not start'), { statusCode: 503 })); return; }
      const chunks: Buffer[] = [];
      let outputBytes = 0, settled = false;
      let pendingFailure: Error | undefined;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value!);
      };
      const fail = (error: Error) => {
        if (settled || pendingFailure) return;
        pendingFailure = error;
        clearTimeout(timer);
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => fail(Object.assign(new Error('Document decoding exceeded the 30-second time limit'), { statusCode: 422 })), options.timeoutMs || decoderLimits.timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled || pendingFailure) return;
        outputBytes += chunk.length;
        if (outputBytes > (split ? pdfSplitLimits.maxOutputBytes : decoderLimits.maxOutputBytes)) {
          fail(Object.assign(new Error('Decoded source response exceeds the output limit'), { statusCode: 413 }));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.on('error', () => fail(Object.assign(new Error('The isolated document decoder could not start'), { statusCode: 503 })));
      child.on('close', code => {
        if (settled) return;
        if (pendingFailure) { finish(pendingFailure); return; }
        if (code !== 0) { finish(Object.assign(new Error('The document decoder stopped within its resource limits'), { statusCode: 422 })); return; }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (result?.ok === false) {
            const failure = failureSchema.parse(result);
            if (failure.code === 'source_validation_failed') { finish(new SourceValidationError(failure.reason)); return; }
            if (split && failure.code === 'pdf_split_validation_failed') { finish(new PdfSplitValidationError(failure.reason)); return; }
            if (failure.code !== 'decoder_failed') throw new Error('Unexpected decoder failure');
            finish(Object.assign(new Error('The document could not be decoded. Retry shortly.'), { statusCode: 503 }));
            return;
          }
          finish(undefined, decodeResponse(result));
        } catch { finish(Object.assign(new Error('The document decoder returned an invalid response'), { statusCode: 422 })); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(bytes);
    });
  } finally { activeDecoders--; }
}

/** Dependency injection is internal-only for resource-boundary regression tests. */
export function runDecoder(bytes: Buffer, filename: string, options: DecoderOptions = {}): Promise<{ mimeType: string; pages: PageText[]; pageCount: number }> {
  return runIsolated(bytes, filename, value => {
    const result = responseSchema.parse(value);
    if (!result.ok) throw new Error('Expected decoder source');
    if (result.source.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0) > decoderLimits.maxTextBytes) throw new Error('Decoder text limit exceeded');
    return result.source;
  }, options);
}

export interface SplitPdfSource {
  sourcePageCount: number;
  selectedPages: number;
  parts: Array<{ range: PdfPageRange; bytes: Buffer; source: { mimeType: 'application/pdf'; pageCount: number; pages: PageText[] } }>;
}

export function splitPdfSource(bytes: Buffer, filename: string, value: PdfSplitSpec, options: DecoderOptions = {}): Promise<SplitPdfSource> {
  // Validate/copy before spawning; caller mutation cannot change IPC interpretation.
  const spec: PdfSplitSpec = JSON.parse(canonicalPdfSplitSpec(value));
  return runIsolated(bytes, filename, output => {
    const response = splitResponseSchema.parse(output);
    if (!response.ok) throw new Error('Expected PDF split');
    const result = response.split, plan = planPdfSplit(spec, result.sourcePageCount);
    if (result.selectedPages !== plan.selectedPages || result.parts.length !== plan.ranges.length) throw new Error('Split plan mismatch');
    let totalBytes = 0, totalText = 0;
    const parts = result.parts.map((part, index) => {
      const range = plan.ranges[index], count = range.end - range.start + 1;
      if (part.range.start !== range.start || part.range.end !== range.end || part.source.pageCount !== count || part.source.pages.length !== count) throw new Error('Split range mismatch');
      const childBytes = Buffer.from(part.data, 'base64');
      if (!childBytes.length || childBytes.length > pdfSplitLimits.maxBytes || childBytes.toString('base64') !== part.data || !childBytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Split bytes invalid');
      totalBytes += childBytes.length;
      for (const [i, page] of part.source.pages.entries()) {
        if (page.page !== i + 1) throw new Error('Split page numbering mismatch');
        totalText += Buffer.byteLength(page.text);
      }
      return { range, bytes: childBytes, source: part.source };
    });
    if (totalBytes > pdfSplitLimits.maxDerivedBytes || totalText > decoderLimits.maxTextBytes) throw new Error('Split response limit exceeded');
    return { sourcePageCount: result.sourcePageCount, selectedPages: result.selectedPages, parts };
  }, options, spec);
}

export const inspectSource = (bytes: Buffer, filename: string) => runDecoder(bytes, filename);
