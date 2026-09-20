import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {deflateRawSync} from 'node:zlib';
import JSZip from 'jszip';
import {scanZip, inflateZipEntry, zipCrc32} from '../server/core/zip-reader.js';
import {decodeArchive} from '../server/core/archive-engine.js';
import {ArchiveImportValidationError} from '../shared/archive-import.js';

type FileSpec = {
  name: string | Buffer; data?: Buffer; method?: number; flags?: number;
  descriptor?: boolean | 'unsigned'; attrs?: number; extra?: Buffer;
  compressed?: Buffer; crc?: number; size?: number;
};

/** Build physical records directly: ZIP libraries normalize away several invalid cases. */
function rawZip(files: FileSpec[]): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = typeof file.name === 'string' ? Buffer.from(file.name) : file.name;
    const data = file.data ?? Buffer.from('Owned archive fixture'), method = file.method ?? 8;
    const flags = file.flags ?? (0x800 | (file.descriptor ? 8 : 0));
    const compressed = file.compressed ?? (method === 0 ? data : deflateRawSync(data));
    const crc = file.crc ?? zipCrc32(data), size = file.size ?? data.length, extra = file.extra ?? Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    if (!file.descriptor) {
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(size, 22);
    }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (file.descriptor) {
      descriptor = Buffer.alloc(file.descriptor === 'unsigned' ? 12 : 16);
      const start = file.descriptor === 'unsigned' ? 0 : 4;
      if (start) descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, start); descriptor.writeUInt32LE(compressed.length, start + 4); descriptor.writeUInt32LE(size, start + 8);
    }
    const physical = Buffer.concat([local, name, extra, compressed, descriptor]);
    locals.push(physical);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(file.attrs ?? (typeof file.name === 'string' && file.name.endsWith('/') ? 0x41ed0010 : 0x81a40000), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name, extra])); offset += physical.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const inflateAll = (bytes: Buffer) => scanZip(bytes).map(entry => inflateZipEntry(bytes, entry, 20 * 1024 * 1024));
const invalid = (bytes: Buffer, reason?: string) => assert.throws(() => inflateAll(bytes), (error: unknown) =>
  error instanceof ArchiveImportValidationError && (!reason || error.reason === reason));

test('standard STORE/DEFLATE accept signed and unsigned descriptors; JSZip DOS/UNIX Unicode works with streaming', async () => {
  for (const method of [0, 8]) for (const descriptor of [false, true, 'unsigned'] as const) {
    const bytes = rawZip([{name: 'folder/', data: Buffer.alloc(0), method}, {name: 'folder/document.txt', method, descriptor}]);
    assert.equal(inflateAll(bytes).at(-1)?.toString(), 'Owned archive fixture');
  }
  for (const compression of ['STORE', 'DEFLATE'] as const) for (const streamFiles of [false, true]) for (const platform of ['DOS', 'UNIX'] as const) {
    const zip = new JSZip(); zip.file('folder/é😀.txt', 'Owned unicode');
    const bytes = await zip.generateAsync({type: 'nodebuffer', compression, streamFiles, platform});
    assert.equal(inflateAll(bytes).at(-1)?.toString(), 'Owned unicode');
  }
});

test('central directory ordinal remains stable when physical record order differs', () => {
  const bytes = rawZip([{name: 'a.txt'}, {name: 'b.txt'}]), end = bytes.length - 22, directory = bytes.readUInt32LE(end + 16);
  const reordered = Buffer.concat([bytes.subarray(0, directory), bytes.subarray(directory + 51, end), bytes.subarray(directory, directory + 51), bytes.subarray(end)]);
  assert.deepEqual(scanZip(reordered).map(entry => entry.path), ['b.txt', 'a.txt']);
  assert.equal(inflateAll(reordered).length, 2);
});

test('unsafe paths, canonical aliases and file-parent conflicts reject without confusing valid distinct folders', () => {
  for (const name of ['../a.txt', 'a/../b.txt', '/absolute.txt', 'a//b.txt', './a.txt', 'a\\b.txt', 'C:relative.txt', 'C:/absolute.txt', 'a/./b.txt', 'a\0.txt', 'a\u0001.txt']) invalid(rawZip([{name}]));
  for (const names of [['a.txt', 'a.txt'], ['a/', 'a'], ['é.txt', 'e\u0301.txt'], ['a', 'a/b.txt'], ['é', 'e\u0301/x.txt']]) {
    invalid(rawZip(names.map(name => ({name, data: name.endsWith('/') ? Buffer.alloc(0) : undefined}))), 'unsafe_path');
  }
  assert.equal(inflateAll(rawZip([{name: 'a/invoice.txt'}, {name: 'b/invoice.txt'}, {name: 'A/invoice.txt'}])).length, 3);
});

test('links, special files and conflicting directory attributes reject before inflation', () => {
  for (const attrs of [0xa1ff0000, 0x21ff0000, 0x61ff0000, 0x11ff0000, 0xc1ff0000, 0x81a40008, 0x41ed0000, 0x81a40010]) {
    invalid(rawZip([{name: 'a.txt', attrs}]), 'unsupported_entry');
  }
});

