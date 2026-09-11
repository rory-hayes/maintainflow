import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { decoderLimits, decoderError } from './decoder-limits.js';
import type { PageText } from '../../shared/types.js';
export { validateZipExpansion } from './decoder-engine.js';

const sourceSchema = z.object({
  mimeType: z.string().max(150),
  pages: z.array(z.object({ page: z.number().int().min(1).max(decoderLimits.maxPages), text: z.string() })).max(decoderLimits.maxPages),
  pageCount: z.number().int().min(1).max(decoderLimits.maxPages),
});
const childFilename = fileURLToPath(new URL('./decoder-child.ts', import.meta.url));
const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url));
let activeDecoders = 0;

/** This subprocess is a resource boundary, not an OS-level security sandbox. */
export function decoderLaunchSpec(filename: string) {
  return {
    command: process.execPath,
    args: [`--max-old-space-size=${decoderLimits.heapMb}`, '--import', 'tsx', childFilename, path.basename(filename)],
    options: {
      cwd: runtimeRoot,
      env: { NODE_ENV: 'production', TZ: 'UTC', LANG: 'en_US.UTF-8', TSX_DISABLE_CACHE: '1' },
      stdio: 'pipe' as const,
    },
  };
}

type DecoderSpawn = (command: string, args: string[], options: ReturnType<typeof decoderLaunchSpec>['options']) => ChildProcessWithoutNullStreams;
/** Dependency injection is internal-only and used for controlled timeout/output regression tests. */
export async function runDecoder(
  bytes: Buffer,
  filename: string,
  options: { spawnChild?: DecoderSpawn; timeoutMs?: number } = {},
): Promise<{ mimeType: string; pages: PageText[]; pageCount: number }> {
  if (!bytes.length) decoderError('The file is empty');
  if (bytes.length > decoderLimits.maxBytes) decoderError('Files must be 10 MB or smaller', 413);
  if (activeDecoders >= decoderLimits.concurrency) decoderError('Document decoding is busy. Retry shortly.', 429);
  activeDecoders++;
  try {
    return await new Promise((resolve, reject) => {
      const spec = decoderLaunchSpec(filename);
      let child: ChildProcessWithoutNullStreams;
      try { child = (options.spawnChild || spawn)(spec.command, spec.args, spec.options); }
      catch { reject(Object.assign(new Error('The isolated document decoder could not start'), { statusCode: 503 })); return; }
      const chunks: Buffer[] = [];
      let outputBytes = 0, settled = false;
      let pendingFailure: Error | undefined;
      const finish = (error?: Error, value?: z.infer<typeof sourceSchema>) => {
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
        outputBytes += chunk.length;
        if (outputBytes > decoderLimits.maxOutputBytes) {
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
          if (!result.ok) { finish(Object.assign(new Error(String(result.error).slice(0,300)), { statusCode: [400,413,422].includes(result.statusCode) ? result.statusCode : 400 })); return; }
          const source = sourceSchema.parse(result.source);
          if (source.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0) > decoderLimits.maxTextBytes) throw new Error('Decoder text limit exceeded');
          finish(undefined, source);
        } catch { finish(Object.assign(new Error('The document decoder returned an invalid response'), { statusCode: 422 })); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(bytes);
    });
  } finally { activeDecoders--; }
}

export const inspectSource = (bytes: Buffer, filename: string) => runDecoder(bytes, filename);
