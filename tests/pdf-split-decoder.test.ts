import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomFillSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PDFDocument, degrees, StandardFonts } from 'pdf-lib';
import { canonicalPdfSplitSpec, parsePdfRanges, planPdfSplit, pdfSplitLimits, PdfSplitValidationError } from '../shared/pdf-split.js';
import { decoderLaunchSpec, inspectSource, runDecoder, splitPdfSource } from '../server/core/source.js';
import { decoderLimits } from '../server/core/decoder-limits.js';
import { SourceValidationError } from '../server/core/source-validation.js';

async function bundle(count = 5, identical = false) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < count; index++) {
    if (identical && index > 0) {
      // Copy one actual page dictionary/content, rather than drawing equivalent
      // text with a new resource name (which would not be byte-identical).
      pdf.addPage((await pdf.copyPages(pdf, [0]))[0]);
      continue;
    }
    const page = pdf.addPage(identical ? [500, 700] : [500 + index * 10, 700 + index * 10]);
    page.drawText(identical ? 'Repeated invoice 123' : `Original page ${index + 1}: INV-${index + 1}`, { x: 40, y: 550, font, size: 18 });
    if (!identical && index === 2) { page.setRotation(degrees(90)); page.setCropBox(20, 30, 460, 620); }
  }
  return Buffer.from(await pdf.save());
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const splitFailure = (reason: string) => (error: unknown) => error instanceof PdfSplitValidationError && error.reason === reason;

test('split planning preserves remainder, selected omissions and single-output selections', () => {
  assert.deepEqual(planPdfSplit({ mode: 'every', pagesPerDocument: 2 }, 5), {
    ranges: [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 5 }], selectedPages: 5,
  });
  assert.deepEqual(planPdfSplit({ mode: 'ranges', ranges: [{ start: 2, end: 3 }, { start: 5, end: 5 }] }, 6), {
    ranges: [{ start: 2, end: 3 }, { start: 5, end: 5 }], selectedPages: 3,
  });
  assert.deepEqual(planPdfSplit({ mode: 'ranges', ranges: [{ start: 4, end: 4 }] }, 6).selectedPages, 1);
  assert.deepEqual(planPdfSplit({ mode: 'every', pagesPerDocument: 30 }, 2).ranges, [{ start: 1, end: 2 }]);
});

test('range input refuses overlaps, reorderings, empty entries, reversed ranges and invalid bounds', () => {
  assert.deepEqual(parsePdfRanges(' 1-2, 5, 7–9 '), [{ start: 1, end: 2 }, { start: 5, end: 5 }, { start: 7, end: 9 }]);
  for (const text of ['', '1,', ',1', '1,,2', '2-1', '1-3,3-4', '5,1', '1,1', 'one', '1.5', '1e1', '1/2', '-1']) {
    assert.throws(() => parsePdfRanges(text), PdfSplitValidationError, text);
  }
  assert.throws(() => planPdfSplit({ mode: 'ranges', ranges: [{ start: 2, end: 4 }] }, 3), splitFailure('page_bounds'));
  assert.throws(() => planPdfSplit({ mode: 'every', pagesPerDocument: 1 }, 30), splitFailure('document_limit'));
  for (const spec of [{ mode: 'every', pagesPerDocument: 0 }, { mode: 'every', pagesPerDocument: 1.5 },
    { mode: 'every', pagesPerDocument: 2, silentlyReverse: true }, { mode: 'ranges', ranges: [] },
    { mode: 'ranges', ranges: [{ start: 0, end: 1 }] }, { mode: 'ranges', ranges: [{ start: 1, end: 31 }] }]) {
    assert.throws(() => planPdfSplit(spec, 30), splitFailure('invalid_spec'));
  }
  for (const count of [0, -1, 31, NaN, Infinity, 2.5]) assert.throws(() => planPdfSplit({ mode: 'every', pagesPerDocument: 2 }, count), splitFailure('page_bounds'));
});

test('request canonicalization ignores object property order but preserves selection and mode', () => {
  assert.equal(canonicalPdfSplitSpec({ ranges: [{ end: 2, start: 1 }], mode: 'ranges' }),
    canonicalPdfSplitSpec({ mode: 'ranges', ranges: [{ start: 1, end: 2 }] }));
  assert.notEqual(canonicalPdfSplitSpec({ mode: 'every', pagesPerDocument: 2 }),
    canonicalPdfSplitSpec({ mode: 'ranges', ranges: [{ start: 1, end: 2 }] }));
});

