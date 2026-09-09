import "server-only";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import {
  adsApiRequest,
  type AdsProviderRequestBudget,
} from "@/lib/openai-ads/client.server";
import {
  fetchLiveAdAccount,
  fetchLiveAttributionInventory,
} from "@/lib/openai-ads/data.server";
import { insightListResponseSchema } from "@/lib/openai-ads/schema";
import {
  localDate,
  defaultMapping,
  type ContactSnapshot,
  type Cost,
  type Deal,
  type Workspace,
} from "./model";
import { AttributionError } from "./store.server";

const hsObject = z.object({
  id: z.string(),
  properties: z.record(z.string().nullable()),
  propertiesWithHistory: z
    .record(z.array(z.object({ value: z.string() })))
    .optional(),
  updatedAt: z.string().datetime({ offset: true }),
  associations: z
    .object({
      contacts: z
        .object({
          results: z.array(z.object({ id: z.string() })),
          paging: z.unknown().optional(),
        })
        .optional(),
    })
    .optional(),
});
const hsPage = z.object({
  results: z.array(hsObject),
  paging: z
    .object({ next: z.object({ after: z.union([z.string(), z.number()]) }) })
    .optional(),
});
async function hubspot<T>(
  path: string,
  token: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  tokenInfoBody?: { tokenKey: string },
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`https://api.hubapi.com${path}`, {
      method: tokenInfoBody ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(tokenInfoBody ? { "Content-Type": "application/json" } : {}),
      },
      ...(tokenInfoBody ? { body: JSON.stringify(tokenInfoBody) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000),
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 429 && attempt < 2) {
      const requested = Number(response.headers.get("retry-after") ?? 1) * 1000;
      await delay(
        Number.isFinite(requested)
          ? Math.max(0, Math.min(requested, 3000))
          : 1000,
        undefined,
        { signal },
      );
      continue;
    }
    if (!response.ok)
      throw new AttributionError(
        502,
        response.status === 401 || response.status === 403
          ? "HubSpot denied access. Check the private app token and contact/deal read permissions."
          : "HubSpot is unavailable. Last successful data is preserved; retry the sync.",
      );
    const body = await response.text();
    if (body.length > 4_000_000)
      throw new AttributionError(
        502,
        "HubSpot response exceeds the supported size.",
      );
    try {
      return schema.parse(JSON.parse(body));
    } catch {
      throw new AttributionError(
        502,
        "HubSpot returned an invalid response. Last successful data is preserved; retry the sync.",
      );
    }
  }
  throw new AttributionError(502, "HubSpot rate limit reached. Retry later.");
}
async function listHubspot(
  kind: "contacts" | "deals",
  properties: string[],
  token: string,
  signal?: AbortSignal,
) {
  const items: z.infer<typeof hsObject>[] = [];
  let after = "";
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({
      limit: "100",
      properties: properties.join(","),
      propertiesWithHistory: properties[0],
    });
    if (kind === "deals") query.set("associations", "contacts");
    if (after) query.set("after", after);
    const result = await hubspot(
      `/crm/v3/objects/${kind}?${query}`,
      token,
      hsPage,
      signal,
    );
    items.push(...result.results);
    if (!result.paging?.next) return items;
    after = String(result.paging.next.after);
    if (seen.has(after)) break;
    seen.add(after);
  }
  throw new AttributionError(
    502,
    "HubSpot exceeds 10,000 records or returned a repeated cursor. No partial snapshot was accepted.",
  );
}
export async function syncHubspot(
  w: Workspace,
  token: string,
  expectedAccountId: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (
    typeof expectedAccountId !== "string" ||
    !/^[1-9]\d*$/.test(expectedAccountId) ||
    !Number.isSafeInteger(Number(expectedAccountId))
  )
    throw new AttributionError(
      400,
      "Enter the numeric HubSpot account ID before connecting or syncing.",
    );
  // HubSpot documents this read-only token inspection as a POST. Never put the
  // token in a URL, and verify its actual portal before reading any CRM data.
  const tokenInfo = await hubspot(
    "/oauth/v2/private-apps/get/access-token-info",
    token,
    z.unknown(),
    signal,
    { tokenKey: token },
  );
  const identity = z
    .object({ hubId: z.number().int().positive().safe() })
    .safeParse(tokenInfo);
  if (!identity.success)
    throw new AttributionError(
      502,
      "HubSpot account identity could not be verified. No CRM data was read.",
    );
  if (String(identity.data.hubId) !== expectedAccountId)
    throw new AttributionError(
      409,
      "The token belongs to a different HubSpot account. Check the account ID and private app token; previous data is preserved.",
    );
  signal?.throwIfAborted();
  // Required custom property must exist. This connector never creates or overwrites CRM properties.
  await hubspot(
    `/crm/v3/properties/contacts/${encodeURIComponent(w.submissionProperty)}`,
    token,
    z.object({ name: z.string() }),
    signal,
  );
  const mappedProperties = [
    ...new Set(
      w.sites.flatMap((site) =>
        Object.entries(site.mapping)
          .filter(([logical]) => logical in defaultMapping)
          .map(([, property]) => property),
      ),
    ),
  ];
  const [rawContacts, rawDeals] = await Promise.all([
    listHubspot(
      "contacts",
      [
        ...new Set([
          w.submissionProperty,
          "lifecyclestage",
          ...mappedProperties,
        ]),
      ],
      token,
      signal,
    ),
    listHubspot(
      "deals",
      [
        w.primaryContactProperty,
        "dealstage",
        "amount",
        "deal_currency_code",
        "closedate",
      ],
      token,
      signal,
    ),
  ]);
  const splitReferences = (value: string) =>
    value
      .split(/[;,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  const contacts: ContactSnapshot[] = rawContacts.map((c) => ({
    id: c.id,
    stage: c.properties.lifecyclestage ?? "unknown",
    submissions: [
      ...new Set(
        [
          c.properties[w.submissionProperty] ?? "",
          ...(c.propertiesWithHistory?.[w.submissionProperty] ?? []).map(
            (h) => h.value,
          ),
        ].flatMap(splitReferences),
      ),
    ],
    currentSubmissions: splitReferences(
      c.properties[w.submissionProperty] ?? "",
    ),
    fieldValues: Object.fromEntries(
      mappedProperties.map((property) => [
        property,
        c.properties[property] ?? null,
      ]),
    ),
    updatedAt: c.updatedAt,
  }));
  const deals: Omit<Deal, "history">[] = rawDeals.map((d) => {
    const p = d.properties;
    const amount =
      p.amount === null || p.amount === undefined || p.amount === ""
        ? null
        : Number(p.amount);
    if (amount !== null && (!Number.isFinite(amount) || amount < 0))
      throw new AttributionError(
        502,
        "A HubSpot deal has an invalid amount. Correct it and retry.",
      );
    if (d.associations?.contacts?.paging)
      throw new AttributionError(
        502,
        "A deal has paginated contact associations. Resolve its primary contact before syncing.",
      );
    const closedAt = p.closedate
      ? /^\d{13}$/.test(p.closedate)
        ? new Date(Number(p.closedate)).toISOString()
        : p.closedate
      : null;
    if (
      closedAt &&
      !z.string().datetime({ offset: true }).safeParse(closedAt).success
    )
      throw new AttributionError(
        502,
        "A HubSpot deal has an invalid close date. Correct it and retry.",
      );
    return {
      id: d.id,
      contacts: d.associations?.contacts?.results.map((c) => c.id) ?? [],
      primaryContactId: p[w.primaryContactProperty] || undefined,
      stage: p.dealstage ?? "unknown",
      amount,
      currency: p.deal_currency_code || "UNKNOWN",
      closedAt,
      updatedAt: d.updatedAt,
    };
  });
  return { contacts, deals };
}
// Resolve day boundaries in the account's IANA timezone, including DST changes.
function accountDayStart(date: string, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  let low = Date.parse(`${date}T00:00:00Z`) / 1000 - 86400;
  let high = low + 3 * 86400;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (formatter.format(new Date(middle * 1000)) < date) low = middle + 1;
    else high = middle;
  }
  if (formatter.format(new Date(low * 1000)) !== date)
    throw new AttributionError(
      502,
      "The advertiser account day could not be resolved.",
    );
  return low;
}
export async function syncOpenAI(
  token: string,
  expectedAccountId?: string,
  signal?: AbortSignal,
) {
  const credential = expectedAccountId
    ? { kind: "account_api_key" as const, secret: token, expectedAccountId }
    : { apiKey: token };
  const providerBudget: AdsProviderRequestBudget | undefined = signal
    ? {
        signal,
        async runRequest<T>(request: () => Promise<T>) {
          signal.throwIfAborted();
          const result = await request();
          signal.throwIfAborted();
          return result;
        },
      }
    : undefined;
  signal?.throwIfAborted();
  const account = await fetchLiveAdAccount(credential, providerBudget);
  if (expectedAccountId && account.id !== expectedAccountId)
    throw new AttributionError(
      409,
      "The key belongs to a different advertiser account.",
    );
  const inventory = await fetchLiveAttributionInventory(
    account,
    credential,
    signal,
  );
  const today = localDate(new Date().toISOString(), account.timezone);
  const firstDay = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  const to = accountDayStart(today, account.timezone),
    from = accountDayStart(firstDay, account.timezone);
  const costs = new Map<string, Cost>();
  let after = "";
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    signal?.throwIfAborted();
    const query = new URLSearchParams({
      time_granularity: "daily",
      aggregation_level: "campaign",
      limit: "2000",
    });
    query.append(
      "time_ranges[]",
      JSON.stringify({ type: "unix_range", start: from, end: to }),
    );
    for (const f of [
      "campaign.id",
      "campaign.name",
      "campaign.spend",
      "campaign.clicks",
      "campaign.impressions",
    ])
      query.append("fields[]", f);
    if (after) query.set("after", after);
    const result = await adsApiRequest(
      `/ad_account/insights?${query}`,
      insightListResponseSchema,
      { providerBudget },
      credential,
    );
    for (const row of result.data) {
      if (row.spend === undefined || !row.campaign_id) continue;
      if (
        row.start_time < from ||
        row.end_time > to ||
        row.end_time <= row.start_time
      )
        throw new AttributionError(
          502,
          "OpenAI returned spend outside the complete account-day window. No partial snapshot was accepted.",
        );
      const date = localDate(
        new Date(row.start_time * 1000).toISOString(),
        account.timezone,
      );
      const nextDate = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000)
        .toISOString()
        .slice(0, 10);
      if (
        row.start_time !== accountDayStart(date, account.timezone) ||
        row.end_time !== accountDayStart(nextDate, account.timezone)
      )
        throw new AttributionError(
          502,
          "OpenAI returned an incomplete account-day cost row. No partial snapshot was accepted.",
        );
      const cost: Cost = {
        id: `${date}:ChatGPT Ads:${row.campaign_id}:${account.currency_code}`,
        source: "openai",
        date,
        campaignId: row.campaign_id,
        campaign: row.campaign_name ?? row.campaign_id,
        channel: "ChatGPT Ads",
        currency: account.currency_code,
        amount: row.spend,
        clicks: row.clicks,
        impressions: row.impressions,
      };
      const previous = costs.get(cost.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(cost))
        throw new AttributionError(
          502,
          "OpenAI returned conflicting daily campaign costs. No partial snapshot was accepted.",
        );
      costs.set(cost.id, cost);
    }
    if (!result.has_more)
      return {
        account,
        inventory,
        costs: [...costs.values()],
        costWindow: { from: firstDay, to: today },
        coverage: `${firstDay} to ${today} (end exclusive; 30 complete days in ${account.timezone})`,
      };
    if (!result.last_id || seen.has(result.last_id)) break;
    after = result.last_id;
    seen.add(after);
  }
  throw new AttributionError(
    502,
    "OpenAI insights pagination was incomplete. Last successful data is preserved.",
  );
}
