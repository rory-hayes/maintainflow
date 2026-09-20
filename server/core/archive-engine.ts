import {createHash} from 'node:crypto';
import {decodeSource} from './decoder-engine.js';
import {SourceValidationError} from './source-validation.js';
import {isTiffHeader,inspectTiffStructure} from './tiff-engine.js';
import {tiffLimits} from '../../shared/tiff.js';
import {sourceFormats, type SourceFormat} from '../../shared/source-formats.js';
import {archiveImportLimits as limits, ArchiveImportValidationError, canonicalArchiveImportSpec, archiveEntryReasons,
  type ArchiveImportSpec, type ArchiveEntryReason, type ArchivePreviewEntry} from '../../shared/archive-import.js';
import type {PageText} from '../../shared/types.js';
import {scanZip, inflateZipEntry, isMacArchiveMetadata} from './zip-reader.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface ArchiveSourcePart {
  index: number; path: string; format: SourceFormat; sha256: string; bytes: Buffer;
  source: {mimeType: string; pageCount: number; pages: PageText[]};
}
export interface DecodedArchive {
  sourceSha256: string; sourceByteSize: number; entries: ArchivePreviewEntry[];
  parts: ArchiveSourcePart[]; totalPages: number;
}
export type ArchiveDecoderResponse = Omit<DecodedArchive, 'parts'> & {parts: Array<Omit<ArchiveSourcePart, 'bytes'> & {data: string}>};
const zipSignature = (bytes: Buffer) => bytes.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(bytes.readUInt32LE(0));
const officeCandidate = (names: Set<string>) => names.has('[Content_Types].xml') || names.has('_rels/.rels') || names.has('word/document.xml') || names.has('xl/workbook.xml');
function entryReason(error: SourceValidationError): ArchiveEntryReason {
  if (error.reason === 'empty') return 'empty_file';
  if (['format_unsupported', 'binary_format_unsupported', 'text_binary_content', 'text_encoding'].includes(error.reason)) return 'unsupported_format';
  if (['pdf_page_limit', 'xlsx_sheet_limit'].includes(error.reason)) return 'page_limit';
  return 'invalid_document';
}

