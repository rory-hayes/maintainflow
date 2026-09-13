/** No environment, filesystem, database or provider imports in the decoder dependency tree. */
export const decoderLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 30,
  maxOutputBytes: 4 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  heapMb: 192,
  // Source execution includes the trusted TSX compiler/loader. The packaged
  // JavaScript decoder retains the smaller production heap boundary above.
  sourceHeapMb: 256,
  timeoutMs: 30_000,
  concurrency: 2,
});
export function decoderError(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}
