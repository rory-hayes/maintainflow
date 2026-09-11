import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAIProvider, extractionResponseSchema, openAIExtraction } from '../server/core/openai-provider.js';
import type { ParserSchema, ProviderInput } from '../shared/types.js';

const schema: ParserSchema = { fields: [
  { key: 'identifier', label: 'Identifier', type: 'string', required: true },
  { key: 'amount', label: 'Amount', type: 'currency', required: true },
  { key: 'date', label: 'Date', type: 'date', required: true },
] };
const input = (overrides: Partial<ProviderInput> = {}): ProviderInput => ({
  bytes: Buffer.from('Owned synthetic test'), mimeType: 'text/plain', schema, instructions: 'Extract the receipt.', locale: 'de-DE',
  pages: [{ page: 1, text: 'Identifier: 000127\nAmount: €1.234,56\nDate: 17.09.2026' }], ...overrides,
});
const rawValues = { identifier: '000127', amount: '€1.234,56', date: '17.09.2026' };
const evidence = [
  { field: 'identifier', page: 1, text: 'Identifier: 000127' },
  { field: 'amount', page: 1, text: 'Amount: €1.234,56' },
  { field: 'date', page: 1, text: 'Date: 17.09.2026' },
];
function response(value: unknown = { rawValues, evidence }, overrides: Record<string, unknown> = {}) {
  return { id: 'resp_owned_fixture', status: 'completed', model: openAIExtraction.model,
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 25 } }, ...overrides };
}
const transport = (payload: unknown, status = 200) => (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
const provider = (payload: unknown, status = 200) => createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: transport(payload, status) });

test('OpenAI request pins model/schema, isolates document instructions and retains native raw values, evidence and cost', async () => {
  let captured: Record<string, any> | undefined;
  const model = createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: (async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options?.redirect, 'error');
    captured = JSON.parse(String(options?.body));
    return new Response(JSON.stringify(response()));
  }) as typeof fetch });
  const result = await model.extract(input());
  assert.equal(captured?.model, openAIExtraction.model);
  assert.equal(captured?.store, false);
  assert.equal(captured?.tools, undefined);
  assert.equal(captured?.max_output_tokens, 16000);
  assert.equal(captured?.text.format.strict, true);
  assert.equal(captured?.input[0].role, 'user');
  assert.match(captured?.input[0].content[0].text, /PAGE 1/);
  assert.doesNotMatch(captured?.instructions, /000127/);
  assert.deepEqual(result.rawValues, rawValues);
  assert.deepEqual(result.normalizedValues, { identifier: '000127', amount: 1234.56, date: '2026-09-17' });
  assert.equal(result.evidence.amount[0].source, 'matched-text');
  assert.deepEqual(result.issues, []);
  assert.equal(result.promptVersion, openAIExtraction.promptVersion);
  assert.equal(result.costUsd, 0.001065);
  assert.equal((result.tokenUsage as any).cachedInputTokens, 200);
  assert.equal((result.tokenUsage as any).reasoningTokens, 25);
});

test('Strict extraction schema preserves nullability, exact nested keys and literal raw enum/date text', () => {
  const value = extractionResponseSchema({ fields: [{ key: 'nested', label: 'Nested', type: 'object', fields: [
    { key: 'rows', label: 'Rows', type: 'array', fields: [{ key: 'state', label: 'State', type: 'string', enum: ['Approved'] }] },
  ] }] }) as any;
  assert.equal(value.additionalProperties, false);
  const nested = value.properties.rawValues.properties.nested.anyOf[0];
  assert.equal(nested.additionalProperties, false);
  assert.deepEqual(nested.required, ['rows']);
  assert.deepEqual(nested.properties.rows.items.properties.state.type, ['string', 'null']);
  assert.equal(nested.properties.rows.items.properties.state.enum, undefined);
});

test('Missing source values remain raw null while defaults and required issues are applied locally', async () => {
  const localSchema: ParserSchema = { fields: [{ key: 'amount', label: 'Amount', type: 'currency', required: true }, { key: 'team', label: 'Team', type: 'string', default: 'Operations' }] };
  const result = await provider(response({ rawValues: { amount: null, team: null }, evidence: [] })).extract(input({ schema: localSchema }));
  assert.deepEqual(result.rawValues, { amount: null, team: null });
  assert.deepEqual(result.normalizedValues, { amount: null, team: 'Operations' });
  assert.equal(result.issues[0].code, 'required');
});

