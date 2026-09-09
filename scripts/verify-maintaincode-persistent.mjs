import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createPortReservation } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { chromium, expect as baseExpect } from "@playwright/test";
import postgres from "postgres";

// Self-contained local verification: no caller-supplied app or database target.
// Own cluster, source copy, browser context and ports preserve existing fixtures,
// the user's open tabs and any running Next.js build/development directory.
// Requires Playwright Chromium and either initdb/pg_ctl or Docker (--docker).
// Docker mode uses an owned postgres:17 container bound only to loopback.
const dockerMode = process.argv.includes("--docker");
if (process.argv.slice(2).some((argument) => argument !== "--docker")) {
  throw new Error(
    "Usage: node scripts/verify-maintaincode-persistent.mjs [--docker]",
  );
}
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runId = randomUUID();
const name = `Browser persistence ${runId}`;
const scratch = await mkdtemp(join(tmpdir(), "maintaincode-persistent-"));
const evidenceDir = await mkdtemp(
  join(tmpdir(), "maintaincode-persistent-evidence-"),
);
const project = join(scratch, "project");
const cluster = join(scratch, "postgres");
const socketDir = join(scratch, "socket");
const command = promisify(execFile);
const childEnvironment = Object.fromEntries(
  ["PATH", "TMPDIR", "SYSTEMROOT", "WINDIR"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
// Homebrew PostgreSQL on macOS needs an explicit valid locale at startup.
childEnvironment.LC_ALL = "C";
const checks = [];
const expect = baseExpect.configure({ timeout: 15_000 });
const externalRequests = [];
const errors = [];
const consoleErrors = [];
const fixtureIds = new Set();
let stage = "initialization";
let sql;
let browser;
let app;
let fixture;
let clusterStarted = false;
let container;
let cancelled = false;
let failure;
let cleanupFailure;
const logs = createWriteStream(join(evidenceDir, "server.log"));
const pass = (label) => {
  checks.push(label);
  console.log(`PASS: ${label}`);
};
const onSignal = () => {
  cancelled = true;
  void browser?.close().catch(() => {});
  signalApp("SIGTERM");
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
const deadline = setTimeout(onSignal, 360_000);
deadline.unref();

async function freePort() {
  const reservation = createPortReservation();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function run(commandName, args) {
  const result = await command(commandName, args, {
    env: childEnvironment,
    timeout: 60_000,
    maxBuffer: 2_000_000,
  });
  return result.stdout.trim();
}

function signalApp(signal) {
  if (!app?.pid) return;
  try {
    if (process.platform === "win32") app.kill(signal);
    else process.kill(-app.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function stopApp() {
  signalApp("SIGTERM");
  if (!app || app.exitCode !== null || app.signalCode !== null) return;
  const force = setTimeout(() => signalApp("SIGKILL"), 5000);
  try {
    await once(app, "exit");
  } finally {
    clearTimeout(force);
  }
}

async function waitForApp(origin) {
  const until = Date.now() + 120_000;
  while (Date.now() < until && !cancelled) {
    assert.equal(app.exitCode, null, "The isolated Next.js server exited.");
    try {
      const response = await fetch(`${origin}/api/attribution/ready`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const ready = await response.json();
        assert.equal(ready.scope, "local_database_only");
        assert.equal(ready.ready, true);
        return;
      }
    } catch {
      // Compilation and initial listening are bounded by the startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The isolated local app did not become ready.");
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

try {
  stage = "isolated source snapshot";
  await mkdir(project);
  await mkdir(socketDir);
  // Explicit allowlist excludes all .env files, .git, .next and existing reports.
  for (const entry of [
    "src",
    "public",
    "scripts",
    "docs",
    "package.json",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "tailwind.config.ts",
  ]) {
    await cp(join(root, entry), join(project, entry), { recursive: true });
  }
  await symlink(join(root, "node_modules"), join(project, "node_modules"));
  await build({
    entryPoints: [join(project, "src/lib/attribution/tracker.ts")],
    outfile: join(project, "public/mc-tracker.js"),
    bundle: true,
    minify: true,
    format: "iife",
    target: "es2020",
  });
  const trackerSha256 = createHash("sha256")
    .update(await readFile(join(project, "public/mc-tracker.js")))
    .digest("hex");

  stage = "owned disposable PostgreSQL cluster";
  let databasePort;
  if (dockerMode) {
    container = `maintaincode-browser-${runId}`;
    await run("docker", [
      "run",
      "--detach",
      "--rm",
      "--name",
      container,
      "--publish",
      "127.0.0.1::5432",
      "--env",
      "POSTGRES_USER=mc_browser_admin",
      "--env",
      "POSTGRES_HOST_AUTH_METHOD=trust",
      "postgres:17",
    ]);
    const address = await run("docker", ["port", container, "5432/tcp"]);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    databasePort = Number(address.split(":")[1]);
  } else {
    databasePort = await freePort();
    await run("initdb", [
      "-D",
      cluster,
      "--username=mc_browser_admin",
      "--auth=trust",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    await run("pg_ctl", [
      "-D",
      cluster,
      "-l",
      join(evidenceDir, "postgres.log"),
      "-w",
      "-t",
      "30",
      "-o",
      `-h 127.0.0.1 -p ${databasePort} -k ${socketDir}`,
      "start",
    ]);
    clusterStarted = true;
  }
  sql = postgres(
    `postgres://mc_browser_admin@127.0.0.1:${databasePort}/postgres`,
    {
      max: 1,
      connect_timeout: 1,
      prepare: false,
      onnotice: () => {},
    },
  );
  for (let attempt = 0; ; attempt++) {
    try {
      await sql`select 1`;
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const manifest = JSON.parse(
    await readFile(
      join(project, "src/lib/database/migration-manifest.json"),
      "utf8",
    ),
  );
  for (const migration of manifest) {
    const source = await readFile(
      join(project, "docs/database", migration.name),
      "utf8",
    );
    assert.equal(
      createHash("sha256").update(source).digest("hex"),
      migration.checksumSha256,
    );
    await sql.begin((tx) => tx.unsafe(source));
  }
  await sql`alter role maintaincode_app login`;
  await sql`grant connect on database postgres to maintaincode_app`;
  const [role] =
    await sql`select rolbypassrls,rolsuper from pg_roles where rolname='maintaincode_app'`;
  assert.equal(role.rolbypassrls, false);
  assert.equal(role.rolsuper, false);
  pass(
    `${manifest.length} checksum-verified migrations in an owned local cluster`,
  );

  stage = "independent Next.js development server";
  const appOrigin = `http://127.0.0.1:${await freePort()}`;
  app = spawn(
    process.execPath,
    [
      join(root, "node_modules/next/dist/bin/next"),
      "dev",
      "--webpack",
      "--hostname",
      "127.0.0.1",
      "--port",
      new URL(appOrigin).port,
    ],
    {
      cwd: project,
      env: {
        ...childEnvironment,
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
        MAINTAINCODE_LOCAL_TEST: "1",
        MAINTAINCODE_APP_ORIGIN: appOrigin,
        DATABASE_URL: `postgres://maintaincode_app@127.0.0.1:${databasePort}/postgres`,
        MAINTAINFLOW_DATABASE_POOL_MAX: "2",
        MAINTAINFLOW_RELEASE_STAGE: "demo",
        OPENAI_ADS_DATA_MODE: "demo",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  app.stdout.pipe(logs, { end: false });
  app.stderr.pipe(logs, { end: false });
  await waitForApp(appOrigin);
  // Complete the initial development compilation before measuring UI actions.
  // This is a read-only request; browser authentication remains out of scope.
  const compiledPage = await fetch(`${appOrigin}/app?mode=live`, {
    signal: AbortSignal.timeout(60_000),
  });
  assert.equal(compiledPage.status, 200);
  await compiledPage.text();
  pass("isolated Next.js output and dedicated local runtime are ready");

  const sites = new Map();
  fixture = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/submit" && request.method === "POST") {
      for await (const chunk of request) void chunk;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const site = sites.get(url.pathname);
    if (!site) {
      response.writeHead(404).end();
      return;
    }
    const hidden = Object.values(site.mapping)
      .map((field) => `<input type="hidden" name="${escapeHtml(field)}">`)
      .join("");
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(`<!doctype html><html><head><title>Local attribution form verification</title>
      <script async src="${appOrigin}/t/${site.id}${url.searchParams.get("diagnostic") === "1" ? "?test=1" : ""}"></script></head>
      <body><h1>Local business form</h1><button id="grant">Grant consent</button>
      <button id="withdraw">Withdraw consent</button><button id="retry">Connection restored</button>
      <form id="enquiry" data-attribution>${hidden}
      <label>Email<input name="email" value="synthetic-${runId}@example.invalid"></label>
      <label>Message<input name="message" value="visible-only-${runId}"></label>
      <button type="submit">Send enquiry</button></form>
      <button id="duplicate">Repeat success callback</button><output id="business-status">Submitted 0</output>
      <script>
      const form=document.querySelector('form'); let submitted=0;
      document.querySelector('#grant').onclick=()=>window.MaintainCode.setConsent(true);
      document.querySelector('#withdraw').onclick=()=>window.MaintainCode.setConsent(false);
      document.querySelector('#retry').onclick=()=>window.dispatchEvent(new Event('online'));
      document.querySelector('#duplicate').onclick=()=>{window.MaintainCode.confirm(form);window.MaintainCode.confirm(form)};
      form.addEventListener('submit',async event=>{
        event.preventDefault();
        const result=await fetch('/submit',{method:'POST',body:new FormData(form)});
        if(result.ok){window.MaintainCode.confirm(form);window.MaintainCode.confirm(form);
          document.querySelector('#business-status').textContent='Submitted '+(++submitted)}
      });
      </script></body></html>`);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const formOrigin = `http://127.0.0.1:${fixture.address().port}`;
  const allowedOrigins = new Set([appOrigin, formOrigin]);
  const captures = [];
  let simulateOutage = false;
  browser = await chromium.launch({ headless: true, env: childEnvironment });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!allowedOrigins.has(url.origin)) {
      externalRequests.push(`${url.origin}${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (
      url.origin === appOrigin &&
      url.pathname === "/api/attribution/collect" &&
      request.method() === "POST"
    ) {
      captures.push(request.postDataJSON());
      if (simulateOutage) {
        await route.fulfill({
          status: 503,
          headers: {
            "Access-Control-Allow-Origin": formOrigin,
            "Content-Type": "application/json",
          },
          body: '{"error":"Simulated temporary local outage"}',
        });
        return;
      }
    }
    await route.continue();
  });
  context.on("page", (page) => {
    page.on("pageerror", (error) => errors.push(error.stack || error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const expectedOutage =
        message.location().url === `${appOrigin}/api/attribution/collect` &&
        message.text().includes("503");
      if (!expectedOutage) consoleErrors.push(message.text());
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(60_000);
  stage = "workspace and website creation through the UI";
  await page.goto(`${appOrigin}/app?mode=live`);
  await expect(page).toHaveTitle(/MaintainCode/);
  await expect(
    page.getByRole("heading", { name: "Give your marketing a clear trail." }),
  ).toBeVisible();
  await page.getByLabel("Workspace name", { exact: true }).fill(name);
  await page.getByLabel("Agency workspace (five active websites)").check();
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url() === `${appOrigin}/api/attribution/workspaces` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  const created = await createdResponse;
  const workspace = await created.json();
  assert.equal(
    created.status(),
    201,
    JSON.stringify({
      error: workspace.error,
      origin: created.request().headers().origin ?? null,
      referer: created.request().headers().referer ?? null,
      requestUrl: created.url(),
    }),
  );
  fixtureIds.add(workspace.id);
  assert.equal(workspace.name, name);
  assert.equal(workspace.mode, "local");
  const workspaceUrl = `${appOrigin}/api/attribution/workspaces/${workspace.id}`;
  const snapshot = async () => {
    const response = await page.request.get(workspaceUrl);
    assert.equal(response.status(), 200);
    return response.json();
  };
  async function addSite(label, path) {
    await page
      .getByRole("button", { name: "Websites & forms", exact: true })
      .click();
    if (
      !(await page
        .getByRole("heading", { name: "Add a website", exact: true })
        .isVisible())
    )
      await page
        .getByRole("button", { name: "Add website", exact: true })
        .click();
    await page
      .getByLabel("Website name", { exact: true })
      .fill(`${name} ${label}`);
    await page.getByLabel("Website origin", { exact: true }).fill(formOrigin);
    await page.getByLabel("Supported form path").selectOption("html");
    await page.getByLabel("Consent policy").selectOption("required");
    await page.getByLabel("HTML form selector").fill("form[data-attribution]");
    const saved = page.waitForResponse(
      (response) =>
        response.url() === workspaceUrl &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save website", exact: true })
      .click();
    assert.equal((await saved).status(), 200);
    const result = await snapshot();
    const site = result.state.sites.find(
      (item) => item.name === `${name} ${label}`,
    );
    assert.ok(site);
    sites.set(path, site);
    await expect(
      page.getByRole("heading", { name: site.name, exact: true }),
    ).toBeVisible();
    return site;
  }
  const siteA = await addSite("A", "/form-a");
  const siteB = await addSite("B", "/form-b");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: siteA.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: siteB.name, exact: true }),
  ).toBeVisible();
  assert.equal(new URL(page.url()).searchParams.get("workspace"), workspace.id);
  const [persisted] =
    await sql`select state from maintaincode_workspaces where organization_id=${workspace.id}`;
  assert.equal(persisted.state.sites.length, 2);
  pass("UI workspace/site creation persists through reload in PostgreSQL");

  stage = "installed tracker, required consent and navigation recovery";
  const loaderResponse = await page.request.get(`${appOrigin}/t/${siteA.id}`);
  assert.equal(loaderResponse.status(), 200);
  assert.equal(
    loaderResponse.headers()["cross-origin-resource-policy"],
    "cross-origin",
    "Installed tracker loader must allow cross-origin resource delivery.",
  );
  assert.ok(
    (await loaderResponse.text()).includes(`\"endpoint\":\"${appOrigin}\"`),
  );
  const form = await context.newPage();
  form.setDefaultTimeout(15_000);
  const campaign = `browser-${runId}`;
  const sourceQuery = `utm_source=chatgpt&utm_medium=paid&utm_campaign=${campaign}&utm_id=${campaign}&oppref=synthetic-${runId}`;
  await form.goto(`${formOrigin}/form-a?${sourceQuery}`);
  await form.waitForFunction(() => !!window.MaintainCode);
  await expect(form.locator('input[type="hidden"]').first()).toHaveValue("");
  await form.getByRole("button", { name: "Send enquiry", exact: true }).click();
  await expect(form.locator("#business-status")).toHaveText("Submitted 1");
  assert.equal(captures.length, 0);
  assert.equal((await snapshot()).state.submissions.length, 0);
  assert.equal(
    await form.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith("mc_")).length,
    ),
    0,
  );
  await form
    .getByRole("button", { name: "Grant consent", exact: true })
    .click();
  await expect(
    form.locator(`[name="${siteA.mapping.first_source}"]`),
  ).toHaveValue("chatgpt");
  const submissionId = await form
    .locator(`[name="${siteA.mapping.submission_id}"]`)
    .inputValue();
  assert.match(submissionId, /^[\da-f-]{36}$/i);
  simulateOutage = true;
  await form.getByRole("button", { name: "Send enquiry", exact: true }).click();
  await expect(form.locator("#business-status")).toHaveText("Submitted 2");
  await expect
    .poll(async () =>
      form.evaluate((id) => {
        const queued = JSON.parse(
          localStorage.getItem(`mc_delivery:${id}`) || "[]",
        );
        return queued[0]?.status;
      }, siteA.id),
    )
    .toBe("confirmed");
  const pending = await form.evaluate(
    (id) => JSON.parse(localStorage.getItem(`mc_delivery:${id}`))[0],
    siteA.id,
  );
  assert.equal(pending.id, submissionId);
  await form.reload();
  await form.waitForFunction(() => !!window.MaintainCode);
  await expect(form.locator('input[type="hidden"]').first()).toHaveValue("");
  const restored = await form.evaluate(
    (id) => JSON.parse(localStorage.getItem(`mc_delivery:${id}`))[0],
    siteA.id,
  );
  assert.equal(restored.id, pending.id);
  assert.equal(restored.at, pending.at);
  assert.deepEqual(restored.evidence, pending.evidence);
  simulateOutage = false;
  await form
    .getByRole("button", { name: "Grant consent", exact: true })
    .click();
  await form
    .getByRole("button", { name: "Connection restored", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await snapshot()).state.submissions.find(
          (item) => item.id === submissionId,
        )?.status,
    )
    .toBe("confirmed");
  await expect
    .poll(() =>
      form.evaluate(
        (id) => localStorage.getItem(`mc_delivery:${id}`),
        siteA.id,
      ),
    )
    .toBeNull();
  const firstCapture = await snapshot();
  assert.equal(firstCapture.state.submissions.length, 1);
  assert.equal(
    firstCapture.state.submissions[0].confirmation,
    "browser_success",
  );
  assert.equal(firstCapture.state.submissions[0].at, pending.at);
  assert.equal(
    firstCapture.state.submissions[0].evidence.first.channel,
    "ChatGPT Ads",
  );
  assert.equal(firstCapture.usage, 1);
  assert.equal(
    firstCapture.state.sites.find((site) => site.id === siteA.id).verifiedAt,
    undefined,
  );
  await form
    .getByRole("button", { name: "Withdraw consent", exact: true })
    .click();
  assert.equal(
    await form.evaluate(
      () =>
        Object.keys(localStorage).filter((key) => key.startsWith("mc_")).length,
    ),
    0,
  );
  await expect(form.locator('input[type="hidden"]').first()).toHaveValue("");
  pass(
    "actual installed tracker waits for consent, preserves delivery across navigation and confirms once",
  );

  stage = "diagnostic capture and repeated successful-submit callbacks";
  await form.goto(`${formOrigin}/form-b?${sourceQuery}&diagnostic=1`);
  await form.waitForFunction(() => !!window.MaintainCode);
  await form
    .getByRole("button", { name: "Grant consent", exact: true })
    .click();
  const diagnosticId = await form
    .locator(`[name="${siteB.mapping.submission_id}"]`)
    .inputValue();
  await form.getByRole("button", { name: "Send enquiry", exact: true }).click();
  await expect(form.locator("#business-status")).toHaveText("Submitted 1");
  await expect
    .poll(
      async () =>
        (await snapshot()).state.submissions.find(
          (item) => item.id === diagnosticId,
        )?.status,
    )
    .toBe("confirmed");
  const beforeRepeat = (await snapshot()).state.submissions.find(
    (item) => item.id === diagnosticId,
  );
  const requestsBeforeRepeat = captures.length;
  await form
    .getByRole("button", { name: "Repeat success callback", exact: true })
    .click();
  await expect
    .poll(() =>
      form.evaluate(
        (id) => localStorage.getItem(`mc_delivery:${id}`),
        siteB.id,
      ),
    )
    .toBeNull();
  assert.equal(captures.length, requestsBeforeRepeat);
  const afterRepeat = await snapshot();
  assert.equal(afterRepeat.state.submissions.length, 2);
  assert.deepEqual(
    afterRepeat.state.submissions.find((item) => item.id === diagnosticId),
    beforeRepeat,
  );
  assert.equal(beforeRepeat.test, true);
  assert.equal(afterRepeat.usage, 1);
  for (const captured of captures) {
    assert.deepEqual(Object.keys(captured).sort(), [
      "at",
      "evidence",
      "formId",
      "id",
      "siteId",
      "status",
      "test",
    ]);
    assert.ok(!JSON.stringify(captured).includes(`visible-only-${runId}`));
    assert.ok(
      !JSON.stringify(captured).includes(`synthetic-${runId}@example.invalid`),
    );
  }
  pass(
    "duplicate success callbacks are idempotent; diagnostics are excluded from usage and visible form values are not collected",
  );

  stage = "browser export, evidence rendering and scoped site deletion";
  await page.reload();
  await expect(
    page.getByRole("heading", { name: siteA.name, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Leads", exact: true }).click();
  await expect(
    page.getByRole("button", { name: submissionId.slice(0, 12), exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: join(evidenceDir, "persistent-leads-desktop.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Workspace & billing", exact: true })
    .click();
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export workspace data", exact: true })
    .click();
  const download = await downloaded;
  await download.saveAs(join(evidenceDir, "workspace-export.json"));
  const exported = JSON.parse(
    await readFile(join(evidenceDir, "workspace-export.json"), "utf8"),
  );
  assert.equal(exported.id, workspace.id);
  assert.equal(exported.submissions.length, 2);
  assert.equal(
    exported.submissions.find((item) => item.id === submissionId).evidence.first
      .oppref,
    "[protected]",
  );
  assert.ok(!JSON.stringify(exported).includes(`synthetic-${runId}`));
  assert.ok(!JSON.stringify(exported).includes(`visible-only-${runId}`));
  await page
    .getByRole("button", { name: "Websites & forms", exact: true })
    .click();
  const targetSite = page.locator("section").filter({
    has: page.getByRole("heading", { name: siteA.name, exact: true }),
  });
  page.once("dialog", (dialog) => dialog.accept());
  await targetSite
    .getByRole("button", { name: "Delete website data", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: siteA.name, exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: siteB.name, exact: true }),
  ).toBeVisible();
  const afterDelete = await snapshot();
  assert.deepEqual(
    afterDelete.state.sites.map((site) => site.id),
    [siteB.id],
  );
  assert.deepEqual(afterDelete.state.submissions, [beforeRepeat]);
  assert.equal(afterDelete.usage, 0);
  const registrations =
    await sql`select id from maintaincode_sites where organization_id=${workspace.id}`;
  assert.deepEqual(
    registrations.map((site) => site.id),
    [siteB.id],
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(evidenceDir, "remaining-site-mobile.png"),
    fullPage: true,
  });
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
  assert.deepEqual(errors, []);
  assert.deepEqual(consoleErrors, []);
  assert.deepEqual(externalRequests, []);
  pass(
    "reloaded leads/export are correct; deleting one site preserves the other site and its capture",
  );
  console.log(
    JSON.stringify({
      appOrigin,
      formOrigin,
      trackerSha256,
      evidenceDir,
      externalRequests: 0,
    }),
  );
} catch (error) {
  failure = {
    stage,
    message: error.message,
    errors,
    consoleErrors,
    externalRequests,
  };
  for (const [index, page] of (
    browser?.contexts()[0]?.pages() ?? []
  ).entries()) {
    await page
      .screenshot({
        path: join(evidenceDir, `failure-${index}.png`),
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      join(evidenceDir, `failure-${index}.html`),
      await page.content(),
    ).catch(() => {});
  }
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  try {
    await browser?.close();
    await stopApp();
    if (fixture?.listening)
      await new Promise((resolve, reject) =>
        fixture.close((error) => (error ? reject(error) : resolve())),
      );
    if (sql) {
      for (const id of fixtureIds) {
        await sql.begin(async (tx) => {
          const [owned] =
            await tx`select name from maintainflow_organizations where id=${id}`;
          assert.equal(
            owned?.name,
            name,
            "Cleanup must match this run's exact organization name and ID.",
          );
          await tx`delete from maintaincode_workspaces where organization_id=${id}`;
          await tx`delete from maintainflow_organization_memberships where organization_id=${id}`;
          await tx`delete from maintainflow_organizations where id=${id} and name=${name}`;
          const remaining =
            await tx`select id from maintainflow_organizations where id=${id}`;
          assert.equal(remaining.length, 0);
          const children =
            await tx`select organization_id from maintaincode_sites where organization_id=${id} union all select organization_id from maintaincode_credentials where organization_id=${id} union all select organization_id from maintaincode_maintenance_queue where organization_id=${id} union all select organization_id from maintainflow_organization_memberships where organization_id=${id}`;
          assert.equal(children.length, 0);
        });
      }
      pass(
        "only this run's fixtures removed; no owned organization or child rows remain",
      );
    }
  } catch (error) {
    cleanupFailure = error.message;
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => {});
    if (container) {
      try {
        await run("docker", ["rm", "--force", container]);
      } catch (error) {
        cleanupFailure = error.message;
      }
    }
    if (clusterStarted) {
      try {
        await run("pg_ctl", [
          "-D",
          cluster,
          "-m",
          "fast",
          "-w",
          "-t",
          "30",
          "stop",
        ]);
        clusterStarted = false;
      } catch (error) {
        cleanupFailure = error.message;
      }
    }
    logs.end();
    if (!clusterStarted) await rm(scratch, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      ok: !failure && !cleanupFailure && !cancelled,
      scope: "disposable local PostgreSQL and browser persistence only",
      checks,
      failure,
      cleanupFailure,
      evidenceDir,
      remainingGates: [
        "Supabase authentication",
        "HubSpot form/CRM acceptance",
        "authorized Ads account",
        "payments/email",
        "deployed domain",
        "external customer use",
      ],
    },
    null,
    2,
  ),
);
if (failure || cleanupFailure || cancelled) process.exitCode = 1;
