import "server-only";
import { getRuntimeDatabase } from "@/lib/database/client.server";
export async function listOrganizationMemberships(operatorId: string) {
  const sql = getRuntimeDatabase(process.env.DATABASE_URL!);
  return sql.begin(async (tx) => {
    await tx`select set_config('maintaincode.actor_id',${operatorId},true)`;
    const rows =
      await tx`select o.id as organization_id,m.role as membership_role from maintainflow_organizations o join maintainflow_organization_memberships m on m.organization_id=o.id where m.clerk_user_id=${operatorId} and o.status='active' order by o.name,o.id`;
    return rows.map((row) => ({
      organizationId: String(row.organization_id),
      membershipRole: String(row.membership_role),
    }));
  });
}