test('isolated every-N split returns real PDFs with exact text/order, rebased pages and unchanged source', async () => {
  const bytes = await bundle(), originalHash = hash(bytes);
  const result = await splitPdfSource(bytes, 'owned-invoices.pdf', { mode: 'every', pagesPerDocument: 2 });
  assert.equal(result.sourcePageCount, 5); assert.equal(result.selectedPages, 5);
  assert.deepEqual(result.parts.map(part => part.source.pageCount), [2, 2, 1]);
  assert.deepEqual(result.parts.map(part => part.range), [{ start: 1, end: 2 }, { start: 3, end: 4 }, { start: 5, end: 5 }]);
  for (const part of result.parts) {
    const decodedAgain = await inspectSource(part.bytes, 'received-child.pdf');
    assert.deepEqual(decodedAgain, part.source);
    for (const [index, page] of part.source.pages.entries()) {
      assert.equal(page.page, index + 1);
      assert.match(page.text, new RegExp(`Original page ${part.range.start + index}: INV-${part.range.start + index}`));
    }
  }
  assert.equal(hash(bytes), originalHash);
});

test('custom ranges omit unselected pages and preserve source page geometry including crop and rotation', async () => {
  const bytes = await bundle(), original = await PDFDocument.load(bytes);
  const result = await splitPdfSource(bytes, 'geometry.pdf', { mode: 'ranges', ranges: [{ start: 3, end: 3 }, { start: 5, end: 5 }] });
  assert.equal(result.selectedPages, 2); assert.equal(result.sourcePageCount, 5);
  for (const part of result.parts) {
    const child = await PDFDocument.load(part.bytes), expected = original.getPage(part.range.start - 1);
    assert.equal(child.getPageCount(), 1);
    assert.deepEqual(child.getPage(0).getMediaBox(), expected.getMediaBox());
    assert.deepEqual(child.getPage(0).getCropBox(), expected.getCropBox());
    assert.deepEqual(child.getPage(0).getRotation(), expected.getRotation());
    assert.doesNotMatch(part.source.pages[0].text, /INV-(1|2|4)\b/);
  }
});

test('byte-identical source pages remain separate ordered children with actual identical content hashes', async () => {
  const result = await splitPdfSource(await bundle(2, true), 'repeated.pdf', { mode: 'every', pagesPerDocument: 1 });
  assert.equal(result.parts.length, 2);
  assert.equal(hash(result.parts[0].bytes), hash(result.parts[1].bytes));
  assert.deepEqual(result.parts.map(part => part.range.start), [1, 2]);
});

test('non-PDF, malformed PDF and oversized/page-limit inputs produce fixed typed errors without source diagnostics', async () => {
  await assert.rejects(splitPdfSource(Buffer.from('not a PDF'), 'renamed.pdf', { mode: 'every', pagesPerDocument: 1 }), splitFailure('pdf_required'));
  await assert.rejects(splitPdfSource(Buffer.from('%PDF-invalid'), 'bad.pdf', { mode: 'every', pagesPerDocument: 1 }),
    (error: unknown) => error instanceof SourceValidationError && error.reason === 'pdf_invalid');
  await assert.rejects(splitPdfSource(await bundle(31), '31-pages.pdf', { mode: 'every', pagesPerDocument: 2 }),
    (error: unknown) => error instanceof SourceValidationError && error.reason === 'pdf_page_limit');
  let started = false;
  await assert.rejects(splitPdfSource(Buffer.alloc(pdfSplitLimits.maxBytes + 1), 'large.pdf', { mode: 'every', pagesPerDocument: 2 },
    { spawnChild: () => { started = true; throw new Error('must not start'); } }),
    (error: unknown) => error instanceof SourceValidationError && error.reason === 'file_too_large');
  assert.equal(started, false);
  await assert.rejects(splitPdfSource(await bundle(3), 'range.pdf', { mode: 'ranges', ranges: [{ start: 2, end: 4 }] }), splitFailure('page_bounds'));
});

test('a small shared-image source cannot expand into more than 20 MiB of derived PDFs', async () => {
  const sharp = (await import('sharp')).default;
  const png = await sharp(randomFillSync(Buffer.alloc(900 * 900 * 3)), { raw: { width: 900, height: 900, channels: 3 } }).png().toBuffer();
  const pdf = await PDFDocument.create({ updateMetadata: false }), image = await pdf.embedPng(png);
  for (let index = 0; index < 10; index++) pdf.addPage([500, 700]).drawImage(image, { x: 0, y: 0, width: 500, height: 500 });
  const bytes = Buffer.from(await pdf.save());
  assert.ok(bytes.length < pdfSplitLimits.maxBytes);
  await assert.rejects(splitPdfSource(bytes, 'shared-image.pdf', { mode: 'every', pagesPerDocument: 1 }), splitFailure('derived_size_limit'));
});

