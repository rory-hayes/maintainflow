import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Encrypter, generateHybridIdentity, identityToRecipient} from 'age-encryption';
import {openArchive, sealArchive} from '../scripts/backup/archive.js';
import {backupLimits, sha256, validateManifest} from '../scripts/backup/files.js';
import {BackupError} from '../scripts/backup/errors.js';
import type {BackupManifest} from '../scripts/backup/types.js';

// Independent framing avoids using the production encoder to construct invalid inputs.
const magic = Buffer.from('FOLIO-BACKUP\n1\n', 'ascii');
const liveKey = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002';
const absentKey = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000003';
const omittedKey = '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000004';
const identities = Promise.all([generateHybridIdentity(), generateHybridIdentity()]).then(async ([identity, wrongIdentity]) => ({identity, wrongIdentity, recipient: await identityToRecipient(identity)}));

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-backup-archive-'));
  await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'payload'), output = path.join(root, 'backup.age');
  await fs.mkdir(source, {mode: 0o700});
  // Table COPY bytes are deliberately opaque here; database correctness has separate acceptance.
  const contents = new Map<string, Buffer>([
    ['integration-key.bin', Buffer.alloc(32, 0x42)],
    ['tables/users.bin', Buffer.concat([Buffer.from('PGCOPY\n\xff\r\n\0', 'binary'), Buffer.alloc(90000, 0x37)])],
    ['objects/' + liveKey, Buffer.from('Owned synthetic original: café, 😀, zero 0, false.\n'.repeat(1900))],
  ]);
  for (const [name, bytes] of contents) {
    await fs.mkdir(path.dirname(path.join(source, name)), {recursive: true, mode: 0o700});
    await fs.writeFile(path.join(source, name), bytes, {mode: 0o600});
  }
  const object = contents.get('objects/' + liveKey)!;
  const manifest: BackupManifest = {
    format: 'folio-backup', version: 1, id: '00000000-0000-4000-8000-000000000010',
    createdAt: '2026-09-20T00:00:00.000Z', capture: 'quiesced-filesystem',
    database: {
      schema: 'folio', postgresMajor: 17, encoding: 'UTF8', sourceIdentity: sha256('owned source'), securitySha256: sha256('owned security'),
      tables: [{name: 'users', columns: [{name: 'id', type: 'uuid', generated: '', identity: ''}], primaryKey: ['id'], rows: 1}],
      sequences: [{name: 'document_events_sequence_seq', lastValue: '1', isCalled: false}],
      migrations: [{name: '001_core.sql', sha256: sha256('owned migration')}],
    },
    files: [...contents].map(([name, bytes]) => ({name, bytes: bytes.length, sha256: sha256(bytes)})),
    objects: [
      {key: liveKey, required: true, byteSize: object.length, present: true, bytes: object.length, sha256: sha256(object)},
      {key: absentKey, required: false, present: false},
    ],
    integrationKeySha256: sha256(contents.get('integration-key.bin')!),
    omittedObjects: [{key: omittedKey, bytes: 11, sha256: sha256('owned orphan')}],
  };
  const sentinel = path.join(root, 'outside-sentinel');
  await fs.writeFile(sentinel, 'unchanged outside extraction', {mode: 0o600});
  return {root, source, output, contents, manifest, sentinel, ...await identities};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function frame(f: Fixture, manifest: BackupManifest = f.manifest, extra = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([magic, length, json, ...manifest.files.map(record => f.contents.get(record.name) ?? Buffer.alloc(0)), extra]);
}
async function encrypt(f: Fixture, plaintext: Uint8Array) {
  const encrypter = new Encrypter(); encrypter.addRecipient(f.recipient);
  return Buffer.from(await encrypter.encrypt(plaintext));
}
async function unchangedSource(f: Fixture) {
  for (const [name, bytes] of f.contents) assert.deepEqual(await fs.readFile(path.join(f.source, name)), bytes, name);
  assert.equal(await fs.readFile(f.sentinel, 'utf8'), 'unchanged outside extraction');
}
async function rejectsCiphertext(f: Fixture, bytes: Buffer, name: string, identity = f.identity, code?: string) {
  const input = path.join(f.root, name + '.age'), destination = path.join(f.root, name);
  await fs.writeFile(input, bytes, {mode: 0o600}); await fs.mkdir(destination, {mode: 0o700});
  await assert.rejects(openArchive(input, identity, destination), (error: unknown) => error instanceof Error && (!code || error instanceof BackupError && error.code === code));
  assert.deepEqual(await fs.readdir(destination), [], 'Failed authentication/validation must clear extracted payloads');
  assert.deepEqual(await fs.readFile(input), bytes, 'Rejected encrypted input must remain unchanged');
  await unchangedSource(f);
}

