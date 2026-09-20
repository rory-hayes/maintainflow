import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Resend, GetReceivingEmailResponseSuccess } from 'resend';
import type { SourceFormat } from '../shared/source-formats.js';
import { adminPool, closeDatabase, transaction, withWorkspace } from '../server/core/db.js';
import { config, defaultPlan } from '../server/core/config.js';
import { addDocument } from '../server/core/intake.js';
import { ParserFormatNotAllowedError, SourceIntakeRejectedError } from '../server/core/intake-policy.js';
import { privateStorage } from '../server/core/storage.js';
import { WorkBudgetExhausted } from '../server/core/work-budget.js';
import { processResendEvent, storeProviderEvent, tickProviders, type ResendDependencies } from '../server/integrations/providers.js';

type Fixture = { userId: string; workspaceId: string; parserId: string; routeId: string; eventId: string; emailId: string; address: string };
type Attachment = { id: string; filename: string; content_type: string; content_disposition: 'attachment'; size: number; bytes: Buffer };
const fixtures: Fixture[] = [];
let localDatabaseVerified = false;

before(() => {
  const options = adminPool.options;
  const host = options.connectionString ? new URL(options.connectionString).hostname : options.host;
  assert.ok(typeof host === 'string' && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)),
    'Resend format-policy fixtures require a local database.');
  assert.equal(privateStorage().kind, 'filesystem', 'Resend format-policy fixtures require local file storage.');
  localDatabaseVerified = true;
});

after(async () => {
  try {
    if (!localDatabaseVerified) return;
    for (const fixture of fixtures) {
      await adminPool.query('delete from workspaces where id=$1', [fixture.workspaceId]);
      await fs.rm(path.join(config.storageDir, fixture.workspaceId), { recursive: true, force: true });
      await adminPool.query('delete from users where id=$1', [fixture.userId]);
      await adminPool.query('delete from provider_events where id=$1', [fixture.eventId]);
    }
  } finally { await closeDatabase(); }
});

async function route(allowedFormats: SourceFormat[] | null = ['pdf'], allowedSenders: string[] = []): Promise<Fixture> {
  const fixture = { userId: randomUUID(), workspaceId: randomUUID(), parserId: randomUUID(), routeId: randomUUID(),
    eventId: `resend:owned-format-${randomUUID()}`, emailId: randomUUID(), address: `owned-format-${randomUUID()}@example.test` };
  const schemaId = randomUUID();
  await transaction(adminPool, async client => {
    await client.query('insert into users(id,email,name,password_hash) values($1,$2,$3,$4)',
      [fixture.userId, `owned-format-${fixture.userId}@example.test`, 'Owned format policy', 'unusable-owned-fixture-hash']);
    await client.query('insert into workspaces(id,name,slug,plan) values($1,$2,$3,$4)',
      [fixture.workspaceId, 'Owned Resend format policy', fixture.workspaceId, JSON.stringify(defaultPlan)]);
    await client.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'owner')", [fixture.workspaceId, fixture.userId]);
    await client.query("insert into parsers(id,workspace_id,name,mode,allowed_formats) values($1,$2,'Owned inbound formats','rules',$3)",
      [fixture.parserId, fixture.workspaceId, allowedFormats]);
    await client.query('insert into schema_versions(id,workspace_id,parser_id,version,schema,created_by) values($1,$2,$3,1,$4,$5)',
      [schemaId, fixture.workspaceId, fixture.parserId, JSON.stringify({ fields: [{ key: 'reference', label: 'Reference', type: 'string' }] }), fixture.userId]);
    await client.query('update parsers set active_schema_id=$2 where id=$1', [fixture.parserId, schemaId]);
    await client.query('insert into email_routes(id,workspace_id,parser_id,address,provider_domain_id,created_by,domain_verified_at,allowed_senders) values($1,$2,$3,$4,$5,$6,now(),$7)',
      [fixture.routeId, fixture.workspaceId, fixture.parserId, fixture.address, 'owned-synthetic-domain', fixture.userId, JSON.stringify(allowedSenders)]);
  });
  fixtures.push(fixture);
  await storeProviderEvent('resend', fixture.eventId.slice('resend:'.length), pointer(fixture));
  return fixture;
}

