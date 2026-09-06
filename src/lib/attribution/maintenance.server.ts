import "server-only";
import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  AttributionError,
  database,
  mutateWorkspace,
  readWorkspace,
} from "./store.server";
import { pruneExpired } from "./model";
import { syncWorkspaceProvider } from "./sync.server";
import {
  deliverWorkspaceNotifications,
  reportMailConfig,
} from "./notifications.server";

export const MAINTENANCE_LIMITS = Object.freeze({
  maxWorkspaces: 8,
  runBudgetMs: 210_000,
  minStartBudgetMs: 30_000,
  providerBudgetMs: 45_000,
  leaseSeconds: 600,
});
export function authorizeMaintenance(
  request: Request,
  secret: string | undefined,
) {
  if (!secret || secret.length < 32)
    throw new AttributionError(503, "Scheduled maintenance is not configured.");
  const expected = Buffer.from(`Bearer ${secret}`);
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  )
    throw new AttributionError(401, "Unauthorized maintenance request.");
}

type Claim = { organizationId: string; token: string };
type WorkspaceResult = {
  retention: "applied";
  providers: { provider: string; status: "synced" | "failed" }[];
  syncSkipped?: "inactive_subscription";
  notifications?: Awaited<ReturnType<typeof deliverWorkspaceNotifications>>;
};
export async function maintainWorkspace(
  id: string,
  signal: AbortSignal,
): Promise<WorkspaceResult> {
  signal.throwIfAborted();
  await mutateWorkspace(id, (state) => pruneExpired(state));
  const state = await readWorkspace(id);
  const active =
    state.billing.status === "active" ||
    (state.billing.status === "trialing" &&
      Date.parse(state.billing.trialEndsAt) > Date.now());
  if (!active)
    return {
      retention: "applied",
      providers: [],
      syncSkipped: "inactive_subscription",
      ...(reportMailConfig()
        ? { notifications: await deliverWorkspaceNotifications(id, signal) }
        : {}),
    };
  const providers: WorkspaceResult["providers"] = [];
  for (const connector of state.connectors.filter(
    (item) => item.status !== "revoked",
  )) {
    try {
      signal.throwIfAborted();
      await syncWorkspaceProvider(
        id,
        { action: "sync", provider: connector.provider },
        AbortSignal.any([
          signal,
          AbortSignal.timeout(MAINTENANCE_LIMITS.providerBudgetMs),
        ]),
      );
      providers.push({ provider: connector.provider, status: "synced" });
    } catch {
      providers.push({ provider: connector.provider, status: "failed" });
    }
  }
  const notifications = reportMailConfig()
    ? await deliverWorkspaceNotifications(id, signal)
    : undefined;
  return {
    retention: "applied",
    providers,
    ...(notifications ? { notifications } : {}),
  };
}

export const maintenanceQueue = {
  async claim(id?: string): Promise<Claim | null> {
    const sql = database();
    const token = randomUUID();
    const rows = id
      ? await sql`update maintaincode_maintenance_queue set lease_token=${token},lease_until=now()+interval '10 minutes',last_started_at=now() where organization_id=${id} and (lease_until is null or lease_until<=now()) returning organization_id`
      : await sql`with candidate as (select organization_id from maintaincode_maintenance_queue where next_due_at<=now() and (lease_until is null or lease_until<=now()) order by next_due_at,organization_id for update skip locked limit 1) update maintaincode_maintenance_queue q set lease_token=${token},lease_until=now()+interval '10 minutes',last_started_at=now() from candidate where q.organization_id=candidate.organization_id returning q.organization_id`;
    return rows[0]
      ? { organizationId: String(rows[0].organization_id), token }
      : null;
  },
  async finish(claim: Claim, status: "complete" | "partial" | "failed") {
    const sql = database();
    const rows =
      await sql`update maintaincode_maintenance_queue set lease_token=null,lease_until=null,last_finished_at=now(),next_due_at=now()+interval '23 hours',last_status=${status},consecutive_failures=case when ${status}='complete' then 0 else least(consecutive_failures+1,1000000) end where organization_id=${claim.organizationId} and lease_token=${claim.token} returning organization_id`;
    return rows.length === 1;
  },
  async backlog() {
    const sql = database();
    const [row] =
      await sql`select count(*) filter(where next_due_at<=now() and (lease_until is null or lease_until<=now()))::int as due,count(*) filter(where lease_until>now())::int as leased,count(*) filter(where last_status in ('partial','failed'))::int as failed from maintaincode_maintenance_queue`;
    return {
      due: Number(row.due),
      leased: Number(row.leased),
      failed: Number(row.failed),
    };
  },
};

export async function runMaintenanceBatch(
  dependencies = {
    queue: maintenanceQueue,
    maintain: maintainWorkspace,
    now: Date.now,
  },
) {
  const deadline = dependencies.now() + MAINTENANCE_LIMITS.runBudgetMs;
  const signal = AbortSignal.timeout(MAINTENANCE_LIMITS.runBudgetMs);
  const results: {
    workspaceId: string;
    status: "complete" | "partial" | "failed" | "lease_lost";
    result?: WorkspaceResult;
  }[] = [];
  while (
    results.length < MAINTENANCE_LIMITS.maxWorkspaces &&
    dependencies.now() + MAINTENANCE_LIMITS.minStartBudgetMs < deadline
  ) {
    const claim = await dependencies.queue.claim();
    if (!claim) break;
    let status: "complete" | "partial" | "failed" = "failed";
    let result: WorkspaceResult | undefined;
    try {
      result = await dependencies.maintain(claim.organizationId, signal);
      status =
        result.providers.some((provider) => provider.status === "failed") ||
        (result.notifications &&
          !["complete", "unavailable"].includes(result.notifications.status))
          ? "partial"
          : "complete";
    } catch {
      /* Failure is retained in queue metadata; raw provider errors are never emitted. */
    }
    const finished = await dependencies.queue.finish(claim, status);
    results.push({
      workspaceId: claim.organizationId,
      status: finished ? status : "lease_lost",
      ...(result ? { result } : {}),
    });
  }
  const backlog = await dependencies.queue.backlog();
  return {
    ok:
      results.every((result) => result.status === "complete") &&
      backlog.due === 0 &&
      backlog.leased === 0 &&
      backlog.failed === 0,
    schedule: "daily",
    budget: MAINTENANCE_LIMITS,
    processed: results.length,
    results,
    backlog,
    deadlineReached:
      dependencies.now() + MAINTENANCE_LIMITS.minStartBudgetMs >= deadline,
  };
}
