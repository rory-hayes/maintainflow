import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Run only against the explicitly selected new project. Every test mutation is
// made in one transaction that is deliberately rolled back, including success.
const [configPath, expectedProject, ...flags] = process.argv.slice(2);
if (
  !configPath ||
  !/^[a-z0-9]{20}$/.test(expectedProject ?? "") ||
  flags.some((flag) => !["--require-queue", "--require-notifications"].includes(flag))
) {
  console.error(
    "Usage: node scripts/verify-maintaincode-database.mjs CONFIG_JSON EXPECTED_PROJECT_REF [--require-queue] [--require-notifications]",
  );
  process.exit(1);
}

let stage = "configuration";
let runtime;
const checks = [];
const check = (name) => {
  checks.push(name);
  stage = name;
};
const rollback = new Error("ROLLBACK_VERIFICATION_FIXTURES");
try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const databaseUrl = new URL(config.DATABASE_URL);
  const username = decodeURIComponent(databaseUrl.username);
  assert(
    ["postgres:", "postgresql:"].includes(databaseUrl.protocol),
    "Expected a PostgreSQL runtime URL.",
  );
  assert(
    ["maintaincode_app", `maintaincode_app.${expectedProject}`].includes(
      username,
    ),
    "Expected only the dedicated application role.",
  );
  assert.equal(
    new URL(config.NEXT_PUBLIC_SUPABASE_URL).hostname,
    `${expectedProject}.supabase.co`,
    "The configured Supabase project differs from the explicit target.",
  );
  if (username === "maintaincode_app")
    assert.equal(
      databaseUrl.hostname,
      `db.${expectedProject}.supabase.co`,
      "The direct database target differs from the explicit project.",
    );
  assert.equal(
    databaseUrl.searchParams.get("sslmode"),
    "verify-full",
    "Verified TLS is required.",
  );
  for (const name of [
    "DATABASE_URL",
    "MAINTAINFLOW_DATABASE_CA_CERT",
    "MAINTAINFLOW_CREDENTIAL_KEYRING",
    "MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID",
  ])
    process.env[name] = config[name];
  process.env.NODE_ENV = "production";
  process.env.MAINTAINFLOW_DATABASE_POOL_MAX = "1";

  // Bundle the existing runtime client/model/vault without importing Next's
  // request/auth modules. The server-only marker has no work in this Node tool.
  stage = "load application modules";
  const source = (name) =>
    JSON.stringify(
      fileURLToPath(new URL(`../src/lib/${name}`, import.meta.url)),
    );
  const bundle = await build({
    stdin: {
      contents: `export * from ${source("database/client.server.ts")}; export * from ${source("credentials/crypto.server.ts")}; export * from ${source("attribution/model.ts")};`,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    banner: {
      js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(fileURLToPath(new URL("../package.json", import.meta.url)))});`,
    },
    plugins: [
      {
        name: "node-verification-server-marker",
        setup(build) {
          build.onResolve({ filter: /^server-only$/ }, () => ({
            path: "server-only",
            namespace: "verification-marker",
          }));
          build.onLoad(
            { filter: /.*/, namespace: "verification-marker" },
            () => ({ contents: "export {};", loader: "js" }),
          );
        },
      },
    ],
  });
  runtime = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  );
  const sql = runtime.getRuntimeDatabase(config.DATABASE_URL);
  stage = "runtime identity and schema";
  const [role] =
    await sql`select current_user as name, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication from pg_roles where rolname=current_user`;
  assert.equal(
    role.name,
    "maintaincode_app",
    "The connected database role differs from the dedicated application role.",
  );
  for (const name of [
    "rolsuper",
    "rolbypassrls",
    "rolcreatedb",
    "rolcreaterole",
    "rolreplication",
  ])
    assert.equal(
      role[name],
      false,
      "The runtime role has unexpected elevated privileges.",
    );
  const [schema] =
    await sql`select to_regclass('public.maintaincode_maintenance_queue') is not null as queue,
      to_regprocedure('public.maintaincode_notification_recipient_valid(uuid,text,text)') is not null as notifications`;
  if (flags.includes("--require-queue"))
    assert.equal(
      schema.queue,
      true,
      "Maintenance queue migration is required.",
    );
  if (schema.queue) {
    const [queueAccess] = await sql`select relrowsecurity as enabled,
      has_table_privilege(current_user,oid,'SELECT') as can_read,
      has_table_privilege(current_user,oid,'UPDATE') as can_update,
      has_table_privilege(current_user,oid,'INSERT') as can_insert,
      has_table_privilege(current_user,oid,'DELETE') as can_delete
      from pg_class where oid='public.maintaincode_maintenance_queue'::regclass`;
    assert.deepEqual(
      queueAccess,
      {
        enabled: true,
        can_read: true,
        can_update: true,
        can_insert: false,
        can_delete: false,
      },
      "Maintenance queue must retain RLS and SELECT/UPDATE-only runtime grants.",
    );
    const policies =
      await sql`select roles::text[] as roles,cmd from pg_policies where schemaname='public' and tablename='maintaincode_maintenance_queue'`;
    assert.equal(
      policies.length,
      1,
      "Maintenance queue must expose only its dedicated runtime policy.",
    );
    assert.deepEqual(policies[0].roles, ["maintaincode_app"]);
    for (const apiRole of ["anon", "authenticated"]) {
      const [access] =
        await sql`select has_table_privilege(${apiRole},'public.maintaincode_maintenance_queue','SELECT') as can_read,
        has_table_privilege(${apiRole},'public.maintaincode_maintenance_queue','UPDATE') as can_update`;
      assert.deepEqual(
        access,
        { can_read: false, can_update: false },
        "Data API roles must not access maintenance metadata.",
      );
    }
    check(
      "maintenance queue RLS, dedicated policy and restricted runtime/Data API grants",
    );
  }
  if (flags.includes("--require-notifications"))
    assert.equal(schema.notifications, true, "Notification recipient migration is required.");
  if (schema.notifications) {
    // Inspect only function/privilege catalogs, never auth user records.
    const [recipientFunction] = await sql`select p.prosecdef as security_definer,
      p.prorettype = 'boolean'::regtype as boolean_only,p.proconfig as settings,
      p.proowner = (select oid from pg_roles where rolname=current_user) as runtime_owns,
      has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute
      from pg_proc p where p.oid='public.maintaincode_notification_recipient_valid(uuid,text,text)'::regprocedure`;
    assert.deepEqual(recipientFunction, {
      security_definer: true,
      boolean_only: true,
      settings: ["search_path=pg_catalog"],
      runtime_owns: false,
      can_execute: true,
    }, "The recipient validator must remain a boolean-only, fixed-search-path privileged boundary.");
    const recipientGrants = await sql`select r.rolname,a.privilege_type,a.is_grantable
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles r on r.oid=a.grantee
      where p.oid='public.maintaincode_notification_recipient_valid(uuid,text,text)'::regprocedure
      and a.grantee<>p.proowner order by r.rolname`;
    assert.deepEqual([...recipientGrants], [{
      rolname: "maintaincode_app", privilege_type: "EXECUTE", is_grantable: false,
    }], "Only the dedicated runtime role may receive recipient-validator EXECUTE.");
    const excludedRoles = await sql`select rolname,
      has_function_privilege(oid,'public.maintaincode_notification_recipient_valid(uuid,text,text)','EXECUTE') as can_execute
      from pg_roles where rolname in ('anon','authenticated','maintainflow_app')`;
    assert(excludedRoles.every((role) => role.can_execute === false),
      "Data API and legacy roles must not inherit recipient-validator EXECUTE.");
    const authAccess = await sql`select
      has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_access,
      has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') as column_access
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='auth' and c.relname='users'`;
    assert(authAccess.every((access) => access.table_access === false && access.column_access === false),
      "The runtime role must not gain direct auth user table or column access.");
    check("notification boolean validator, fixed search path, runtime-only effective EXECUTE and no direct auth grants");
  }
  check("restricted runtime role and verified TLS connection");

  const [siteRegistry] = await sql`select relrowsecurity as enabled,
    row_security_active(oid) as active from pg_class
    where oid='public.maintaincode_sites'::regclass`;
  assert.deepEqual(siteRegistry, { enabled: true, active: true },
    "The dedicated runtime must use active site registry row security.");
  const sitePolicies = await sql`select policyname,cmd,roles::text[] as roles
    from pg_policies where schemaname='public' and tablename='maintaincode_sites'
    order by policyname`;
  assert.deepEqual([...sitePolicies], [
    { policyname: "maintaincode_site_registry_delete", cmd: "DELETE", roles: ["maintaincode_app"] },
    { policyname: "maintaincode_site_registry_insert", cmd: "INSERT", roles: ["maintaincode_app"] },
    { policyname: "maintaincode_site_registry_read", cmd: "SELECT", roles: ["maintaincode_app"] },
    { policyname: "maintaincode_site_registry_update", cmd: "UPDATE", roles: ["maintaincode_app"] },
  ], "The site registry must retain its four dedicated runtime policies.");
  const siteApiAccess = await sql`select rolname,
    has_table_privilege(oid,'public.maintaincode_sites','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_access,
    has_any_column_privilege(oid,'public.maintaincode_sites','SELECT,INSERT,UPDATE,REFERENCES') as column_access
    from pg_roles where rolname in ('anon','authenticated','service_role','maintainflow_app')`;
  assert(siteApiAccess.every((role) => !role.table_access && !role.column_access),
    "Data API and retired legacy roles must not access the site registry.");
  check("site registry row security, dedicated policies and server-only grants");

  const run = randomUUID();
  const fixtures = ["a", "b"].map((suffix) => {
    const id = randomUUID();
    const siteId = randomUUID();
    const actor = `user_mc_verify_${run.replaceAll("-", "")}_${suffix}`;
    const state = runtime.emptyWorkspace(
      id,
      `Database verification ${suffix}`,
      "live",
    );
    state.sites = [
      {
        id: siteId,
        name: "Synthetic website",
        origin: `https://verification-${suffix}.invalid`,
        consent: "required",
        retentionDays: 90,
        formSelector: "form",
        adapter: "html",
        mapping: runtime.defaultMapping,
        paused: false,
      },
    ];
    return { id, siteId, actor, state };
  });
  const [a, b] = fixtures;
  const json = (value) => JSON.parse(JSON.stringify(value));
  const setContext = async (tx, fixture) => {
    await tx`select set_config('maintaincode.actor_id',${fixture.actor},true),set_config('maintaincode.organization_id',${fixture.id},true)`;
  };
  const sealedSecret = `synthetic-database-check-${randomUUID()}`;
  try {
    await sql.begin(async (tx) => {
      stage = "transactional workspace onboarding";
      for (const fixture of fixtures) {
        await setContext(tx, fixture);
        await tx`insert into public.maintainflow_organizations(id,name,customer_type) values(${fixture.id},${fixture.state.name},'advertiser')`;
        await tx`insert into public.maintainflow_organization_memberships(organization_id,clerk_user_id,role) values(${fixture.id},${fixture.actor},'owner')`;
        await tx`insert into public.maintaincode_workspaces(organization_id,state) values(${fixture.id},${tx.json(json(fixture.state))})`;
        await tx`insert into public.maintaincode_sites(id,organization_id,origin) values(${fixture.siteId},${fixture.id},${fixture.state.sites[0].origin})`;
      }
      check(
        "two transactional organizations, owner memberships, workspaces and sites",
      );
      if (schema.notifications) {
        await setContext(tx, a);
        // This deliberately non-UUID actor cannot exist in auth.users. The
        // function returns one boolean; no auth user reads/inserts are exposed.
        const [recipient] = await tx`select public.maintaincode_notification_recipient_valid(
          ${a.id}::uuid,${a.actor},${"nobody@verification.invalid"}) as valid`;
        assert.equal(recipient.valid, false, "A synthetic nonrecipient must fail closed even with an owner membership.");
        check("notification validator rejects a nonexistent synthetic owner recipient");
      }

      for (const fixture of fixtures) {
        await setContext(tx, fixture);
        const rows =
          await tx`select o.id,m.role from public.maintainflow_organizations o join public.maintainflow_organization_memberships m on m.organization_id=o.id where o.id in (${a.id},${b.id}) order by o.id`;
        assert.deepEqual(
          rows.map((row) => ({ id: row.id, role: row.role })),
          [{ id: fixture.id, role: "owner" }],
          "Membership discovery must stay within the current actor.",
        );
        const workspaces =
          await tx`select organization_id from public.maintaincode_workspaces where organization_id in (${a.id},${b.id})`;
        assert.deepEqual(
          workspaces.map((row) => row.organization_id),
          [fixture.id],
          "Workspace rows must stay within the selected tenant.",
        );
      }
      check("actor membership discovery and tenant-scoped workspace reads");

      // Trackers must resolve public site metadata before choosing a workspace.
      // This read permission must never permit unscoped or cross-workspace writes.
      await tx`select set_config('maintaincode.organization_id','',true)`;
      const registry = await tx`select id,organization_id,origin from public.maintaincode_sites
        where id in (${a.siteId},${b.siteId}) order by id`;
      assert.equal(registry.length, 2, "Public tracker lookup must work without tenant context.");
      await assert.rejects(tx.savepoint(async (sp) => {
        await sp`insert into public.maintaincode_sites(id,organization_id,origin)
          values(${randomUUID()},${a.id},${a.state.sites[0].origin})`;
      }), { code: "42501" });
      await setContext(tx, b);
      assert.equal((await tx`update public.maintaincode_sites set origin='https://changed.invalid'
        where id=${a.siteId} returning id`).length, 0);
      assert.equal((await tx`delete from public.maintaincode_sites where id=${a.siteId} returning id`).length, 0);
      await assert.rejects(tx.savepoint(async (sp) => {
        await sp`insert into public.maintaincode_sites(id,organization_id,origin)
          values(${randomUUID()},${a.id},${a.state.sites[0].origin})`;
      }), { code: "42501" });
      await assert.rejects(tx.savepoint(async (sp) => {
        await sp`update public.maintaincode_sites set organization_id=${a.id} where id=${b.siteId}`;
      }), { code: "42501" });
      assert.equal((await tx`update public.maintaincode_sites set origin=${b.state.sites[0].origin}
        where id=${b.siteId} returning id`).length, 1, "An owner context must still update its own site.");
      const temporarySite = randomUUID();
      await tx`insert into public.maintaincode_sites(id,organization_id,origin)
        values(${temporarySite},${b.id},${b.state.sites[0].origin})`;
      assert.equal((await tx`delete from public.maintaincode_sites where id=${temporarySite} returning id`).length, 1);
      check("public tracker lookup, own site writes and rejected unscoped/cross-workspace registry mutations");

      await setContext(tx, a);
      const item = {
        id: randomUUID(),
        siteId: a.siteId,
        formId: "synthetic-form",
        at: new Date().toISOString(),
        evidence: runtime.advanceEvidence(
          null,
          runtime.captureTouch(
            `${a.state.sites[0].origin}/?utm_source=chatgpt&utm_medium=cpc&utm_id=verification-campaign&oppref=synthetic-reference`,
          ),
        ),
        test: true,
        status: "attempted",
      };
      runtime.upsertSubmission(a.state, item);
      runtime.upsertSubmission(a.state, {
        ...item,
        status: "confirmed",
        confirmation: "browser_success",
      });
      runtime.upsertSubmission(a.state, { ...item, status: "attempted" });
      const expected = runtime.attributionFields(item.evidence, item.id);
      runtime.reconcileCRM(
        a.state,
        [
          {
            id: "synthetic-contact",
            stage: "customer",
            submissions: [item.id],
            currentSubmissions: [item.id],
            fieldValues: Object.fromEntries(
              Object.entries(runtime.defaultMapping).map(
                ([logical, property]) => [property, expected[logical]],
              ),
            ),
            updatedAt: new Date().toISOString(),
          },
        ],
        [],
      );
      await tx`select organization_id from public.maintaincode_workspaces where organization_id=${a.id} for update`;
      await tx`update public.maintaincode_workspaces set state=${tx.json(json(a.state))},updated_at=now() where organization_id=${a.id}`;
      const [stored] =
        await tx`select state from public.maintaincode_workspaces where organization_id=${a.id}`;
      assert.equal(
        stored.state.submissions.length,
        1,
        "Retries must not add persisted submissions.",
      );
      assert.equal(stored.state.submissions[0].status, "confirmed");
      assert.equal(
        stored.state.submissions[0].evidence.first.channel,
        "ChatGPT Ads",
      );
      assert(
        stored.state.submissions[0].crmFieldsVerifiedAt,
        "Mapped CRM-field proof must persist.",
      );
      assert.equal(
        runtime.usage(stored.state),
        0,
        "Diagnostic records must not consume paid submission usage.",
      );
      assert.equal(
        stored.state.contacts[0].fieldValues,
        undefined,
        "Raw mapped CRM fields must remain transient.",
      );
      check(
        "attribution JSON round-trip, idempotency, diagnostics and test-usage exclusion",
      );

      const material = runtime.encryptAdsApiKey({
        apiKey: sealedSecret,
        externalAccountId: `maintaincode:${a.id}:hubspot`,
      });
      const sealed = {
        ...material,
        ciphertext: material.ciphertext.toString("base64"),
        initializationVector: material.initializationVector.toString("base64"),
        authenticationTag: material.authenticationTag.toString("base64"),
      };
      await tx`insert into public.maintaincode_credentials(organization_id,provider,sealed) values(${a.id},'hubspot',${tx.json(sealed)})`;
      const [credential] =
        await tx`select sealed from public.maintaincode_credentials where organization_id=${a.id} and provider='hubspot'`;
      assert(
        !JSON.stringify(credential.sealed).includes(sealedSecret),
        "Plaintext credential must not be stored.",
      );
      const decoded = {
        ...credential.sealed,
        ciphertext: Buffer.from(credential.sealed.ciphertext, "base64"),
        initializationVector: Buffer.from(
          credential.sealed.initializationVector,
          "base64",
        ),
        authenticationTag: Buffer.from(
          credential.sealed.authenticationTag,
          "base64",
        ),
      };
      assert.equal(
        runtime.decryptAdsApiKey(decoded, `maintaincode:${a.id}:hubspot`),
        sealedSecret,
      );
      assert.throws(
        () => runtime.decryptAdsApiKey(decoded, `maintaincode:${b.id}:hubspot`),
        "Credential encryption must remain bound to its workspace.",
      );
      check(
        "configured credential vault encrypted storage and workspace binding",
      );

      await setContext(tx, b);
      assert.equal(
        (
          await tx`select sealed from public.maintaincode_credentials where organization_id=${a.id}`
        ).length,
        0,
        "A selected tenant must not read another tenant's credentials.",
      );
      assert.equal(
        (
          await tx`update public.maintaincode_workspaces set updated_at=now() where organization_id=${a.id} returning organization_id`
        ).length,
        0,
        "A selected tenant must not update another tenant's state.",
      );
      assert.equal(
        (
          await tx`delete from public.maintaincode_credentials where organization_id=${a.id} returning organization_id`
        ).length,
        0,
        "A selected tenant must not delete another tenant's credential.",
      );
      check(
        "tenant-scoped credential reads and workspace/credential mutations",
      );

      if (schema.queue) {
        const rows =
          await tx`select organization_id,last_status from public.maintaincode_maintenance_queue where organization_id in (${a.id},${b.id})`;
        assert.equal(
          rows.length,
          2,
          "Workspace creation must register maintenance metadata.",
        );
        assert(rows.every((row) => row.last_status === "pending"));
        const lease = randomUUID();
        await tx`update public.maintaincode_maintenance_queue set lease_token=${lease},lease_until=now()+interval '2 minutes',last_started_at=now() where organization_id=${b.id}`;
        await tx`update public.maintaincode_maintenance_queue set lease_token=null,lease_until=null,last_status='complete',last_finished_at=now(),next_due_at=now()+interval '1 day' where organization_id=${b.id} and lease_token=${lease}`;
        const [completed] =
          await tx`select last_status,lease_token from public.maintaincode_maintenance_queue where organization_id=${b.id}`;
        assert.equal(completed.last_status, "complete");
        assert.equal(completed.lease_token, null);
        check(
          "maintenance registration and restricted runtime lease completion",
        );
      }

      await setContext(tx, a);
      await tx`delete from public.maintaincode_credentials where organization_id=${a.id} and provider='hubspot'`;
      assert.equal(
        (
          await tx`select provider from public.maintaincode_credentials where organization_id=${a.id}`
        ).length,
        0,
      );
      await tx`delete from public.maintaincode_workspaces where organization_id=${a.id}`;
      assert.equal(
        (
          await tx`select id from public.maintaincode_sites where id=${a.siteId}`
        ).length,
        0,
      );
      if (schema.queue)
        assert.equal(
          (
            await tx`select organization_id from public.maintaincode_maintenance_queue where organization_id=${a.id}`
          ).length,
          0,
        );
      check("credential revocation and workspace child cleanup");
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }

  stage = "post-rollback absence verification";
  for (const fixture of fixtures) {
    await sql.begin(async (tx) => {
      await setContext(tx, fixture);
      for (const table of [
        "maintainflow_organizations",
        "maintainflow_organization_memberships",
        "maintaincode_workspaces",
        "maintaincode_credentials",
      ]) {
        const column =
          table === "maintainflow_organizations" ? "id" : "organization_id";
        const rows =
          await tx`select count(*)::int as count from ${tx(table)} where ${tx(column)}=${fixture.id}`;
        assert.equal(
          rows[0].count,
          0,
          "Synthetic fixture must not remain after rollback.",
        );
      }
      assert.equal(
        (
          await tx`select id from public.maintaincode_sites where id=${fixture.siteId}`
        ).length,
        0,
      );
      if (schema.queue)
        assert.equal(
          (
            await tx`select organization_id from public.maintaincode_maintenance_queue where organization_id=${fixture.id}`
          ).length,
          0,
        );
    });
  }
  check(
    "rollback confirmed: no synthetic organizations, memberships, workspaces, sites, credentials or queue rows remain",
  );
  console.log(
    JSON.stringify(
      {
        ok: true,
        project: expectedProject,
        role: "maintaincode_app",
        maintenanceQueue: Boolean(schema.queue),
        fixtureMutations: "rolled back",
        checks,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        stage,
        code: error?.code ?? error?.name ?? "UNKNOWN",
        constraint: error?.constraint_name,
        table: error?.table_name,
        message:
          error?.name === "AssertionError"
            ? error.message
            : "Verification failed; transaction changes are rolled back.",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await runtime?.closeRuntimeDatabase();
}