function fakeChild(onCreate?: (child: ChildProcessWithoutNullStreams) => void) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  child.kill = () => { (child as any).killed = true; queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
  queueMicrotask(() => onCreate?.(child));
  return child;
}
const spec = { mode: 'every', pagesPerDocument: 1 } as const;
const reply = () => ({ ok: true, split: { sourcePageCount: 1, selectedPages: 1, parts: [
  { range: { start: 1, end: 1 }, data: Buffer.from('%PDF-controlled IPC only').toString('base64'), source: { mimeType: 'application/pdf', pageCount: 1, pages: [{ page: 1, text: 'fixture' }] } },
] } });
function respond(value: unknown) { return () => fakeChild(child => { child.stdout.emit('data', Buffer.from(JSON.stringify(value))); child.emit('close', 0); }); }

test('split IPC rejects changed ranges/counts, noncanonical bytes, forged page numbers and untyped failures', async () => {
  const mutations = [
    (r: ReturnType<typeof reply>) => { r.split.selectedPages = 2; },
    (r: ReturnType<typeof reply>) => { r.split.parts[0].range.start = 2; },
    (r: ReturnType<typeof reply>) => { r.split.parts[0].source.pages[0].page = 2; },
    (r: ReturnType<typeof reply>) => { r.split.parts[0].source.pageCount = 2; },
    (r: ReturnType<typeof reply>) => { r.split.parts[0].data += '!'; },
    (r: ReturnType<typeof reply>) => { r.split.parts[0].data = Buffer.from('not PDF').toString('base64'); },
    (r: ReturnType<typeof reply>) => { r.split.parts[0].source.pages[0].text = 'x'.repeat(decoderLimits.maxTextBytes + 1); },
  ];
  for (const mutate of mutations) {
    const value = reply(); mutate(value);
    await assert.rejects(splitPdfSource(Buffer.from('fixture'), 'fixture.pdf', spec, { spawnChild: respond(value) }),
      (error: any) => error.statusCode === 422 && !(error instanceof PdfSplitValidationError) && !(error instanceof SourceValidationError));
  }
  await assert.rejects(splitPdfSource(Buffer.from('fixture'), 'fixture.pdf', spec, { spawnChild: respond({ ok: false, code: 'pdf_split_validation_failed', reason: 'invented dependency diagnostic' }) }),
    (error: any) => error.statusCode === 422 && !error.message.includes('diagnostic'));
  await assert.rejects(splitPdfSource(Buffer.from('fixture'), 'fixture.pdf', spec, { spawnChild: respond({ ok: false, code: 'decoder_failed' }) }),
    (error: any) => error.statusCode === 503 && !(error instanceof PdfSplitValidationError));
});

test('split resource boundary removes credentials, caps output, kills timed-out children and shares ordinary concurrency', async () => {
  const launch = decoderLaunchSpec('/private/owned.pdf', spec);
  assert.deepEqual(Object.keys(launch.options.env).sort(), ['LANG', 'NODE_ENV', 'TSX_DISABLE_CACHE', 'TZ']);
  assert.ok(launch.args.includes('--max-old-space-size=192'));
  assert.ok(launch.args.includes('owned.pdf')); assert.ok(!launch.args.includes('/private/owned.pdf'));
  let overflow!: ChildProcessWithoutNullStreams;
  await assert.rejects(splitPdfSource(Buffer.from('fixture'), 'fixture.pdf', spec, { spawnChild: () => overflow = fakeChild(child => child.stdout.emit('data', Buffer.alloc(pdfSplitLimits.maxOutputBytes + 1))) }),
    (error: any) => error.statusCode === 413 && !(error instanceof PdfSplitValidationError));
  assert.equal(overflow.killed, true);
  let timeout!: ChildProcessWithoutNullStreams;
  await assert.rejects(splitPdfSource(Buffer.from('fixture'), 'fixture.pdf', spec, { timeoutMs: 15, spawnChild: () => timeout = fakeChild() }),
    (error: any) => error.statusCode === 422 && !(error instanceof PdfSplitValidationError));
  assert.equal(timeout.killed, true);
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnChild = () => { const child = fakeChild(); children.push(child); return child; };
  const first = splitPdfSource(Buffer.from('fixture'), 'fixture.pdf', spec, { spawnChild });
  const second = runDecoder(Buffer.from('fixture'), 'fixture.txt', { spawnChild });
  await assert.rejects(splitPdfSource(Buffer.from('fixture'), 'third.pdf', spec, { spawnChild }), (error: any) => error.statusCode === 429);
  await assert.rejects(runDecoder(Buffer.from('fixture'), 'fourth.txt', { spawnChild }), (error: any) => error.statusCode === 429);
  children[0].stdout.emit('data', Buffer.from(JSON.stringify(reply()))); children[0].emit('close', 0);
  children[1].stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, source: { mimeType: 'text/plain', pages: [{ page: 1, text: 'fixture' }], pageCount: 1 } }))); children[1].emit('close', 0);
  assert.equal((await first).parts.length, 1); assert.equal((await second).pageCount, 1);
});
