import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCsvRawValues } from '../server/core/csv-values.js';
import { normalizeValue } from '../server/core/extraction.js';
import type { ParserSchema } from '../shared/types.js';

const schema: ParserSchema = { fields: [
  { key: 'merchant', label: 'Merchant', type: 'string' },
  { key: 'message', label: 'Message', type: 'multiline' },
  { key: 'total', label: 'Total', type: 'currency' },
] };
const decode = (raw: Record<string, unknown>, text: string) => decodeCsvRawValues(raw, schema, [{ page: 1, text }]);

test('CSV normalization decodes exact quoted cells with commas, line breaks, and doubled quotes', () => {
  const raw = Object.freeze({ merchant: '"Maple, Supplies"', message: '"First line\r\nSecond ""quoted"" line"', total: '"1,234.56"' });
  const result = decode(raw, 'Merchant,Message,Total\r\n"Maple, Supplies","First line\r\nSecond ""quoted"" line","1,234.56"\r\n');
  assert.deepEqual(result, { merchant: 'Maple, Supplies', message: 'First line\r\nSecond "quoted" line', total: '1,234.56' });
  assert.equal(normalizeValue(result.total, schema.fields[2], 'en-US'), 1234.56);
  assert.equal(raw.merchant, '"Maple, Supplies"');
  assert.notEqual(result, raw);
});

test('CSV normalization preserves already-decoded quoted values and arbitrary strings', () => {
  const text = 'Merchant,Message\n"""Fancy""","""A, B"""\n';
  assert.deepEqual(decode({ merchant: '"Fancy"', message: '"A, B"' }, text), { merchant: '"Fancy"', message: '"A, B"' });
  assert.deepEqual(decode({ merchant: '"""Fancy"""', message: '"""A, B"""' }, text), { merchant: '"Fancy"', message: '"A, B"' });
  const raw = { merchant: '"Not present"', message: 'prefix """Fancy""" suffix', total: 10 };
  assert.deepEqual(decode(raw, text), raw);
});

test('CSV normalization leaves ambiguous serialized-token versus decoded-cell collisions unchanged', () => {
  const raw = { merchant: '"Fancy"', message: '"""Fancy"""' };
  assert.deepEqual(decode(raw, 'One,Two\n"Fancy","""Fancy"""'), { merchant: '"Fancy"', message: '"Fancy"' });
});

test('CSV normalization requires whole cell tokens and never decodes a quoted substring', () => {
  const raw = { merchant: '"Maple, Supplies"', message: '"Fancy"' };
  assert.deepEqual(decode(raw, 'Merchant,Message\n"prefix ""Maple, Supplies"" suffix","""Fancy"""'), raw);
  assert.deepEqual(decode({ merchant: ' "Maple, Supplies" ' }, 'Merchant\n"Maple, Supplies"'), { merchant: ' "Maple, Supplies" ' });
});

test('CSV normalization fails closed for malformed CSV, including errors after valid cells', () => {
  const raw = { merchant: '"Maple, Supplies"' };
  for (const tail of ['"unterminated', 'plain"quote', '"closed"garbage', ' "leading space"', '"trailing space" ', '"broken""']) {
    assert.deepEqual(decode(raw, '"Maple, Supplies",' + tail), raw, tail);
  }
  assert.deepEqual(decodeCsvRawValues(raw, schema, [
    { page: 1, text: '"Maple, Supplies"' }, { page: 2, text: '"broken' },
  ]), raw);
});

test('CSV normalization supports BOM, empty quoted cells, and common record endings', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    assert.deepEqual(decode({ merchant: '"Maple, Supplies"', message: '""' }, '\uFEFFMerchant,Message' + ending + '"Maple, Supplies",""' + ending), { merchant: 'Maple, Supplies', message: '' });
  }
});

test('CSV normalization recurses through schema objects and array rows without mutating raw data', () => {
  const nested: ParserSchema = { fields: [
    { key: 'vendor', label: 'Vendor', type: 'object', fields: [{ key: 'name', label: 'Name', type: 'string' }] },
    { key: 'items', label: 'Items', type: 'array', fields: [
      { key: 'description', label: 'Description', type: 'string' },
      { key: 'detail', label: 'Detail', type: 'object', fields: [{ key: 'name', label: 'Name', type: 'string' }] },
    ] },
    { key: 'missing', label: 'Missing', type: 'string' },
    { key: 'constructor', label: 'Constructor', type: 'string' },
  ] };
  const raw = Object.freeze({ vendor: Object.freeze({ name: '"Maple, Supplies"', extra: '"Maple, Supplies"' }),
    items: Object.freeze([Object.freeze({ description: '"Maple, Supplies"', detail: Object.freeze({ name: '"Maple, Supplies"' }) }), null, 7]),
    unknown: '"Maple, Supplies"', constructor: '"Maple, Supplies"' });
  const result = decodeCsvRawValues(raw, nested, [{ page: 1, text: '"Maple, Supplies"' }]);
  assert.deepEqual(result, { vendor: { name: 'Maple, Supplies', extra: '"Maple, Supplies"' }, items: [{ description: 'Maple, Supplies', detail: { name: 'Maple, Supplies' } }, null, 7], unknown: '"Maple, Supplies"', constructor: 'Maple, Supplies' });
  assert.equal(raw.vendor.name, '"Maple, Supplies"');
  assert.notEqual(result.vendor, raw.vendor);
  assert.notEqual(result.items, raw.items);
  assert.equal(Object.hasOwn(result, 'missing'), false);
});

test('CSV normalization retains invalid structured shapes and non-string scalar values for validation', () => {
  const nested: ParserSchema = { fields: [
    { key: 'object', label: 'Object', type: 'object', fields: [] },
    { key: 'array', label: 'Array', type: 'array', fields: [] },
    ...schema.fields,
  ] };
  const raw = { object: '"Maple, Supplies"', array: '"Maple, Supplies"', merchant: null, message: false, total: 12 };
  assert.deepEqual(decodeCsvRawValues(raw, nested, [{ page: 1, text: '"Maple, Supplies"' }]), raw);
});

test('CSV source and traversal limits fail closed without partially changing normalization input', () => {
  const raw = { merchant: '"Maple, Supplies"' };
  assert.equal(decode(raw, '"Maple, Supplies",' + 'x'.repeat(512 * 1024)), raw);
  assert.equal(decode(raw, '"Maple, Supplies",' + ','.repeat(20_000)), raw);
  assert.equal(decodeCsvRawValues(raw, schema, Array.from({ length: 31 }, (_, i) => ({ page: i + 1, text: '"Maple, Supplies"' }))), raw);
  const many = { merchant: '"Maple, Supplies"', ...Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => ['extra' + i, i])) };
  assert.equal(decode(many, '"Maple, Supplies"'), many);
});
