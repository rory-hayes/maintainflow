import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Evidence, SchemaField } from '../shared/types';
import OriginalExtractionSources, { SourceQuotes } from '../src/features/documents/ExtractionSources';
import ValueEditor from '../src/features/documents/ValueEditor';

const onPage = (_page: number) => {};
function render(field: SchemaField, value: unknown, evidence: Record<string, Evidence[]> = {}) {
  return renderToStaticMarkup(createElement(OriginalExtractionSources, { field, rawValues: { [field.key]: value }, evidence, onPage }));
}

test('original sources reach nested arrays and object leaves by full immutable paths', () => {
  const field: SchemaField = { key: 'groups', label: 'Groups', type: 'array', fields: [
    { key: 'account', label: 'Account', type: 'object', fields: [{ key: 'code', label: 'Account code', type: 'string' }] },
    { key: 'items', label: 'Items', type: 'array', fields: [{ key: 'amount', label: 'Amount', type: 'currency' }] },
  ] };
  const html = render(field, [{ account: { code: '000042' }, items: [{ amount: '€12.30' }, { amount: '€6.20' }] }], {
    'groups[0].account.code': [{ page: 1, text: 'Account 000042' }],
    'groups[0].items[0].amount': [{ page: 2, text: 'First item €12.30', source: 'matched-text' }],
    'groups[0].items[1].amount': [{ page: 3, text: 'Second item €6.20', source: 'model-visual' }],
    'groups[9].items[0].amount': [{ page: 4, text: 'Orphan quote must not appear' }],
  });
  assert.match(html, /data-source-path="groups\[0\]\.account\.code"/);
  assert.match(html, /data-source-path="groups\[0\]\.items\[1\]\.amount"/);
  assert.match(html, /Original row 2/);
  assert.match(html, /Account code/);
  assert.match(html, /000042/);
  assert.match(html, /Source · Page 2/);
  assert.match(html, /AI-read source · Page 3/);
  assert.doesNotMatch(html, /Orphan quote/);
  assert.match(html, /Your corrections do not change this source record/);
});

