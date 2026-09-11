import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import ExcelJS from 'exceljs';
import { z, ZodError } from 'zod';
import { registerCore } from '../server/core/index.js';
import { adminPool, transaction, closeDatabase } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { registerExports } from '../server/integrations/exports.js';
import { registerIntegrations, enqueueApprovals, processOneDelivery, signDelivery } from '../server/integrations/webhooks.js';
import { exportRows, renderExport, safeCell, type ExportRecord } from '../server/integrations/export-format.js';
import { encryptSecret, decryptSecret } from '../server/integrations/secrets.js';
import { isPublicAddress, validateDestination, type PublicRequestOptions } from '../server/integrations/network.js';

let app: FastifyInstance;
const suffix = randomUUID().slice(0, 8);
const users: string[] = [], workspaces: string[] = [];
let owner: any, outsider: any, parser: any;
const docId = randomUUID(), runId = randomUUID(), approvalId = randomUUID(), laterApprovalId = randomUUID();
const integrationId = randomUUID(), signingSecret = 'owned-synthetic-integration-test-secret';
let firstSnapshotId: string, firstSnapshotBytes: Buffer;
const values = { identifier: '000127', customer: { name: 'Acorn Research' }, line_items: [
  { description: '=SUM(1,2)', quantity: 2, details: { sku: '0009' }, amount: 20 },
  { description: 'Paper, recycled', quantity: 3, details: { sku: '0010' }, amount: 30 },
] };
const record: ExportRecord = { documentId: docId, filename: 'owned-synthetic.txt', runId, revision: 0, approvalId, values };
async function request(method: any, url: string, payload?: any, account = owner) {
  const response = await app.inject({ method, url, payload, headers: { cookie: account.cookie, origin: config.origin } });
  return { status: response.statusCode, body: response.headers['content-type']?.includes('application/json') ? response.json() : response.body, response };
}
async function signup(name: string) {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
    name, email: `${name}-${suffix}@example.test`, password: 'owned integration fixture password', workspaceName: `Integration ${name}`,
  }, headers: { origin: config.origin } });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json(); users.push(body.user.id); workspaces.push(body.workspace.id);
  return { ...body, cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; ') };
}
before(async () => {
  app = Fastify(); await app.register(cookie); await app.register(multipart);
  app.setErrorHandler((error: any, _request, reply) => { reply.code(error instanceof ZodError ? 400 : error.statusCode || 500).send({ error: error.message }); });
  await registerCore(app); await registerExports(app); await registerIntegrations(app); await app.ready();
  owner = await signup('exports'); outsider = await signup('outsider');
  const created = await request('POST', '/api/parsers', { name: 'Export fixtures', useCase: 'custom', schema: { fields: [
    { key: 'identifier', label: 'Identifier', type: 'string', required: true },
    { key: 'customer', label: 'Customer', type: 'object', fields: [{ key: 'name', label: 'Name', type: 'string' }] },
    { key: 'line_items', label: 'Line items', type: 'array', fields: [{ key: 'description', label: 'Description', type: 'string' }, { key: 'quantity', label: 'Quantity', type: 'number' }] },
  ] } });
  assert.equal(created.status, 201); parser = created.body.parser;
  const storageKey = `${owner.workspace.id}/${docId}`;
  await fs.mkdir(path.join(config.storageDir, owner.workspace.id), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config.storageDir, storageKey), 'Owned synthetic export fixture', { mode: 0o600 });
  await transaction(adminPool, async c => {
    await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count) values($1,$2,$3,'owned-synthetic.txt','text/plain',29,$4,$5,'processed',1)", [docId, owner.workspace.id, parser.id, 'f'.repeat(64), storageKey]);
    await c.query("insert into extraction_runs(id,workspace_id,document_id,schema_version_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues) values($1,$2,$3,$4,'synthetic-test-fixture','deterministic-v1','fixture-v1',$5,$6,$6,'{}','[]')", [runId, owner.workspace.id, docId, parser.activeSchemaId, 'f'.repeat(64), JSON.stringify(values)]);
    await c.query("insert into approvals(id,workspace_id,run_id,user_id,values,created_at) values($1,$2,$3,$4,$5,now()-interval '10 seconds')", [approvalId, owner.workspace.id, runId, owner.user.id, JSON.stringify(values)]);
    await c.query('update documents set latest_run_id=$2,approved_run_id=$2 where id=$1', [docId, runId]);
    await c.query("insert into integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext,created_at) values($1,$2,$3,'Controlled fixture','webhook',$4,$5,now()-interval '1 day')", [integrationId, owner.workspace.id, parser.id, JSON.stringify({ url: 'https://receiver.example/owned-test' }), encryptSecret(signingSecret)]);
  });
});
after(async () => {
  await app?.close();
  for (const workspaceId of workspaces) {
    await adminPool.query('delete from workspaces where id=$1', [workspaceId]);
    await fs.rm(path.join(config.storageDir, workspaceId), { recursive: true, force: true });
  }
  for (const userId of users) await adminPool.query('delete from users where id=$1', [userId]);
  await closeDatabase();
});

