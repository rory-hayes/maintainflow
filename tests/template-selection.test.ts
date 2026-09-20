import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTemplateExtraction } from '../server/core/template-selection.js';
import { extractRules } from '../server/core/extraction.js';
import { templateFieldOptions, templateLimits } from '../shared/template-selection.js';
import type { PageText, ParserSchema, SchemaField } from '../shared/types.js';

const reference: SchemaField = { key: 'reference', label: 'Reference', type: 'string', required: true };
const amount: SchemaField = { key: 'amount', label: 'Amount', type: 'currency' };
const basic: ParserSchema = { fields: [reference, amount, { key: 'note', label: 'Note', type: 'string' }] };
type SavedTemplate = {
  id: string; name: string; enabled: boolean; match_text: string;
  created_at: string; rules: { field: string; anchor: string }[];
};
const saved = (id: string, rules: SavedTemplate['rules'], extra: Partial<SavedTemplate> = {}): SavedTemplate => ({
  id, name: `Template ${id}`, enabled: true, match_text: '',
  created_at: '2026-09-01T00:00:00.000Z', rules, ...extra,
});
const pages = (text: string): PageText[] => [{ page: 1, text }];
const select = (text: string | PageText[], schema = basic, templates: unknown[] = [], mode: 'ai' | 'rules' = 'ai') =>
  selectTemplateExtraction(typeof text === 'string' ? pages(text) : text, schema, 'en-IE', templates, mode);
const anchor = (field = 'reference', value = 'Reference') => ({ field, anchor: value });
const table: SchemaField = { key: 'items', label: 'Items', type: 'array', fields: [
  { key: 'description', label: 'Description', type: 'string', required: true },
  { key: 'amount', label: 'Amount', type: 'currency', required: true },
] };

test('the most configured distinct leaf fields win, independently of phrase length or input order', () => {
  const text = 'ACORN LONG CONTRACT\nReference: 000127\nAmount: EUR 24.50';
  const broad = saved('broad', [anchor()], { match_text: 'ACORN LONG CONTRACT', created_at: '2025-01-01T00:00:00Z' });
  const precise = saved('precise', [anchor(), anchor('amount', 'Amount')], { match_text: 'ACORN' });
  for (const templates of [[broad, precise], [precise, broad]]) {
    const checked = select(text, basic, templates);
    assert.equal(checked.selection.outcome, 'template');
    assert.equal(checked.selection.reason, 'matched');
    assert.equal(checked.selection.policy, 'complete-v1');
    assert.equal(checked.selection.template?.id, 'precise');
    assert.equal(checked.selection.template?.fieldCount, 2);
    assert.equal(checked.selection.consideredTemplates, 2);
    assert.equal(checked.selection.eligibleTemplates, 2);
    assert.equal(checked.availableSourceText, true);
    assert.equal(checked.result?.rawValues.reference, '000127');
    assert.equal(checked.result?.normalizedValues.amount, 24.5);
    assert.equal(checked.result?.normalizedValues.note, null);
    assert.equal(checked.result?.engine, 'text-template');
    assert.equal(checked.result?.model, 'deterministic-v3');
    assert.equal(checked.result?.promptVersion, 'folio-text-template-v1');
    assert.ok(!checked.result?.issues.some(issue => issue.code === 'multiple_templates'));
  }
});

test('equal field counts resolve by oldest timestamp then id and retain the tied candidate count', () => {
  const templates = [
    saved('a-newer', [anchor()], { created_at: '2026-09-02T00:00:00Z' }),
    saved('z-oldest', [anchor()]), saved('a-oldest', [anchor()]),
  ];
  for (const order of [templates, [...templates].reverse()]) {
    const checked = select('Reference: 127', basic, order);
    assert.equal(checked.selection.template?.id, 'a-oldest');
    assert.equal(checked.selection.template?.tieCount, 3);
    assert.ok(checked.candidates.every(candidate => candidate.matched));
    assert.deepEqual(checked.result?.issues, []);
  }
});

