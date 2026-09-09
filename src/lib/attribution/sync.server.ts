import "server-only";
import { randomUUID } from "node:crypto";
import {
  readWorkspace,
  mutateWorkspace,
  credential,
  AttributionError,
} from "./store.server";
import { reconcileCRM } from "./model";
import { syncHubspot, syncOpenAI } from "./connectors.server";
export async function syncWorkspaceProvider(
  id: string,
  input:
    | {
        action: "connect";
        provider: "hubspot" | "openai";
        token: string;
        accountId: string;
      }
    | { action: "sync"; provider: "hubspot" | "openai" },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const w = await readWorkspace(id);
  const provider = input.provider;
  const token =
    input.action === "connect" ? input.token : await credential(id, provider);
  const accountId =
    input.action === "connect"
      ? input.accountId
      : w.connectors.find((c) => c.provider === provider)?.accountId;
  const observed = w.connectors.find((c) => c.provider === provider);
  if (input.action === "sync" && (!observed || observed.status === "revoked"))
    throw new AttributionError(409, "Reconnect this provider before syncing.");
  const hasProviderHistory =
    provider === "hubspot"
      ? w.contacts.length > 0 || w.deals.length > 0
      : Boolean(w.adInventory) ||
        w.costs.some((cost) => cost.source === "openai");
  const canCorrectAccount =
    observed &&
    ["error", "revoked"].includes(observed.status) &&
    !observed.syncedAt &&
    !hasProviderHistory;
  if (
    input.action === "connect" &&
    observed &&
    observed.accountId !== input.accountId &&
    !canCorrectAccount
  )
    throw new AttributionError(
      409,
      "Use a separate workspace for a different provider account so client histories are not mixed.",
    );
  signal?.throwIfAborted();
  const operationId = randomUUID();
  await mutateWorkspace(id, (state) => {
    const current = state.connectors.find((c) => c.provider === provider);
    if (
      current?.operationId !== observed?.operationId ||
      current?.status !== observed?.status
    )
      throw new AttributionError(
        409,
        "A newer connector action replaced this sync. Refresh and retry.",
      );
    if (current) {
      current.operationId = operationId;
      // An unsuccessful first verification has no client history to protect.
      // Record its corrected input while keeping the existing operation fence.
      if (input.action === "connect" && canCorrectAccount)
        current.accountId = input.accountId;
    } else
      state.connectors.push({
        provider,
        accountId: accountId!,
        operationId,
        status: "error",
        error: "Connection verification is in progress.",
      });
  });
  const change = {
    provider,
    operationId,
    ...(input.action === "connect" ? { secret: token } : {}),
  };
  try {
    if (provider === "hubspot") {
      const snapshot = await syncHubspot(w, token, accountId!, signal);
      signal?.throwIfAborted();
      await mutateWorkspace(
        id,
        (state) => {
          signal?.throwIfAborted();
          reconcileCRM(state, snapshot.contacts, snapshot.deals);
          state.connectors = state.connectors.filter(
            (c) => c.provider !== provider,
          );
          state.connectors.push({
            provider,
            accountId: accountId!,
            status: "connected",
            operationId,
            syncedAt: new Date().toISOString(),
          });
          for (const site of state.sites)
            if (
              state.submissions.some(
                (s) => s.siteId === site.id && s.test && s.crmFieldsVerifiedAt,
              )
            )
              site.verifiedAt = new Date().toISOString();
            else delete site.verifiedAt;
        },
        change,
      );
    } else {
      const snapshot = await syncOpenAI(token, accountId, signal);
      signal?.throwIfAborted();
      await mutateWorkspace(
        id,
        (state) => {
          signal?.throwIfAborted();
          state.adInventory = snapshot.inventory;
          const incomingIds = new Set(snapshot.costs.map((cost) => cost.id));
          state.costs = state.costs
            .filter(
              (c) =>
                !(
                  incomingIds.has(c.id) ||
                  (c.source === "openai" &&
                    c.date >= snapshot.costWindow.from &&
                    c.date < snapshot.costWindow.to)
                ),
            )
            .concat(snapshot.costs);
          state.connectors = state.connectors.filter(
            (c) => c.provider !== provider,
          );
          state.connectors.push({
            provider,
            accountId: snapshot.account.id,
            status: "connected",
            operationId,
            syncedAt: new Date().toISOString(),
            timezone: snapshot.account.timezone,
            coverage: snapshot.coverage,
          });
        },
        change,
      );
    }
  } catch (e) {
    await mutateWorkspace(id, (state) => {
      const c = state.connectors.find((c) => c.provider === provider);
      if (c && c.operationId === operationId) {
        c.status = "error";
        c.error =
          "Sync failed. Check credentials and permissions; previous data is preserved.";
      }
    });
    throw e;
  }
}
