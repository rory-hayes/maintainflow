import { timingSafeEqual } from "node:crypto";
import { database, localMode } from "@/lib/attribution/store.server";
import { resolveBuildRevision } from "@/lib/release/revision";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
export async function GET(request: Request) {
  const local = localMode();
  if (!local) {
    const secret = process.env.MAINTAINFLOW_READINESS_PROBE_SECRET;
    if (!secret || secret.length < 32)
      return Response.json(
        { ready: false, error: "Readiness authentication is not configured." },
        { status: 503, headers },
      );
    const expected = Buffer.from(`Bearer ${secret}`);
    const supplied = Buffer.from(request.headers.get("authorization") ?? "");
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return Response.json(
        { ready: false, error: "Unauthorized readiness request." },
        { status: 401, headers },
      );
  }
  const revision = resolveBuildRevision();
  try {
    if (!local && !revision) throw new Error("build_revision");
    const sql = database();
    const [role] =
      await sql`select current_user as name,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole,rolreplication from pg_roles where rolname=current_user`;
    if (
      !role ||
      (!local &&
        (role.name !== "maintaincode_app" ||
          role.rolsuper ||
          role.rolbypassrls ||
          role.rolcreatedb ||
          role.rolcreaterole ||
          role.rolreplication))
    )
      throw new Error("runtime_role");
    const rows =
      await sql`select relname,relrowsecurity,relforcerowsecurity,row_security_active(oid) as rls_active,has_table_privilege(current_user,oid,'SELECT') as can_read,has_table_privilege(current_user,oid,'INSERT') as can_insert,has_table_privilege(current_user,oid,'UPDATE') as can_update,has_table_privilege(current_user,oid,'DELETE') as can_delete from pg_class where relnamespace='public'::regnamespace and relname in ('maintaincode_workspaces','maintaincode_credentials','maintaincode_sites','maintainflow_organizations','maintainflow_organization_memberships','maintaincode_maintenance_queue')`;
    if (
      rows.length !== 6 ||
      rows.some(
        (row) =>
          !row.can_read ||
          (row.relname === "maintaincode_maintenance_queue"
            ? !row.can_update
            : !row.can_insert) ||
          (row.relname.startsWith("maintaincode_") &&
            row.relname !== "maintaincode_maintenance_queue" &&
            (!row.can_update || !row.can_delete)) ||
          !row.relrowsecurity ||
          (!local && !row.rls_active) ||
          (["maintaincode_workspaces", "maintaincode_credentials"].includes(
            row.relname,
          ) &&
            !row.relforcerowsecurity),
      )
    )
      throw new Error("schema_or_grants");
    const policies =
      await sql`select policyname from pg_policies where schemaname='public' and policyname in ('maintaincode_workspace_isolation','maintaincode_credential_isolation','maintaincode_member_read','maintaincode_member_create','maintaincode_organization_read','maintaincode_organization_create','maintaincode_site_registry_read','maintaincode_site_registry_insert','maintaincode_site_registry_update','maintaincode_site_registry_delete')`;
    if (policies.length !== 10) throw new Error("isolation_policies");
    const [registration] =
      await sql`select count(*)::int as count from pg_trigger where tgname='maintaincode_workspace_maintenance_registration' and tgrelid='public.maintaincode_workspaces'::regclass and tgenabled='O' and not tgisinternal`;
    if (registration?.count !== 1) throw new Error("maintenance_registration");
    const [recipientValidator] =
      await sql`select p.prosecdef,p.proconfig,has_function_privilege(current_user,p.oid,'EXECUTE') as can_execute,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.privilege_type='EXECUTE' and a.grantee not in (p.proowner,(select oid from pg_roles where rolname='maintaincode_app'))) as unexpected_execute from pg_proc p where p.oid=to_regprocedure('public.maintaincode_notification_recipient_valid(uuid,text,text)')`;
    if (
      !recipientValidator?.prosecdef ||
      !recipientValidator.can_execute ||
      recipientValidator.unexpected_execute ||
      !Array.isArray(recipientValidator.proconfig) ||
      !recipientValidator.proconfig.includes("search_path=pg_catalog")
    )
      throw new Error("notification_recipient_validator");
    return Response.json(
      {
        ready: true,
        service: "maintaincode-ads",
        scope: local ? "local_database_only" : "runtime_database_only",
        revision: revision ?? "unknown",
        checks: {
          runtimeRole: true,
          tables: 6,
          isolationPolicies: 10,
          maintenanceQueue: true,
          notificationRecipientValidator: true,
        },
        providers: "not_verified",
        payments: "not_verified",
      },
      { headers },
    );
  } catch {
    return Response.json(
      {
        ready: false,
        service: "maintaincode-ads",
        revision: revision ?? "unknown",
        error:
          "Check build revision, migrations 023–027, dedicated runtime role, isolation policies, table grants and the restricted email-recipient validator.",
      },
      { status: 503, headers },
    );
  }
}
