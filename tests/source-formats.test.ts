import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { inspectSource } from '../server/core/source.js';
import { extractRules } from '../server/core/extraction.js';
import { presets } from '../shared/presets.js';

const folder = 'fixtures/source-formats';

test('real small JPEG metadata is readable and decoding preserves original bytes without invented OCR', async () => {
  const bytes = await fs.readFile(`${folder}/receipt-image.jpg`), original = Buffer.from(bytes);
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.width, 480); assert.equal(metadata.height, 240);
  const source = await inspectSource(bytes, 'receipt-image.jpg');
  assert.equal(source.mimeType, 'image/jpeg'); assert.equal(source.pageCount, 1);
  assert.deepEqual(source.pages, [{ page: 1, text: '' }]);
  assert.deepEqual(bytes, original);
  const extracted = extractRules(source.pages, { fields: presets.receipt.fields }, 'en-IE');
  assert.equal(extracted.rawValues.merchant, null); assert.equal(extracted.rawValues.total, null);
  assert.deepEqual(extracted.evidence, {});
});

test('real image-only PDF has one page, unchanged bytes and no fabricated native text', async () => {
  const bytes = await fs.readFile(`${folder}/receipt-image-only.pdf`), original = Buffer.from(bytes);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const source = await inspectSource(bytes, 'receipt-image-only.pdf');
  assert.equal(source.mimeType, 'application/pdf'); assert.equal(source.pageCount, 1);
  assert.deepEqual(source.pages, [{ page: 1, text: '' }]);
  assert.deepEqual(bytes, original);
});

test('HTML text preserves entities, line breaks and separate list items while omitting script and style content', async () => {
  const bytes = await fs.readFile(`${folder}/receipt.html`), original = Buffer.from(bytes);
  const source = await inspectSource(bytes, 'receipt.html');
  assert.equal(source.mimeType, 'text/html'); assert.equal(source.pageCount, 1);
  const text = source.pages[0].text;
  assert.ok(!text.includes('OMIT_SCRIPT_FIXTURE')); assert.ok(!text.includes('OMIT_STYLE_FIXTURE'));
  assert.match(text, /Merchant: Cedar & Pine/);
  assert.match(text, /Reference: "000042" <draft>/);
  assert.match(text, /Entities: 'quoted' €18\.60 © 2026[\s\u00a0]records/);
  assert.match(text, /Message: Preserve this line\.\nKeep this second line\./);
  assert.match(text, /First unordered item[^\S\n]*\n[^\n]*Second unordered item/);
  assert.match(text, /First ordered item[^\S\n]*\n[^\n]*Second ordered item/);
  assert.ok(text.indexOf('First ordered item') < text.indexOf('Second ordered item'));
  assert.deepEqual(bytes, original);
  const extracted = extractRules(source.pages, { fields: [
    { key: 'merchant', label: 'Merchant', type: 'string' },
    { key: 'message', label: 'Message', type: 'multiline' },
    { key: 'total', label: 'Total', type: 'currency' },
  ] }, 'en-IE');
  assert.equal(extracted.normalizedValues.merchant, 'Cedar & Pine');
  assert.equal(extracted.normalizedValues.message, 'Preserve this line.\nKeep this second line.');
  assert.equal(extracted.normalizedValues.total, 18.6);
});

for (const extension of ['docx', 'xlsx']) {
  test(`harmless incomplete ${extension.toUpperCase()} package is rejected rather than accepted as a document`, async () => {
    const bytes = await fs.readFile(`${folder}/incomplete.${extension}`), original = Buffer.from(bytes);
    await assert.rejects(inspectSource(bytes, `incomplete.${extension}`), (error: any) => error.statusCode === 400 && /office|DOCX|XLSX/i.test(error.message));
    assert.deepEqual(bytes, original);
  });
}