test('phrase matching is literal and case sensitive, and every configured anchor must supply a value', () => {
  const rules = [anchor(), anchor('amount', 'Payable')];
  const template = saved('literal', rules, { match_text: 'ACORN+ [EU]' });
  assert.equal(select('ACORN+ [EU]\nReference: 127\nPayable: 12', basic, [template]).selection.outcome, 'template');
  const cases = [
    { text: 'acorn+ [EU]\nReference: 127\nPayable: 12', reason: 'phrase_missing' },
    { text: 'ACORN+ [EU]\nReference: 127\nAmount: 12', reason: 'missing_anchor' },
    { text: 'ACORN+ [EU]\nReference: 127\nPayable:', reason: 'missing_value' },
    { text: 'ACORN+ [EU]\nReference: 127\nPayable: twelve', reason: 'invalid_value' },
  ];
  for (const item of cases) {
    const checked = select(item.text, basic, [template]);
    assert.equal(checked.selection.outcome, 'ai', item.reason);
    assert.equal(checked.selection.reason, 'no_match');
    assert.equal(checked.result, undefined);
    assert.equal(checked.candidates[0].matched, false);
    assert.ok(checked.candidates[0].reasons.includes(item.reason), item.reason);
  }
});

test('defaults cannot establish a match for configured optional or unconfigured required fields', () => {
  const schema: ParserSchema = { fields: [reference, { ...amount, default: 12 },
    { key: 'state', label: 'State', type: 'string', required: true, default: 'Open' }] };
  for (const text of ['Reference: 127\nState: Open', 'Reference: 127\nAmount: 12']) {
    const checked = select(text, schema, [saved('default', [anchor(), anchor('amount', 'Amount')])]);
    assert.equal(checked.selection.outcome, 'ai');
    assert.ok(checked.candidates[0].reasons.some(reason => ['missing_anchor', 'missing_value'].includes(reason)));
  }
  assert.equal(select('Reference: 127\nAmount: 12\nState: Open', schema,
    [saved('source', [anchor(), anchor('amount', 'Amount')])]).selection.outcome, 'template');
});

test('required objects need a real source descendant and required descendants still need their own source', () => {
  const contact: SchemaField = { key: 'contact', label: 'Contact', type: 'object', required: true, fields: [
    { key: 'name', label: 'Contact name', type: 'string', default: 'Unknown' },
  ] };
  const template = saved('nested', [anchor()]);
  assert.equal(select('Reference: 127', { fields: [reference, contact] }, [template]).selection.outcome, 'ai');
  const accepted = select('Reference: 127\nContact name: Avery', { fields: [reference, contact] }, [template]);
  assert.equal(accepted.selection.outcome, 'template');
  assert.deepEqual(accepted.result?.rawValues.contact, { name: 'Avery' });
  const requiredChild: SchemaField = { ...contact, fields: [...contact.fields!,
    { key: 'code', label: 'Contact code', type: 'string', required: true, default: 'NONE' }] };
  const missing = select('Reference: 127\nContact name: Avery', { fields: [reference, requiredChild] }, [template]);
  assert.equal(missing.selection.outcome, 'ai');
  assert.ok(missing.candidates[0].unmatchedFields.includes('contact.code'));
});

test('an explicit scalar CSV anchor never falls back to the parser key or label', () => {
  const template = saved('csv', [anchor('reference', 'Contract ID')]);
  const checked = select('Contract ID,Amount\n000127,24.50', basic, [template]);
  assert.equal(checked.selection.outcome, 'template');
  assert.equal(checked.result?.rawValues.reference, '000127');
  for (const text of ['Reference,Amount\n000127,24.50', 'reference,Amount\n000127,24.50', 'Reference: 000127']) {
    const rejected = select(text, basic, [template]);
    assert.equal(rejected.selection.outcome, 'ai');
    assert.ok(rejected.candidates[0].reasons.includes('missing_anchor'));
  }
});

test('legacy scalar CSV snapshots preserve the original selected-anchor, key, and label lookup', () => {
  const schema: ParserSchema = { fields: [{ ...reference, anchor: 'Old code' }, amount] };
  const template = saved('legacy-scalar', [anchor('reference', 'Contract ID')]);
  const oldAnchor = extractRules(pages('Old code,Amount\nOLD-127,12'), schema, 'en-IE', [template]);
  assert.equal(oldAnchor.rawValues.reference, null);
  assert.ok(oldAnchor.issues.some(issue => issue.field === 'reference' && issue.code === 'required'));
  for (const header of ['Contract ID', 'Reference', 'reference']) {
    const checked = extractRules(pages(`${header},Amount\n000127,12`), schema, 'en-IE', [template]);
    assert.equal(checked.rawValues.reference, '000127');
    assert.equal(checked.engine, 'text-anchors');
    assert.equal(checked.model, 'deterministic-v2');
  }
});