test('top-level objects expose nested sources and retain every complete quote', () => {
  const field: SchemaField = { key: 'customer', label: 'Customer', type: 'object', fields: [
    { key: 'contacts', label: 'Contacts', type: 'array', fields: [{ key: 'email', label: 'Email', type: 'string' }] },
  ] };
  const longQuote = 'Email line one\n' + 'A long readable source quotation. '.repeat(30) + 'FINAL QUOTE WORDS';
  const html = render(field, { contacts: [{ email: 'synthetic@example.test' }] }, {
    'customer.contacts[0].email': [{ page: 1, text: longQuote }, { page: 2, text: 'Second distinct quotation' }],
  });
  assert.equal((html.match(/class="evidence-link"/g) || []).length, 2);
  assert.match(html, /data-source-path="customer\.contacts\[0\]\.email"/);
  assert.ok(html.includes(longQuote));
  assert.match(html, /Second distinct quotation/);
  assert.match(html, /class="source-quote-text"/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
});

test('missing original values stay missing while explicit zero, false and empty structures remain distinct', () => {
  const field: SchemaField = { key: 'data', label: 'Data', type: 'object', fields: [
    { key: 'missing', label: 'Missing', type: 'string', default: 'A configured default' },
    { key: 'zero', label: 'Zero', type: 'number' },
    { key: 'no', label: 'No', type: 'boolean' },
    { key: 'empty', label: 'Empty', type: 'array', fields: [{ key: 'name', label: 'Name', type: 'string' }] },
    { key: 'absent', label: 'Absent object', type: 'object', fields: [{ key: 'name', label: 'Name', type: 'string' }] },
  ] };
  const html = render(field, { missing: null, zero: 0, no: false, empty: [], absent: null });
  assert.match(html, /Not found in the original extraction/);
  assert.match(html, /Extracted: <\/span>0/);
  assert.match(html, /Extracted: <\/span>false/);
  assert.match(html, /No rows in the original extraction/);
  assert.match(html, /No source quote recorded/);
  assert.doesNotMatch(html, /A configured default|class="evidence-link"/);
});

test('deleted, added, reordered and corrected review rows cannot relabel the original source record', () => {
  const field: SchemaField = { key: 'items', label: 'Items', type: 'array', fields: [
    { key: 'name', label: 'Name', type: 'string' }, { key: 'amount', label: 'Amount', type: 'currency' },
  ] };
  const original = [
    { name: 'First original', amount: '1' }, { name: 'Second original', amount: '2' }, { name: 'Third original', amount: '3' },
  ];
  const rawValues = { items: structuredClone(original) };
  const evidence = Object.fromEntries(original.map((row, index) => [`items[${index}].name`, [{ page: index + 1, text: `${row.name} source` }]]));
  const renderPair = (current: typeof original) => renderToStaticMarkup(createElement('div', null,
    createElement(ValueEditor, { field, value: current, disabled: false, onChange: () => {} }),
    createElement(OriginalExtractionSources, { field, rawValues, evidence, onPage }),
  ));
  const before = renderPair(original);
  const edited = structuredClone(original);
  edited.shift();
  edited.push({ name: 'Added review row', amount: '9' });
  edited.reverse();
  edited[1].amount = '30';
  const after = renderPair(edited);
  assert.match(after, /value="Added review row"/);
  assert.match(after, /value="30"/);
  const disclosure = (html: string) => html.slice(html.indexOf('<details class="original-extraction-sources">'));
  assert.equal(disclosure(after), disclosure(before));
  assert.match(disclosure(after), /Original row 1/);
  assert.match(disclosure(after), /Source · Page 1/);
  assert.match(disclosure(after), /First original source/);
  assert.doesNotMatch(disclosure(after), /Added review row/);
  assert.deepEqual(rawValues.items, original);
});

test('table-level evidence remains separate from numbered original rows', () => {
  const field: SchemaField = { key: 'items', label: 'Items', type: 'array', fields: [{ key: 'name', label: 'Name', type: 'string' }] };
  const html = render(field, [{ name: 'First' }, { name: 'Second' }], {
    items: [{ page: 2, text: 'A quote recorded for the entire table' }],
    'items[1].name': [{ page: 3, text: 'Second row source' }],
  });
  assert.match(html, /Table-level source quotes/);
  assert.ok(html.indexOf('A quote recorded for the entire table') < html.indexOf('data-original-row="1"'));
  assert.ok(html.indexOf('Second row source') > html.indexOf('data-original-row="2"'));
  assert.equal((html.match(/A quote recorded for the entire table/g) || []).length, 1);
});

test('source labels, original values and quotes render as escaped text', () => {
  const field: SchemaField = { key: 'group', label: '<b>Group & label</b>', type: 'object', fields: [{ key: 'value', label: '<img src=x>', type: 'string' }] };
  const html = render(field, { value: '<script>alert("value")</script>' }, {
    'group.value': [{ page: 1, text: '<img src=x onerror="alert(1)"> & "quote"', source: 'model-visual' }],
  });
  assert.match(html, /&lt;b&gt;Group &amp; label&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;value&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &quot;quote&quot;/);
  assert.doesNotMatch(html, /<script|<img/);
});

test('source buttons preserve each quote page through the supplied review page handler', () => {
  const pages: number[] = [];
  const element = SourceQuotes({ items: [{ page: 2, text: 'Native quote' }, { page: 4, text: 'Visual quote', source: 'model-visual' }], onPage: page => pages.push(page) });
  const buttons = element.props.children as ReactElement<{ type: string; onClick: () => void }>[];
  for (const button of buttons) {
    assert.equal(button.props.type, 'button');
    button.props.onClick();
  }
  assert.deepEqual(pages, [2, 4]);
  const html = renderToStaticMarkup(element);
  assert.match(html, /type="button"/);
  assert.match(html, /AI-read source · Page 4/);
});

test('prototype-named fields use only explicitly recorded values and evidence', () => {
  const field: SchemaField = { key: 'constructor', label: 'Constructor', type: 'object', fields: [{ key: 'name', label: 'Name', type: 'string' }] };
  const html = render(field, { name: 'Recorded name' });
  assert.match(html, /Recorded name/);
  assert.doesNotMatch(html, /function Object|native code|class="evidence-link"/);
});
