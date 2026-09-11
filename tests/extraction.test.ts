import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { extractRules, normalizeValue } from '../server/core/extraction.js';
import { validateValues } from '../server/core/schema.js';
import { presets } from '../shared/presets.js';
import type { ParserSchema, SchemaField } from '../shared/types.js';

const message: SchemaField = { key: 'message', label: 'Message', type: 'multiline', required: true };
const run = (text: string, fields: SchemaField[] = [message]) => extractRules([{ page: 1, text }], { fields }, 'en-IE');

test('stock lead fixture preserves three message lines, the following company and exact page evidence', async () => {
  const text = await fs.readFile('fixtures/browser-multiline/lead-message.txt', 'utf8');
  const expected = JSON.parse(await fs.readFile('fixtures/browser-multiline/expected.json', 'utf8'));
  const result = run(text, presets.leads.fields);
  assert.deepEqual(result.rawValues, expected.expectedValues);
  assert.deepEqual(result.normalizedValues, expected.expectedValues);
  assert.deepEqual(result.evidence.message, [expected.expectedMessageEvidence]);
  assert.equal(result.model, 'deterministic-v2');
  assert.equal(result.engine, 'text-anchors');
  assert.deepEqual(result.issues, []);
});

test('multiline transforms preserve raw spacing, internal newlines and untouched source evidence', () => {
  const result = run('Message: First line  \n  Second line  \nLast line  \n\nFooter', [{ ...message, transform: 'uppercase' }]);
  assert.equal(result.rawValues.message, 'First line  \n  Second line  \nLast line  ');
  assert.equal(result.normalizedValues.message, 'FIRST LINE  \n  SECOND LINE  \nLAST LINE');
  assert.deepEqual(result.evidence.message, [{ page: 1, text: 'Message: First line  \n  Second line  \nLast line  ' }]);
});

test('anchor-only multiline values end at nested field anchors and preserve address lines', () => {
  const result = run('Message:\n42 Orchard Road\nDublin 2\nContact name = Avery Lane', [message, {
    key: 'contact', label: 'Contact', type: 'object', fields: [{ key: 'name', label: 'Contact name', type: 'string' }],
  }]);
  assert.equal(result.rawValues.message, '42 Orchard Road\nDublin 2');
  assert.deepEqual(result.rawValues.contact, { name: 'Avery Lane' });
  assert.equal(result.evidence.message[0].text, 'Message:\n42 Orchard Road\nDublin 2');
});

test('blank lines stop capture while unknown colon prose and ordinary commas remain content', () => {
  const result = run('Message: Please review\nContext: retain this sentence\nTea, coffee and water\n  \nUnrelated footer');
  assert.equal(result.rawValues.message, 'Please review\nContext: retain this sentence\nTea, coffee and water');
  assert.ok(!result.evidence.message[0].text.includes('footer'));
});

test('only selected template overrides supply continuation boundaries', () => {
  const result = extractRules([{ page: 1, text: 'WILLOW FORM\nBody: First\nOld contact: this stays in the message\nContact ID: 00017' }], {
    fields: [message, { key: 'contact', label: 'Contact', type: 'string' }],
  }, 'en-IE', [
    { enabled: true, match_text: 'WILLOW FORM', rules: [{ field: 'message', anchor: 'Body' }, { field: 'contact', anchor: 'Contact ID' }] },
    { enabled: false, rules: [{ field: 'contact', anchor: 'Old contact' }] },
  ]);
  assert.equal(result.rawValues.message, 'First\nOld contact: this stays in the message');
  assert.equal(result.rawValues.contact, '00017');
  assert.deepEqual(result.issues, []);
});

test('known CSV headers and explicit pipe/tab structures stop multiline capture before table data', () => {
  const fields: SchemaField[] = [message, { key: 'items', label: 'Items', type: 'array', fields: [
    { key: 'description', label: 'Description', type: 'string' }, { key: 'amount', label: 'Amount', type: 'number' },
  ] }];
  for (const separator of [',', '|', '\t']) {
    const result = run(`Message: Please review\nKeep these notes\nDescription${separator}Amount\nPaper${separator}12`, fields);
    assert.equal(result.rawValues.message, 'Please review\nKeep these notes');
    assert.deepEqual(result.normalizedValues.items, [{ description: 'Paper', amount: 12 }]);
    assert.ok(!result.evidence.message[0].text.includes('Description'));
  }
});

