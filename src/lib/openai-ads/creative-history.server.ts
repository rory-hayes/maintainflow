import "server-only";

import { randomUUID } from "node:crypto";

import type { Sql } from "postgres";

import { getRuntimeDatabase } from "../database/client.server";
import {
  buildCreativeReviewTransitions,
  creativeReviewEventSchema,
  creativeReviewStateSchema,
  toCreativeReviewState,
  type CreativeReviewEvent,
  type CreativeReviewState,
} from "./creative-history";
import type { ScopedAd } from "./schema";

type CreativeStateRow = {
  ad_id: string;
  ad_group_id: string;
  ad_name: string;
  review_status: CreativeReviewState["reviewStatus"];
  delivery_status: CreativeReviewState["deliveryStatus"];
  provider_updated_at: number | string;
};

type CreativeEventRow = CreativeStateRow & {
  id: string;
  external_account_id: string;
  event_type: CreativeReviewEvent["eventType"];
  previous_review_status: CreativeReviewEvent["previousReviewStatus"];
  previous_delivery_status: CreativeReviewEvent["previousDeliveryStatus"];
  detected_at: Date;
};

export class CreativeHistoryStoreUnavailableError extends Error {
  constructor(message = "Creative review history storage is not configured.") {
    super(message);
    this.name = "CreativeHistoryStoreUnavailableError";
  }
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new CreativeHistoryStoreUnavailableError();

  return getRuntimeDatabase(connectionString);
}

function parseStateRow(row: CreativeStateRow): CreativeReviewState {
  return creativeReviewStateSchema.parse({
    adId: row.ad_id,
    adGroupId: row.ad_group_id,
    adName: row.ad_name,
    reviewStatus: row.review_status,
    deliveryStatus: row.delivery_status,
    providerUpdatedAt: Number(row.provider_updated_at),
  });
}

function parseEventRow(row: CreativeEventRow): CreativeReviewEvent {
  return creativeReviewEventSchema.parse({
    id: row.id,
    accountId: row.external_account_id,
    adId: row.ad_id,
    adGroupId: row.ad_group_id,
    adName: row.ad_name,
    eventType: row.event_type,
    previousReviewStatus: row.previous_review_status,
    reviewStatus: row.review_status,
    previousDeliveryStatus: row.previous_delivery_status,
    deliveryStatus: row.delivery_status,
    providerUpdatedAt: Number(row.provider_updated_at),
    detectedAt: row.detected_at.toISOString(),
  });
}

export async function verifyCreativeHistoryStore(database?: Sql) {
  if (!database && !process.env.DATABASE_URL) return false;
  const sql = database ?? getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_creative_review_state') is not null
      and to_regclass('public.maintainflow_creative_review_events') is not null
    ) as ready
  `;
  return result?.ready === true;
}

export async function recordCreativeReviewSnapshot(options: {
  accountId: string;
  ads: ScopedAd[];
  observedAt?: Date;
}) {
  if (options.ads.length === 0) return [];
  const sql = getDatabase();
  const observedAt = options.observedAt ?? new Date();
  const detectedAt = observedAt.toISOString();

  return sql.begin(async (transaction) => {
    // The provider request is complete before this transaction starts. Locking
    // one advertiser row serializes snapshots for that account only.
    const [account] = await transaction<{ id: string }[]>`
      select id from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for update
    `;
    if (!account) {
      throw new CreativeHistoryStoreUnavailableError(
        "The advertiser account is not available for creative history.",
      );
    }

    const previousRows = await transaction<CreativeStateRow[]>`
      select
        ad_id, ad_group_id, ad_name, review_status, delivery_status,
        provider_updated_at
      from maintainflow_creative_review_state
      where advertiser_account_id = ${account.id}
        and ad_id in ${transaction(options.ads.map((ad) => ad.id))}
    `;
    const previousStates = previousRows.map(parseStateRow);
    const previousByAdId = new Map(
      previousStates.map((state) => [state.adId, state]),
    );
    const transitions = buildCreativeReviewTransitions({
      accountId: options.accountId,
      previousStates,
      ads: options.ads,
      detectedAt,
    });

    const stateRows = options.ads.flatMap((ad) => {
      const previous = previousByAdId.get(ad.id);
      if (previous && ad.updated_at < previous.providerUpdatedAt) return [];
      const state = toCreativeReviewState(ad);
      return [
        {
          advertiser_account_id: account.id,
          ad_id: state.adId,
          ad_group_id: state.adGroupId,
          ad_name: state.adName,
          review_status: state.reviewStatus,
          delivery_status: state.deliveryStatus,
          provider_updated_at: state.providerUpdatedAt,
          observed_at: observedAt,
        },
      ];
    });

    let insertedEvents: CreativeEventRow[] = [];
    if (transitions.length > 0) {
      const eventRows = transitions.map((event) => ({
        id: randomUUID(),
        advertiser_account_id: account.id,
        ad_id: event.adId,
        ad_group_id: event.adGroupId,
        ad_name: event.adName,
        event_type: event.eventType,
        previous_review_status: event.previousReviewStatus,
        review_status: event.reviewStatus,
        previous_delivery_status: event.previousDeliveryStatus,
        delivery_status: event.deliveryStatus,
        provider_updated_at: event.providerUpdatedAt,
        detected_at: observedAt,
      }));
      const inserted = await transaction`
        insert into maintainflow_creative_review_events ${transaction(
          eventRows,
          "id",
          "advertiser_account_id",
          "ad_id",
          "ad_group_id",
          "ad_name",
          "event_type",
          "previous_review_status",
          "review_status",
          "previous_delivery_status",
          "delivery_status",
          "provider_updated_at",
          "detected_at",
        )}
        on conflict do nothing
        returning
          id, ${options.accountId}::text as external_account_id,
          ad_id, ad_group_id, ad_name, event_type,
          previous_review_status, review_status,
          previous_delivery_status, delivery_status,
          provider_updated_at, detected_at
      `;
      insertedEvents = inserted as unknown as CreativeEventRow[];
    }

    if (stateRows.length > 0) {
      await transaction`
        insert into maintainflow_creative_review_state ${transaction(
          stateRows,
          "advertiser_account_id",
          "ad_id",
          "ad_group_id",
          "ad_name",
          "review_status",
          "delivery_status",
          "provider_updated_at",
          "observed_at",
        )}
        on conflict (advertiser_account_id, ad_id) do update set
          ad_group_id = excluded.ad_group_id,
          ad_name = excluded.ad_name,
          review_status = excluded.review_status,
          delivery_status = excluded.delivery_status,
          provider_updated_at = excluded.provider_updated_at,
          observed_at = excluded.observed_at,
          updated_at = now()
        where excluded.provider_updated_at >=
          maintainflow_creative_review_state.provider_updated_at
      `;
    }

    return insertedEvents.map(parseEventRow);
  });
}

export async function listCreativeReviewEvents(
  accountId: string,
  limit = 20,
) {
  const sql = getDatabase();
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await sql<CreativeEventRow[]>`
    select
      event.id, account.external_account_id, event.ad_id, event.ad_group_id,
      event.ad_name, event.event_type, event.previous_review_status,
      event.review_status, event.previous_delivery_status,
      event.delivery_status, event.provider_updated_at, event.detected_at
    from maintainflow_creative_review_events event
    join maintainflow_advertiser_accounts account
      on account.id = event.advertiser_account_id
    where account.external_account_id = ${accountId}
    order by event.detected_at desc, event.id desc
    limit ${safeLimit}
  `;
  return rows.map(parseEventRow);
}
