import '../server/core/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOpenAIProvider, openAIExtraction } from '../server/core/openai-provider.js';
import { inspectSource } from '../server/core/source.js';
import { presets } from '../shared/presets.js';

if (!process.argv.includes('--live')) throw new Error('This command calls the configured OpenAI project using synthetic fixtures. Add --live to run it.');
const selected = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const folder = 'fixtures/generated';
const { fixtures } = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
const expectations = JSON.parse(await fs.readFile('fixtures/ai/expectations.json', 'utf8'));
const cases = [...fixtures, ...expectations.additional].filter((fixture: any) => !selected || fixture.filename === selected);
if (!cases.length) throw new Error('No matching synthetic fixture.');
const provider = createOpenAIProvider();
if (!provider.configured()) throw new Error('The server OpenAI provider is not configured.');
const flatten = (value: unknown, prefix = ''): Record<string, unknown> => {
  if (Array.isArray(value)) return value.length ? Object.assign({}, ...value.map((item, index) => flatten(item, `${prefix}[${index}]`))) : { [prefix]: [] };
  if (value && typeof value === 'object') return Object.assign({}, ...Object.entries(value).map(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key)));
  return { [prefix]: value };
};
const results: Record<string, any>[] = [];
let calls = 0, correct = 0, total = 0, costUsd = 0, stopped = false;
const startedAt = new Date().toISOString();
for (const fixture of cases) {
  if (stopped) { results.push({ name: fixture.name, filename: fixture.filename, state: 'not_run', reason: 'Provider access needs attention.' }); continue; }
  const bytes = await fs.readFile(fixture.sourcePath || path.join(folder, fixture.filename));
  const started = Date.now();
  try {
    const source = await inspectSource(bytes, fixture.filename);
    if (fixture.category === 'malformed') throw new Error('Malformed fixture unexpectedly passed the source decoder.');
    calls++;
    const result = await provider.extract({ bytes, mimeType: source.mimeType, pages: source.pages, schema: { fields: presets[fixture.useCase as keyof typeof presets].fields }, instructions: '', locale: fixture.locale });
    const expectation = expectations.overrides[fixture.filename];
    const expected = flatten({ ...fixture.expected, ...expectation?.values }), actual = flatten(result.normalizedValues);
    const mismatches = Object.entries(expected).filter(([field, value]) => JSON.stringify(actual[field]) !== JSON.stringify(value)).map(([field, expected]) => ({ field, expected, actual: actual[field] ?? null }));
    const fieldsExpected = Object.keys(expected).length, fieldsCorrect = fieldsExpected - mismatches.length;
    correct += fieldsCorrect; total += fieldsExpected; costUsd += result.costUsd || 0;
    results.push({ name: fixture.name, filename: fixture.filename, sha256: createHash('sha256').update(bytes).digest('hex'), category: fixture.category, state: 'needs_review', pages: source.pageCount, elapsedMs: Date.now() - started, fieldsCorrect, fieldsExpected, mismatches, expectationCorrection: expectation?.reason, ...result });
    console.log(JSON.stringify({ fixture: fixture.filename, correct: fieldsCorrect, expected: fieldsExpected, issues: result.issues.length, elapsedMs: Date.now() - started, estimatedCostUsd: result.costUsd }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Extraction failed';
    const rejected = fixture.category === 'malformed' && !reason.includes('unexpectedly passed');
    results.push({ name: fixture.name, filename: fixture.filename, category: fixture.category, state: rejected ? 'rejected' : 'failed', reason, elapsedMs: Date.now() - started });
    console.log(JSON.stringify({ fixture: fixture.filename, state: rejected ? 'rejected' : 'failed', reason }));
    if (/credentials|no available API quota|model access/.test(reason)) stopped = true;
  }
}
const report = { startedAt, finishedAt: new Date().toISOString(), engine: 'openai', model: openAIExtraction.model, promptVersion: openAIExtraction.promptVersion, actualProviderCalls: calls, correct, total, estimatedSuccessfulCallCostUsd: costUsd, description: 'Real API calls on owned synthetic fixtures only. Exact-value counts include expected missing fields. All successful results require review; matched quotes do not prove interpretation. Costs estimate successful responses only and are not a billing reconciliation.', results };
const destination = `docs/evidence/openai-evaluation-${startedAt.replace(/[:.]/g, '-')}.json`;
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: destination, correct, total, actualProviderCalls: calls, estimatedSuccessfulCallCostUsd: costUsd }));
if (correct !== total || results.some(result => result.state === 'failed' || result.state === 'not_run')) process.exitCode = 1;
