import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import { decodeSource } from '../server/core/decoder-engine.js';
import { inspectSource, runDecoder } from '../server/core/source.js';
import { decoderLimits } from '../server/core/decoder-limits.js';
import { SourceValidationError, isSourceValidationReason, sourceValidationReasons, type SourceValidationReason } from '../server/core/source-validation.js';

const fixture = Buffer.from('Owned validation fixture');
const validResponse = { ok: true, source: { mimeType: 'text/plain', pages: [{ page: 1, text: 'Owned validation fixture' }], pageCount: 1 } };
const permanent = (reason: SourceValidationReason) => (error: unknown) => {
  assert.ok(error instanceof SourceValidationError);
  assert.equal(error.code, 'source_validation_failed');
  assert.equal(error.reason, reason);
  assert.equal(error.statusCode, sourceValidationReasons[reason].statusCode);
  assert.equal(error.message, sourceValidationReasons[reason].message);
  return true;
};
const retryable = (status: number) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.ok(!(error instanceof SourceValidationError));
  assert.equal((error as Error & { statusCode: number }).statusCode, status);
  assert.equal((error as Error & { code?: string }).code, undefined);
  assert.ok(!error.message.includes('private-fixture-diagnostic'));
  return true;
};

function fakeChild(onCreate?: (child: ChildProcessWithoutNullStreams) => void) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  child.kill = () => { Object.assign(child, { killed: true }); queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; };
  queueMicrotask(() => onCreate?.(child));
  return child;
}
function responseChild(response: unknown) {
  return fakeChild(child => {
    child.stdout.emit('data', Buffer.from(typeof response === 'string' ? response : JSON.stringify(response)));
    child.emit('close', 0);
  });
}

test('real malformed PDF, unsupported binary, invalid text and empty input have explicit stable rejection reasons', async () => {
  for (const [bytes, filename, reason] of [
    [Buffer.from('%PDF-1.7\nOwned incomplete document'), 'renamed.txt', 'pdf_invalid'],
    [Buffer.from('GIF89aOwned unsupported image'), 'renamed.txt', 'binary_format_unsupported'],
    [Buffer.from('Owned\x00body'), 'owned.eml', 'text_binary_content'],
    [Buffer.from([0xff, 0xfe, 0x41, 0]), 'owned.txt', 'text_encoding'],
    [Buffer.from('Owned unknown format'), 'owned.exe', 'format_unsupported'],
    [Buffer.alloc(0), 'owned.txt', 'empty'],
  ] as const) {
    await assert.rejects(inspectSource(bytes, filename), permanent(reason));
  }
  const accepted = await inspectSource(await fs.readFile('fixtures/generated/invoice-multipage.pdf'), 'owned.pdf');
  assert.equal(accepted.pageCount, 2);
  assert.match(accepted.pages[0].text, /INV-00601/);
});

test('empty and oversized source bytes reject before starting a child', async () => {
  let starts = 0;
  const spawnChild = () => { starts++; return responseChild(validResponse); };
  await assert.rejects(runDecoder(Buffer.alloc(0), 'owned.txt', { spawnChild }), permanent('empty'));
  await assert.rejects(runDecoder(Buffer.alloc(decoderLimits.maxBytes + 1), 'owned.txt', { spawnChild }), permanent('file_too_large'));
  assert.equal(starts, 0);
});

test('only catalogue reasons reconstruct permanent errors across the strict child protocol', async () => {
  for (const reason of Object.keys(sourceValidationReasons)) {
    assert.ok(isSourceValidationReason(reason));
    await assert.rejects(runDecoder(fixture, 'owned.txt', {
      spawnChild: () => responseChild({ ok: false, code: 'source_validation_failed', reason }),
    }), permanent(reason));
  }
  for (const value of ['toString', '__proto__', 'constructor', 'unknown', null, {}, 400]) assert.equal(isSourceValidationReason(value), false);
  assert.throws(() => new SourceValidationError('unknown' as SourceValidationReason), /Unknown source validation reason/);
});

test('unknown reasons, status-only lookalikes and malformed child responses remain retryable', async () => {
  for (const response of [
    { ok: false, code: 'source_validation_failed', reason: 'unknown' },
    { ok: false, code: 'source_validation_failed', reason: '__proto__' },
    { ok: false, code: 'source_validation_failed', reason: 'pdf_invalid', error: 'private-fixture-diagnostic', statusCode: 400 },
    ...[400, 413, 422].map(statusCode => ({ ok: false, error: 'private-fixture-diagnostic', statusCode })),
    { ok: false, reason: 'pdf_invalid' },
    { ok: true, code: 'source_validation_failed', reason: 'pdf_invalid' },
    { ok: true, source: { pageCount: 0 } },
    null, [], 'not JSON',
  ]) {
    await assert.rejects(runDecoder(fixture, 'owned.txt', { spawnChild: () => responseChild(response) }), retryable(422));
  }
  await assert.rejects(runDecoder(fixture, 'owned.txt', { spawnChild: () => responseChild({ ok: false, code: 'decoder_failed' }) }), retryable(503));
});

