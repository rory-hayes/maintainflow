import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeValue } from '../server/core/extraction.js';
import { validateValues } from '../server/core/schema.js';
const field = { key: 'date', label: 'Date', type: 'date' as const, required: true };

test('Written months normalize deterministically using the parser locale without changing raw source', () => {
  for (const [source, locale, expected] of [
    ['24 August 2026', 'en-IE', '2026-08-24'], ['August 24th, 2026', 'en-US', '2026-08-24'],
    ['17. September 2026', 'de-DE', '2026-09-17'], ['24 août 2026', 'fr-FR', '2026-08-24'],
    ['24 sierpnia 2026', 'pl-PL', '2026-08-24'], ['17 Sept 2026', 'en-IE', '2026-09-17'],
  ]) assert.equal(normalizeValue(source, field, locale), expected);
});

test('Written-date normalization does not roll over invalid dates or guess foreign/ambiguous months', () => {
  const date = normalizeValue('31 February 2026', field, 'en-IE');
  assert.equal(date, '2026-02-31');
  assert.ok(validateValues({ date }, { fields: [field] }).some(issue => issue.code === 'date'));
  assert.equal(normalizeValue('24 août 2026', field, 'en-IE'), '24 août 2026');
  assert.equal(normalizeValue('last Thursday', field, 'en-IE'), 'last Thursday');
  assert.equal(normalizeValue('15 Nisan 5786', field, 'en-US-u-ca-hebrew'), '15 Nisan 5786');
});
