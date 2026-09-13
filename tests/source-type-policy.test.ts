import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { decodeSource } from '../server/core/decoder-engine.js';

const textNames = ['renamed.txt', 'renamed.csv', 'renamed.html', 'renamed.eml'];
const rejection = (error: any) => error.statusCode === 400;

// A normal, uncompressed ASCII PDF demonstrates why UTF-8 validation alone is
// insufficient to establish that an original is a text document.
function asciiPdf(): Buffer {
  const content = 'BT /F1 12 Tf 40 80 Td (Owned classification receipt) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test('valid ASCII PDF bytes keep PDF identity under every text suffix', async () => {
  const bytes = asciiPdf(), original = Buffer.from(bytes);
  assert.doesNotThrow(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.equal(bytes.includes(0), false);
  for (const filename of textNames) {
    const source = await decodeSource(bytes, filename);
    assert.equal(source.mimeType, 'application/pdf', filename);
    assert.equal(source.pageCount, 1);
    assert.match(source.pages[0].text, /Owned classification receipt/);
  }
  assert.deepEqual(bytes, original);
});

test('PNG and JPEG originals retain actual image identity despite renamed or conflicting suffixes', async () => {
  for (const [fixture, mimeType] of [
    ['fixtures/generated/receipt-scan.png', 'image/png'],
    ['fixtures/source-formats/receipt-image.jpg', 'image/jpeg'],
  ]) {
    const bytes = await fs.readFile(fixture), original = Buffer.from(bytes);
    for (const filename of [...textNames, 'renamed.pdf', 'renamed.unknown']) {
      const source = await decodeSource(bytes, filename);
      assert.equal(source.mimeType, mimeType, filename);
      assert.deepEqual(source.pages, [{ page: 1, text: '' }]);
    }
    assert.deepEqual(bytes, original);
  }
});

test('validated Office containers select DOCX or XLSX from package contents before filename', async () => {
  for (const [fixture, mimeType] of [
    ['fixtures/generated/receipt.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['fixtures/generated/receipt.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ]) {
    const bytes = await fs.readFile(fixture), original = Buffer.from(bytes);
    for (const filename of [...textNames, 'renamed.docx', 'renamed.xlsx']) {
      const source = await decodeSource(bytes, filename);
      assert.equal(source.mimeType, mimeType, filename);
      assert.ok(source.pages.some(page => /Merchant/.test(page.text)));
    }
    assert.deepEqual(bytes, original);
  }
});

test('ordinary ZIP packages cannot masquerade as supported text or Office input', async () => {
  const zip = new JSZip(); zip.file('notes.txt', 'Owned harmless notes');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  for (const filename of [...textNames, 'renamed.docx', 'renamed.xlsx']) {
    await assert.rejects(decodeSource(bytes, filename), (error: any) => rejection(error) && /archive.*DOCX.*XLSX/i.test(error.message));
  }
});

test('ambiguous Office roots and incomplete Office archives are rejected without text fallback', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>'); zip.file('_rels/.rels', '<Relationships/>');
  zip.file('word/document.xml', '<document/>'); zip.file('xl/workbook.xml', '<workbook/>');
  await assert.rejects(decodeSource(await zip.generateAsync({ type: 'nodebuffer' }), 'ambiguous.txt'), rejection);
  for (const extension of ['docx', 'xlsx']) {
    const bytes = await fs.readFile(`fixtures/source-formats/incomplete.${extension}`);
    await assert.rejects(decodeSource(bytes, 'renamed.txt'), rejection);
  }
});

async function officeDirectoryFixture() {
  const bytes = await fs.readFile('fixtures/generated/receipt.docx');
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  assert.ok(end >= 0);
  const directory = bytes.readUInt32LE(end + 16);
  assert.equal(bytes.readUInt32LE(directory), 0x02014b50);
  const local = bytes.readUInt32LE(directory + 42);
  assert.equal(bytes.readUInt32LE(local), 0x04034b50);
  assert.ok(bytes.readUInt16LE(local + 26) > 0);
  return { bytes, end, directory, local };
}

const controlledArchiveRejection = (error: any) =>
  !(error instanceof RangeError) && [400, 413].includes(error.statusCode);

