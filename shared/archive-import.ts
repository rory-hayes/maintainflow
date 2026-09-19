import {z} from 'zod';
import type {SourceFormat} from './source-formats.js';

export const archiveImportLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxDocuments: 20,
  maxRecords: 256,
  maxPathBytes: 1024,
  maxPagesPerDocument: 30,
  maxExpandedBytes: 20 * 1024 * 1024,
  maxOfficeExpandedBytes: 40 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  maxSpecBytes: 4096,
  maxOutputBytes: 44 * 1024 * 1024,
});

export const archiveImportSpecSchema = z.object({
  mode: z.literal('zip'), version: z.literal(1),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(z.number().int().min(1).max(archiveImportLimits.maxRecords))
    .min(1).max(archiveImportLimits.maxDocuments)
    .refine(entries => entries.every((entry, index) => index === 0 || entry > entries[index - 1])),
}).strict();
export type ArchiveImportSpec = z.infer<typeof archiveImportSpecSchema>;

export const archiveImportValidationReasons = Object.freeze({
  invalid_spec: {message: 'Preview this ZIP and select 1–20 files to import.', statusCode: 400},
  source_mismatch: {message: 'This ZIP differs from the preview. Preview the file again before importing.', statusCode: 409},
  selection_mismatch: {message: 'The selected files are not available in this ZIP. Preview it again.', statusCode: 400},
  zip_required: {message: 'Choose a ZIP archive to import.', statusCode: 400},
  invalid_archive: {message: 'This ZIP is damaged or has inconsistent file records. Create a new ZIP and try again.', statusCode: 400},
  unsupported_archive: {message: 'Use a standard, unencrypted ZIP with STORE or DEFLATE compression. Split archives and ZIP64 are not supported.', statusCode: 400},
  unsafe_path: {message: 'This ZIP contains unsafe or duplicate file paths. Create a ZIP with distinct relative paths.', statusCode: 400},
  unsupported_entry: {message: 'This ZIP contains a link or special file. Zip regular document files and folders only.', statusCode: 400},
  path_encoding: {message: 'ZIP file paths must use UTF-8 and contain no control characters.', statusCode: 400},
  record_limit: {message: 'This ZIP has too many file and folder records. Use at most 256 records.', statusCode: 413},
  document_limit: {message: 'Use a ZIP with at most 20 document files. macOS metadata does not count toward this limit.', statusCode: 413},
  file_size_limit: {message: 'A file in this ZIP exceeds the 10 MB limit. Use smaller document files.', statusCode: 413},
  expansion_limit: {message: 'This ZIP expands beyond the 20 MB limit. Split it into smaller archives.', statusCode: 413},
  office_expansion_limit: {message: 'Office documents in this ZIP expand beyond the combined 40 MB limit. Use fewer or smaller Office documents.', statusCode: 413},
  text_limit: {message: 'The documents in this ZIP exceed the combined 2 MB readable-text limit. Use a smaller archive.', statusCode: 413},
  office_package: {message: 'This is an Office document package. Upload it as a document instead of importing it as a ZIP.', statusCode: 400},
} as const);
export type ArchiveImportValidationReason = keyof typeof archiveImportValidationReasons;
export const isArchiveImportValidationReason = (value: unknown): value is ArchiveImportValidationReason =>
  typeof value === 'string' && Object.hasOwn(archiveImportValidationReasons, value);
export class ArchiveImportValidationError extends Error {
  readonly code = 'archive_import_validation_failed';
  readonly statusCode: number;
  constructor(readonly reason: ArchiveImportValidationReason) {
    if (!isArchiveImportValidationReason(reason)) throw new TypeError('Unknown ZIP import validation reason');
    super(archiveImportValidationReasons[reason].message);
    this.name = 'ArchiveImportValidationError';
    this.statusCode = archiveImportValidationReasons[reason].statusCode;
  }
}
export function canonicalArchiveImportSpec(value: unknown): string {
  const result = archiveImportSpecSchema.safeParse(value);
  if (!result.success) throw new ArchiveImportValidationError('invalid_spec');
  const {sourceSha256, entries} = result.data;
  return JSON.stringify({mode: 'zip', version: 1, sourceSha256, entries});
}

export const archiveEntryReasons = Object.freeze({
  macos_metadata: 'macOS metadata — not a document.',
  nested_archive: 'Nested ZIP archives are not imported. Extract this archive and upload its documents separately.',
  unsupported_format: 'Unsupported format. Use PDF, PNG, JPEG, TXT, CSV, HTML, EML, DOCX or XLSX.',
  empty_file: 'This file is empty.',
  invalid_document: 'This document is damaged, encrypted or has unsupported content.',
  page_limit: 'This document exceeds the 30-page or 30-sheet limit.',
} as const);
export type ArchiveEntryReason = keyof typeof archiveEntryReasons;
export interface ArchivePreviewEntry {
  /** Stable one-based central-directory record index, including intervening folders. */
  index: number; path: string; byteSize: number; sha256: string;
  status: 'ready' | 'unsupported' | 'metadata';
  format: SourceFormat | null; pageCount: number | null; reason: string | null;
}
export interface ArchivePreview {
  requestId: string; parserId: string; sourceSha256: string; sourceByteSize: number;
  entries: ArchivePreviewEntry[]; totalPages: number;
}
export interface ArchiveImportReceipt {
  archive: {id: string; requestId: string; parserId: string; sourceName: string | null;
    childCount: number; totalPages: number; sourceAvailable: boolean; createdAt: string};
  documents: Array<{id: string; jobId: string; index: number; path: string | null;
    name: string | null; pageCount: number; available: boolean}>;
  replayed: boolean;
}
export interface ArchiveImportLineage {
  id: string; index: number; path: string; childCount: number; totalPages: number;
  sourceName: string | null; sourceAvailable: boolean; retainedDocuments: number;
}
