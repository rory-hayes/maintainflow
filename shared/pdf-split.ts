import { z } from 'zod';

/** Shared upload limits; PDF parsing still happens inside the isolated decoder. */
export const pdfSplitLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 30,
  maxDocuments: 20,
  maxMarkerLength: 200,
  maxSpecBytes: 4096,
  maxDerivedBytes: 20 * 1024 * 1024,
  // Base64 for 20 MiB of PDFs, plus worst-case JSON escaping for 2 MiB of text.
  maxOutputBytes: 42 * 1024 * 1024,
});

const pageNumber = z.number().int().min(1).max(pdfSplitLimits.maxPages);
const rangeSchema = z.object({ start: pageNumber, end: pageNumber }).strict();
/** Keep extraction text unchanged; only literal marker matching folds whitespace. */
export function normalizePdfMarkerText(text: string): string { return text.replace(/\s+/gu, ' ').trim(); }
const markerSchema = z.string().max(pdfSplitLimits.maxMarkerLength)
  .refine(text => !/[\u0000\uD800-\uDFFF]/u.test(text))
  .transform(normalizePdfMarkerText).pipe(z.string().min(1).max(pdfSplitLimits.maxMarkerLength));
export const pdfSplitSpecSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('every'), pagesPerDocument: pageNumber }).strict(),
  z.object({ mode: z.literal('ranges'), ranges: z.array(rangeSchema).min(1).max(pdfSplitLimits.maxDocuments) }).strict(),
  z.object({ mode: z.literal('marker'), marker: markerSchema, ranges: z.array(rangeSchema).min(1).max(pdfSplitLimits.maxDocuments) }).strict(),
]);
export type PdfSplitSpec = z.infer<typeof pdfSplitSpecSchema>;
export type PdfPageRange = { start: number; end: number };

export const pdfSplitValidationReasons = Object.freeze({
  tiff_marker_unsupported: { message: 'TIFFs do not contain searchable text. Use a page count or custom page ranges.', statusCode: 400 },
  tiff_repack_unsupported: { message: 'This TIFF cannot be split without changing its image data. Try exporting a standard TIFF from the source application.', statusCode: 415 },
  invalid_spec: { message: 'Choose a page count, valid page ranges, or a text marker of 1–200 characters.', statusCode: 400 },
  invalid_ranges: { message: 'Enter page ranges in order, without overlaps, such as 1-2, 5, 7-9.', statusCode: 400 },
  page_bounds: { message: 'Page ranges must stay within this document.', statusCode: 400 },
  document_limit: { message: 'A document can be split into at most 20 documents at once.', statusCode: 413 },
  pdf_required: { message: 'Choose a PDF or TIFF to split.', statusCode: 400 },
  child_size_limit: { message: 'A split document exceeds the 10 MB file limit. Choose smaller page ranges.', statusCode: 413 },
  derived_size_limit: { message: 'The split documents exceed the 20 MB combined limit. Select fewer pages or larger groups.', statusCode: 413 },
  text_limit: { message: 'The PDF contains more text than the supported 2 MB limit.', statusCode: 413 },
  marker_no_text: { message: 'This PDF has no searchable text. Use a page count or custom page ranges instead.', statusCode: 400 },
  marker_not_found: { message: 'The text marker was not found on any page. Check its spelling and case, or use custom page ranges.', statusCode: 400 },
  marker_plan_mismatch: { message: 'The confirmed page ranges do not match this PDF’s text marker. Preview the split again.', statusCode: 400 },
} as const);
export type PdfSplitValidationReason = keyof typeof pdfSplitValidationReasons;
export const isPdfSplitValidationReason = (value: unknown): value is PdfSplitValidationReason =>
  typeof value === 'string' && Object.hasOwn(pdfSplitValidationReasons, value);

export class PdfSplitValidationError extends Error {
  readonly code = 'pdf_split_validation_failed';
  readonly statusCode: number;
  constructor(readonly reason: PdfSplitValidationReason) {
    if (!isPdfSplitValidationReason(reason)) throw new TypeError('Unknown PDF split validation reason');
    super(pdfSplitValidationReasons[reason].message);
    this.name = 'PdfSplitValidationError';
    this.statusCode = pdfSplitValidationReasons[reason].statusCode;
  }
}

