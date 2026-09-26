/** Execute the checked recipe in a disposable, network-isolated real n8n runtime. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {buildWorkflow, reviewedN8nVersion} from '../examples/automations/source-intake/google-drive-n8n.mjs';
import {createFixtureCatalog, syntheticDriveToken, syntheticMaintainFlowToken, syntheticAdminToken, syntheticParserId} from './source-intake-n8n-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = 'docker.n8n.io/n8nio/n8n@sha256:ffeb52485f78b1b06c9a832205853cf75da72a07a514c9a27724df85979d6c34';
const label = 'io.maintainflow.source-intake-qa';
const digest = value => createHash('sha256').update(value).digest('hex');
const catalog = createFixtureCatalog();
const plan = {version: reviewedN8nVersion, image, isolation: 'Disposable Docker internal-only network; synthetic TLS endpoints and credentials; no host ports or existing containers', scenarios: catalog.scenarios.map(x => x.name), applicationDatabase: 'untouched', hostedCalls: 0, realProviderCalls: 0};
if (process.argv.length === 2 || process.argv[2] === '--plan') { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
assert.deepEqual(process.argv.slice(2), ['--execute'], 'Only explicit --execute is supported');
assert.equal(process.cwd(), root, 'Run from the existing application checkout');
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 is required');
process.umask(0o077);
const runId = randomUUID(), short = runId.slice(0, 8), prefix = `mf-source-${short}`;
const directory = path.join(root, '.local', 'source-intake-n8n', runId);
const bundle = path.join(directory, 'bundle');
await fs.mkdir(bundle, {recursive: true, mode: 0o755});
await fs.chmod(bundle, 0o755);
const receipt = {version: 1, runId, ...plan, startedAt: new Date().toISOString(), result: 'running', cases: [], commands: [], cleanup: {}};
const resource = {network: false, fixture: false, engine: false};
const network = `${prefix}-net`, fixture = `${prefix}-fixture`, engine = `${prefix}-engine`;
async function save() { await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); }
async function command(name, program, args, options = {}) {
  const started = Date.now(), stdout = [], stderr = [];
  const child = spawn(program, args, {cwd: root, env: {...process.env, ...options.env}, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', b => stdout.push(b)); child.stderr.on('data', b => stderr.push(b));
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, options.timeout ?? 120000);
  const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); }).finally(() => clearTimeout(timeout));
  const output = Buffer.concat(stdout).toString(), errors = Buffer.concat(stderr).toString();
  await fs.writeFile(path.join(directory, `${name}.stdout.log`), output);
  await fs.writeFile(path.join(directory, `${name}.stderr.log`), errors);
  receipt.commands.push({name, status, timedOut, elapsedMs: Date.now() - started}); await save();
  if ((status !== 0 || timedOut) && !options.allowFailure) throw new Error(`${name} failed; inspect the private receipt logs`);
  return {status, output, errors, timedOut};
}
const docker = (name, args, options) => command(name, 'docker', args, options);
async function writeBundle(name, value) { await fs.writeFile(path.join(bundle, name), value, {mode: 0o644}); }
function workflowFor(scenario) {
  const workflow = buildWorkflow();
  const triggers = workflow.nodes.filter(n => n.type === 'n8n-nodes-base.googleDriveTrigger');
  assert.equal(triggers.length, 2); assert.deepEqual(workflow.connections[triggers[0].name], workflow.connections[triggers[1].name]);
  const start = workflow.connections[triggers[0].name];
  workflow.nodes = workflow.nodes.filter(n => !triggers.includes(n));
  for (const trigger of triggers) delete workflow.connections[trigger.name];
  workflow.nodes.unshift(
    {id: 'qa-manual', name: 'QA Manual Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {}, position: [-400, 180]},
    {id: 'qa-seed', name: 'QA synthetic trigger items', type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {mode: 'runOnceForAllItems', jsCode: `return ${JSON.stringify(scenario.inputItems)}.map(json => ({json}));`}, position: [-180, 180]},
  );
  workflow.connections['QA Manual Trigger'] = {main: [[{node: 'QA synthetic trigger items', type: 'main', index: 0}]]};
  workflow.connections['QA synthetic trigger items'] = start;
  for (const node of workflow.nodes) {
    if (node.name === 'Configure import') {
      node.parameters.jsCode = node.parameters.jsCode.replace("parserId: 'REPLACE_WITH_EXISTING_PARSER_UUID'", `parserId: '${syntheticParserId}'`).replace("folderId: 'REPLACE_WITH_DRIVE_FOLDER_ID'", "folderId: 'synthetic-owned-folder'");
    }
    if (node.type === 'n8n-nodes-base.googleDrive' || node.parameters.nodeCredentialType === 'googleDriveOAuth2Api') node.credentials = {googleDriveOAuth2Api: {id: 'source-qa-drive', name: 'Synthetic Drive QA only'}};
    if (node.parameters.genericAuthType === 'httpHeaderAuth') node.credentials = {httpHeaderAuth: {id: 'source-qa-maintainflow', name: 'Synthetic MaintainFlow QA only'}};
    if (node.name === 'Wait before next check') node.parameters.amount = 0.01;
  }
  workflow.id = `sourceQA${short}${String(catalog.scenarios.indexOf(scenario)).padStart(2, '0')}`;
  workflow.name = `Synthetic source recipe ${scenario.name}`;
  workflow.settings = {...workflow.settings, saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all'};
  return workflow;
}
function resultJson(output) {
  // CLI --rawOutput can still precede the execution JSON with migration logs.
  for (const start of [...output.matchAll(/\{\s*"(?:data|mode|startedAt|status)"\s*:/g)].map(m => m.index)) {
    try { return JSON.parse(output.slice(start, output.lastIndexOf('}') + 1)); } catch {}
  }
  throw new Error('n8n did not return an execution JSON record');
}
async function admin(method, endpoint, body) {
  const script = `const r=await fetch('https://maintainflow.io/__qa/${endpoint}',{method:${JSON.stringify(method)},headers:{'X-QA-Token':${JSON.stringify(syntheticAdminToken)},'content-type':'application/json'},${body ? `body:${JSON.stringify(JSON.stringify(body))},` : ''}});if(!r.ok)throw Error('fixture_admin_'+r.status);process.stdout.write(await r.text());`;
  const r = await docker(`admin-${endpoint}-${receipt.commands.length}`, ['exec', fixture, 'node', '--input-type=module', '-e', script]);
  return JSON.parse(r.output);
}
async function removeOwned(type, name) {
  const inspected = await docker(`inspect-cleanup-${name}`, [type === 'network' ? 'network' : 'container', 'inspect', name, '--format', type === 'network' ? `{{index .Labels "${label}"}}` : `{{index .Config.Labels "${label}"}}`], {allowFailure: true});
  if (inspected.status !== 0) return 'already_absent';
  assert.equal(inspected.output.trim(), runId, 'Refusing to remove an unowned Docker resource');
  await docker(`remove-${name}`, type === 'network' ? ['network', 'rm', name] : ['rm', '-f', name]);
  return 'removed';
}
try {
  const artifact = await fs.readFile(path.join(root, 'examples/automations/google-drive-n8n.workflow.json'));
  assert.deepEqual(JSON.parse(artifact), buildWorkflow(), 'Regenerate the workflow before verification');
  receipt.workflowSha256 = digest(artifact);
  receipt.generatorSha256 = digest(await fs.readFile(path.join(root, 'examples/automations/source-intake/google-drive-n8n.mjs')));
  receipt.fixtureSha256 = digest(await fs.readFile(path.join(root, 'scripts/source-intake-n8n-fixture.mjs')));
  const inspected = await docker('image', ['image', 'inspect', image]);
  const imageInfo = JSON.parse(inspected.output)[0]; receipt.imageId = imageInfo.Id;
  assert.ok(imageInfo.RepoDigests.includes(image));
  await writeBundle('source-intake-n8n-fixture.mjs', await fs.readFile(path.join(root, 'scripts/source-intake-n8n-fixture.mjs')));
  await writeBundle('scenarios.json', JSON.stringify({driveToken: syntheticDriveToken, maintainflowToken: syntheticMaintainFlowToken, adminToken: syntheticAdminToken, parserId: syntheticParserId, folderId: 'synthetic-owned-folder', ...catalog}));
  const config = '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=v3\n[dn]\nCN=MaintainFlow isolated synthetic QA only\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nsubjectAltName=DNS:www.googleapis.com,DNS:maintainflow.io\n';
  await writeBundle('tls.cnf', config);
  await command('synthetic-tls', 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', path.join(bundle, 'tls-key.pem'), '-out', path.join(bundle, 'tls.pem'), '-config', path.join(bundle, 'tls.cnf')]);
  await fs.chmod(path.join(bundle, 'tls.pem'), 0o644);
  await writeBundle('credentials.json', JSON.stringify([
    {id: 'source-qa-drive', name: 'Synthetic Drive QA only', type: 'googleDriveOAuth2Api', data: {clientId: 'SYNTHETIC_CLIENT_ID', clientSecret: 'SYNTHETIC_CLIENT_SECRET', scope: 'https://www.googleapis.com/auth/drive.readonly', oauthTokenData: {access_token: syntheticDriveToken, token_type: 'Bearer', expires_in: 3600, expires_at: Date.now() + 3600000, refresh_token: 'SYNTHETIC_UNUSED_REFRESH'}}},
    {id: 'source-qa-maintainflow', name: 'Synthetic MaintainFlow QA only', type: 'httpHeaderAuth', data: {name: 'Authorization', value: `Bearer ${syntheticMaintainFlowToken}`}},
  ]));
  await docker('network', ['network', 'create', '--internal', '--label', `${label}=${runId}`, network]); resource.network = true;
  const internal = await docker('network-proof', ['network', 'inspect', network]); assert.equal(JSON.parse(internal.output)[0].Internal, true);
  const common = ['--network', network, '--label', `${label}=${runId}`, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '1g', '--cpus', '2', '--tmpfs', '/tmp:rw,size=256m', '--mount', `type=bind,src=${bundle},dst=/fixtures,readonly`, '-e', 'NODE_EXTRA_CA_CERTS=/fixtures/tls.pem'];
  await docker('start-fixture', ['run', '-d', '--name', fixture, ...common, '--network-alias', 'www.googleapis.com', '--network-alias', 'maintainflow.io', '--user', '0', '--entrypoint', 'node', '-e', 'SOURCE_INTAKE_FIXTURE_DIR=/fixtures', image, '/fixtures/source-intake-n8n-fixture.mjs']); resource.fixture = true;
  await docker('start-engine', ['run', '-d', '--name', engine, ...common, '--tmpfs', '/home/node/.n8n:rw,uid=1000,gid=1000,size=256m', '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false', '-e', 'N8N_TEMPLATES_ENABLED=false', '-e', 'N8N_PERSONALIZATION_ENABLED=false', '-e', 'N8N_COMMUNITY_PACKAGES_ENABLED=false', '-e', 'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true', '--entrypoint', 'node', image, '-e', 'setInterval(()=>{},60000)']); resource.engine = true;
  await docker('import-synthetic-credentials', ['exec', engine, 'n8n', 'import:credentials', '--input=/fixtures/credentials.json']);
  receipt.nativeVersion = (await docker('native-version', ['exec', engine, 'n8n', '--version'])).output.trim(); assert.equal(receipt.nativeVersion, reviewedN8nVersion);
  for (const scenario of catalog.scenarios) {
    const workflow = workflowFor(scenario), filename = `workflow-${scenario.name}.json`;
    await writeBundle(filename, JSON.stringify(workflow));
    const baseline = await admin('POST', 'reset', {scenario: scenario.name});
    await docker(`import-${scenario.name}`, ['exec', engine, 'n8n', 'import:workflow', `--input=/fixtures/${filename}`]);
    const executed = await docker(`execute-${scenario.name}`, ['exec', engine, 'n8n', 'execute', `--id=${workflow.id}`, '--rawOutput'], {allowFailure: true, timeout: 120000});
    const result = resultJson(executed.output), state = await admin('GET', 'state');
    await fs.writeFile(path.join(directory, `state-${scenario.name}.json`), JSON.stringify(state, null, 2));
    const runData = result.data?.resultData?.runData ?? result.resultData?.runData;
    assert.ok(runData, 'Missing native execution node history');
    const error = result.data?.resultData?.error ?? result.resultData?.error;
    const outputs = (runData['Review receipt'] ?? []).flatMap(run => run.data?.main?.flat() ?? []).map(item => item.json);
    const record = {name: scenario.name, status: 'running', nativeExitCode: executed.status, outcome: error ? 'failed' : 'completed', nodeNames: Object.keys(runData), outputs, state, baseline};
    receipt.cases.push(record); await save();
    if (scenario.expectedOutcome === 'success') {
      assert.equal(executed.status, 0); assert.equal(error, undefined); assert.equal(outputs.length, scenario.inputItems.length);
      for (const item of outputs) { assert.ok(item.documentId && item.runId); assert.equal(item.parserId, syntheticParserId); assert.match(item.approval, /never approves/); }
    } else {
      assert.ok(error, `Expected ${scenario.name} to stop with an explicit error`);
      record.errorMessage = error.message;
      if (scenario.expectedErrorCode) assert.match(error.message, new RegExp(scenario.expectedErrorCode));
    }
    for (const [expectation,key] of [['expectedNewDocuments','documents'],['expectedNewJobs','jobs'],['expectedNewPageCharges','pageCharges']]) {
      if (scenario[expectation] !== undefined) assert.equal(state.counters[key]-state.baseline[key],scenario[expectation],`${scenario.name} ${key}`);
    }
    if (scenario.expectedUploadAttempts !== undefined) assert.equal(state.requests.filter(x=>x.method==='POST'&&x.path.includes('/api/parsers/')).length,scenario.expectedUploadAttempts);
    if (scenario.expectedDownloads !== undefined) assert.equal(state.downloads.length,scenario.expectedDownloads);
    for (const upload of state.uploads) {
      const source=catalog.files.find(x=>x.id===upload.fileId);assert.ok(source);
      assert.equal(upload.sha256,source.sha256);assert.equal(upload.md5,source.md5Checksum);assert.equal(upload.bytes,Number(source.size));assert.equal(upload.field,'file');
    }
    for(const output of outputs){const doc=state.documents.find(x=>x.id===output.documentId);assert.equal(output.jobId,doc.currentJobId);assert.equal(output.runId,doc.latestRunId);}
    if(scenario.name==='multipleFiles'||scenario.name==='reordered')assert.deepEqual(outputs.map(x=>x.sourceFileId),scenario.inputItems.map(x=>x.id));
    if(scenario.name==='duplicate')assert.ok(outputs.every(x=>x.duplicate===true));
    if(['happy','multipleFiles','reordered'].includes(scenario.name)){
      const count=scenario.inputItems.length;
      assert.equal(state.counters.documents,count);assert.equal(state.counters.jobs,count);assert.equal(state.counters.runs,count);assert.equal(state.counters.pageCharges,count);
      assert.equal(state.uploads.length,count);assert.equal(state.downloads.length,count);
    }
    assert.deepEqual(state.unexpectedRequests,[],'Only the enumerated synthetic services may be accessed');
    record.status = 'passed'; await save();
    console.log(JSON.stringify({scenario: scenario.name, result: 'passed', outputRows: outputs.length}));
  }
  assert.equal(digest(await fs.readFile(path.join(root, 'examples/automations/google-drive-n8n.workflow.json'))), receipt.workflowSha256);
  assert.equal(digest(await fs.readFile(path.join(root, 'examples/automations/source-intake/google-drive-n8n.mjs'))), receipt.generatorSha256);
  assert.equal(digest(await fs.readFile(path.join(root, 'scripts/source-intake-n8n-fixture.mjs'))), receipt.fixtureSha256);
  receipt.result = 'passed';
} catch (error) {
  receipt.result = 'failed'; receipt.failure = error.message; process.exitCode = 1;
} finally {
  for (const [key, name] of [['engine', engine], ['fixture', fixture], ['network', network]]) {
    try { receipt.cleanup[key] = await removeOwned(key === 'network' ? 'network' : 'container', name); } catch { receipt.cleanup[key] = 'requires_owned_resource_cleanup'; process.exitCode = 1; }
  }
  await fs.rm(path.join(bundle, 'tls-key.pem'), {force: true}); await fs.rm(path.join(bundle, 'credentials.json'), {force: true});
  receipt.cleanup.syntheticKeyAndCredentials = 'removed';
  receipt.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({result: receipt.result, failure: receipt.failure ?? null, receipt: path.join(directory, 'receipt.json'), cleanup: receipt.cleanup}));
}
