import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise real Chromium native-form behavior with the actual route's GET body
// and headers. Only the disposable HTTPS receiver gets a POST; no app mutation.
export async function verifyUnsubscribeNativeForm(browser, appOrigin) {
  const origin = new URL(appOrigin);
  assert.equal(origin.hostname, "127.0.0.1", "Browser verifier is loopback-only");
  const workspace = "00000000-0000-4000-8000-000000000001";
  const token = "a".repeat(64);
  const query = new URLSearchParams({ workspace, token });
  const response = await fetch(
    `${origin.origin}/notifications/unsubscribe?${query}`,
    { redirect: "error", signal: AbortSignal.timeout(10000) },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "strict-origin");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  const headers = Object.fromEntries(response.headers);
  delete headers["content-length"];
  delete headers["content-encoding"];
  delete headers["transfer-encoding"];
  const directory = await mkdtemp(join(tmpdir(), "maintaincode-unsubscribe-"));
  let server;
  let context;
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", join(directory, "key.pem"),
      "-out", join(directory, "cert.pem"),
    ], { stdio: "ignore" });
    const captures = [];
    let policy = "no-referrer";
    let accepted = 0;
    let fixtureOrigin;
    server = createServer({
      key: await readFile(join(directory, "key.pem")),
      cert: await readFile(join(directory, "cert.pem")),
    }, (request, result) => {
      if (request.method === "GET") {
        result.writeHead(200, { ...headers, "referrer-policy": policy });
        result.end(html);
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const values = new URLSearchParams(body);
        const matches = values.get("workspace") === workspace && values.get("token") === token;
        const allowed = request.method === "POST" &&
          request.url === "/notifications/unsubscribe" &&
          request.headers.origin === fixtureOrigin && matches;
        captures.push({ origin: request.headers.origin, referer: request.headers.referer, matches });
        if (allowed) accepted++;
        result.writeHead(allowed ? 200 : 400, { "content-type": "text/html" });
        result.end(allowed ? "<p>Accepted fixture opt-out</p>" : "<p>Rejected fixture origin</p>");
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    fixtureOrigin = `https://127.0.0.1:${server.address().port}`;
    context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === fixtureOrigin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    // Negative control reproduces the deployed failure without rewriting headers.
    await page.goto(`${fixtureOrigin}/notifications/unsubscribe?${query}`);
    assert.equal(accepted, 0, "GET must not perform the fixture opt-out");
    const rejected = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: "Stop workspace emails" }).click();
    assert.equal((await rejected).status(), 400);
    assert.equal(captures[0].origin, "null");
    assert.equal(captures[0].referer, undefined);
    assert.equal(accepted, 0);

    policy = response.headers.get("referrer-policy");
    await page.goto(`${fixtureOrigin}/notifications/unsubscribe?${query}`);
    assert.equal(accepted, 0, "Opening the corrected page must not opt out");
    const submitted = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: "Stop workspace emails" }).click();
    assert.equal((await submitted).status(), 200);
    assert.deepEqual(captures[1], { origin: fixtureOrigin, referer: `${fixtureOrigin}/`, matches: true });
    assert.equal(accepted, 1);
    assert.equal(captures.length, 2);
    console.log("PASS: native HTTPS unsubscribe form sends exact Origin and origin-only Referer; no-referrer control rejected; GET remains inert. No application POST, database or email operation.");
  } finally {
    await context?.close();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