test('backup archive round-trips actual hybrid age encryption across multiple chunks with exact private payloads', async t => {
  const f = await fixture(t), destination = path.join(f.root, 'restored');
  await fs.mkdir(destination, {mode: 0o700});
  await sealArchive(f.source, f.manifest, f.recipient, f.output);
  const ciphertext = await fs.readFile(f.output);
  assert.ok(ciphertext.length > 65536);
  const agePrefix = Buffer.from('age-encryption.org/v1\n');
  assert.ok(ciphertext.subarray(0, agePrefix.length).equals(agePrefix));
  assert.equal(ciphertext.includes(f.contents.get('integration-key.bin')!), false);
  const result = await openArchive(f.output, f.identity, destination);
  assert.deepEqual(result.manifest, f.manifest); assert.equal(result.ciphertextSha256, sha256(ciphertext));
  for (const [name, bytes] of f.contents) {
    const filename = path.join(destination, name);
    assert.deepEqual(await fs.readFile(filename), bytes, name);
    assert.equal((await fs.stat(filename)).mode & 0o777, 0o600);
  }
  assert.equal((await fs.stat(f.output)).mode & 0o777, 0o600);
  assert.equal(await fs.stat(path.join(destination, 'objects', absentKey)).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(destination, 'objects', omittedKey)).then(() => true, () => false), false);
  assert.deepEqual(await fs.readFile(f.output), ciphertext); await unchangedSource(f);
});

test('wrong identity, tampered body and truncated final authentication reject and clear staged plaintext', async t => {
  const f = await fixture(t), valid = await encrypt(f, frame(f));
  await rejectsCiphertext(f, valid, 'wrong-identity', f.wrongIdentity);
  for (const [label, at] of [['middle', Math.floor(valid.length / 2)], ['final-tag', valid.length - 1]] as const) {
    const altered = Buffer.from(valid); altered[at] ^= 0x80; await rejectsCiphertext(f, altered, 'tampered-' + label);
  }
  for (const [label, length] of [['header', 12], ['middle', Math.floor(valid.length / 2)], ['final-byte', valid.length - 1]] as const) {
    await rejectsCiphertext(f, valid.subarray(0, length), 'truncated-' + label);
  }
});

test('complete inner payload still rejects trailing plaintext, trailing ciphertext and concatenated age files', async t => {
  const f = await fixture(t), valid = await encrypt(f, frame(f));
  await rejectsCiphertext(f, await encrypt(f, frame(f, f.manifest, Buffer.from('extra'))), 'trailing-plaintext', f.identity, 'BACKUP_TRAILING');
  await rejectsCiphertext(f, Buffer.concat([valid, Buffer.from([0])]), 'trailing-ciphertext');
  await rejectsCiphertext(f, Buffer.concat([valid, valid]), 'concatenated-ciphertext');
});

test('correctly encrypted hostile payload paths and duplicate names are rejected before extraction', async t => {
  const f = await fixture(t);
  for (const [index, name] of ['../outside-sentinel', '/tmp/folio-backup-escape', 'tables/../users.bin', 'tables\\users.bin', 'tables//users.bin', 'objects/' + liveKey + '/child', 'tables/Users.bin'].entries()) {
    const manifest = structuredClone(f.manifest); manifest.files[1].name = name;
    await rejectsCiphertext(f, await encrypt(f, frame(f, manifest)), 'path-' + index);
  }
  const duplicate = structuredClone(f.manifest); duplicate.files.push({...duplicate.files[0]});
  await rejectsCiphertext(f, await encrypt(f, frame(f, duplicate)), 'duplicate-path', f.identity, 'BACKUP_PATH');
});

test('missing key/table/object payload declarations and duplicate database/object identities reject', async t => {
  const f = await fixture(t);
  const mutate: Array<(manifest: BackupManifest) => void> = [
    m => {m.files = m.files.filter(f => f.name !== 'integration-key.bin');},
    m => {m.files = m.files.filter(f => f.name !== 'tables/users.bin');},
    m => {m.files = m.files.filter(f => !f.name.startsWith('objects/'));},
    m => {m.database.tables.push(structuredClone(m.database.tables[0]));},
    m => {m.database.sequences.push({...m.database.sequences[0]});},
    m => {m.database.migrations.push({...m.database.migrations[0]});},
    m => {m.objects.push({...m.objects[0]});},
    m => {m.omittedObjects.push({...m.omittedObjects[0]});},
    m => {m.omittedObjects[0].key = liveKey;},
  ];
  for (const [index, change] of mutate.entries()) {
    const manifest = structuredClone(f.manifest); change(manifest);
    await rejectsCiphertext(f, await encrypt(f, frame(f, manifest)), 'inventory-' + index);
  }
});

test('optional absent reservations are accepted but required absent or mismatched originals reject', async t => {
  const f = await fixture(t); assert.deepEqual(validateManifest(f.manifest), f.manifest);
  const cases: Array<(manifest: BackupManifest) => void> = [
    m => {m.objects[1].required = true;},
    m => {m.objects[1].bytes = 0;},
    m => {m.objects[1].sha256 = sha256('absent');},
    m => {m.objects[0].byteSize! += 1;},
    m => {m.objects[0].sha256 = sha256('wrong digest');},
    m => {m.objects[0].bytes! += 1;},
  ];
  for (const [index, change] of cases.entries()) {
    const manifest = structuredClone(f.manifest); change(manifest);
    await rejectsCiphertext(f, await encrypt(f, frame(f, manifest)), 'reference-' + index);
  }
});

