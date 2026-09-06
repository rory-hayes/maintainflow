import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const hostname = databaseUrl.hostname.replace(/^\[|\]$/g, "");
if (
  !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
  !(hostname === "localhost" || hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.split(".")[0] === "127")) ||
  !/^\/maintainflow_ads_test_[a-z0-9_]+$/.test(databaseUrl.pathname)
) {
  throw new Error("Recipient integration fixtures require the disposable local database runner.");
}
const database = postgres(databaseUrl.toString(), { max: 1, prepare: false, connect_timeout: 5 });
const functionSignature = "public.maintaincode_notification_recipient_valid(uuid,text,text)";
const rollback = new Error("ROLLBACK_NOTIFICATION_RECIPIENT_FIXTURES");

async function rolledBack(run: (tx: postgres.TransactionSql) => Promise<void>) {
  try {
    await database.begin(async (tx) => {
      await run(tx);
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
}

async function restrictedCall(
  tx: postgres.TransactionSql,
  workspace: string,
  actor: string,
  email: string | null,
  contextWorkspace = workspace,
  contextActor = actor,
) {
  await tx`set local role maintaincode_app`;
  try {
    await tx`select set_config('maintaincode.organization_id',${contextWorkspace},true),
      set_config('maintaincode.actor_id',${contextActor},true)`;
    const [result] = await tx`select public.maintaincode_notification_recipient_valid(
      ${workspace}::uuid,${actor},${email}) as valid`;
    return result.valid;
  } finally {
    await tx`reset role`;
  }
}

async function expectRestrictedGrants(tx: postgres.TransactionSql) {
  await tx`set local role maintaincode_app`;
  try {
    const [definition] = await tx`select prosecdef,proconfig,prorettype::regtype::text as result_type,
      has_function_privilege(current_user,oid,'EXECUTE') as can_execute
      from pg_proc where oid=${functionSignature}::regprocedure`;
    expect(definition).toEqual({
      prosecdef: true, proconfig: ["search_path=pg_catalog"], result_type: "boolean", can_execute: true,
    });
    const grants = await tx`select r.rolname,a.privilege_type,a.is_grantable
      from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles r on r.oid=a.grantee
      where p.oid=${functionSignature}::regprocedure and a.grantee<>p.proowner order by r.rolname`;
    expect([...grants]).toEqual([{ rolname: "maintaincode_app", privilege_type: "EXECUTE", is_grantable: false }]);
    for (const role of ["anon", "authenticated", "maintainflow_app"]) {
      const [access] = await tx`select has_function_privilege(${role},${functionSignature},'EXECUTE') as allowed`;
      expect(access.allowed, role).toBe(false);
    }
  } finally {
    await tx`reset role`;
  }
}

afterAll(async () => { await database.end({ timeout: 5 }); });

describe("current notification recipient boundary", () => {
  it("is a restricted boolean function and fails closed without Supabase auth tables", async () => {
    await rolledBack(async (tx) => {
      const [before] = await tx`select to_regclass('auth.users') as users`;
      expect(before.users).toBeNull();
      await expectRestrictedGrants(tx);
      expect(await restrictedCall(tx, randomUUID(), randomUUID(), "nobody@example.test")).toBe(false);
    });
  });

  it("removes inherited default function grants during migration", async () => {
    const migration = await readFile(new URL("../../../docs/database/026_maintaincode_notification_recipient.sql", import.meta.url), "utf8");
    await rolledBack(async (tx) => {
      await tx`drop function public.maintaincode_notification_recipient_valid(uuid,text,text)`;
      await tx`alter default privileges in schema public grant execute on functions to anon,authenticated,maintainflow_app`;
      await tx.unsafe(migration);
      await expectRestrictedGrants(tx);
    });
  });

  it("allows only the current confirmed, unbanned owner/admin recipient and rejects offboarding changes", async () => {
    await rolledBack(async (tx) => {
      const [before] = await tx`select to_regnamespace('auth') as auth_schema`;
      expect(before.auth_schema).toBeNull();
      await tx`create schema auth`;
      await tx`create table auth.users (
        id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz
      )`;
      const workspace = randomUUID();
      const actor = randomUUID();
      const email = "approved-recipient@example.test";
      await tx`insert into public.maintainflow_organizations(id,name,customer_type)
        values(${workspace},'Recipient rollback fixture','advertiser')`;
      await tx`insert into public.maintainflow_organization_memberships(organization_id,clerk_user_id,role)
        values(${workspace},${actor},'owner')`;
      await tx`insert into auth.users values(${actor},${email},now(),null,null)`;
      await tx`set local role maintaincode_app`;
      const [authAccess] = await tx`select
        has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_access,
        has_any_column_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,REFERENCES') as column_access
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='auth' and c.relname='users'`;
      expect(authAccess).toEqual({ table_access: false, column_access: false });
      await tx`reset role`;
      const call = (address: string | null = email) => restrictedCall(tx, workspace, actor, address);
      expect(await call()).toBe(true);
      await tx`update public.maintainflow_organization_memberships set role='admin' where organization_id=${workspace}`;
      expect(await call()).toBe(true);
      await tx`update public.maintainflow_organization_memberships set role='analyst' where organization_id=${workspace}`;
      expect(await call()).toBe(false);
      await tx`update public.maintainflow_organization_memberships set role='owner' where organization_id=${workspace}`;
      expect(await restrictedCall(tx, workspace, actor, email, "", actor)).toBe(false);
      expect(await restrictedCall(tx, workspace, actor, email, workspace, "")).toBe(false);
      expect(await restrictedCall(tx, workspace, actor, email, randomUUID(), actor)).toBe(false);
      expect(await restrictedCall(tx, workspace, actor, email, workspace, randomUUID())).toBe(false);
      expect(await restrictedCall(tx, randomUUID(), actor, email)).toBe(false);
      expect(await restrictedCall(tx, workspace, randomUUID(), email)).toBe(false);
      expect(await call(null)).toBe(false);
      await tx`update auth.users set email='changed-recipient@example.test' where id=${actor}`;
      expect(await call()).toBe(false);
      expect(await call("changed-recipient@example.test")).toBe(true);
      await tx`update auth.users set email=${email},email_confirmed_at=null where id=${actor}`;
      expect(await call()).toBe(false);
      await tx`update auth.users set email_confirmed_at=now(),deleted_at=now() where id=${actor}`;
      expect(await call()).toBe(false);
      await tx`update auth.users set deleted_at=null,banned_until=now()+interval '1 day' where id=${actor}`;
      expect(await call()).toBe(false);
      await tx`update auth.users set banned_until=now()-interval '1 second' where id=${actor}`;
      expect(await call()).toBe(true);
      await tx`update auth.users set banned_until=null where id=${actor}`;
      await tx`update public.maintainflow_organizations set status='suspended' where id=${workspace}`;
      expect(await call()).toBe(false);
      await tx`update public.maintainflow_organizations set status='active' where id=${workspace}`;
      await tx`delete from public.maintainflow_organization_memberships where organization_id=${workspace}`;
      expect(await call()).toBe(false);
      await tx`insert into public.maintainflow_organization_memberships(organization_id,clerk_user_id,role)
        values(${workspace},${actor},'owner')`;
      await tx`delete from auth.users where id=${actor}`;
      expect(await call()).toBe(false);
    });
    const [after] = await database`select to_regnamespace('auth') as auth_schema`;
    expect(after.auth_schema).toBeNull();
  });
});