test('Office local names and flags must agree with the central directory', async () => {
  const { bytes, local } = await officeDirectoryFixture();
  const changedName = Buffer.from(bytes);
  changedName[local + 30] ^= 1;
  const changedFlags = Buffer.from(bytes);
  changedFlags.writeUInt16LE(changedFlags.readUInt16LE(local + 6) ^ 0x0800, local + 6);
  for (const [label, changed] of [['local filename', changedName], ['local flags', changedFlags]] as const) {
    await assert.rejects(decodeSource(changed, 'renamed.txt'), error =>
      controlledArchiveRejection(error) && /metadata does not match/.test((error as Error).message), label);
  }
});

test('Office truncation and invalid directory or local offsets reject without raw buffer errors', async () => {
  const { bytes, end, directory } = await officeDirectoryFixture();
  const invalidDirectory = Buffer.from(bytes);
  invalidDirectory.writeUInt32LE(invalidDirectory.readUInt32LE(end + 12) + 1, end + 12);
  const invalidLocal = Buffer.from(bytes);
  invalidLocal.writeUInt32LE(0xfffffff0, directory + 42);
  for (const [label, changed] of [
    ['truncated footer', bytes.subarray(0, bytes.length - 8)],
    ['directory bounds', invalidDirectory],
    ['local offset beyond file', invalidLocal],
  ] as const) {
    await assert.rejects(decodeSource(changed, 'renamed.csv'), controlledArchiveRejection, label);
  }
});

test('Office declared expansion above the cap is rejected before decompression', async () => {
  const { bytes, directory } = await officeDirectoryFixture();
  // Change only the size declaration in this small owned document. No large
  // payload is allocated, compressed or expanded by this regression fixture.
  const declaredOversize = Buffer.from(bytes);
  declaredOversize.writeUInt32LE(40 * 1024 * 1024 + 1, directory + 24);
  await assert.rejects(decodeSource(declaredOversize, 'renamed.html'), error =>
    controlledArchiveRejection(error) && /Expanded office file exceeds the 40 MB limit/.test((error as Error).message));
});

test('real unsupported image and compressed formats are rejected under text suffixes', async () => {
  const image = sharp({ create: { width: 8, height: 8, channels: 3, background: '#eeeeee' } });
  const examples = [await image.clone().gif().toBuffer(), await image.clone().webp().toBuffer(), gzipSync('Owned compressed text')];
  for (const bytes of examples) {
    for (const filename of textNames) {
      await assert.rejects(decodeSource(bytes, filename), (error: any) => rejection(error) && /binary file type.*not supported/.test(error.message));
    }
  }
});

test('recognized malformed binary content fails its decoder instead of being accepted as text', async () => {
  for (const bytes of [
    Buffer.from('%PDF-1.7\nOwned incomplete PDF fixture'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0x50, 0x4b, 3, 4]),
  ]) {
    await assert.rejects(decodeSource(bytes, 'renamed.txt'), rejection);
  }
  await assert.rejects(decodeSource(Buffer.concat([Buffer.from(' \n'), asciiPdf()]), 'renamed.txt'), rejection);
});

test('ordinary UTF-8 text and CSV preserve accents, BOM, emoji and line separators', async () => {
  const content = 'Merchant: Café 明日 🌿\r\nTotal: 18.60\tEUR\nNotes: first\fsecond';
  for (const [filename, mimeType] of [['receipt.txt', 'text/plain'], ['receipt.csv', 'text/csv']]) {
    const source = await decodeSource(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]), filename);
    assert.equal(source.mimeType, mimeType);
    assert.equal(source.pages[0].text, content);
  }
});

test('control bytes and unsupported text encodings do not create a text MIME result', async () => {
  for (const bytes of [Buffer.from('Text\x00data'), Buffer.from('Text\x01data'), Buffer.from('Text\x1bdata'), Buffer.from('Text\x7fdata'), Buffer.from([0xff, 0xfe, 0x41, 0])]) {
    for (const filename of textNames) await assert.rejects(decodeSource(bytes, filename), rejection);
  }
});

test('unambiguous HTML document structure overrides misleading text suffixes', async () => {
  for (const markup of [
    '<!DOCTYPE html><html><body><p>Merchant: Cedar &amp; Pine</p><p>Total: 18.60</p></body></html>',
    '\ufeff\n<!-- owned harmless comment -->\n<HTML lang="en"><body><p>Merchant: Cedar &amp; Pine</p><p>Total: 18.60</p></body></HTML>',
    '<?xml version="1.0"?><html><body><p>Merchant: Cedar &amp; Pine</p><p>Total: 18.60</p></body></html>',
  ]) {
    for (const filename of textNames) {
      const source = await decodeSource(Buffer.from(markup), filename);
      assert.equal(source.mimeType, 'text/html');
      assert.match(source.pages[0].text, /Merchant: Cedar & Pine/);
      assert.match(source.pages[0].text, /Total: 18.60/);
      assert.ok(!source.pages[0].text.includes('<body>'));
    }
  }
});

