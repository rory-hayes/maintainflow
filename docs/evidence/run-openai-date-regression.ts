import '../../server/core/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createOpenAIProvider, openAIExtraction } from '../../server/core/openai-provider.js';
import { inspectSource } from '../../server/core/source.js';
import { presets } from '../../shared/presets.js';

if (!process.argv.includes('--live')) throw new Error('Add --live to evaluate the fresh owned synthetic documents using the configured OpenAI project.');
const folder = 'docs/evidence/heldout-ai-2026-09-07';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = await fs.readFile(path.join(folder, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const source = JSON.parse(await fs.readFile('docs/evidence/openai-date-source-before.json', 'utf8'));
async function verifySource() {
  for (const entry of source.files) {
    if (digest(await fs.readFile(entry.path)) !== entry.sha256) throw new Error(`Frozen source changed: ${entry.path}`);
  }
}
await verifySource();
const inputs = new Map<string, Buffer>();
for (const fixture of manifest.fixtures) {
  if (path.basename(fixture.filename) !== fixture.filename || !presets[fixture.useCase]) throw new Error('Invalid fixture identity or preset');
  const bytes = await fs.readFile(path.join(folder, fixture.filename));
  if (digest(bytes) !== fixture.sourceSha256) throw new Error(`Fixture digest mismatch: ${fixture.filename}`);
  inputs.set(fixture.id, bytes);
}
for (const fixture of manifest.fixtures) {
  if (fixture.duplicateOf && !inputs.get(fixture.id)!.equals(inputs.get(fixture.duplicateOf)!)) throw new Error('Duplicate fixture is not byte-identical');
}
const provider = createOpenAIProvider();
if (!provider.configured()) throw new Error('The server OpenAI provider is not configured');
const startedAt = new Date().toISOString();
const stamp = startedAt.replace(/[:.]/g, '-');
const freeze = {
  recordedAt: startedAt, sourceFingerprint: source.sourceFingerprint, sourceFiles: source.files.length,
  manifestSha256: digest(manifestBytes), runnerSha256: digest(await fs.readFile('docs/evidence/run-openai-date-regression.ts')),
  fixtures: manifest.fixtures.map((f: any) => ({ id: f.id, filename: f.filename, sha256: f.sourceSha256 })),
  policy: 'Regression replay of the previously held-out set after a date-field selection instruction was added in prompt v2. Expected values and input bytes unchanged. Original first-pass 49/51 result preserved. No code or prompt changes between replay cases. This replay is not held-out accuracy evidence.',
};
await fs.writeFile(`docs/evidence/openai-date-regression-freeze-${stamp}.json`, JSON.stringify(freeze, null, 2) + '\n', { flag: 'wx' });
const flatten = (value: unknown, prefix = ''): Record<string, unknown> => {
  if (Array.isArray(value)) return value.length ? Object.assign({}, ...value.map((item, index) => flatten(item, `${prefix}[${index}]`))) : { [prefix]: [] };
  if (value && typeof value === 'object') return Object.assign({}, ...Object.entries(value).map(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key)));
  return { [prefix]: value };
};
const results: Record<string, any>[] = [];
let actualProviderCalls = 0, correct = 0, total = 0, costUsd = 0, stopped = false;
for (const fixture of manifest.fixtures) {
  if (stopped) { results.push({ id: fixture.id, filename: fixture.filename, state: 'not_run' }); continue; }
  const started = Date.now();
  let invoked = false;
  try {
    const bytes = inputs.get(fixture.id)!;
    const sourceDocument = await inspectSource(bytes, fixture.filename);
    if (fixture.category === 'malformed_pdf') throw new Error('Malformed fixture unexpectedly passed source inspection');
    if (sourceDocument.mimeType !== fixture.mimeType) throw new Error('Inspected MIME type differs from the held-out manifest');
    actualProviderCalls++; invoked = true;
    const result = await provider.extract({ bytes, mimeType: sourceDocument.mimeType, pages: sourceDocument.pages, schema: { fields: presets[fixture.useCase].fields }, instructions: '', locale: fixture.locale });
    const expected = flatten(fixture.expected), actual = flatten(result.normalizedValues);
    const mismatches = Object.entries(expected).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(actual[field])).map(([field, expected]) => ({ field, expected, actual: actual[field] ?? null }));
    const unexpectedFields = Object.keys(actual).filter(field => !(field in expected));
    const fieldsExpected = Object.keys(expected).length, fieldsCorrect = fieldsExpected - mismatches.length;
    total += fieldsExpected; correct += fieldsCorrect; costUsd += result.costUsd || 0;
    const record = { id: fixture.id, filename: fixture.filename, duplicateOf: fixture.duplicateOf, sha256: fixture.sourceSha256, state: 'needs_review', elapsedMs: Date.now() - started, pages: sourceDocument.pageCount, fieldsExpected, fieldsCorrect, mismatches, unexpectedFields, ...result };
    results.push(record);
    console.log(JSON.stringify({ fixture: fixture.filename, correct: fieldsCorrect, expected: fieldsExpected, unexpectedFields, issues: result.issues.length, elapsedMs: record.elapsedMs }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Extraction failed';
    const rejected = fixture.category === 'malformed_pdf' && !invoked && !reason.includes('unexpectedly passed');
    results.push({ id: fixture.id, filename: fixture.filename, sha256: fixture.sourceSha256, state: rejected ? 'rejected' : 'failed', reason, elapsedMs: Date.now() - started });
    console.log(JSON.stringify({ fixture: fixture.filename, state: rejected ? 'rejected' : 'failed', reason }));
    if (/credentials|no available API quota|model access/.test(reason)) stopped = true;
  }
}
await verifySource();
const report = {
  startedAt, finishedAt: new Date().toISOString(), model: openAIExtraction.model, promptVersion: openAIExtraction.promptVersion,
  ...freeze, actualProviderCalls, correct, total, estimatedSuccessfulCallCostUsd: costUsd,
  sourceUnchangedAfter: true,
  duplicateScope: 'The duplicate is a byte-identical independent model input. Both calls are intentional and may be billed. This checks extraction consistency, not intake deduplication; intake deduplication is covered by separate local tests.',
  results,
};
const destination = `docs/evidence/openai-date-regression-evaluation-${stamp}.json`;
await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ report: destination, actualProviderCalls, correct, total, estimatedSuccessfulCallCostUsd: costUsd }));
if (correct !== total || results.some(r => ['failed', 'not_run'].includes(r.state) || r.unexpectedFields?.length)) process.exitCode = 1;