test('multiline capture is page bounded and keeps the source page number', () => {
  const result = extractRules([{ page: 4, text: 'Message: Page four\nLast visible line' }, { page: 5, text: 'Unrelated next-page text\nMessage: Repeated block' }], { fields: [message] }, 'en-IE');
  assert.equal(result.rawValues.message, 'Page four\nLast visible line');
  assert.deepEqual(result.evidence.message, [{ page: 4, text: 'Message: Page four\nLast visible line' }]);
});

test('empty first block stays missing across repeated anchors; absent values retain default and required semantics', () => {
  const repeated = run('Message:\nMessage: Later block');
  assert.equal(repeated.rawValues.message, null);
  assert.deepEqual(repeated.evidence.message, [{ page: 1, text: 'Message:' }]);
  assert.ok(repeated.issues.some(issue => issue.code === 'required'));
  const absent = run('Unrelated source', [message, { key: 'state', label: 'State', type: 'string', default: 'Pending' }]);
  assert.deepEqual(absent.rawValues, { message: null, state: null });
  assert.deepEqual(absent.normalizedValues, { message: null, state: 'Pending' });
  assert.deepEqual(absent.evidence, {});
});

test('multiline size limits return a reviewable missing value instead of a silently truncated prefix', () => {
  const accepted = run('Message: Line 1\n' + Array.from({ length: 99 }, (_, index) => `Line ${index + 2}`).join('\n'));
  assert.equal((accepted.rawValues.message as string).split('\n').length, 100);
  assert.equal((run('Message:\n' + 'a'.repeat(65_536)).rawValues.message as string).length, 65_536);
  for (const text of ['Message: First\n' + Array.from({ length: 100 }, () => 'Continuation').join('\n'), 'Message: ' + 'a'.repeat(65_537)]) {
    const result = run(text);
    assert.equal(result.rawValues.message, null);
    assert.equal(result.normalizedValues.message, null);
    assert.ok(result.issues.some(issue => issue.field === 'message' && issue.code === 'multiline_limit'));
  }
});

test('CSV cell extraction of a multiline field remains a single table value', () => {
  const result = run('Message,Company\n"Please keep, this comma",Willow Research\nUnrelated text', [message, { key: 'company', label: 'Company', type: 'string' }]);
  assert.equal(result.rawValues.message, 'Please keep, this comma');
  assert.equal(result.rawValues.company, 'Willow Research');
});

test('trim, case and defaults normalize independently without replacing raw values', () => {
  const original = '  MiXeD Case  ';
  assert.equal(normalizeValue(original, { key: 'text', label: 'Text', type: 'string', transform: 'trim' }, 'en-IE'), 'MiXeD Case');
  assert.equal(original, '  MiXeD Case  ');
  const result = run('Upper: mixed Case\nLower: MIXED Case', [
    { key: 'upper', label: 'Upper', type: 'string', transform: 'uppercase' },
    { key: 'lower', label: 'Lower', type: 'string', transform: 'lowercase' },
    { key: 'missing', label: 'Missing', type: 'string', default: 'Pending', required: true },
  ]);
  assert.deepEqual(result.rawValues, { upper: 'mixed Case', lower: 'MIXED Case', missing: null });
  assert.deepEqual(result.normalizedValues, { upper: 'MIXED CASE', lower: 'mixed case', missing: 'Pending' });
  assert.deepEqual(result.issues, []);
});

test('line-item and subtotal-tax mismatches produce precise issues and corrected totals validate', () => {
  const schema: ParserSchema = { fields: presets.invoice.fields };
  const result = extractRules([{ page: 1, text: presets.invoice.sample.replace('Subtotal: 450.00', 'Subtotal: 400.00').replace('Total: 553.50', 'Total: 600.00') }], schema, 'en-IE');
  assert.equal(result.rawValues.subtotal, '400.00');
  assert.equal(result.normalizedValues.subtotal, 400);
  assert.ok(result.issues.some(issue => issue.field === 'subtotal' && issue.code === 'line_total' && /Line-item amounts/.test(issue.message)));
  assert.ok(result.issues.some(issue => issue.field === 'total' && issue.code === 'total' && /Subtotal plus tax/.test(issue.message)));
  const corrected = { ...result.normalizedValues, subtotal: 450, total: 553.5 };
  assert.deepEqual(validateValues(corrected, schema), []);
  assert.equal(result.rawValues.total, '600.00');
  assert.equal(result.normalizedValues.total, 600);
});