test('recognizable MIME email retains email processing when renamed', async () => {
  for (const fixture of ['fixtures/generated/lead.eml', 'fixtures/source-formats/receipt-html-only.eml', 'fixtures/source-formats/receipt-alternative.eml']) {
    const bytes = await fs.readFile(fixture);
    const expected = await decodeSource(bytes, 'original.eml');
    assert.equal(expected.mimeType, 'message/rfc822');
    for (const filename of ['renamed.txt', 'renamed.csv', 'renamed.html']) {
      assert.deepEqual(await decodeSource(bytes, filename), expected);
    }
  }
});

test('HTML preambles recognize comments before and after one XML declaration', async () => {
  const body = '<html><body><p>Merchant: Cedar &amp; Pine</p><p>Total: 18.60</p></body></html>';
  for (const preamble of [
    '<?xml version="1.0"?>\n<!-- owned comment -->\n',
    '<!-- first -->\n<?xml version="1.0"?>\n<!-- second -->\n<!-- third -->\n',
  ]) {
    for (const filename of textNames) {
      const source = await decodeSource(Buffer.from(preamble + body), filename);
      assert.equal(source.mimeType, 'text/html', filename);
      assert.match(source.pages[0].text, /Merchant: Cedar & Pine/);
      assert.match(source.pages[0].text, /Total: 18.60/);
      assert.ok(!source.pages[0].text.includes('<html>'));
    }
  }
});

test('From-address and Date labels remain intact text without MIME markers', async () => {
  const prose = 'From: supplier@example.test\nDate: 2026-09-13\n\nReceipt total: 18.60 EUR';
  for (const [filename, mimeType] of [['receipt.txt', 'text/plain'], ['receipt.csv', 'text/csv']]) {
    for (const prefix of ['', 'MIME-Version: 1.0\n', 'Content-Type: text/plain\n']) {
      const content = prefix + prose;
      const source = await decodeSource(Buffer.from(content), filename);
      assert.equal(source.mimeType, mimeType);
      assert.equal(source.pages[0].text, content);
    }
  }
  // An explicit .eml filename still permits older email without MIME headers.
  const email = await decodeSource(Buffer.from(prose), 'receipt.eml');
  assert.equal(email.mimeType, 'message/rfc822');
  assert.match(email.pages[0].text, /Receipt total: 18\.60 EUR/);
});

test('ambiguous fragments and labelled prose keep extension-informed text classification', async () => {
  const prose = 'From: Warehouse\nTo: Dispatch\nSubject: Receipt\n\nMerchant: Cedar & Pine';
  assert.equal((await decodeSource(Buffer.from(prose), 'receipt.txt')).mimeType, 'text/plain');
  assert.equal((await decodeSource(Buffer.from('merchant,total\nCedar,18.60'), 'receipt.txt')).mimeType, 'text/plain');
  assert.equal((await decodeSource(Buffer.from('merchant,total\nCedar,18.60'), 'receipt.csv')).mimeType, 'text/csv');
  const fragment = '<p>Merchant: Cedar &amp; Pine</p>';
  assert.equal((await decodeSource(Buffer.from(fragment), 'receipt.txt')).pages[0].text, fragment);
  assert.equal((await decodeSource(Buffer.from(fragment), 'receipt.html')).pages[0].text, 'Merchant: Cedar & Pine');
});


test('leading document whitespace cannot hide HTML and oversized recognizable email headers fail closed', async () => {
  const html = Buffer.from(' '.repeat(70_000) + '<!doctype html><html><body>Owned padded HTML</body></html>');
  const source = await decodeSource(html, 'renamed.txt');
  assert.equal(source.mimeType, 'text/html');
  assert.equal(source.pages[0].text, 'Owned padded HTML');
  const email = Buffer.from('X-Owned-Note: ' + 'n'.repeat(66_000) + '\r\nFrom: sender@example.test\r\nTo: receiver@example.test\r\nMIME-Version: 1.0\r\nContent-Type: text/plain\r\n\r\nOwned body');
  await assert.rejects(decodeSource(email, 'renamed.txt'), (error: any) => rejection(error) && /Email headers exceed/.test(error.message));
});