test('legacy table snapshots ignore column overrides while complete-v1 honors them strictly', () => {
  const schema: ParserSchema = { fields: [table] };
  const template = saved('legacy-table', [anchor('items.description', 'SKU'), anchor('items.amount', 'Price')]);
  const overridden = pages('SKU,Price\nPaper,12');
  assert.equal(extractRules(overridden, schema, 'en-IE', [template]).rawValues.items, null);
  assert.deepEqual(select(overridden, schema, [template]).result?.normalizedValues.items, [{ description: 'Paper', amount: 12 }]);
  const labelled = pages('Description,Amount\nPaper,12');
  assert.deepEqual(extractRules(labelled, schema, 'en-IE', [template]).normalizedValues.items, [{ description: 'Paper', amount: 12 }]);
  assert.equal(select(labelled, schema, [template]).selection.outcome, 'ai');
});

test('strict multiline boundaries use selected anchors while legacy CSV label boundaries stay unchanged', () => {
  const schema: ParserSchema = { fields: [
    { key: 'message', label: 'Message', type: 'multiline', required: true },
    { key: 'company', label: 'Company', type: 'string' },
    { key: 'status', label: 'Status', type: 'string' },
  ] };
  const template = saved('body-boundaries', [anchor('message', 'Body'),
    anchor('company', 'Contact ID'), anchor('status', 'Current state')]);
  const text = 'Body: First\nCompany,Status\nThese,are message text\nContact ID: C1\nCurrent state: Open';
  const strict = select(text, schema, [template]);
  assert.equal(strict.selection.outcome, 'template');
  assert.equal(strict.result?.rawValues.message, 'First\nCompany,Status\nThese,are message text');
  assert.equal(strict.result?.rawValues.company, 'C1');
  assert.equal(strict.result?.rawValues.status, 'Open');
  assert.equal(extractRules(pages(text), schema, 'en-IE', [template]).rawValues.message, 'First');
});

test('table headings gate first capture, explicit column anchors are strict, and repeated headers continue across pages', () => {
  const schema: ParserSchema = { fields: [table] };
  const template = saved('columns', [anchor('items', 'Purchased goods'),
    anchor('items.description', 'SKU'), anchor('items.amount', 'Price')]);
  const checked = select([
    { page: 3, text: 'SKU,Price\nIGNORE,99\n\nPurchased goods:\nSKU,Price\nPaper,12' },
    { page: 4, text: 'SKU,Price\nPens,4.50' },
  ], schema, [template]);
  assert.equal(checked.selection.outcome, 'template');
  assert.equal(checked.selection.template?.fieldCount, 2);
  assert.deepEqual(checked.result?.normalizedValues.items, [
    { description: 'Paper', amount: 12 }, { description: 'Pens', amount: 4.5 },
  ]);
  for (const text of ['SKU,Price\nPaper,12\nPurchased goods:',
    'Purchased goods:\nDescription,Amount\nPaper,12',
    'Purchased goods:\nSKU,Price\nPaper,']) {
    assert.equal(select(text, schema, [template]).selection.outcome, 'ai');
  }
});

test('table rows never inflate the configured field rank and any truncated table prevents selection', () => {
  const schema: ParserSchema = { fields: [table, { ...reference, required: false },
    { key: 'date', label: 'Date', type: 'date' }, { key: 'state', label: 'State', type: 'string' }] };
  const columns = saved('columns', [anchor('items.description', 'Description'), anchor('items.amount', 'Amount')]);
  const scalars = saved('scalars', [anchor(), anchor('date', 'Date'), anchor('state', 'State')]);
  const text = 'Reference: 127\nDate: 2026-09-13\nState: Open\nDescription,Amount\n' +
    Array.from({ length: 8 }, (_, index) => `Item ${index},1`).join('\n');
  const checked = select(text, schema, [columns, scalars]);
  assert.equal(checked.selection.template?.id, 'scalars');
  assert.equal(checked.candidates.find(candidate => candidate.id === 'columns')?.fieldCount, 2);
  const oversized = 'Description,Amount\n' + Array.from({ length: 1001 }, (_, index) => `Item ${index},1`).join('\n');
  const limited = select(oversized, { fields: [table] }, [columns]);
  assert.notEqual(limited.selection.outcome, 'template');
  assert.ok(limited.candidates[0].reasons.includes('extraction_limit'));
});