test('stored JPEG and image-only PDF originals remain retrievable after explicit provider-needed worker failure', async () => {
  const { randomUUID, createHash } = await import('node:crypto');
  const path = await import('node:path');
  const { buildApp } = await import('../server/app.js');
  const { adminPool, closeDatabase } = await import('../server/core/db.js');
  const { addDocument } = await import('../server/core/intake.js');
  const { processOneCoreJob } = await import('../server/core/worker.js');
  const { config } = await import('../server/core/config.js');
  const app = await buildApp();
  let workspaceId: string | undefined, userId: string | undefined;
  try {
    const signup = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
      name: 'Owned image format fixture', email: `formats-${randomUUID()}@example.test`, password: 'owned image format fixture password', workspaceName: 'Owned image format fixture',
    } });
    assert.equal(signup.statusCode, 201, signup.body);
    const account = signup.json(); workspaceId = account.workspace.id; userId = account.user.id;
    const headers = { origin: config.origin, cookie: signup.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
    const parserReply = await app.inject({ method: 'POST', url: '/api/parsers', headers, payload: { name: 'Owned image receipt parser', useCase: 'receipt', mode: 'rules' } });
    assert.equal(parserReply.statusCode, 201, parserReply.body);
    for (const [filename, mimeType] of [['receipt-image.jpg', 'image/jpeg'], ['receipt-image-only.pdf', 'application/pdf']]) {
      const bytes = await fs.readFile(`${folder}/${filename}`);
      const intake = await addDocument({ userId: userId!, workspaceId: workspaceId!, role: 'owner', authType: 'session' }, parserReply.json().parser.id, bytes, filename);
      assert.equal(intake.document.mimeType, mimeType);
      assert.equal(Number(intake.document.byteSize), bytes.length);
      assert.equal(intake.document.pageCount, 1);
      assert.equal(intake.document.sha256, createHash('sha256').update(bytes).digest('hex'));
      // This test cannot claim any other fixture or browser job.
      assert.equal(await processOneCoreJob(intake.jobId), true);
      const detail = await app.inject({ method: 'GET', url: `/api/documents/${intake.document.id}`, headers });
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().document.status, 'failed');
      assert.match(detail.json().document.error, /no readable text.*require a configured OCR\/AI provider/);
      assert.deepEqual(detail.json().document.sourceText, [{ page: 1, text: '' }]);
      assert.equal(detail.json().runs.length, 0);
      assert.equal(detail.json().jobs[0].state, 'failed');
      assert.equal(detail.json().jobs[0].attempts, 1);
      const original = await app.inject({ method: 'GET', url: `/api/documents/${intake.document.id}/original`, headers });
      assert.equal(original.statusCode, 200, original.body);
      assert.equal(original.headers['content-type'], mimeType);
      assert.match(String(original.headers['cache-control']), /private/);
      assert.deepEqual(original.rawPayload, bytes);
    }
  } finally {
    await app.close();
    if (workspaceId) {
      await adminPool.query('delete from workspaces where id=$1', [workspaceId]);
      await fs.rm(path.join(config.storageDir, workspaceId), { recursive: true, force: true });
    }
    if (userId) await adminPool.query('delete from users where id=$1', [userId]);
    await closeDatabase();
  }
});

test('HTML extraction does not wrap long scalar values, uppercase headings or append link destinations', async () => {
  const bytes = await fs.readFile(`${folder}/receipt-long.html`);
  const source = await inspectSource(bytes, 'receipt-long.html');
  const merchant = 'Cedar and Pine Office Supplies and Workspace Furnishings Trading Company Limited';
  assert.match(source.pages[0].text, new RegExp(`Merchant: ${merchant}`));
  assert.ok(!source.pages[0].text.includes('https://example.test'));
  const result = extractRules(source.pages, { fields: presets.receipt.fields }, 'en-IE');
  assert.equal(result.rawValues.merchant, merchant);
  assert.equal(result.normalizedValues.merchant, merchant);
  assert.equal(result.normalizedValues.total, 18.6);
});

test('flat HTML tables retain row and cell boundaries and yield separately typed scalar values', async () => {
  const bytes = await fs.readFile(`${folder}/receipt-table.html`);
  const source = await inspectSource(bytes, 'receipt-table.html');
  assert.match(source.pages[0].text, /Merchant \| Total\nCedar & Pine \| 18\.60/);
  const result = extractRules(source.pages, { fields: presets.receipt.fields }, 'en-IE');
  assert.equal(result.rawValues.merchant, 'Cedar & Pine');
  assert.equal(result.rawValues.total, '18.60');
  assert.equal(result.normalizedValues.total, 18.6);
  assert.equal(result.evidence.merchant[0].page, 1);
  assert.equal(result.evidence.merchant[0].text, 'Merchant | Total\nCedar & Pine | 18.60');
});

test('HTML-only EML shares extraction-oriented long-value and flat-table conversion', async () => {
  const bytes = await fs.readFile(`${folder}/receipt-html-only.eml`), original = Buffer.from(bytes);
  const source = await inspectSource(bytes, 'receipt-html-only.eml');
  assert.equal(source.mimeType, 'message/rfc822'); assert.equal(source.pageCount, 1);
  const merchant = 'Cedar and Pine Office Supplies and Workspace Furnishings Trading Company Limited';
  assert.match(source.pages[0].text, new RegExp(`Merchant: ${merchant}`));
  assert.match(source.pages[0].text, /Merchant \| Total\nCedar & Pine \| 18\.60/);
  assert.ok(!source.pages[0].text.includes('https://example.test'));
  const result = extractRules(source.pages, { fields: presets.receipt.fields }, 'en-IE');
  assert.equal(result.rawValues.merchant, merchant);
  assert.equal(result.normalizedValues.total, 18.6);
  assert.deepEqual(bytes, original);
});

test('multipart EML prefers the actual plain-text body over conflicting HTML values', async () => {
  const bytes = await fs.readFile(`${folder}/receipt-alternative.eml`), original = Buffer.from(bytes);
  const source = await inspectSource(bytes, 'receipt-alternative.eml');
  const result = extractRules(source.pages, { fields: presets.receipt.fields }, 'en-IE');
  assert.equal(result.rawValues.merchant, 'Plain Body Preferred');
  assert.equal(result.normalizedValues.total, 7.5);
  assert.ok(!source.pages[0].text.includes('Conflicting HTML Body'));
  assert.deepEqual(bytes, original);
});