export function canonicalPdfSplitSpec(value: unknown): string {
  const parsed = pdfSplitSpecSchema.safeParse(value);
  if (!parsed.success) throw new PdfSplitValidationError('invalid_spec');
  const spec = parsed.data;
  // Construct the shape explicitly: property order supplied by a caller is not identity.
  return JSON.stringify(spec.mode === 'every'
    ? { mode: 'every', pagesPerDocument: spec.pagesPerDocument }
    : { mode: spec.mode, ...(spec.mode === 'marker' ? { marker: spec.marker } : {}), ranges: spec.ranges.map(({ start, end }) => ({ start, end })) });
}

export function planPdfSplit(value: unknown, pageCount: number): { ranges: PdfPageRange[]; selectedPages: number } {
  const spec: PdfSplitSpec = JSON.parse(canonicalPdfSplitSpec(value));
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > pdfSplitLimits.maxPages) {
    throw new PdfSplitValidationError('page_bounds');
  }
  const ranges = spec.mode !== 'every' ? spec.ranges : Array.from(
    { length: Math.ceil(pageCount / spec.pagesPerDocument) },
    (_, index) => ({ start: index * spec.pagesPerDocument + 1, end: Math.min((index + 1) * spec.pagesPerDocument, pageCount) }),
  );
  if (ranges.length > pdfSplitLimits.maxDocuments) throw new PdfSplitValidationError('document_limit');
  let lastEnd = 0, selectedPages = 0;
  for (const { start, end } of ranges) {
    if (start > end || start <= lastEnd) throw new PdfSplitValidationError('invalid_ranges');
    if (end > pageCount) throw new PdfSplitValidationError('page_bounds');
    if (spec.mode === 'marker' && start !== lastEnd + 1) throw new PdfSplitValidationError('marker_plan_mismatch');
    selectedPages += end - start + 1;
    lastEnd = end;
  }
  if (spec.mode === 'marker' && lastEnd !== pageCount) throw new PdfSplitValidationError('marker_plan_mismatch');
  return { ranges, selectedPages };
}

/** PDF.js items in source order, identical to the original native-text decoder. */
export function nativePdfPageText(items: readonly unknown[]): string {
  let prevY: number | undefined;
  const lines: string[] = [];
  for (const value of items) {
    if (!value || typeof value !== 'object' || !('str' in value)) continue;
    const item = value as { str: string; transform: number[]; hasEOL?: boolean };
    const y = item.transform[5];
    if (prevY !== undefined && Math.abs(y - prevY) > 3) lines.push('\n');
    else if (lines.length && !lines.at(-1)?.endsWith('\n')) lines.push(' ');
    lines.push(item.str); if (item.hasEOL) lines.push('\n'); prevY = y;
  }
  return lines.join('').replace(/\n\s*\n/g, '\n');
}

/** Match within each page only. Prefix pages and textless pages remain included. */
export function findPdfMarkerRanges(marker: string, pageTexts: readonly string[]): {
  marker: string; ranges: PdfPageRange[]; matchedPages: number[]; textlessPages: number[]; selectedPages: number;
} {
  const parsed = markerSchema.safeParse(marker);
  if (!parsed.success) throw new PdfSplitValidationError('invalid_spec');
  if (!Number.isInteger(pageTexts.length) || pageTexts.length < 1 || pageTexts.length > pdfSplitLimits.maxPages) throw new PdfSplitValidationError('page_bounds');
  const matchedPages: number[] = [], textlessPages: number[] = [];
  for (const [index, text] of pageTexts.entries()) {
    const normalized = normalizePdfMarkerText(text);
    if (!normalized) textlessPages.push(index + 1);
    else if (normalized.includes(parsed.data)) matchedPages.push(index + 1);
  }
  if (textlessPages.length === pageTexts.length) throw new PdfSplitValidationError('marker_no_text');
  if (!matchedPages.length) throw new PdfSplitValidationError('marker_not_found');
  const starts = matchedPages[0] === 1 ? matchedPages : [1, ...matchedPages];
  if (starts.length > pdfSplitLimits.maxDocuments) throw new PdfSplitValidationError('document_limit');
  const ranges = starts.map((start, index) => ({ start, end: (starts[index + 1] ?? pageTexts.length + 1) - 1 }));
  return { marker: parsed.data, ranges, matchedPages, textlessPages, selectedPages: pageTexts.length };
}

