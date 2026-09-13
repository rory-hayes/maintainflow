import { PDFDocument } from 'pdf-lib';
import { decodeSource } from './decoder-engine.js';
import { decoderLimits } from './decoder-limits.js';
import { pdfSplitLimits, planPdfSplit, PdfSplitValidationError, type PdfSplitSpec } from '../../shared/pdf-split.js';

/** Called only inside decoder-child. The original stays byte-for-byte untouched. */
export async function decodePdfSplit(bytes: Buffer, filename: string, spec: PdfSplitSpec) {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new PdfSplitValidationError('pdf_required');
  const source = await decodeSource(bytes, filename);
  if (source.mimeType !== 'application/pdf') throw new PdfSplitValidationError('pdf_required');
  if (source.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0) > decoderLimits.maxTextBytes) {
    throw new PdfSplitValidationError('text_limit');
  }
  const plan = planPdfSplit(spec, source.pageCount);
  // PDF.js establishes validity/page limits before pdf-lib is given the input.
  // Unexpected library failures remain retryable decoder failures, not input receipts.
  const original = await PDFDocument.load(bytes, { updateMetadata: false });
  if (original.isEncrypted || original.getPageCount() !== source.pageCount) throw new Error('PDF page counts disagree');
  const parts = [];
  let totalBytes = 0, totalText = 0;
  for (const range of plan.ranges) {
    const child = await PDFDocument.create({ updateMetadata: false });
    const indexes = Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start - 1 + index);
    for (const page of await child.copyPages(original, indexes)) child.addPage(page);
    const childBytes = Buffer.from(await child.save({ addDefaultPage: false }));
    if (childBytes.length > pdfSplitLimits.maxBytes) throw new PdfSplitValidationError('child_size_limit');
    totalBytes += childBytes.length;
    if (totalBytes > pdfSplitLimits.maxDerivedBytes) throw new PdfSplitValidationError('derived_size_limit');
    const childSource = await decodeSource(childBytes, 'split.pdf');
    if (childSource.mimeType !== 'application/pdf' || childSource.pageCount !== indexes.length) {
      throw new Error('Generated PDF page counts disagree');
    }
    totalText += childSource.pages.reduce((sum, page) => sum + Buffer.byteLength(page.text), 0);
    if (totalText > decoderLimits.maxTextBytes) throw new PdfSplitValidationError('text_limit');
    parts.push({ range, data: childBytes.toString('base64'), source: childSource });
  }
  return { sourcePageCount: source.pageCount, selectedPages: plan.selectedPages, parts };
}
