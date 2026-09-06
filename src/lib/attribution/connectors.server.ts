import "server-only";
import { z } from "zod";
import { adsApiRequest } from "@/lib/openai-ads/client.server";
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
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`https://api.hubapi.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
      cache: "no-store",
      redirect: "error",
    });
    if (response.status === 429 && attempt < 2) {
      await new Promise((r) =>
        setTimeout(
          r,
          Math.min(
            Number(response.headers.get("retry-after") ?? 1) * 1000,
            3000,
          ),
        ),
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
    return schema.parse(JSON.parse(body));
  }
  throw new AttributionError(502, "HubSpot rate limit reached. Retry later.");
}
async function listHubspot(
  kind: "contacts" | "deals",
  properties: string[],
  token: string,
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
export async function syncHubspot(w: Workspace, token: string) {
  // Required custom property must exist. This connector never creates or overwrites CRM properties.
  await hubspot(
    `/crm/v3/properties/contacts/${encodeURIComponent(w.submissionProperty)}`,
    token,
    z.object({ name: z.string() }),
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
export async function syncOpenAI(token: string, expectedAccountId?: string) {
  const credential = expectedAccountId
    ? { kind: "account_api_key" as const, secret: token, expectedAccountId }
    : { apiKey: token };
  const account = await fetchLiveAdAccount(credential);
  if (expectedAccountId && account.id !== expectedAccountId)
    throw new AttributionError(
      409,
      "The key belongs to a different advertiser account.",
    );
  const inventory = await fetchLiveAttributionInventory(account, credential);
  const to = Math.floor(Date.now() / 1000),
    from = to - 30 * 86400;
  const costs: Cost[] = [];
  let after = "";
  const seen = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({
      time_granularity: "day",
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
      {},
      credential,
    );
    for (const row of result.data) {
      if (row.spend === undefined || !row.campaign_id) continue;
      const date = localDate(
        new Date(row.start_time * 1000).toISOString(),
        account.timezone,
      );
      costs.push({
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
      });
    }
    if (!result.has_more)
      return {
        account,
        inventory,
        costs: [...new Map(costs.map((c) => [c.id, c])).values()],
        coverage: `${new Date(from * 1000).toISOString()} to ${new Date(to * 1000).toISOString()}`,
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