test('timeout, child crash, start failure and output overflow cannot become source rejections', async () => {
  let timedOut!: ChildProcessWithoutNullStreams;
  await assert.rejects(runDecoder(fixture, 'owned.txt', { timeoutMs: 10, spawnChild: () => timedOut = fakeChild() }), retryable(422));
  assert.equal(timedOut.killed, true);
  await assert.rejects(runDecoder(fixture, 'owned.txt', { spawnChild: () => fakeChild(child => child.emit('close', 1)) }), retryable(422));
  await assert.rejects(runDecoder(fixture, 'owned.txt', { spawnChild: () => { throw new Error('private-fixture-diagnostic'); } }), retryable(503));
  await assert.rejects(runDecoder(fixture, 'owned.txt', { spawnChild: () => fakeChild(child => child.emit('error', new Error('private-fixture-diagnostic'))) }), retryable(503));
  let overflowing!: ChildProcessWithoutNullStreams;
  await assert.rejects(runDecoder(fixture, 'owned.txt', {
    spawnChild: () => overflowing = fakeChild(child => child.stdout.emit('data', Buffer.alloc(decoderLimits.maxOutputBytes + 1))),
  }), retryable(413));
  assert.equal(overflowing.killed, true);
  assert.equal((await runDecoder(fixture, 'owned.txt', { spawnChild: () => responseChild(validResponse) })).pageCount, 1);
});

test('decoder busy remains retryable and completed children release every concurrency slot', async () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnChild = () => { const child = fakeChild(); children.push(child); return child; };
  const pending = Array.from({ length: decoderLimits.concurrency }, () => runDecoder(fixture, 'owned.txt', { spawnChild }));
  try {
    await assert.rejects(runDecoder(fixture, 'owned.txt', { spawnChild }), retryable(429));
    assert.equal(children.length, decoderLimits.concurrency);
  } finally {
    for (const child of children) { child.stdout.emit('data', Buffer.from(JSON.stringify(validResponse))); child.emit('close', 0); }
    await Promise.all(pending);
  }
  assert.equal((await runDecoder(fixture, 'owned.txt', { spawnChild: () => responseChild(validResponse) })).pageCount, 1);
});

test('real child text output limits remain operational failures without permanent receipts', async () => {
  await assert.rejects(inspectSource(Buffer.alloc(decoderLimits.maxTextBytes + 1, 65), 'owned.txt'), retryable(503));
});

// Inject only an owned Node loader into the existing internal child-spawn seam.
// No installed dependency is modified and no application environment flag exists.
type DecoderSpawn = NonNullable<NonNullable<Parameters<typeof runDecoder>[2]>['spawnChild']>;
function pdfDependency(hookBody: string): DecoderSpawn {
  const hook = `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,nextResolve){if(specifier==='pdfjs-dist/legacy/build/pdf.mjs'){${hookBody}}return nextResolve(specifier,context);}});`;
  return (command, args, options) =>
    spawn(command, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, ...args], options);
}

test('real missing dependency and same-status library lookalikes stay retryable across child IPC', async () => {
  const bytes = Buffer.from('%PDF-1.7\nOwned dependency fixture');
  await assert.rejects(runDecoder(bytes, 'owned.pdf', {
    spawnChild: pdfDependency("throw Object.assign(new Error('private-fixture-diagnostic'),{code:'ERR_MODULE_NOT_FOUND'});"),
  }), retryable(503));
  for (const statusCode of [400, 413, 422]) {
    const module = `export class InvalidPDFException extends Error{};export class PasswordException extends Error{};export const getDocument=()=>({promise:Promise.reject(Object.assign(new Error('private-fixture-diagnostic'),{statusCode:${statusCode},code:'source_validation_failed',reason:'pdf_invalid',name:'InvalidPDFException'})),destroy:async()=>{}});`;
    await assert.rejects(runDecoder(bytes, 'owned.pdf', {
      spawnChild: pdfDependency(`return {url:${JSON.stringify(`data:text/javascript,${encodeURIComponent(module)}`)},shortCircuit:true};`),
    }), retryable(503));
  }
});

test('ambiguous native image-library errors retain no permanent validation type', async () => {
  // A recognized but truncated header reaches Sharp; its generic exception is
  // insufficient evidence to checkpoint an invalid-source decision.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await assert.rejects(decodeSource(bytes, 'owned.png'), retryable(400));
  await assert.rejects(inspectSource(bytes, 'owned.png'), retryable(503));
});