test('empty, duplicate, malformed, unknown, and unsupported rules cannot qualify legacy templates', () => {
  const schema: ParserSchema = { fields: [reference, { key: 'contact', label: 'Contact', type: 'object', fields: [
    { key: 'name', label: 'Name', type: 'string' },
  ] }, { key: 'nested_items', label: 'Nested', type: 'array', fields: [
    { key: 'detail', label: 'Detail', type: 'object', fields: [{ key: 'value', label: 'Value', type: 'string' }] },
  ] }] };
  const invalid: unknown[] = [
    saved('empty', []), saved('duplicate', [anchor(), anchor()]),
    saved('unknown', [anchor('absent', 'Reference')]), saved('object', [anchor('contact', 'Contact')]),
    saved('nested-table', [anchor('nested_items.detail.value', 'Value')]),
    saved('empty-anchor', [anchor('reference', '')]),
    { ...saved('not-array', []), rules: {} }, { ...saved('null-rule', []), rules: [null] },
    { ...saved('wrong-field', []), rules: [{ field: 1, anchor: 'Reference' }] },
    { ...saved('wrong-phrase', [anchor()]), match_text: { value: 'Reference' } },
  ];
  const checked = select('Reference: 127\nContact: Avery\nName: Avery\nValue: Present', schema, invalid);
  assert.equal(checked.selection.outcome, 'ai');
  assert.equal(checked.selection.eligibleTemplates, 0);
  assert.equal(checked.candidates.length, invalid.length);
  assert.ok(checked.candidates.every(candidate => !candidate.matched && candidate.reasons.length > 0));
  assert.ok(checked.candidates.find(candidate => candidate.id === 'empty')?.reasons.includes('empty_rules'));
  assert.ok(checked.candidates.find(candidate => candidate.id === 'duplicate')?.reasons.includes('invalid_rules'));
  assert.ok(checked.candidates.find(candidate => candidate.id === 'object')?.reasons.includes('unsupported_field'));
});

test('the shared field catalogue exposes nested scalar leaves and flat table headings/columns only', () => {
  const schema: ParserSchema = { fields: [reference, table,
    { key: 'contact', label: 'Contact', type: 'object', fields: [{ key: 'name', label: 'Name', type: 'string' }] },
    { key: 'nested', label: 'Nested table', type: 'array', fields: [{ key: 'child', label: 'Child', type: 'array', fields: [reference] }] },
  ] };
  assert.deepEqual(templateFieldOptions(schema).map(({ path, kind }) => ({ path, kind })), [
    { path: 'reference', kind: 'scalar' }, { path: 'items', kind: 'table' },
    { path: 'items.description', kind: 'column' }, { path: 'items.amount', kind: 'column' },
    { path: 'contact.name', kind: 'scalar' },
  ]);
  assert.equal(templateFieldOptions(schema).find(option => option.path === 'contact.name')?.label, 'Contact / Name');
});

test('no enabled templates select the legacy rules path, while partial templates fail rules or fall back to AI', () => {
  for (const templates of [[], [saved('disabled', [anchor('reference', 'Wrong')], { enabled: false })]]) {
    const checked = select('Reference: 127', basic, templates, 'rules');
    assert.equal(checked.selection.outcome, 'rules');
    assert.equal(checked.selection.reason, 'no_templates');
    assert.equal(checked.selection.consideredTemplates, 0);
    // The worker owns legacy extraction after this decision; the selector has
    // produced no template result to mistake for a complete template match.
    assert.equal(checked.result, undefined);
  }
  const template = saved('partial', [anchor(), anchor('amount', 'Payable')]);
  for (const mode of ['rules', 'ai'] as const) {
    const checked = select('Reference: 127\nAmount: 12', basic, [template], mode);
    assert.equal(checked.selection.outcome, mode === 'rules' ? 'failed' : 'ai');
    assert.equal(checked.selection.reason, 'no_match');
    assert.equal(checked.result, undefined);
  }
  const ai = select('Reference: 127', basic, [], 'ai');
  assert.equal(ai.selection.outcome, 'ai');
  assert.equal(ai.selection.reason, 'no_templates');
  assert.equal(ai.result, undefined);
});