/** Runs only inside the existing isolated decoder. All records are checked, even excluded files. */
export async function decodeArchive(bytes: Buffer, _filename: string, value?: ArchiveImportSpec): Promise<ArchiveDecoderResponse> {
  if (!bytes.length || bytes.length > limits.maxBytes) throw new ArchiveImportValidationError('zip_required');
  const sourceSha256 = sha(bytes), spec: ArchiveImportSpec | undefined = value ? JSON.parse(canonicalArchiveImportSpec(value)) : undefined;
  if (spec && spec.sourceSha256 !== sourceSha256) throw new ArchiveImportValidationError('source_mismatch');
  const records = scanZip(bytes), names = new Set(records.map(record => record.path));
  if (officeCandidate(names)) throw new ArchiveImportValidationError('office_package');
  const entries: ArchivePreviewEntry[] = [], allParts: ArchiveSourcePart[] = [];
  let expanded = 0, officeExpanded = 0, textBytes = 0, documents = 0,totalTiffPixels=0;
  const prepared=new Map<number,Buffer>();
  // Inspect the aggregate TIFF workload before any document enters a native decoder.
  // The existing complete preview catalogue decodes eligible unselected leaves too,
  // so all non-metadata TIFF pages share this one 300 MP budget.
  for(const record of records){
    const data=inflateZipEntry(bytes,record,Math.min(limits.maxBytes,limits.maxExpandedBytes-expanded));expanded+=data.length;prepared.set(record.index,data);
    if(record.directory||isMacArchiveMetadata(record.path,data)||!isTiffHeader(data))continue;
    try{totalTiffPixels+=inspectTiffStructure(data).totalPixels;}
    catch(error){if(!(error instanceof SourceValidationError))throw error;continue;} // Invalid leaf remains visibly unsupported in the catalogue.
    if(totalTiffPixels>tiffLimits.maxTotalPixels)throw new SourceValidationError('tiff_pixel_limit');
  }
  for (const record of records) {
    const data = prepared.get(record.index)!;
    if (record.directory) continue;
    const entry: ArchivePreviewEntry = {index: record.index, path: record.path, byteSize: data.length,
      sha256: sha(data), status: 'unsupported', format: null, pageCount: null, reason: null};
    entries.push(entry);
    if (isMacArchiveMetadata(record.path,data)) {entry.status = 'metadata'; entry.reason = archiveEntryReasons.macos_metadata; continue;}
    if (++documents > limits.maxDocuments) throw new ArchiveImportValidationError('document_limit');
    if (zipSignature(data)) {
      // Office leaves are atomic documents, but their actual inner expansion is
      // charged to one shared budget before a document library can inflate them.
      let inner: ReturnType<typeof scanZip>;
      try {inner = scanZip(data, {maxRecords: 2000, maxExpandedBytes: limits.maxOfficeExpandedBytes, maxFileBytes: limits.maxOfficeExpandedBytes});}
      catch (error) {
        if (!(error instanceof ArchiveImportValidationError)) throw error;
        if (['expansion_limit', 'file_size_limit'].includes(error.reason)) throw new ArchiveImportValidationError('office_expansion_limit');
        // Structural corruption remains a whole-container failure, even when
        // this leaf would be omitted. Only semantic content is excludable.
        throw error;
      }
      const innerNames = new Set(inner.map(record => record.path));
      if (!officeCandidate(innerNames)) {entry.reason = archiveEntryReasons.nested_archive; continue;}
      const word = innerNames.has('word/document.xml'), sheet = innerNames.has('xl/workbook.xml');
      if (!innerNames.has('[Content_Types].xml') || !innerNames.has('_rels/.rels') || word === sheet) {entry.reason = archiveEntryReasons.invalid_document; continue;}
      for (const item of inner) {
        const remaining = limits.maxOfficeExpandedBytes - officeExpanded;
        if (item.byteSize > remaining) throw new ArchiveImportValidationError('office_expansion_limit');
        try {officeExpanded += inflateZipEntry(data, item, remaining).length;}
        catch (error) {
          if (error instanceof ArchiveImportValidationError && error.reason === 'expansion_limit') throw new ArchiveImportValidationError('office_expansion_limit');
          throw error;
        }
      }
    }
    let source: ArchiveSourcePart['source'];
    try {source = await decodeSource(data, record.path);}
    catch (error) {
      if (!(error instanceof SourceValidationError)) throw error;
      entry.reason = archiveEntryReasons[entryReason(error)]; continue;
    }
    const format = sourceFormats.find(item => item.mimeType === source.mimeType)?.id;
    if (!format || source.pageCount < 1 || source.pageCount > limits.maxPagesPerDocument || source.pages.length !== source.pageCount || source.pages.some((page, i) => page.page !== i + 1)) throw new Error('Invalid decoded archive document');
    textBytes += source.pages.reduce((total, page) => total + Buffer.byteLength(page.text), 0);
    if (textBytes > limits.maxTextBytes) throw new ArchiveImportValidationError('text_limit');
    entry.status = 'ready'; entry.format = format; entry.pageCount = source.pageCount;
    allParts.push({index: record.index, path: record.path, format, sha256: entry.sha256, bytes: data, source});
  }
  const selected = new Set(spec?.entries ?? allParts.map(part => part.index));
  const parts = allParts.filter(part => selected.has(part.index));
  if (spec && (parts.length !== selected.size || !parts.length)) throw new ArchiveImportValidationError('selection_mismatch');
  return {sourceSha256, sourceByteSize: bytes.length, entries,
    parts: parts.map(({bytes, ...part}) => ({...part, data: bytes.toString('base64')})),
    totalPages: parts.reduce((total, part) => total + part.source.pageCount, 0)};
}
