import { mkdir, writeFile, copyFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';

// Self-contained original fictional acceptance data. No application code,
// existing fixtures, models, APIs, or database are read by this generator.
const out = dirname(fileURLToPath(import.meta.url));
const previews = join(out, 'previews');
await mkdir(previews, { recursive: true });
const fixedDate = new Date('2026-09-07T00:00:00.000Z');
const ink = rgb(0.12, 0.17, 0.2);
const muted = rgb(0.38, 0.43, 0.46);
const accent = rgb(0.14, 0.34, 0.38);

function pdfMetadata(doc, title) {
  doc.setTitle(title);
  doc.setAuthor('Fictional held-out document author');
  doc.setCreator('Deterministic synthetic document generator');
  doc.setProducer('pdf-lib');
  doc.setCreationDate(fixedDate);
  doc.setModificationDate(fixedDate);
}

const items = [
  { description: 'Ceramic carafes', quantity: 4, unit_price: 28.5, amount: 114 },
  { description: 'Felt coasters', quantity: 18, unit_price: 3.2, amount: 57.6 },
  { description: 'Linen table runners', quantity: 3, unit_price: 22, amount: 66 },
  { description: 'Brass napkin rings', quantity: 12, unit_price: 2.75, amount: 33 },
  { description: 'Protective packaging', quantity: 1, unit_price: 12, amount: 12 },
  { description: 'Courier delivery', quantity: 1, unit_price: 18.4, amount: 18.4 },
];
const invoice = await PDFDocument.create();
pdfMetadata(invoice, 'Synthetic invoice BBw-260901-73');
const regular = await invoice.embedFont(StandardFonts.Helvetica);
const bold = await invoice.embedFont(StandardFonts.HelveticaBold);
function text(page, value, x, y, size = 12, heavy = false, color = ink) {
  page.drawText(value, { x, y, size, font: heavy ? bold : regular, color });
}
function right(page, value, x, y, size = 12, heavy = false) {
  const font = heavy ? bold : regular;
  text(page, value, x - font.widthOfTextAtSize(value, size), y, size, heavy);
}
function rule(page, y) {
  page.drawLine({ start: { x: 46, y }, end: { x: 549, y }, thickness: 0.7, color: muted });
}
function table(page, subset, y) {
  page.drawRectangle({ x: 46, y: y - 9, width: 503, height: 29, color: rgb(0.93, 0.95, 0.95) });
  text(page, 'Description', 57, y, 11, true);
  right(page, 'Qty', 349, y, 11, true);
  right(page, 'Unit (GBP)', 446, y, 11, true);
  right(page, 'Amount (GBP)', 538, y, 11, true);
  for (const [index, item] of subset.entries()) {
    const rowY = y - 46 - index * 55;
    text(page, item.description, 57, rowY, 11);
    right(page, String(item.quantity), 349, rowY, 11);
    right(page, item.unit_price.toFixed(2), 446, rowY, 11);
    right(page, item.amount.toFixed(2), 538, rowY, 11);
    rule(page, rowY - 16);
  }
}
const p1 = invoice.addPage([595, 842]);
text(p1, 'BRACKEN & BLUE', 46, 771, 24, true, accent);
text(p1, 'Bracken & Blue Workshop', 46, 741, 14);
text(p1, 'INVOICE', 435, 771, 19, true);
text(p1, 'Invoice number  BBw-260901-73', 46, 684, 13, true);
text(p1, 'Invoice date  September 1, 2026', 46, 657, 12);
text(p1, 'Currency  GBP', 46, 630, 12);
text(p1, 'Billed to: Tern House Events', 46, 583, 12);
text(p1, 'Seasonal dining supplies', 46, 556, 11, false, muted);
table(p1, items.slice(0, 3), 496);
right(p1, 'Page 1 items subtotal: GBP 237.60', 538, 263, 12, true);
text(p1, 'Three further charges continue on page 2.', 46, 217, 12);
text(p1, 'This is a fictional invoice for extraction evaluation.', 46, 70, 9, false, muted);
right(p1, '1 / 2', 549, 44, 10);
const p2 = invoice.addPage([595, 842]);
text(p2, 'Invoice BBw-260901-73', 46, 772, 21, true, accent);
text(p2, 'Continued itemized charges', 46, 739, 13);
text(p2, 'Brought forward from page 1: GBP 237.60', 46, 685, 12);
table(p2, items.slice(3), 624);
right(p2, 'Subtotal  GBP 301.00', 538, 358, 14, true);
right(p2, 'Tax (20%)  GBP 60.20', 538, 327, 13);
rule(p2, 306);
right(p2, 'TOTAL DUE  GBP 361.20', 538, 274, 19, true);
text(p2, 'Payment requested within 14 days of invoice date.', 46, 211, 11);
text(p2, 'This is a fictional invoice for extraction evaluation.', 46, 70, 9, false, muted);
right(p2, '2 / 2', 549, 44, 10);
await writeFile(join(out, 'bracken-blue-invoice.pdf'), await invoice.save({ useObjectStreams: false }));

const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function receiptSvg(title, subtitle, lines, footer) {
  const height = 350 + lines.length * 56;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}">
  <rect width="100%" height="100%" fill="#eee9dd"/>
  <rect x="34" y="25" width="932" height="${height - 50}" rx="8" fill="#fffdf7"/>
  <g fill="#172629" font-family="DejaVu Sans,Arial,sans-serif">
  <text x="500" y="105" text-anchor="middle" font-size="42" font-weight="700">${escapeXml(title)}</text>
  <text x="500" y="153" text-anchor="middle" font-size="25">${escapeXml(subtitle)}</text>
  <path d="M84 189H916" stroke="#82908b" stroke-width="2" stroke-dasharray="8 7"/>
  ${lines.map((line, i) => `<text x="86" y="${242 + i * 56}" font-size="${line.startsWith('TOTAL') ? 35 : 28}" ${line.startsWith('TOTAL') ? 'font-weight="700"' : ''}>${escapeXml(line)}</text>`).join('\n')}
  <text x="500" y="${height - 65}" text-anchor="middle" font-size="21" fill="#626b67">${escapeXml(footer)}</text>
  </g></svg>`;
}
const frSvg = receiptSvg('Épicerie des Lucioles', 'TICKET DE CAISSE · Boutique fictive', [
  'Achat du 2 septembre 2026 à 10:43',
  'Café moulu                                      8,40 €',
  'Miel de lavande                             12,90 €',
  'Infusion verveine                             7,60 €',
  'Biscottes                                        5,80 €',
  'Pâte de fruits                                   8,00 €',
  'TOTAL À PAYER                           42,70 EUR',
  'TVA incluse                                     2,23 €',
  'Réglé par carte · Merci de votre visite',
], 'Document synthétique · aucune transaction réelle');
await writeFile(join(previews, 'lucioles-source.svg'), frSvg);
const frenchBytes = await sharp(Buffer.from(frSvg)).png({ compressionLevel: 9 }).toBuffer();
await writeFile(join(out, 'lucioles-receipt.png'), frenchBytes);

const noDateSvg = receiptSvg('Moss Lantern Books', 'SALES RECEIPT · Fictional bookshop', [
  'Receipt ref. MLB-K73',
  'Pocket field guide                              18.00',
  'Recycled-paper journal                        9.50',
  'TOTAL PAID                              EUR 27.50',
  'Paid in cash',
  'Transaction date: not recorded',
  'No purchase date is available on this receipt.',
], 'Synthetic receipt · no real transaction');
await writeFile(join(previews, 'moss-lantern-source.svg'), noDateSvg);
const noDateBytes = await sharp(Buffer.from(noDateSvg)).png({ compressionLevel: 9 }).toBuffer();
await writeFile(join(previews, 'moss-lantern-image.png'), noDateBytes);
const imagePdf = await PDFDocument.create();
pdfMetadata(imagePdf, 'Synthetic receipt with transaction date absent');
const embeddedImage = await imagePdf.embedPng(noDateBytes);
const imagePage = imagePdf.addPage([595, embeddedImage.height * 595 / embeddedImage.width]);
imagePage.drawImage(embeddedImage, { x: 0, y: 0, width: 595, height: imagePage.getHeight() });
await writeFile(join(out, 'moss-lantern-undated.pdf'), await imagePdf.save({ useObjectStreams: false }));

const leadMessage = 'We are opening a second ceramics studio and need a booking system that can keep the two workshop calendars separate. Could you send a written outline of your team plan and whether attendees can move their own reservations?\n\nOur first classes begin in November. I can share our current spreadsheet by email; a reply with pricing and setup steps would be ideal.';
const leadEmail = [
  'From: Nina Calder <Nina.Calder@example.com>',
  'To: Enquiries <enquiries@example.org>',
  'Date: Fri, 4 Sep 2026 09:17:00 +0100',
  'Subject: Two studios and a shared booking process',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  leadMessage,
  '',
  '-- ',
  'Nina Calder',
  'Studio coordinator | Little Heron Ceramics',
  'Nina.Calder@example.com',
  '',
].join('\n').replaceAll('\n', '\r\n');
await writeFile(join(out, 'studio-enquiry.eml'), leadEmail);
await writeFile(join(out, 'harbour-freeform-receipt.txt'), 'Synthetic purchase record\n\nThanks for stopping by Harbour Kettle Kitchen. On September 4, 2026, you paid GBP 27.65 by debit card for two takeaway lunches and a bottle of sparkling water. That amount is the final charge, including all tax. Nothing remains to be paid.\n\nWe hope to see you again.\n');
await writeFile(join(out, 'broken-receipt.pdf'), Buffer.from('%PDF-1.7\n% intentionally malformed synthetic PDF; no readable transaction data\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R\nstream\nTRUNCATED\n', 'ascii'));
await copyFile(join(out, 'lucioles-receipt.png'), join(out, 'lucioles-receipt-copy.png'));

const fixtures = [
  {
    id: 'two-page-native-invoice', filename: 'bracken-blue-invoice.pdf', mimeType: 'application/pdf', locale: 'en-GB', useCase: 'invoice', category: 'native_pdf_continued_line_items',
    expected: { invoice_number: 'BBw-260901-73', supplier: 'Bracken & Blue Workshop', invoice_date: '2026-09-01', currency: 'GBP', subtotal: 301, tax: 60.2, total: 361.2, line_items: items },
    expectedOutcome: 'needs_review',
    notes: 'Exactly two native-text pages. The six line items span both pages; the page-1 subtotal and brought-forward amount are not extra items or the invoice subtotal.',
  },
  {
    id: 'french-image-receipt', filename: 'lucioles-receipt.png', mimeType: 'image/png', locale: 'fr-FR', useCase: 'receipt', category: 'image_french_decimal_written_date',
    expected: { merchant: 'Épicerie des Lucioles', date: '2026-09-02', currency: 'EUR', total: 42.7 },
    expectedOutcome: 'needs_review', notes: 'Visible source date: 2 septembre 2026. Visible source total: 42,70 EUR. Preserve merchant accents and casing.',
  },
  {
    id: 'image-pdf-absent-date', filename: 'moss-lantern-undated.pdf', mimeType: 'application/pdf', locale: 'en-IE', useCase: 'receipt', category: 'image_only_pdf_missing_required_date',
    expected: { merchant: 'Moss Lantern Books', date: null, currency: 'EUR', total: 27.5 },
    expectedOutcome: 'needs_review', expectedMissingFields: ['date'],
    notes: 'The only page embeds one raster image and has no text layer. The visible source explicitly says the transaction date was not recorded. PDF creation metadata is not a transaction date.',
  },
  {
    id: 'narrative-lead-email', filename: 'studio-enquiry.eml', mimeType: 'message/rfc822', locale: 'en-GB', useCase: 'leads', category: 'narrative_email_multiline_message',
    expected: { name: 'Nina Calder', email: 'Nina.Calder@example.com', company: 'Little Heron Ceramics', message: leadMessage },
    expectedOutcome: 'needs_review',
    notes: 'Message is the two request paragraphs before the standard -- signature separator; preserve the paragraph break. Name/email appear in From and signature. Company appears in signature. There is no lowercase transform in the preset, so preserve the email casing.',
  },
  {
    id: 'english-freeform-receipt', filename: 'harbour-freeform-receipt.txt', mimeType: 'text/plain', locale: 'en-GB', useCase: 'receipt', category: 'freeform_english_receipt',
    expected: { merchant: 'Harbour Kettle Kitchen', date: '2026-09-04', currency: 'GBP', total: 27.65 },
    expectedOutcome: 'needs_review', notes: 'Receipt information is expressed as prose with no labelled fields.',
  },
  {
    id: 'malformed-pdf', filename: 'broken-receipt.pdf', mimeType: 'application/pdf', locale: 'en-GB', useCase: 'receipt', category: 'malformed_pdf',
    expected: { merchant: null, date: null, currency: null, total: null },
    expectedOutcome: 'failed',
    notes: 'Deliberately truncated PDF object without a usable page tree, closing dictionary, xref, or trailer. No extraction should be fabricated; nulls document the absence of schema values, not a successful extraction expectation.',
  },
  {
    id: 'french-image-receipt-duplicate', filename: 'lucioles-receipt-copy.png', mimeType: 'image/png', locale: 'fr-FR', useCase: 'receipt', category: 'exact_duplicate_identity',
    expected: { merchant: 'Épicerie des Lucioles', date: '2026-09-02', currency: 'EUR', total: 42.7 },
    expectedOutcome: 'needs_review', duplicateOf: 'french-image-receipt',
    notes: 'Exact byte copy under a new filename. Repeated extraction assesses identical-input consistency only; actual intake deduplication must be evaluated separately.',
  },
];
for (const fixture of fixtures) {
  const bytes = await readFile(join(out, fixture.filename));
  fixture.sourceSha256 = createHash('sha256').update(bytes).digest('hex');
  fixture.sizeBytes = bytes.length;
}
const manifest = {
  authoredOn: '2026-09-07',
  finalizedAt: new Date().toISOString(),
  synthetic: true,
  authoringIsolation: 'Authored using shared/presets.ts, shared/types.ts and package.json only. No extraction implementation, existing fixtures, tests, reports, model calls, APIs or database were inspected or used.',
  expectedConvention: 'Complete schema values after type normalization: date fields use YYYY-MM-DD; numbers use JSON numbers; absent data is null; string values retain visible source casing and accents. No preset has a transform. Exact email message expectation excludes the standard signature block.',
  reproduction: 'From repository root: node docs/evidence/heldout-ai-2026-09-07/generate.mjs. Requires installed pdf-lib and sharp. PDF metadata dates and content are fixed; PNG rendering uses the installed system font stack, so bit identity across different font/runtime environments is not guaranteed.',
  fixtures,
};
await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ manifest: join(out, 'manifest.json'), documents: fixtures.length, fixtures: fixtures.map(({ id, filename, sourceSha256, sizeBytes }) => ({ id, filename, sourceSha256, sizeBytes })) }, null, 2));
