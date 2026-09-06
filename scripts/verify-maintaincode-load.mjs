import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import postgres from "postgres";
import { loadMigrations } from "./run-database-migrations.mjs";

// This verifier owns a fresh loopback-only PostgreSQL cluster. It cannot accept
// a hosted database URL, and never loads an environment file or provider key.
const pgBin = process.env.MAINTAINCODE_TEST_PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const dockerMode = process.argv.includes("--docker");
if (process.argv.slice(2).some(value => value !== "--docker")) throw new Error("Only --docker is supported; external database URLs are not accepted.");
const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "mc-load-"));
const data = join(scratch, "pg");
let started = false;
let container;
let admin;
let runtime;
let stage = "disposable database setup";
const checks = [];
const timings = [];
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function pg(command, args) {
  const result = spawnSync(join(pgBin, command), args, { encoding: "utf8", timeout: 45_000 });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.code ?? "unknown"}).`);
}
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0) throw new Error(`Owned test container operation failed (${result.status ?? result.error?.code ?? "unknown"}).`);
  return result.stdout.trim();
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
function check(name) { checks.push(name); console.log(`PASS: ${name}`); }
try {
  let port;
  if (dockerMode) {
    container = `maintaincode-load-${randomUUID()}`;
    docker(["run", "--detach", "--rm", "--name", container, "--publish", "127.0.0.1::5432", "--env", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17"]);
    started = true;
    const mapping = docker(["port", container, "5432/tcp"]);
    assert.match(mapping, /^127\.0\.0\.1:\d+$/);
    port = Number(mapping.split(":")[1]);
  } else {
    pg("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=trust", "--encoding=UTF8", "--locale=C"]);
    port = await freePort();
    pg("pg_ctl", ["-D", data, "-l", join(scratch, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${scratch}`, "-w", "start"]);
    started = true;
  }
  admin = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, connect_timeout: 1, onnotice: () => {} });
  for (let attempt = 0; ; attempt++) {
    try { await admin`select 1`; break; }
    catch (error) { if (attempt >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  const migrations = await loadMigrations();
  for (const migration of migrations) await admin.begin(tx => tx.unsafe(migration.sql));
  await admin`alter role maintaincode_app login`;
  await admin`grant connect on database postgres to maintaincode_app`;
  process.env.DATABASE_URL = `postgres://maintaincode_app@127.0.0.1:${port}/postgres`;
  process.env.NODE_ENV = "development";
  process.env.MAINTAINCODE_LOCAL_TEST = "1";
  process.env.MAINTAINFLOW_DATABASE_POOL_MAX = "2";

  stage = "load actual application persistence and collector";
  const source = path => JSON.stringify(join(root, "src", path));
  const bundle = await build({
    stdin: { contents: `export * from ${source("lib/attribution/store.server.ts")}; export * from ${source("lib/attribution/model.ts")}; export {closeRuntimeDatabase} from ${source("lib/database/client.server.ts")}; export {POST as collect} from ${source("app/api/attribution/collect/route.ts")};`, resolveDir: root, loader: "ts" },
    bundle: true, write: false, platform: "node", format: "esm", target: "node22",
    banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(join(root, "package.json"))});` },
    plugins: [{ name: "local-database-only", setup(builder) {
      builder.onResolve({ filter: /^server-only$/ }, () => ({ path: "marker", namespace: "local-verifier" }));
      builder.onResolve({ filter: /(?:^@\/lib\/|\/)auth\/operator\.server(?:\.ts)?$/ }, () => ({ path: "identity", namespace: "local-verifier" }));
      builder.onLoad({ filter: /.*/, namespace: "local-verifier" }, ({ path }) => ({
        contents: path === "identity" ? "export async function requireOperatorId(){throw new Error('Hosted identity is outside this local verifier.')}" : "export {};", loader: "js",
      }));
    } }],
  });
  runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
  const [role] = await runtime.database()`select current_user as name,rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
  assert.equal(role.name, "maintaincode_app");
  assert.equal(role.rolsuper, false);
  assert.equal(role.rolbypassrls, false);
  check(`${migrations.length} migrations and dedicated non-bypass runtime on an owned local cluster`);

  const create = (name, agency) => runtime.createWorkspace(new Request("http://127.0.0.1/app"), `Load verification ${name}`, agency);
  const request = (item, origin) => new Request("http://127.0.0.1/api/attribution/collect", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(item) });
  const makeItem = (site, { test = false, id = randomUUID(), evidence } = {}) => ({
    id, siteId: site.id, formId: "load-form", at: new Date().toISOString(), test, status: "confirmed",
    evidence: evidence ?? runtime.advanceEvidence(null, runtime.captureTouch(`${site.origin}/enquiry?utm_source=qa&utm_medium=email`, "")),
  });
  const site = () => ({ id: randomUUID(), name: "Owned synthetic form", origin: "https://load-verification.invalid", adapter: "html", formSelector: "form", consent: "required", retentionDays: 90, mapping: runtime.defaultMapping, paused: false });

  for (const [plan, limit] of [["starter", 500], ["agency", 2500]]) {
    stage = `${plan} concurrent captures at its declared monthly limit`;
    const workspace = await create(plan, plan === "agency");
    const sites = Array.from({ length: plan === "agency" ? 5 : 1 }, site);
    const fixtures = Array.from({ length: limit - 20 }, () => makeItem(sites[0]));
    await runtime.mutateWorkspace(workspace.id, state => { state.sites = sites; state.submissions = fixtures; });
    const additions = Array.from({ length: 20 }, (_, index) => makeItem(sites[index % sites.length]));
    const burst = [...additions, ...additions].map(async item => {
      const began = performance.now();
      const response = await runtime.collect(request(item, sites[0].origin));
      timings.push({ plan, milliseconds: performance.now() - began });
      assert.equal(response.status, 202, `${plan} capture/retry should be accepted`);
    });
    burst.push(runtime.mutateWorkspace(workspace.id, state => { state.name = `Updated ${plan}`; }));
    burst.push(runtime.mutateWorkspace(workspace.id, state => { state.timezone = "Europe/London"; }));
    await Promise.all(burst);
    const saved = await runtime.readWorkspace(workspace.id);
    assert.equal(saved.submissions.length, limit);
    assert.equal(new Set(saved.submissions.map(item => item.id)).size, limit);
    assert.equal(runtime.usage(saved), limit);
    assert.equal(saved.name, `Updated ${plan}`);
    assert.equal(saved.timezone, "Europe/London");
    for (const currentSite of sites) assert.equal((await runtime.siteOwner(currentSite.id)).organizationId, workspace.id);
    assert.equal((await runtime.collect(request(makeItem(sites[0]), sites[0].origin))).status, 429);
    assert.equal((await runtime.readWorkspace(workspace.id)).submissions.length, limit);
    const diagnostic = makeItem(sites[0], { test: true });
    assert.equal((await runtime.collect(request(diagnostic, sites[0].origin))).status, 202);
    assert.equal(runtime.usage(await runtime.readWorkspace(workspace.id)), limit);
    check(`${plan}: ${limit} unique production submissions, 40 concurrent capture/retry requests, concurrent settings preserved, quota bounded, diagnostic excluded`);
  }

  stage = "declared retained-record ceiling and atomic storage failures";
  const bounded = await create("bounds", true);
  const boundedSite = site();
  const items = Array.from({ length: 10000 }, () => makeItem(boundedSite, { test: true }));
  await runtime.mutateWorkspace(bounded.id, state => { state.sites = [boundedSite]; state.submissions = items; });
  assert.equal((await runtime.collect(request(makeItem(boundedSite, { test: true }), boundedSite.origin))).status, 429);
  assert.equal((await runtime.collect(request(items[0], boundedSite.origin))).status, 202);
  assert.equal((await runtime.readWorkspace(bounded.id)).submissions.length, 10000);
  check("10,000 retained-record ceiling rejects a new record but accepts an idempotent retry");
  const before = await runtime.readWorkspace(bounded.id);
  const beforeHash = digest(before);
  await assert.rejects(runtime.mutateWorkspace(bounded.id, state => { state.name = "x".repeat(12_000_001); }), { status: 413 });
  assert.equal(digest(await runtime.readWorkspace(bounded.id)), beforeHash);
  assert.equal((await runtime.siteOwner(boundedSite.id)).organizationId, bounded.id);
  check("oversized state update rolls back both workspace and site registry");

  stage = "UTF-8 storage boundary";
  await runtime.mutateWorkspace(bounded.id, state => { state.submissions = []; });
  const smallState = await runtime.readWorkspace(bounded.id);
  // Four million non-ASCII characters fit the previous character-count guard,
  // but exceed the documented 12 MB serialized UTF-8 storage ceiling.
  await assert.rejects(runtime.mutateWorkspace(bounded.id, state => { state.name = "界".repeat(4_000_001); }), { status: 413 });
  assert.equal(digest(await runtime.readWorkspace(bounded.id)), digest(smallState));
  check("12 MB limit counts serialized UTF-8 bytes and failed updates leave state unchanged");
  const measurement = Object.fromEntries(["starter", "agency"].map(plan => {
    const values = timings.filter(item => item.plan === plan).map(item => item.milliseconds).sort((a,b) => a-b);
    return [plan, { requests: values.length, medianMs: Math.round(values[Math.floor(values.length / 2)]), p95Ms: Math.round(values[Math.ceil(values.length * .95) - 1]), maxMs: Math.round(values.at(-1)) }];
  }));
  console.log(JSON.stringify({ ok: true, checks, measurements: measurement, scope: "Local PostgreSQL with app pool size 2 and generated fixtures; not hosted capacity or provider evidence." }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, stage, name: error.name, message: error.message?.slice(0, 500) }));
  process.exitCode = 1;
} finally {
  await runtime?.closeRuntimeDatabase();
  await admin?.end({ timeout: 5 });
  if (started) {
    if (container) docker(["rm", "--force", container]);
    else pg("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
  }
  await rm(scratch, { recursive: true, force: true });
}
