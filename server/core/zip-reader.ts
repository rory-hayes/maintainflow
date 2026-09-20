import {inflateRawSync} from 'node:zlib';
import {archiveImportLimits as limits, ArchiveImportValidationError, type ArchiveImportValidationReason} from '../../shared/archive-import.js';

const fail = (reason: ArchiveImportValidationReason): never => {throw new ArchiveImportValidationError(reason);};
const crcTable = Uint32Array.from({length: 256}, (_, value) => {
  let crc = value;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
export function zipCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
export interface ZipEntry {
  index: number; path: string; directory: boolean; localOffset: number;
  dataOffset: number; compressedSize: number; byteSize: number; crc32: number;
  method: number; flags: number;
}
export interface ZipReadLimits {maxRecords: number; maxExpandedBytes: number; maxFileBytes: number}
const defaultLimits: ZipReadLimits = {maxRecords: limits.maxRecords, maxExpandedBytes: limits.maxExpandedBytes, maxFileBytes: limits.maxBytes};

function decodeName(raw: Buffer): string {
  let name: string;
  try {name = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(raw);}
  catch {return fail('path_encoding');}
  if (!name || raw.length > limits.maxPathBytes || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(name)) fail('path_encoding');
  return name;
}
export function safeArchivePath(name: string): boolean {
  if (!name || Buffer.byteLength(name) > limits.maxPathBytes || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(name)) return false;
  if (name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  const parts = name.replace(/\/$/, '').split('/');
  return parts.every(part => part !== '' && part !== '.' && part !== '..');
}
function extras(bytes: Buffer, rawName: Buffer, name: string): void {
  const seen = new Set<number>();
  for (let cursor = 0; cursor < bytes.length;) {
    if (cursor + 4 > bytes.length) fail('invalid_archive');
    const id = bytes.readUInt16LE(cursor), size = bytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > bytes.length || seen.has(id)) fail('invalid_archive');
    seen.add(id);
    if (id === 0x0001 || id === 0x9901) fail('unsupported_archive');
    // Unicode-path extras may supplement encoding, but may not supply an alias.
    if (id === 0x7075) {
      if (size < 5 || bytes[cursor] !== 1 || bytes.readUInt32LE(cursor + 1) !== zipCrc32(rawName)) fail('invalid_archive');
      if (decodeName(bytes.subarray(cursor + 5, cursor + size)) !== name) fail('unsafe_path');
    }
    cursor += size;
  }
}

/** Validate physical records before any inflation. No archive path is used on disk. */
export function scanZip(bytes: Buffer, budget: ZipReadLimits = defaultLimits): ZipEntry[] {
  if (bytes.length < 4 || ![0x04034b50, 0x06054b50].includes(bytes.readUInt32LE(0))) fail('zip_required');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {end = offset; break;}
  }
  if (end < 0) fail('invalid_archive');
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 0xffff || directoryOffset === 0xffffffff || directorySize === 0xffffffff) fail('unsupported_archive');
  if (count > budget.maxRecords) fail('record_limit');
  if (directoryOffset + directorySize !== end) fail('invalid_archive');
  const entries: ZipEntry[] = [], names = new Map<string, boolean>();
  let cursor = directoryOffset, expanded = 0;
  for (let index = 1; index <= count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('invalid_archive');
    const needed = bytes.readUInt16LE(cursor + 6), flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16), compressedSize = bytes.readUInt32LE(cursor + 20), byteSize = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const attrs = bytes.readUInt32LE(cursor + 38), localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || !nameSize) fail('invalid_archive');
    if (needed > 20 || bytes.readUInt16LE(cursor + 34) || flags & ~0x080e || ![0, 8].includes(method) || (method === 0 && flags & 6) || [compressedSize, byteSize, localOffset].includes(0xffffffff)) fail('unsupported_archive');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize), name = decodeName(rawName);
    if (!safeArchivePath(name)) fail('unsafe_path');
    const directory = name.endsWith('/'), canonicalName = name.replace(/\/$/, '').normalize('NFC');
    if (names.has(canonicalName)) fail('unsafe_path');
    names.set(canonicalName, directory);
    const mode = (attrs >>> 16) & 0xf000;
    if ((mode && mode !== 0x8000 && mode !== 0x4000) || (attrs & 8)) fail('unsupported_entry');
    if ((mode === 0x4000 && !directory) || (mode === 0x8000 && directory) || ((attrs & 0x10) !== 0 && !directory)) fail('unsupported_entry');
    if (directory && (byteSize !== 0 || crc32 !== 0)) fail('invalid_archive');
    extras(bytes.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize), rawName, name);
    if (byteSize > budget.maxFileBytes) fail('file_size_limit');
    expanded += byteSize;
    if (expanded > budget.maxExpandedBytes) fail('expansion_limit');
    if (localOffset + 30 > directoryOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail('invalid_archive');
    const localNameSize = bytes.readUInt16LE(localOffset + 26), localExtraSize = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameSize + localExtraSize;
    if (dataOffset + compressedSize > directoryOffset || localNameSize !== nameSize || bytes.readUInt16LE(localOffset + 4) !== needed || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(rawName)) fail('invalid_archive');
    extras(bytes.subarray(localOffset + 30 + localNameSize, dataOffset), rawName, name);
    for (const [offset, expected] of [[14, crc32], [18, compressedSize], [22, byteSize]]) {
      const actual = bytes.readUInt32LE(localOffset + offset);
      if (actual !== expected && (!(flags & 8) || actual !== 0)) fail('invalid_archive');
    }
    entries.push({index, path: name, directory, localOffset, dataOffset, compressedSize, byteSize, crc32, method, flags});
    cursor = next;
  }
  if (cursor !== end) fail('invalid_archive');
  for (const [name] of names) {
    const segments = name.split('/');
    for (let i = 1; i < segments.length; i++) if (names.get(segments.slice(0, i).join('/')) === false) fail('unsafe_path');
  }
  const physical = [...entries].sort((a, b) => a.localOffset - b.localOffset);
  if ((physical[0]?.localOffset ?? directoryOffset) !== 0) fail('invalid_archive');
  for (const [i, entry] of physical.entries()) {
    const dataEnd = entry.dataOffset + entry.compressedSize, next = physical[i + 1]?.localOffset ?? directoryOffset;
    if (!(entry.flags & 8)) {if (dataEnd !== next) fail('invalid_archive'); continue;}
    const length = next - dataEnd;
    if (length !== 12 && length !== 16) fail('invalid_archive');
    const descriptor = dataEnd + (length === 16 ? 4 : 0);
    if ((length === 16 && bytes.readUInt32LE(dataEnd) !== 0x08074b50) || bytes.readUInt32LE(descriptor) !== entry.crc32 || bytes.readUInt32LE(descriptor + 4) !== entry.compressedSize || bytes.readUInt32LE(descriptor + 8) !== entry.byteSize) fail('invalid_archive');
  }
  return entries;
}

