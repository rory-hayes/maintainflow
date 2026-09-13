import { z } from 'zod';

/** Shared upload limits; PDF parsing still happens inside the isolated decoder. */
export const pdfSplitLimits = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPages: 30,
  maxDocuments: 20,
  maxDerivedBytes: 20 * 1024 * 1024,
  // Base64 for 20 MiB of PDFs, plus worst-case JSON escaping for 2 MiB of text.
  maxOutputBytes: 42 * 1024 * 1024,
});

const pageNumber = z.number().int().min(1).max(pdfSplitLimits.maxPages);
const rangeSchema = z.object({ start: pageNumber, end: pageNumber }).strict();
export const pdfSplitSpecSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('every'), pagesPerDocument: pageNumber }).strict(),
  z.object({ mode: z.literal('ranges'), ranges: z.array(rangeSchema).min(1).max(pdfSplitLimits.maxDocuments) }).strict(),
]);
export type PdfSplitSpec = z.infer<typeof pdfSplitSpecSchema>;
export type PdfPageRange = { start: number; end: number };

export const pdfSplitValidationReasons = Object.freeze({
  invalid_spec: { message: 'Choose a page count or valid page ranges for this PDF.', statusCode: 400 },
  invalid_ranges: { message: 'Enter page ranges in order, without overlaps, such as 1-2, 5, 7-9.', statusCode: 400 },
  page_bounds: { message: 'Page ranges must stay within this PDF.', statusCode: 400 },
  document_limit: { message: 'A PDF can be split into at most 20 documents at once.', statusCode: 413 },
  pdf_required: { message: 'Choose a PDF to split.', statusCode: 400 },
  child_size_limit: { message: 'A split document exceeds the 10 MB file limit. Choose smaller page ranges.', statusCode: 413 },
  derived_size_limit: { message: 'The split PDFs exceed the 20 MB combined limit. Select fewer pages or larger groups.', statusCode: 413 },
  text_limit: { message: 'The PDF contains more text than the supported 2 MB limit.', statusCode: 413 },
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
    : { mode: 'ranges', ranges: spec.ranges.map(({ start, end }) => ({ start, end })) });
}

export function planPdfSplit(value: unknown, pageCount: number): { ranges: PdfPageRange[]; selectedPages: number } {
  const spec: PdfSplitSpec = JSON.parse(canonicalPdfSplitSpec(value));
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > pdfSplitLimits.maxPages) {
    throw new PdfSplitValidationError('page_bounds');
  }
  const ranges = spec.mode === 'ranges' ? spec.ranges : Array.from(
    { length: Math.ceil(pageCount / spec.pagesPerDocument) },
    (_, index) => ({ start: index * spec.pagesPerDocument + 1, end: Math.min((index + 1) * spec.pagesPerDocument, pageCount) }),
  );
  if (ranges.length > pdfSplitLimits.maxDocuments) throw new PdfSplitValidationError('document_limit');
  let lastEnd = 0, selectedPages = 0;
  for (const { start, end } of ranges) {
    if (start > end || start <= lastEnd) throw new PdfSplitValidationError('invalid_ranges');
    if (end > pageCount) throw new PdfSplitValidationError('page_bounds');
    selectedPages += end - start + 1;
    lastEnd = end;
  }
  return { ranges, selectedPages };
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
    sourceAvailable: boolean; createdAt: string;
  };
  documents: Array<{
    id: string; jobId: string; name: string | null; pageCount: number;
    originalPageStart: number; originalPageEnd: number; index: number; available: boolean;
  }>;
  replayed: boolean;
}

export interface PdfSplitLineage {
  id: string; index: number; childCount: number;
  originalPageStart: number; originalPageEnd: number;
  sourcePageCount: number; sourceName: string | null;
  sourceAvailable: boolean; retainedDocuments: number;
}