test('Nested line items normalize independently and reject undeclared nested properties or scalar types', async () => {
  const localSchema: ParserSchema = { fields: [{ key: 'line_items', label: 'Items', type: 'array', fields: [{ key: 'amount', label: 'Amount', type: 'currency' }] }] };
  const nested = { line_items: [{ amount: '1.234,56' }, { amount: null }] };
  const result = await provider(response({ rawValues: nested, evidence: [{ field: 'line_items[0].amount', page: 1, text: '€1.234,56' }] })).extract(input({ schema: localSchema }));
  assert.deepEqual(result.normalizedValues, { line_items: [{ amount: 1234.56 }, { amount: null }] });
  assert.equal(result.evidence['line_items[0].amount'][0].page, 1);
  for (const rawValues of [{ line_items: [{ amount: '1', extra: 'injected' }] }, { line_items: [{ amount: 1234.56 }] }, { line_items: [null] }, {}]) {
    await assert.rejects(provider(response({ rawValues, evidence: [] })).extract(input({ schema: localSchema })), /invalid structured extraction/);
  }
});

test('Evidence requires a real field path, actual page and quote on that page', async () => {
  const badEvidence = [
    { field: 'identifier', page: 2, text: 'Identifier: 000127' },
    { field: 'amount', page: 1, text: 'Invented source text' },
    { field: 'outside', page: 1, text: 'Date: 17.09.2026' },
    { field: 'date', page: null, text: 'Date: 17.09.2026' },
  ];
  const result = await provider(response({ rawValues, evidence: badEvidence })).extract(input());
  assert.equal(Object.keys(result.evidence).length, 0);
  assert.equal(result.issues.filter(issue => issue.code === 'evidence_missing').length, 3);
});

test('A real quote cannot hide a literal value that is absent from the cited page', async () => {
  const result = await provider(response({ rawValues: { ...rawValues, amount: '€9.999,99' }, evidence })).extract(input());
  assert.equal(result.evidence.amount, undefined);
  assert.ok(result.issues.some(issue => issue.field === 'amount' && issue.code === 'value_source_mismatch'));
});

test('Image and mixed PDF inputs include original bytes with explicit detail and honest visual evidence', async () => {
  for (const mimeType of ['image/png', 'image/jpeg', 'application/pdf']) {
    let body: any;
    const model = createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: (async (_url, options) => {
      body = JSON.parse(String(options?.body)); return new Response(JSON.stringify(response()));
    }) as typeof fetch });
    const bytes = Buffer.from('Synthetic image bytes');
    const pages = mimeType === 'application/pdf' ? [{ page: 1, text: '' }, { page: 2, text: 'A sufficiently long native text page in a mixed PDF.' }] : [{ page: 1, text: '' }];
    const result = await model.extract(input({ bytes, mimeType, pages }));
    const visual = body.input[0].content[1];
    assert.equal(visual.type, mimeType === 'application/pdf' ? 'input_file' : 'input_image');
    assert.equal(visual.detail, 'high');
    assert.equal(visual.file_data || visual.image_url, `data:${mimeType};base64,${bytes.toString('base64')}`);
    assert.equal(result.evidence.identifier[0].source, 'model-visual');
    assert.ok(result.issues.some(issue => issue.code === 'visual_evidence'));
  }
});

test('AI receives the original PDF even when every page has substantial native header text', async () => {
  let body: any;
  const model = createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: (async (_url, options) => {
    body = JSON.parse(String(options?.body)); return new Response(JSON.stringify(response()));
  }) as typeof fetch });
  await model.extract(input({ mimeType: 'application/pdf', pages: [{ page: 1, text: 'A long native header does not prove that all image-only invoice totals are decoded.' }] }));
  assert.equal(body.input[0].content[1].type, 'input_file');
  assert.equal(body.input[0].content[1].detail, 'high');
});

test('Refusals and incomplete/truncated output never become successful runs', async () => {
  const refusal = response(undefined, { output: [{ type: 'message', status: 'completed', content: [{ type: 'refusal', refusal: 'PRIVATE_REASON_DO_NOT_PERSIST' }] }] });
  await assert.rejects(provider(refusal).extract(input()), error => error instanceof Error && /declined/.test(error.message) && !error.message.includes('PRIVATE_REASON'));
  await assert.rejects(provider(response(undefined, { status: 'incomplete' })).extract(input()), /did not complete/);
  await assert.rejects(provider(response(undefined, { output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: '{' }] }] })).extract(input()), /invalid structured/);
});

test('Provider errors are classified without storing raw bodies or credential fragments', async () => {
  for (const [status, code, permanent] of [[401, 'invalid_api_key', true], [403, 'denied', true], [429, 'insufficient_quota', true], [429, 'rate_limit', false], [500, 'server_error', false], [400, 'invalid_request', true]] as const) {
    await assert.rejects(provider({ error: { code, message: 'PRIVATE_PROVIDER_BODY synthetic-fixture-credential' } }, status).extract(input()), error => {
      assert.ok(error instanceof Error); assert.equal((error as any).permanent, permanent);
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_BODY|synthetic-fixture-credential/); return true;
    });
  }
});