test('oversize or invalid declarations fail without allocating their declared payload', async t => {
  const f = await fixture(t);
  for (const [index, bytes] of [backupLimits.payloadBytes + 1, -1, Number.MAX_SAFE_INTEGER, backupLimits.payloadBytes].entries()) {
    const manifest = structuredClone(f.manifest); manifest.files[1].bytes = bytes;
    await rejectsCiphertext(f, await encrypt(f, frame(f, manifest)), 'oversize-file-' + index);
  }
  for (const [index, declared] of [0, backupLimits.manifestBytes + 1, 0xffffffff].entries()) {
    const length = Buffer.alloc(4); length.writeUInt32BE(declared);
    await rejectsCiphertext(f, await encrypt(f, Buffer.concat([magic, length])), 'oversize-manifest-' + index, f.identity, 'BACKUP_LIMIT');
  }
});

test('authenticated invalid UTF8/JSON, wrong magic and incomplete file bytes reject with no retained extraction', async t => {
  const f = await fixture(t);
  for (const [index, bytes] of [Buffer.from([0xc0, 0xaf]), Buffer.from('{"format":')].entries()) {
    const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
    await rejectsCiphertext(f, await encrypt(f, Buffer.concat([magic, length, bytes])), 'invalid-json-' + index, f.identity, 'BACKUP_MANIFEST');
  }
  const wrongMagic = frame(f); wrongMagic[0] ^= 1;
  await rejectsCiphertext(f, await encrypt(f, wrongMagic), 'wrong-magic', f.identity, 'BACKUP_FORMAT');
  await rejectsCiphertext(f, await encrypt(f, frame(f).subarray(0, -1)), 'missing-final-payload-byte', f.identity, 'BACKUP_TRUNCATED');
  const changed = frame(f); changed[changed.length - 1] ^= 1;
  await rejectsCiphertext(f, await encrypt(f, changed), 'incorrect-content-digest', f.identity, 'BACKUP_DIGEST');
});

test('non-age input and headers beyond the bounded prefix reject before cryptographic parsing', async t => {
  const f = await fixture(t);
  await rejectsCiphertext(f, Buffer.from('not encrypted'), 'non-age', f.identity, 'BACKUP_HEADER');
  const oversizedHeader = Buffer.concat([Buffer.from('age-encryption.org/v1\n'), Buffer.alloc(backupLimits.headerBytes, 0x41), Buffer.from('\n--- ' + 'A'.repeat(43) + '\n')]);
  await rejectsCiphertext(f, oversizedHeader, 'oversize-header', f.identity, 'BACKUP_HEADER');
});

test('encryption failures remove new partial output and never replace an existing output', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.output, 'existing artifact must survive', {mode: 0o600});
  await assert.rejects(sealArchive(f.source, f.manifest, f.recipient, f.output));
  assert.equal(await fs.readFile(f.output, 'utf8'), 'existing artifact must survive');
  const manifest = structuredClone(f.manifest); manifest.files[1].sha256 = sha256('incorrect source digest');
  const failedOutput = path.join(f.root, 'failed-output.age');
  await assert.rejects(sealArchive(f.source, manifest, f.recipient, failedOutput));
  assert.equal(await fs.stat(failedOutput).then(() => true, () => false), false);
  const missingSource = path.join(f.root, 'missing-source'); await fs.mkdir(missingSource, {mode: 0o700});
  await assert.rejects(sealArchive(missingSource, f.manifest, f.recipient, failedOutput));
  assert.equal(await fs.stat(failedOutput).then(() => true, () => false), false);
  await unchangedSource(f);
});

test('preexisting extraction content and symbolic-link input are refused without touching their targets', async t => {
  const f = await fixture(t), bytes = await encrypt(f, frame(f)); await fs.writeFile(f.output, bytes, {mode: 0o600});
  const destination = path.join(f.root, 'nonempty'); await fs.mkdir(destination, {mode: 0o700});
  await fs.writeFile(path.join(destination, 'keep'), 'owned existing content');
  await assert.rejects(openArchive(f.output, f.identity, destination), (error: unknown) => error instanceof BackupError && error.code === 'BACKUP_TARGET');
  assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'owned existing content');
  const link = path.join(f.root, 'input-link.age'), empty = path.join(f.root, 'empty');
  await fs.symlink(f.output, link); await fs.mkdir(empty, {mode: 0o700});
  await assert.rejects(openArchive(link, f.identity, empty));
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true); assert.deepEqual(await fs.readdir(empty), []);
  assert.deepEqual(await fs.readFile(f.output), bytes); await unchangedSource(f);
});
