import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  authorize,
  mutateWorkspace,
  readWorkspace,
  publicWorkspace,
  sameOrigin,
  AttributionError,
} from "@/lib/attribution/store.server";
import {
  defaultMapping,
  costCSV,
  usage,
  pruneExpired,
  workspaceRetentionDays,
  planSiteLimit,
  activeSiteCount,
} from "@/lib/attribution/model";
import { syncWorkspaceProvider } from "@/lib/attribution/sync.server";
import { failure, jsonBody } from "@/lib/attribution/http.server";
type Context = { params: Promise<{ id: string }> };
const mapping = z.record(
  z.enum(Object.keys(defaultMapping) as [string, ...string[]]),
  z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/),
);
const action = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("site"),
    siteId: z.string().uuid().optional(),
    name: z.string().min(2).max(100),
    origin: z.string().url(),
    consent: z.enum(["required", "not_required"]),
    adapter: z.enum(["html", "hubspot_v4"]),
    formSelector: z.string().min(1).max(200),
    mapping: mapping.optional(),
  }),
  z.object({
    action: z.literal("pause"),
    siteId: z.string().uuid(),
    paused: z.boolean(),
  }),
  z.object({ action: z.literal("costs"), csv: z.string().max(500000) }),
  z.object({
    action: z.literal("settings"),
    name: z.string().min(2).max(100),
    timezone: z.string(),
    qualifiedStages: z.array(z.string().min(1)).min(1),
    wonStages: z.array(z.string().min(1)).min(1),
    retentionDays: z.number().int().min(1).max(90),
    submissionProperty: z.string().regex(/^[a-z][a-z0-9_]+$/),
    primaryContactProperty: z.string().regex(/^[a-z][a-z0-9_]+$/),
  }),
  z.object({
    action: z.literal("connect"),
    provider: z.enum(["hubspot", "openai"]),
    token: z.string().min(10).max(4096),
    accountId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(100),
  }),
  z.object({
    action: z.literal("sync"),
    provider: z.enum(["hubspot", "openai"]),
  }),
  z.object({
    action: z.literal("revoke"),
    provider: z.enum(["hubspot", "openai"]),
  }),
  z.object({
    action: z.literal("primary"),
    dealId: z.string(),
    contactId: z.string(),
  }),
  z.object({ action: z.literal("delete_site"), siteId: z.string().uuid() }),
  z.object({ action: z.literal("purge") }),
]);
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    z.string().uuid().parse(id);
    const membership = await authorize(request, id);
    const state = publicWorkspace(await readWorkspace(id));
    return Response.json(
      { state, role: membership.membershipRole, usage: usage(state) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const { id } = await context.params;
    z.string().uuid().parse(id);
    await authorize(request, id, true);
    const input = action.parse(await jsonBody(request));
    if (input.action === "connect" || input.action === "sync") {
      await syncWorkspaceProvider(id, input);
    } else if (input.action === "revoke") {
      await mutateWorkspace(
        id,
        (w) => {
          w.connectors = w.connectors.map((c) =>
            c.provider === input.provider
              ? {
                  ...c,
                  status: "revoked",
                  operationId: undefined,
                  error: undefined,
                }
              : c,
          );
        },
        { provider: input.provider, revoke: true },
      );
    } else
      await mutateWorkspace(id, (w) => {
        // Preserve a legacy site's setting before a mutation can remove it.
        w.retentionDays ??= workspaceRetentionDays(w);
        if (input.action === "site") {
          const origin = new URL(input.origin);
          if (
            origin.protocol !== "https:" &&
            !(
              w.mode === "local" &&
              ["localhost", "127.0.0.1"].includes(origin.hostname)
            )
          )
            throw new AttributionError(400, "Use an HTTPS website origin.");
          if (
            origin.pathname !== "/" ||
            origin.search ||
            origin.hash ||
            origin.username ||
            origin.password
          )
            throw new AttributionError(
              400,
              "Enter the website origin without a path, query or credentials.",
            );
          const existing = input.siteId
            ? w.sites.find((s) => s.id === input.siteId)
            : undefined;
          if (input.siteId && !existing)
            throw new AttributionError(
              404,
              "Website not found in this workspace.",
            );
          if (!existing && activeSiteCount(w) >= planSiteLimit(w.billing.plan))
            throw new AttributionError(
              409,
              "Active website limit reached. Pause another website before adding one, or review your plan in Workspace & billing.",
            );
          const fields = input.mapping ?? defaultMapping;
          if (
            new Set(Object.values(fields)).size !==
              Object.keys(fields).length ||
            !fields.submission_id
          )
            throw new AttributionError(
              400,
              "Mappings must be unique and include submission_id.",
            );
          const nextSite = {
            id: existing?.id ?? randomUUID(),
            name: input.name,
            origin: origin.origin,
            consent: input.consent,
            adapter: input.adapter,
            formSelector: input.formSelector,
            mapping: fields,
            retentionDays: existing?.retentionDays ?? workspaceRetentionDays(w),
            paused: existing?.paused ?? false,
          };
          if (existing) {
            Object.assign(existing, nextSite);
            delete existing.installedAt;
            delete existing.verifiedAt;
          } else w.sites.push(nextSite);
        }
        if (input.action === "pause") {
          const site = w.sites.find((s) => s.id === input.siteId);
          if (!site) throw new AttributionError(404, "Website not found.");
          if (
            site.paused &&
            !input.paused &&
            activeSiteCount(w) >= planSiteLimit(w.billing.plan)
          )
            throw new AttributionError(
              409,
              `Active website limit reached. Pause another website before resuming this one${w.billing.plan === "starter" ? ", or choose Agency in Workspace & billing" : ""}.`,
            );
          site.paused = input.paused;
        }
        if (input.action === "costs") {
          const costs = costCSV(input.csv);
          if (
            costs.some((c) =>
              w.costs.some((old) => old.id === c.id && old.source === "openai"),
            )
          )
            throw new AttributionError(
              409,
              "CSV overlaps native OpenAI cost data. Remove those rows first.",
            );
          const ids = new Set(costs.map((c) => c.id));
          w.costs = w.costs.filter((c) => !ids.has(c.id)).concat(costs);
        }
        if (input.action === "settings") {
          try {
            new Intl.DateTimeFormat("en", { timeZone: input.timezone });
          } catch {
            throw new AttributionError(400, "Use a valid IANA timezone.");
          }
          Object.assign(w, {
            name: input.name,
            timezone: input.timezone,
            retentionDays: input.retentionDays,
            qualifiedStages: input.qualifiedStages,
            wonStages: input.wonStages,
            submissionProperty: input.submissionProperty,
            primaryContactProperty: input.primaryContactProperty,
          });
          w.sites.forEach((s) => (s.retentionDays = input.retentionDays));
          for (const submission of w.submissions) {
            const cap =
              Date.parse(submission.evidence.first.at) +
              input.retentionDays * 86400000;
            if (Date.parse(submission.evidence.expiresAt) > cap)
              submission.evidence.expiresAt = new Date(cap).toISOString();
          }
          pruneExpired(w);
        }
        if (input.action === "primary") {
          const deal = w.deals.find((d) => d.id === input.dealId);
          if (!deal || !deal.contacts.includes(input.contactId))
            throw new AttributionError(
              400,
              "Choose a contact associated with this deal.",
            );
          deal.primaryContactId = input.contactId;
          w.primarySelections = {
            ...w.primarySelections,
            [deal.id]: input.contactId,
          };
        }
        if (input.action === "delete_site") {
          w.sites = w.sites.filter((s) => s.id !== input.siteId);
          for (const submission of w.submissions)
            if (submission.siteId === input.siteId)
              submission.evidence.expiresAt = new Date(0).toISOString();
          pruneExpired(w);
        }
        if (input.action === "purge") {
          pruneExpired(w);
        }
      });
    return Response.json(
      { state: publicWorkspace(await readWorkspace(id)) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