test('path decoding rejects invalid UTF8, surrogate encoding and byte-limit overflow', () => {
  for (const name of [Buffer.from([0xff]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.alloc(1025, 97)]) invalid(rawZip([{name}]), 'path_encoding');
  assert.equal(inflateAll(rawZip([{name: 'a'.repeat(1024)}])).length, 1);
});

test('actual CRC/length and complete compressed stream are verified for every leaf', () => {
  invalid(rawZip([{name: 'a.txt', crc: 42}]), 'invalid_archive');
  for (const size of [2, 200]) invalid(rawZip([{name: 'a.txt', size}]), 'invalid_archive');
  const stream = deflateRawSync(Buffer.from('Owned archive fixture'));
  for (const trailing of [Buffer.from([0]), deflateRawSync(Buffer.from('extra'))]) {
    invalid(rawZip([{name: 'a.txt', compressed: Buffer.concat([stream, trailing])}]), 'invalid_archive');
  }
  const forged = rawZip([{name: 'a.txt', size: 1, data: Buffer.alloc(100000, 65)}]);
  assert.throws(() => inflateZipEntry(forged, scanZip(forged)[0], 1024), (error: unknown) => error instanceof ArchiveImportValidationError && error.reason === 'expansion_limit');
});

test('overlap, hidden records and damaged signed or unsigned descriptors reject', () => {
  const overlap = rawZip([{name: 'a.txt'}, {name: 'b.txt'}]), directory = overlap.readUInt32LE(overlap.length - 6);
  overlap.writeUInt32LE(0, directory + 51 + 42); invalid(overlap);
  const bytes = rawZip([{name: 'a.txt'}, {name: 'b.txt'}]), end = bytes.length - 22, offset = bytes.readUInt32LE(end + 16);
  const hidden = Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset, offset + 51), bytes.subarray(end)]);
  hidden.writeUInt16LE(1, hidden.length - 14); hidden.writeUInt16LE(1, hidden.length - 12); hidden.writeUInt32LE(51, hidden.length - 10); invalid(hidden);
  for (const descriptor of [true, 'unsigned'] as const) {
    const damaged = rawZip([{name: 'a.txt', descriptor}]), entry = scanZip(damaged)[0];
    damaged.writeUInt32LE(7, entry.dataOffset + entry.compressedSize + 4); invalid(damaged);
  }
});

test('encryption, unsupported compression, ZIP64 and split-disk markers reject', () => {
  invalid(rawZip([{name: 'a.txt', flags: 0x801}]), 'unsupported_archive');
  invalid(rawZip([{name: 'a.txt', method: 12}]), 'unsupported_archive');
  invalid(rawZip([{name: 'a.txt', extra: Buffer.from([1, 0, 0, 0])}]), 'unsupported_archive');
  const split = rawZip([{name: 'a.txt'}]); split.writeUInt16LE(1, split.length - 18); invalid(split, 'unsupported_archive');
});

test('deterministic corrupted and truncated archives never escape as untyped scanner exceptions', () => {
  const original = rawZip([{name: 'a/', data: Buffer.alloc(0)}, {name: 'a/é.txt', descriptor: true}, {name: 'b.txt', method: 0}]);
  for (let index = 0; index < 2000; index++) {
    const bytes = Buffer.from(original), changed = (Math.imul(index + 1, 2654435761) >>> 0) % bytes.length;
    bytes[changed] ^= 1 + index % 255;
    try {inflateAll(bytes);} catch (error) {assert.ok(error instanceof ArchiveImportValidationError, `mutation ${index}/${changed}: ${String(error)}`);}
  }
  const bytes = rawZip([{name: 'a.txt', descriptor: true}]);
  for (let length = 0; length < bytes.length; length++) invalid(bytes.subarray(0, length));
});

test('structural or CRC corruption inside Office packages rejects the container; semantic incomplete Office remains visible', async () => {
  const source = await fs.readFile('fixtures/generated/receipt.docx'), malformed = Buffer.from(source), record = scanZip(source)[0];
  malformed[record.localOffset + 30] ^= 1;
  await assert.rejects(decodeArchive(rawZip([{name: 'a.txt'}, {name: 'bad.docx', data: malformed}]), 'owned.zip'), (error: unknown) => error instanceof ArchiveImportValidationError && error.reason === 'invalid_archive');
  const inner = await JSZip.loadAsync(source), files: FileSpec[] = [];
  for (const entry of Object.values(inner.files)) files.push({name: entry.name, data: await entry.async('nodebuffer'), ...(entry.dir ? {} : {crc: 123})});
  await assert.rejects(decodeArchive(rawZip([{name: 'bad.docx', data: rawZip(files)}]), 'owned.zip'), (error: unknown) => error instanceof ArchiveImportValidationError && error.reason === 'invalid_archive');
  const incomplete = await fs.readFile('fixtures/source-formats/incomplete.docx');
  const result = await decodeArchive(rawZip([{name: 'a.txt'}, {name: 'incomplete.docx', data: incomplete}]), 'owned.zip');
  assert.equal(result.entries[1].status, 'unsupported'); assert.equal(result.parts.length, 1);
});

test('operational document-reader failure aborts preview rather than silently excluding the document', async () => {
  const brokenPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
  await assert.rejects(decodeArchive(rawZip([{name: 'a.txt'}, {name: 'a.png', data: brokenPng}]), 'owned.zip'), (error: unknown) => error instanceof Error && !(error instanceof ArchiveImportValidationError));
});