test('default line-item expansion produces scalar nested columns and preserves identifiers', () => {
  const table = exportRows([record], { format: 'csv', lineItems: 'line_items' });
  assert.deepEqual(table.headers, ['identifier', 'customer.name', 'line_items.description', 'line_items.quantity', 'line_items.details.sku', 'line_items.amount']);
  assert.equal(table.rows.length, 2);
  assert.deepEqual(table.rows[0], ['000127', 'Acorn Research', "'=SUM(1,2)", 2, '0009', 20]);
  assert.deepEqual(table.rows[1], ['000127', 'Acorn Research', 'Paper, recycled', 3, '0010', 30]);
});
test('CSV and actual XLSX cells escape formulas, quotes and line breaks', async () => {
  assert.equal(safeCell(' =SUM(1,2)'), "' =SUM(1,2)"); assert.equal(safeCell(-14), -14); assert.equal(safeCell(false), false);
  const options = { lineItems: 'line_items', columns: [{ source: 'identifier', label: 'Reference' }, { source: '$item.description', label: 'Description' }, { source: '$item.quantity', label: 'Quantity' }] };
  const csv = await renderExport([record], { ...options, format: 'csv' });
  assert.match(csv.bytes.toString(), /"'=SUM\(1,2\)"/); assert.match(csv.bytes.toString(), /"Paper, recycled"/);
  const xlsx = await renderExport([record], { ...options, format: 'xlsx' });
  const book = new ExcelJS.Workbook(); await book.xlsx.load(xlsx.bytes as any); const sheet = book.getWorksheet(1)!;
  assert.equal(sheet.rowCount, 3); assert.equal(sheet.getCell('A2').value, '000127');
  assert.equal(sheet.getCell('B2').value, "'=SUM(1,2)"); assert.equal(sheet.getCell('C2').value, 2);
  assert.equal(sheet.getCell('B2').type, ExcelJS.ValueType.String);
});
test('JSON preserves nested values and explicit revision metadata', async () => {
  const json = await renderExport([record], { format: 'json' }); const parsed = JSON.parse(json.bytes.toString());
  assert.equal(parsed.documents[0].approvalId, approvalId); assert.equal(parsed.documents[0].values.line_items[0].description, '=SUM(1,2)');
});
test('encrypted integration secrets round-trip and reject corrupted ciphertext', () => {
  const encrypted = encryptSecret(signingSecret); assert.equal(decryptSecret(encrypted), signingSecret); assert.ok(!encrypted.includes(signingSecret));
  const parts = encrypted.split('.'); parts[1] = Buffer.alloc(16).toString('base64url');
  assert.throws(() => decryptSecret(parts.join('.'))); assert.throws(() => decryptSecret('invalid'));
});
test('destination policy classifies reserved addresses and validates syntax without network calls', async () => {
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('127.0.0.1'), false);
  assert.equal(isPublicAddress('10.0.0.1'), false); assert.equal(isPublicAddress('::1'), false); assert.equal(isPublicAddress('fe80::1'), false);
  await assert.rejects(validateDestination('http://receiver.example'), /HTTPS/);
  await assert.rejects(validateDestination('https://receiver.internal'), /public hostname/);
});
test('authenticated exports persist byte snapshots and enforce tenant ownership', async () => {
  const made = await request('POST', '/api/exports', { documentIds: [docId], format: 'json' });
  assert.equal(made.status, 200, JSON.stringify(made.body)); firstSnapshotId = made.body.id;
  const download = await request('GET', made.body.downloadUrl); assert.equal(download.status, 200);
  firstSnapshotBytes = download.response.rawPayload; assert.equal(download.body.documents[0].values.identifier, '000127');
  assert.equal(made.body.revisions[0].approvalId, approvalId);
  assert.equal((await request('GET', made.body.downloadUrl, undefined, outsider)).status, 404);
  assert.equal((await request('POST', '/api/exports', { documentIds: [docId], format: 'csv' }, outsider)).status, 404);
  const mapping = await request('POST', '/api/export-mappings', { parserId: parser.id, name: 'Nested rows', lineItems: 'line_items', columns: [{ source: '$item.details.sku', label: 'SKU' }] });
  assert.equal(mapping.status, 200); assert.equal((await request('GET', '/api/export-mappings', undefined, outsider)).body.mappings.length, 0);
});
test('approved snapshots remain immutable and historical approvals can be explicitly exported', async () => {
  const correctionId = randomUUID(), corrected = { ...values, identifier: '000128' };
  await transaction(adminPool, async c => {
    await c.query('insert into corrections(id,workspace_id,run_id,user_id,values,created_at) values($1,$2,$3,$4,$5,clock_timestamp())', [correctionId, owner.workspace.id, runId, owner.user.id, JSON.stringify(corrected)]);
    await c.query('insert into approvals(id,workspace_id,run_id,correction_id,user_id,values,created_at) values($1,$2,$3,$4,$5,$6,clock_timestamp())', [laterApprovalId, owner.workspace.id, runId, correctionId, owner.user.id, JSON.stringify(corrected)]);
  });
  const latest = await request('POST', '/api/exports', { documentIds: [docId], format: 'json' });
  const latestBody = (await request('GET', latest.body.downloadUrl)).body;
  assert.equal(latestBody.documents[0].values.identifier, '000128'); assert.equal(latestBody.documents[0].approvalId, laterApprovalId);
  const historical = await request('POST', '/api/exports', { documentIds: [docId], format: 'json', revisions: [{ documentId: docId, approvalId }] });
  assert.equal(historical.status, 200); assert.equal((await request('GET', historical.body.downloadUrl)).body.documents[0].values.identifier, '000127');
  assert.deepEqual((await request('GET', `/api/exports/${firstSnapshotId}/download`)).response.rawPayload, firstSnapshotBytes);
  assert.equal((await request('POST', '/api/exports', { documentIds: [docId], format: 'json', revisions: [{ documentId: docId, approvalId: randomUUID() }] })).status, 400);
});
test('exporting prior approval preserves a newer needs-review document status', async () => {
  const latestRun = randomUUID();
  await adminPool.query("insert into extraction_runs(id,workspace_id,document_id,schema_version_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues) select $1,workspace_id,document_id,schema_version_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues from extraction_runs where id=$2", [latestRun, runId]);
  await adminPool.query("update documents set latest_run_id=$2,status='needs_review' where id=$1", [docId, latestRun]);
  assert.equal((await request('POST', '/api/exports', { documentIds: [docId], format: 'csv' })).status, 200);
  assert.equal((await adminPool.query('select status from documents where id=$1', [docId])).rows[0].status, 'needs_review');
});
test('approval enqueue is idempotent and preserves numeric correction revision', async () => {
  await enqueueApprovals(); await enqueueApprovals();
  const { rows } = await adminPool.query('select * from webhook_deliveries where workspace_id=$1 order by created_at', [owner.workspace.id]);
  const automationSchema=z.fromJSONSchema(JSON.parse(await fs.readFile(path.join(config.root,'fixtures/automations/document-approved.schema.json'),'utf8')));
  for(const row of rows)automationSchema.parse(row.payload);
  assert.equal(rows.length, 2); assert.equal(rows.find(r => r.payload.id === laterApprovalId).payload.revision, 1);
  assert.equal(rows.find(r => r.payload.id === approvalId).payload.values.identifier, '000127');
});
test('signed webhook delivery retries and explicit replay keep stable idempotency identity', async () => {
  const captured: Array<{ body: string; headers: Record<string, string> }> = [];
  const transport = async (_url: string, options: PublicRequestOptions = {}) => {
    captured.push({ body: options.body!, headers: options.headers! });
    return { status: captured.length === 1 ? 503 : 204, bytes: Buffer.alloc(0) };
  };
  await processOneDelivery({ workspaceId: owner.workspace.id, transport });
  const id = captured[0].headers['X-Folio-Delivery'];
  const failed = (await adminPool.query('select * from webhook_deliveries where id=$1', [id])).rows[0]; assert.equal(failed.status, 'retry'); assert.equal(failed.attempts, 1);
  await adminPool.query("update webhook_deliveries set next_attempt_at=case when id=$1 then now() else now()+interval '1 hour' end where workspace_id=$2", [id, owner.workspace.id]);
  await processOneDelivery({ workspaceId: owner.workspace.id, transport });
  const success = (await adminPool.query('select * from webhook_deliveries where id=$1', [id])).rows[0]; assert.equal(success.status, 'delivered'); assert.equal(success.attempts, 2);
  assert.equal(captured[0].headers['Idempotency-Key'], captured[1].headers['Idempotency-Key']); assert.equal(captured[0].body, captured[1].body);
  const expected = createHmac('sha256', signingSecret).update(`${captured[0].headers['X-Folio-Timestamp']}.${captured[0].body}`).digest('hex');
  assert.equal(captured[0].headers['X-Folio-Signature'], `v1=${expected}`); assert.equal(signDelivery(signingSecret, captured[0].headers['X-Folio-Timestamp'], captured[0].body), expected);
  assert.equal((await request('POST', `/api/deliveries/${id}/replay`, {})).status, 200);
  await processOneDelivery({ workspaceId: owner.workspace.id, transport });
  assert.equal(captured[2].headers['Idempotency-Key'], id); assert.equal(captured[2].body, captured[0].body);
});
test('expired final webhook lease becomes failed instead of remaining in progress', async () => {
  const target = (await adminPool.query('select id from webhook_deliveries where workspace_id=$1 limit 1', [owner.workspace.id])).rows[0].id;
  await adminPool.query("update webhook_deliveries set status='delivering',attempts=5,lease_until=now()-interval '1 second',lease_token=$2 where id=$1", [target, randomUUID()]);
  await processOneDelivery({ workspaceId: owner.workspace.id, transport: async () => { throw new Error('No request expected for an exhausted lease'); } });
  const row = (await adminPool.query('select status,error from webhook_deliveries where id=$1', [target])).rows[0];
  assert.equal(row.status, 'failed'); assert.match(row.error, /final delivery attempt/);
});
test('deleting a document removes persisted exports and local delivery payloads', async () => {
  assert.equal((await request('DELETE', `/api/documents/${docId}`)).status, 200);
  assert.equal((await adminPool.query('select id from export_snapshots where $1::uuid=any(document_ids)', [docId])).rowCount, 0);
  assert.equal((await adminPool.query("select id from webhook_deliveries where payload->'document'->>'id'=$1", [docId])).rowCount, 0);
  assert.equal((await request('GET', `/api/exports/${firstSnapshotId}/download`)).status, 404);
});