/** Validate actual length, end-of-stream consumption and CRC under an output cap. */
export function inflateZipEntry(bytes: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  const input = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let output: Buffer;
  if (entry.method === 0) output = input;
  else {
    try {
      const result = inflateRawSync(input, {maxOutputLength: Math.max(1, maxBytes), info: true}) as unknown as {buffer: Buffer; engine: {bytesWritten: number}};
      if (result.engine.bytesWritten !== input.length) fail('invalid_archive');
      output = result.buffer;
    } catch (error) {
      if (error instanceof ArchiveImportValidationError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') fail('expansion_limit');
      if (['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_NEED_DICT'].includes((error as NodeJS.ErrnoException).code || '')) fail('invalid_archive');
      throw error;
    }
  }
  if (output.length > maxBytes) fail('expansion_limit');
  if (output.length !== entry.byteSize || zipCrc32(output) !== entry.crc32) fail('invalid_archive');
  return output;
}

export const isMacArchiveMetadataPath = (name: string) => name.split('/').includes('__MACOSX') || name.split('/').at(-1) === '.DS_Store' || name.split('/').at(-1)?.startsWith('._') === true;
/** A filename alone must not make a real document impossible to select. */
export const isMacArchiveMetadata = (name: string, bytes: Buffer): boolean => isMacArchiveMetadataPath(name) && (
  (bytes.length >= 26 && bytes.readUInt32BE(0) === 0x00051607 && bytes.readUInt32BE(4) === 0x00020000) ||
  (name.split('/').at(-1) === '.DS_Store' && bytes.length >= 8 && bytes.readUInt32BE(0) === 1 && bytes.subarray(4,8).equals(Buffer.from('Bud1')))
);