function pointer(fixture: Fixture) { return { emailId: fixture.emailId, recipients: [fixture.address] }; }
function attachment(filename: string, bytes: Buffer, mimeType = 'application/pdf'): Attachment {
  return { id: randomUUID(), filename, content_type: mimeType, content_disposition: 'attachment', size: bytes.length, bytes };
}
async function pdf(label: string) {
  const document = await PDFDocument.create();
  document.addPage().drawText(`SYNTHETIC OWNED FORMAT POLICY ${label}`);
  return Buffer.from(await document.save());
}
function message(fixture: Fixture, attachments: Attachment[]): GetReceivingEmailResponseSuccess {
  return { id: fixture.emailId, from: 'Owned supplier <supplier@example.test>', to: [fixture.address], cc: [], bcc: [],
    received_for: [fixture.address], subject: 'PRIVATE OWNED EMAIL SUBJECT', text: 'PRIVATE OWNED EMAIL BODY', html: null,
    attachments: attachments.map(({ bytes: _bytes, ...item }) => item), headers: {}, created_at: new Date().toISOString(),
    message_id: fixture.eventId, reply_to: [] } as unknown as GetReceivingEmailResponseSuccess;
}
function transport(fixture: Fixture, attachments: Attachment[], onIntake?: (...args: Parameters<typeof addDocument>) => Promise<void>) {
  const email = message(fixture, attachments);
  const intakeCalls: string[] = [], metadataCalls: string[] = [], downloadCalls: string[] = [];
  const client = { emails: { receiving: {
    get: async () => ({ data: email, error: null }),
    attachments: { get: async ({ id }: { id: string }) => {
      metadataCalls.push(id);
      const item = attachments.find(item => item.id === id); assert.ok(item);
      return { data: { download_url: `https://controlled.example.test/${id}`, size: item.size }, error: null };
    } },
  } } } as unknown as Resend;
  const dependencies: ResendDependencies = {
    client,
    download: async url => {
      const parsed = new URL(url); assert.equal(parsed.origin, 'https://controlled.example.test');
      const id = parsed.pathname.slice(1); downloadCalls.push(id);
      const item = attachments.find(item => item.id === id); assert.ok(item);
      return { status: 200, bytes: item.bytes };
    },
    intake: async (...args) => {
      assert.ok(args[5]); intakeCalls.push(args[5]);
      await onIntake?.(...args);
      return addDocument(...args);
    },
  };
  return { dependencies, email, intakeCalls, metadataCalls, downloadCalls };
}
function itemKey(fixture: Fixture, item: string) { return `resend:${fixture.emailId}:${fixture.parserId}:${item}`; }
async function counts(fixture: Fixture) {
  const result: Record<string, number> = {};
  for (const table of ['documents', 'jobs', 'usage_ledger', 'intake_events', 'intake_files']) {
    result[table] = (await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`, [fixture.workspaceId])).rows[0].n;
  }
  return result;
}

test('a PDF-only route checkpoints rejected body and text attachment while accepting its PDF, including replay after policy expansion', async () => {
  const fixture = await route();
  const text = attachment('PRIVATE OWNED BLOCKED FILENAME.txt', Buffer.from('PRIVATE OWNED ATTACHMENT CONTENT'), 'text/plain');
  const allowed = attachment('allowed.pdf', await pdf('allowed'));
  const state = transport(fixture, [text, allowed]);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  assert.deepEqual(await counts(fixture), { documents: 1, jobs: 1, usage_ledger: 1, intake_events: 3, intake_files: 0 });
  assert.deepEqual(state.intakeCalls, [itemKey(fixture, 'body'), itemKey(fixture, text.id), itemKey(fixture, allowed.id)]);
  const receipts = (await adminPool.query('select idempotency_key,document_id,rejection_code,rejection_format,rejection_sha256,rejected_parser_id from intake_events where workspace_id=$1 order by rejection_format', [fixture.workspaceId])).rows;
  const rejected = receipts.filter(row => row.rejection_code);
  assert.deepEqual(rejected.map(row => row.rejection_format), ['eml', 'txt']);
  for (const receipt of rejected) {
    assert.equal(receipt.rejection_code, 'parser_format_not_allowed');
    assert.equal(receipt.document_id, null); assert.equal(receipt.rejected_parser_id, fixture.parserId);
    assert.match(receipt.rejection_sha256, /^[a-f0-9]{64}$/);
  }
  const accepted = receipts.find(row => !row.rejection_code);
  assert.ok(accepted?.document_id); assert.equal(accepted.idempotency_key, itemKey(fixture, allowed.id));
  const audits = (await adminPool.query("select metadata from audit_events where workspace_id=$1 and action='document.rejected' order by metadata->>'format'", [fixture.workspaceId])).rows;
  assert.equal(audits.length, 2);
  assert.deepEqual(audits.map(row => row.metadata.format), ['eml', 'txt']);
  assert.ok(audits.every(row => row.metadata.parserId === fixture.parserId));
  assert.ok(!JSON.stringify({ receipts, audits }).includes('PRIVATE OWNED'));
  assert.ok((await adminPool.query('select last_received_at from email_routes where id=$1', [fixture.routeId])).rows[0].last_received_at);

  const beforeReplay = { counts: await counts(fixture), intakes: state.intakeCalls.length, metadata: state.metadataCalls.length, downloads: state.downloadCalls.length };
  await adminPool.query('update parsers set allowed_formats=$2 where id=$1', [fixture.parserId, ['pdf', 'eml', 'txt']]);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  assert.deepEqual({ counts: await counts(fixture), intakes: state.intakeCalls.length, metadata: state.metadataCalls.length, downloads: state.downloadCalls.length }, beforeReplay);
  assert.equal((await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='document.rejected'", [fixture.workspaceId])).rows[0].n, 2);
  const outsider = await route();
  assert.equal((await withWorkspace(outsider.workspaceId, client => client.query('select id from intake_events where workspace_id=$1', [fixture.workspaceId]))).rowCount, 0);
});

test('transient failure resumes only the unfinished attachment after durable accepted and rejected items', async () => {
  const fixture = await route();
  const first = attachment('first.pdf', await pdf('first'));
  const second = attachment('second.pdf', await pdf('second'));
  const transient = Object.assign(new Error('Owned transient intake failure'), { statusCode: 503 });
  let fail = true;
  const state = transport(fixture, [first, second], async (...args) => {
    if (args[5] === itemKey(fixture, second.id) && fail) { fail = false; throw transient; }
  });
  await assert.rejects(processResendEvent(fixture.eventId, pointer(fixture), state.dependencies), error => error === transient);
  assert.deepEqual(await counts(fixture), { documents: 1, jobs: 1, usage_ledger: 1, intake_events: 2, intake_files: 0 });
  assert.equal((await adminPool.query('select last_received_at from email_routes where id=$1', [fixture.routeId])).rows[0].last_received_at, null);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  assert.deepEqual(await counts(fixture), { documents: 2, jobs: 2, usage_ledger: 2, intake_events: 3, intake_files: 0 });
  assert.deepEqual(state.intakeCalls, [itemKey(fixture, 'body'), itemKey(fixture, first.id), itemKey(fixture, second.id), itemKey(fixture, second.id)]);
  assert.deepEqual(state.metadataCalls, [first.id, second.id, second.id]);
  assert.deepEqual(state.downloadCalls, state.metadataCalls);
  assert.equal((await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='document.rejected'", [fixture.workspaceId])).rows[0].n, 1);
});

test('sender allowlisting remains ahead of format decisions and document intake', async () => {
  const fixture = await route(['pdf'], ['someone-else@example.test']);
  const allowed = attachment('allowed.pdf', await pdf('sender allowed'));
  const state = transport(fixture, [allowed]);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  assert.deepEqual(await counts(fixture), { documents: 0, jobs: 0, usage_ledger: 0, intake_events: 0, intake_files: 0 });
  assert.deepEqual([state.intakeCalls, state.metadataCalls, state.downloadCalls], [[], [], []]);
  assert.equal((await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='email.rejected'", [fixture.workspaceId])).rows[0].n, 1);
  assert.equal((await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='document.rejected'", [fixture.workspaceId])).rows[0].n, 0);
  await adminPool.query('update email_routes set allowed_senders=$2 where id=$1', [fixture.routeId, JSON.stringify(['supplier@example.test'])]);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  assert.deepEqual(await counts(fixture), { documents: 1, jobs: 1, usage_ledger: 1, intake_events: 2, intake_files: 0 });
});

test('unrelated intake failures and a rejection naming another parser are not swallowed', async () => {
  const fixture = await route(null);
  let current: Error = new Error('initial');
  const state = transport(fixture, [], async () => { throw current; });
  for (const error of [
    Object.assign(new Error('Owned file limit'), { statusCode: 413 }),
    Object.assign(new Error('Owned quota limit'), { statusCode: 429 }),
    Object.assign(new Error('Owned temporary service failure'), { statusCode: 503 }),
    Object.assign(new Error('Owned unsupported file'), { statusCode: 415, code: 'parser_format_not_allowed', parserId: fixture.parserId, format: 'eml' }),
    new ParserFormatNotAllowedError(randomUUID(), 'eml'),
    new ParserFormatNotAllowedError(fixture.parserId, 'eml'),
    new SourceIntakeRejectedError(fixture.parserId, 'pdf_invalid'),
    new WorkBudgetExhausted(),
  ]) {
    current = error;
    await assert.rejects(processResendEvent(fixture.eventId, pointer(fixture), state.dependencies), received => received === error);
  }
  assert.equal(state.intakeCalls.length, 8);
  assert.deepEqual(await counts(fixture), { documents: 0, jobs: 0, usage_ledger: 0, intake_events: 0, intake_files: 0 });
  assert.equal((await adminPool.query('select last_received_at from email_routes where id=$1', [fixture.routeId])).rows[0].last_received_at, null);
});


test('worker completes mixed permanent source rejections while accepting a later valid PDF', async () => {
  const fixture = await route(null);
  const malformed = attachment('PRIVATE BAD.pdf', Buffer.from('%PDF-1.7\nnot a PDF object'));
  const unsupported = attachment('PRIVATE BAD.txt', Buffer.from('GIF89aPRIVATE CONTENT'), 'text/plain');
  const allowed = attachment('valid.pdf', await pdf('after permanent rejections'));
  const state = transport(fixture, [malformed, unsupported, allowed]);
  state.email.text = 'PRIVATE INVALID BODY\u0000';
  assert.equal(await tickProviders({}, { eventId: fixture.eventId, resend: state.dependencies }), true);
  assert.deepEqual(await counts(fixture), { documents: 1, jobs: 1, usage_ledger: 1, intake_events: 4, intake_files: 0 });
  const event = (await adminPool.query('select status,attempts,error from provider_events where id=$1', [fixture.eventId])).rows[0];
  assert.deepEqual(event, { status: 'completed', attempts: 1, error: null });
  const receipts = (await adminPool.query('select rejection_code,rejection_reason,rejection_format,document_id from intake_events where workspace_id=$1 and rejection_code is not null', [fixture.workspaceId])).rows;
  assert.equal(receipts.length, 3);
  assert.ok(receipts.every(row => row.rejection_code === 'source_validation_failed' && row.document_id === null && row.rejection_format === null));
  assert.deepEqual(receipts.map(row => row.rejection_reason).sort(), ['binary_format_unsupported','pdf_invalid','text_binary_content']);
  const audits = (await adminPool.query("select metadata from audit_events where workspace_id=$1 and action='document.rejected'", [fixture.workspaceId])).rows;
  assert.equal(audits.length, 3);assert.ok(!JSON.stringify(audits).includes('PRIVATE'));
  const replay = { counts: await counts(fixture), intakes: state.intakeCalls.length, downloads: state.downloadCalls.length };
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  assert.deepEqual({ counts: await counts(fixture), intakes: state.intakeCalls.length, downloads: state.downloadCalls.length }, replay);
  assert.equal((await fs.readdir(path.join(config.storageDir, fixture.workspaceId))).length, 1);
});

test('an all-rejected email completes with durable reasons and zero imported documents', async () => {
  const fixture = await route(null);
  const state = transport(fixture, [attachment('broken.pdf', Buffer.from('%PDF-1.7\ninvalid'))]);
  state.email.text = 'invalid\u0000body';
  assert.equal(await tickProviders({}, { eventId: fixture.eventId, resend: state.dependencies }), true);
  assert.deepEqual(await counts(fixture), { documents: 0, jobs: 0, usage_ledger: 0, intake_events: 2, intake_files: 0 });
  assert.equal((await adminPool.query('select status from provider_events where id=$1', [fixture.eventId])).rows[0].status, 'completed');
  assert.equal((await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='document.rejected'", [fixture.workspaceId])).rows[0].n, 2);
  const previousCalls = state.intakeCalls.length;
  assert.equal(await tickProviders({}, { eventId: fixture.eventId, resend: state.dependencies }), false);
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  assert.equal(state.intakeCalls.length, previousCalls);
  await assert.rejects(fs.stat(path.join(config.storageDir, fixture.workspaceId)), { code: 'ENOENT' });
});

test('a transient item does not hold up later valid attachments and the worker retries only unfinished items', async () => {
  const fixture = await route();
  const temporary = attachment('temporary.pdf', await pdf('temporary'));
  const later = attachment('later.pdf', await pdf('later'));
  let fail = true;
  const state = transport(fixture, [temporary, later], async (...args) => {
    if (args[5] === itemKey(fixture, temporary.id) && fail) { fail = false; throw Object.assign(new Error('PRIVATE decoder fault'), { statusCode: 422 }); }
  });
  assert.equal(await tickProviders({}, { eventId: fixture.eventId, resend: state.dependencies }), true);
  assert.deepEqual(await counts(fixture), { documents: 1, jobs: 1, usage_ledger: 1, intake_events: 2, intake_files: 0 });
  const event = (await adminPool.query('select status,attempts,error from provider_events where id=$1', [fixture.eventId])).rows[0];
  assert.equal(event.status, 'retry');assert.equal(event.attempts, 1);assert.ok(!event.error.includes('PRIVATE'));
  assert.equal((await adminPool.query('select last_received_at from email_routes where id=$1', [fixture.routeId])).rows[0].last_received_at, null);
  await adminPool.query('update provider_events set next_attempt_at=now() where id=$1', [fixture.eventId]);
  assert.equal(await tickProviders({}, { eventId: fixture.eventId, resend: state.dependencies }), true);
  assert.deepEqual(await counts(fixture), { documents: 2, jobs: 2, usage_ledger: 2, intake_events: 3, intake_files: 0 });
  assert.deepEqual(state.intakeCalls, [itemKey(fixture,'body'),itemKey(fixture,temporary.id),itemKey(fixture,later.id),itemKey(fixture,temporary.id)]);
  assert.deepEqual((await adminPool.query('select status,attempts,error from provider_events where id=$1', [fixture.eventId])).rows[0], { status: 'completed', attempts: 2, error: null });
});

test('HTML-only email is decoded from stable EML bytes inside central intake', async () => {
  const fixture = await route(null), state = transport(fixture, []);
  state.email.text = null;state.email.html = '<p>Invoice <b>00042</b></p>';
  await processResendEvent(fixture.eventId, pointer(fixture), state.dependencies);
  const document = (await adminPool.query('select source_text,storage_key,mime_type from documents where workspace_id=$1', [fixture.workspaceId])).rows[0];
  assert.equal(document.mime_type, 'message/rfc822');
  assert.match(document.source_text[0].text, /Invoice 00042/);
  assert.ok(!document.source_text[0].text.includes('<p>'));
  const original = await privateStorage().read(document.storage_key);
  assert.match(original.toString(), /Content-Type: text\/html; charset=utf-8/);
  assert.match(original.toString(), /<p>Invoice <b>00042<\/b><\/p>/);
});


test('underreported metadata cannot continue downloads or intake after the actual aggregate cap is reached', async () => {
  const fixture = await route(null);
  const attachments = Array.from({length:4},(_,index)=>attachment(`underreported-${index}.txt`,Buffer.alloc(9*1024*1024),'text/plain'));
  for(const item of attachments)item.size=1;
  const state=transport(fixture,attachments);
  await assert.rejects(processResendEvent(fixture.eventId,pointer(fixture),state.dependencies),/25 MiB aggregate limit/);
  assert.deepEqual(state.downloadCalls,attachments.slice(0,3).map(item=>item.id));
  assert.deepEqual(state.metadataCalls,state.downloadCalls);
  assert.deepEqual(state.intakeCalls,[itemKey(fixture,'body'),...attachments.slice(0,2).map(item=>itemKey(fixture,item.id))]);
  assert.equal((await adminPool.query('select id from intake_events where workspace_id=$1 and idempotency_key=any($2)',[fixture.workspaceId,attachments.slice(2).map(item=>itemKey(fixture,item.id))])).rowCount,0);
  assert.equal((await adminPool.query('select last_received_at from email_routes where id=$1',[fixture.routeId])).rows[0].last_received_at,null);
});


test('a later work-budget yield does not erase an earlier real failure from worker attempts', async () => {
  const fixture=await route(),later=attachment('later.pdf',await pdf('after real failure and yield'));
  const budget={deadlineAt:Date.now()+240_000};let fail=true;
  const state=transport(fixture,[later],async(...args)=>{
    if(args[5]===itemKey(fixture,'body')&&fail){fail=false;budget.deadlineAt=Date.now()+70_000;throw Object.assign(new Error('PRIVATE earlier real failure'),{statusCode:503});}
  });
  assert.equal(await tickProviders(budget,{eventId:fixture.eventId,resend:state.dependencies}),true);
  const failed=(await adminPool.query('select status,attempts,error from provider_events where id=$1',[fixture.eventId])).rows[0];
  assert.equal(failed.status,'retry');assert.equal(failed.attempts,1);assert.ok(!failed.error.includes('PRIVATE'));
  assert.deepEqual(state.intakeCalls,[itemKey(fixture,'body')]);assert.deepEqual(state.downloadCalls,[]);
  await adminPool.query('update provider_events set next_attempt_at=now() where id=$1',[fixture.eventId]);
  assert.equal(await tickProviders({},{eventId:fixture.eventId,resend:state.dependencies}),true);
  assert.deepEqual((await adminPool.query('select status,attempts,error from provider_events where id=$1',[fixture.eventId])).rows[0],{status:'completed',attempts:2,error:null});
  assert.deepEqual(await counts(fixture),{documents:1,jobs:1,usage_ledger:1,intake_events:2,intake_files:0});
});