test('Completed HTTP transport distinguishes temporary model failure from content-filter and output limits', async () => {
  await assert.rejects(provider(response(undefined, { status: 'failed', error: { code: 'server_error', message: 'PRIVATE' } })).extract(input()), error => (error as any).permanent === false && !String(error).includes('PRIVATE'));
  await assert.rejects(provider(response(undefined, { status: 'incomplete', incomplete_details: { reason: 'content_filter' } })).extract(input()), /declined/);
  await assert.rejects(provider(response(undefined, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })).extract(input()), /output limits/);
});

test('Request deadline and parent cancellation abort the transport and leave retriable fixed errors', async () => {
  const aborting = (async (_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_NETWORK_ERROR')), { once: true });
  })) as typeof fetch;
  const timed = createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: aborting, timeoutMs: 5 });
  await assert.rejects(timed.extract(input()), error => /canceled|time limit/.test((error as Error).message) && (error as any).permanent === false);
  const controller = new AbortController();
  const waiting = createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: aborting }).extract(input({ signal: controller.signal }));
  controller.abort();
  await assert.rejects(waiting, /canceled/);
});

test('Response and input limits reject oversized content before unsafe parsing or provider use', async () => {
  const large = createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: (async () => new Response(' '.repeat(openAIExtraction.maxResponseBytes + 1))) as typeof fetch });
  await assert.rejects(large.extract(input()), /response limit/);
  let calls = 0;
  const guarded = createOpenAIProvider({ apiKey: 'synthetic-fixture-credential', fetch: (async () => { calls++; throw new Error('Must not call'); }) as typeof fetch });
  await assert.rejects(guarded.extract(input({ bytes: Buffer.alloc(10 * 1024 * 1024 + 1) })), /input limits/);
  await assert.rejects(guarded.extract(input({ pages: [{ page: 1, text: 'x'.repeat(openAIExtraction.maxTextBytes + 1) }] })), /input limits/);
  await assert.rejects(guarded.extract(input({ pages: [{ page: 0, text: 'Bad page metadata' }] })), /page metadata/);
  assert.equal(calls, 0);
});

test('Total schema bounds prevent large expanded nested schemas and instructions', () => {
  const fields = Array.from({ length: 50 }, (_, index) => ({ key: `group${index}`, label: 'Group', type: 'object' as const, fields: Array.from({ length: 10 }, (_, child) => ({ key: `field${child}`, label: 'Field', type: 'string' as const })) }));
  assert.throws(() => extractionResponseSchema({ fields }), /500 fields/);
  assert.throws(() => extractionResponseSchema({ fields: Array.from({ length: 60 }, (_, index) => ({ key: `field${index}`, label: 'Field', type: 'string', instructions: 'x'.repeat(2000) })) }), /100 KB/);
});

test('Pinned model and token accounting cannot silently accept a different version or impossible cached usage', async () => {
  await assert.rejects(provider(response(undefined, { model: 'different-model' })).extract(input()), /different model version/);
  await assert.rejects(provider(response(undefined, { usage: { input_tokens: 10, output_tokens: 10, input_tokens_details: { cached_tokens: 11 } } })).extract(input()), /invalid structured/);
});

test('A constructor-named parser field does not collide with the evidence object prototype', async () => {
  const localSchema: ParserSchema = { fields: [{ key: 'constructor', label: 'Constructor', type: 'string' }] };
  const result = await provider(response({ rawValues: { constructor: '000127' }, evidence: [{ field: 'constructor', page: 1, text: '000127' }] })).extract(input({ schema: localSchema }));
  assert.equal(Object.values(result.evidence)[0][0].text, '000127');
});

test('An explicitly unconfigured provider does not use an environment key or invoke the transport', async () => {
  let called = false;
  const model = createOpenAIProvider({ apiKey: '', fetch: (async () => { called = true; throw new Error('Do not call'); }) as typeof fetch });
  assert.equal(model.configured(), false);
  await assert.rejects(model.extract(input()), /not configured/);
  assert.equal(called, false);
});

test('CSV serialization quotes normalize from complete source cells while raw extraction and other formats remain unchanged', async () => {
  const localSchema: ParserSchema = { fields: [{ key: 'merchant', label: 'Merchant', type: 'string' }] };
  const values = { merchant: '"Maple, Supplies"' };
  const payload = response({ rawValues: values, evidence: [{ field: 'merchant', page: 1, text: '"Maple, Supplies"' }] });
  const pages = [{ page: 1, text: 'Merchant\n"Maple, Supplies"' }];
  const csv = await provider(payload).extract(input({ schema: localSchema, mimeType: 'text/csv', pages }));
  assert.deepEqual(csv.rawValues, values);
  assert.equal(csv.normalizedValues.merchant, 'Maple, Supplies');
  assert.equal(csv.evidence.merchant[0].text, '"Maple, Supplies"');
  const plain = await provider(payload).extract(input({ schema: localSchema, mimeType: 'text/plain', pages }));
  assert.equal(plain.normalizedValues.merchant, '"Maple, Supplies"');
});