test('absent native text cannot match a template or manufacture a rules result', () => {
  for (const source of [[], [{ page: 1, text: '  \n\t' }]] as PageText[][]) {
    for (const mode of ['rules', 'ai'] as const) {
      const checked = select(source, basic, [saved('empty-phrase', [anchor()])], mode);
      assert.equal(checked.availableSourceText, false);
      assert.equal(checked.selection.reason, 'no_readable_text');
      assert.equal(checked.selection.outcome, mode === 'ai' ? 'ai' : 'failed');
      assert.equal(checked.result, undefined);
    }
  }
});

test('nested scalar paths at the 259-character supported boundary can match actual source', () => {
  const keys = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64));
  const schema: ParserSchema = { fields: [{ key: keys[0], label: 'One', type: 'object', fields: [
    { key: keys[1], label: 'Two', type: 'object', fields: [{ key: keys[2], label: 'Three', type: 'object', fields: [
      { key: keys[3], label: 'Deep value', type: 'string', required: true },
    ] }] },
  ] }] };
  const path = keys.join('.');
  assert.equal(path.length, 259);
  assert.equal(select('Owned ID: 000127', schema, [saved('deep', [anchor(path, 'Owned ID')])]).selection.outcome, 'template');
  assert.notEqual(select('Owned ID: 000127', schema, [saved('too-long', [anchor(path + 'x', 'Owned ID')])]).selection.outcome, 'template');
});

test('template, rule, native-byte, descriptor, line-work and character-work limits never select a truncated candidate set', () => {
  assert.deepEqual(templateLimits, { templates: 100, rules: 100, nativeBytes: 2 * 1024 * 1024,
    schemaFields: 600, lineFieldChecks: 5_000_000, characterFieldChecks: 100_000_000 });
  const hundred = Array.from({ length: 100 }, (_, index) => saved(`candidate-${String(index).padStart(3, '0')}`, [anchor()]));
  assert.equal(select('Reference: 127', basic, hundred).selection.outcome, 'template');
  const manyFields: SchemaField[] = Array.from({ length: 101 }, (_, index) => ({ key: `field${index}`, label: `Field ${index}`, type: 'string' }));
  const grouped: ParserSchema = { fields: Array.from({ length: 20 }, (_, index) => ({
    key: `group${index}`, label: `Group ${index}`, type: 'object', fields: Array.from({ length: 30 }, (_, field) => ({
      key: `field${field}`, label: `Field ${field}`, type: 'string',
    })),
  })) };
  const checkFields: SchemaField[] = Array.from({ length: 60 }, (_, index) => ({ key: `field${index}`, label: `Field ${index}`, type: 'string' }));
  const fixtures = [
    { text: 'Reference: 127', schema: basic, templates: [...hundred, saved('overflow', [anchor()])] },
    { text: manyFields.map(field => `${field.label}: value`).join('\n'), schema: { fields: manyFields },
      templates: [saved('too-many-rules', manyFields.map(field => anchor(field.key, field.label)))] },
    // UTF-8 byte size, rather than JavaScript character count, determines this bound.
    { text: 'Reference: 127\n' + 'é'.repeat(1_048_577), schema: basic, templates: [saved('large-source', [anchor()])] },
    { text: 'Field 0: value', schema: grouped, templates: [saved('descriptors', [anchor('group0.field0', 'Field 0')])] },
    // One long line stays under byte/line bounds but cannot trigger 120M character checks.
    { text: ' '.repeat(400_000) + 'Reference: 127', schema: basic, templates: hundred },
    { text: 'Field 0: value\n' + Array.from({ length: 1000 }, () => 'Unrelated line').join('\n'), schema: { fields: checkFields },
      templates: hundred.map(template => ({ ...template, rules: [anchor('field0', 'Field 0')] })) },
  ];
  for (const fixture of fixtures) {
    for (const mode of ['rules', 'ai'] as const) {
      const checked = select(fixture.text, fixture.schema, fixture.templates, mode);
      assert.equal(checked.selection.reason, 'limit', fixture.templates[0].id);
      assert.equal(checked.selection.outcome, mode === 'ai' ? 'ai' : 'failed');
      assert.equal(checked.selection.template, undefined);
      assert.equal(checked.result, undefined);
    }
  }
});