/** A confirmed plan is an assertion about native text, never authority to omit pages. */
export function verifyPdfMarkerRanges(spec: PdfSplitSpec, pageTexts: readonly string[]): void {
  if (spec.mode !== 'marker') return;
  const expected = findPdfMarkerRanges(spec.marker, pageTexts).ranges;
  if (expected.length !== spec.ranges.length || expected.some((range, index) => range.start !== spec.ranges[index]?.start || range.end !== spec.ranges[index]?.end)) {
    throw new PdfSplitValidationError('marker_plan_mismatch');
  }
}

export function parsePdfRanges(text: string): PdfPageRange[] {
  if (text.length > 1000 || !text.trim()) throw new PdfSplitValidationError('invalid_ranges');
  const chunks = text.split(',');
  if (chunks.length > pdfSplitLimits.maxDocuments) throw new PdfSplitValidationError('document_limit');
  const ranges = chunks.map(chunk => {
    const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+)\s*)?$/.exec(chunk);
    if (!match) throw new PdfSplitValidationError('invalid_ranges');
    return { start: Number(match[1]), end: Number(match[2] || match[1]) };
  });
  return planPdfSplit({ mode: 'ranges', ranges }, pdfSplitLimits.maxPages).ranges;
}

export interface PdfSplitReceipt {
  split: {
    id: string; requestId: string; parserId: string; sourceName: string | null;
    sourcePageCount: number; selectedPages: number; childCount: number;
    sourceAvailable: boolean; createdAt: string; sourceMimeType?: 'application/pdf' | 'image/tiff';
    origin?: 'upload' | 'stored'; sourceDocumentId?: string | null;
    sourceDocumentAvailable?: boolean; sourceSha256?: string; undoneAt?: string | null;
  };
  documents: Array<{
    id: string; jobId: string; name: string | null; pageCount: number;
    originalPageStart: number; originalPageEnd: number; index: number; available: boolean;
    root?: PdfSplitRootLineage;
  }>;
  replayed: boolean;
}

export interface PdfSplitLineage {
  id: string; index: number; childCount: number;
  originalPageStart: number; originalPageEnd: number;
  sourcePageCount: number; sourceName: string | null;
  sourceAvailable: boolean; retainedDocuments: number; sourceMimeType?: 'application/pdf' | 'image/tiff';
  origin?: 'upload' | 'stored'; sourceDocumentId?: string | null;
  sourceDocumentAvailable?: boolean; requestId?: string; parserId?: string;
  undoneAt?: string | null; root?: PdfSplitRootLineage;
}

/** Root means the PDF or TIFF asset. An archive itself never supplies page numbers. */
export interface PdfSplitRootLineage {
  kind: 'document' | 'pdf-split'; id: string; sha256: string;
  pageCount: number; pageStart: number; pageEnd: number;
}
export interface StoredPdfSplitBatches {
  batches: PdfSplitReceipt[]; nextCursor: string | null; sourceAvailable: boolean;
}
export interface StoredPdfSplitUndo {
  ok: true; removedDocuments: number; storageDeletion: 'pending' | 'failed' | 'complete';
  receipt: PdfSplitReceipt;
}
export interface StoredPdfSplitRejected {
  rejected: {
    id: string; requestId: string; parserId: string; sourceDocumentId: string;
    sourceSha256: string; sourceMimeType?: 'application/pdf' | 'image/tiff'; options: PdfSplitSpec; code: string; reason: string; message: string;
  };
}
