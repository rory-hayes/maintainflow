import "server-only";

import { randomUUID } from "node:crypto";

import type postgres from "postgres";
import type { Sql } from "postgres";

import { getRuntimeDatabase } from "../database/client.server";
import type { LiveWorkbenchData } from "./data.server";
import {
  LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION,
  LiveWorkbenchSnapshotValidationError,
  parseLiveWorkbenchSnapshot,
  serializeLiveWorkbenchSnapshot,
} from "./live-sync-snapshot";

type LiveSyncStateRow = {
  payload_schema_version: number | null;
  snapshot_payload: unknown | null;
  snapshot_bytes: number | null;
  synced_at: Date | null;
  fresh_until: Date | null;
  stale_until: Date | null;
  refresh_claim_id: string | null;
  refresh_claimed_at: Date | null;
  refresh_claim_expires_at: Date | null;
  consecutive_failures: number;
  last_failure_code: string | null;
  last_failed_at: Date | null;
  retry_after: Date | null;
};

export type LiveSyncState = {
  snapshot: LiveWorkbenchData | null;
  payloadSchemaVersion: number | null;
  snapshotBytes: number | null;
  syncedAt: Date | null;
  freshUntil: Date | null;
  staleUntil: Date | null;
  claim: {
    claimId: string;
    claimedAt: Date;
    expiresAt: Date;
  } | null;
  consecutiveFailures: number;
  lastFailureCode: string | null;
  lastFailedAt: Date | null;
  retryAfter: Date | null;
};

export class LiveSyncStoreUnavailableError extends Error {
  constructor(message = "Live workbench snapshot storage is not configured.") {
    super(message);
    this.name = "LiveSyncStoreUnavailableError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new LiveSyncStoreUnavailableError();
  return getRuntimeDatabase(connectionString);
}

function validateScope(accountId: string, credentialGeneration: string) {
  if (!accountId || accountId.length > 255 || /\s/.test(accountId)) {
    throw new TypeError("accountId must be a non-whitespace identifier.");
  }
  if (
    !credentialGeneration ||
    credentialGeneration.length > 255 ||
    /\s/.test(credentialGeneration)
  ) {
    throw new TypeError(
      "credentialGeneration must be a non-whitespace identifier of at most 255 characters.",
    );
  }
}

function validateDate(value: Date, name: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid Date.`);
  }
}

function validateClaimId(claimId: string) {
  if (!UUID_PATTERN.test(claimId)) {
    throw new TypeError("claimId must be a UUID.");
  }
}

function futureDate(now: Date, durationMs: number, name: string) {
  validateDate(now, "now");
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new TypeError(`${name} must be a positive integer number of milliseconds.`);
  }
  const timestamp = now.getTime() + durationMs;
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${name} produces an invalid timestamp.`);
  }
  return new Date(timestamp);
}

function parseStateRow(
  row: LiveSyncStateRow,
  accountId: string,
): LiveSyncState {
  const snapshot =
    row.snapshot_payload === null
      ? null
      : parseLiveWorkbenchSnapshot(row.snapshot_payload, {
          expectedAccountId: accountId,
          recordedSchemaVersion: row.payload_schema_version,
          recordedBytes: row.snapshot_bytes,
        });
  const claim = row.refresh_claim_id
    ? {
        claimId: row.refresh_claim_id,
        claimedAt: row.refresh_claimed_at!,
        expiresAt: row.refresh_claim_expires_at!,
      }
    : null;
  return {
    snapshot,
    payloadSchemaVersion: row.payload_schema_version,
    snapshotBytes: row.snapshot_bytes,
    syncedAt: row.synced_at,
    freshUntil: row.fresh_until,
    staleUntil: row.stale_until,
    claim,
    consecutiveFailures: row.consecutive_failures,
    lastFailureCode: row.last_failure_code,
    lastFailedAt: row.last_failed_at,
    retryAfter: row.retry_after,
  };
}

function withoutSnapshot(row: LiveSyncStateRow): LiveSyncStateRow {
  return {
    ...row,
    payload_schema_version: null,
    snapshot_payload: null,
    snapshot_bytes: null,
    synced_at: null,
    fresh_until: null,
    stale_until: null,
  };
}

export async function verifyLiveSyncStore(database?: Sql) {
  if (!database && !process.env.DATABASE_URL) return false;
  const sql = database ?? getDatabase();
  const [row] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_live_workbench_snapshots') is not null
      and to_regclass(
        'public.maintainflow_live_workbench_snapshots_retention_idx'
      ) is not null
      and exists (
        select 1
        from pg_attribute
        where attrelid =
          'public.maintainflow_live_workbench_snapshots'::regclass
          and attname = 'detected_signal_count'
          and not attisdropped
      )
    ) as ready
  `;
  return row?.ready === true;
}

export async function readLiveSyncState(options: {
  accountId: string;
  credentialGeneration: string;
}): Promise<LiveSyncState | null> {
  validateScope(options.accountId, options.credentialGeneration);
  const sql = getDatabase();

  async function selectStateRow() {
    const [row] = await sql<LiveSyncStateRow[]>`
      select
        state.payload_schema_version,
        state.snapshot_payload,
        state.snapshot_bytes,
        state.synced_at,
        state.fresh_until,
        state.stale_until,
        state.refresh_claim_id,
        state.refresh_claimed_at,
        state.refresh_claim_expires_at,
        state.consecutive_failures,
        state.last_failure_code,
        state.last_failed_at,
        state.retry_after
      from maintainflow_live_workbench_snapshots state
      join maintainflow_advertiser_accounts account
        on account.id = state.advertiser_account_id
      where account.external_account_id = ${options.accountId}
        and account.status = 'active'
        and state.credential_generation = ${options.credentialGeneration}
    `;
    return row;
  }

  async function clearSnapshotIfUnchanged(row: LiveSyncStateRow) {
    const cleared = await sql<{ cleared: boolean }[]>`
      with locked_account as materialized (
        select id
        from maintainflow_advertiser_accounts
        where external_account_id = ${options.accountId}
          and status = 'active'
        for share
      )
      update maintainflow_live_workbench_snapshots state set
        payload_schema_version = null,
        snapshot_payload = null,
        snapshot_bytes = null,
        detected_signal_count = null,
        synced_at = null,
        fresh_until = null,
        stale_until = null,
        updated_at = now()
      from locked_account account
      where account.id = state.advertiser_account_id
        and state.credential_generation = ${options.credentialGeneration}
        and state.payload_schema_version is not distinct from ${row.payload_schema_version}
        and state.snapshot_bytes is not distinct from ${row.snapshot_bytes}
        and state.snapshot_payload = ${sql.json(
          row.snapshot_payload as postgres.JSONValue,
        )}
      returning true as cleared
    `;
    return cleared[0]?.cleared === true;
  }

  let row = await selectStateRow();
  if (!row) return null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return parseStateRow(row, options.accountId);
    } catch (error) {
      if (!(error instanceof LiveWorkbenchSnapshotValidationError)) throw error;
    }

    if (await clearSnapshotIfUnchanged(row)) {
      return parseStateRow(withoutSnapshot(row), options.accountId);
    }

    // A concurrent writer replaced the invalid payload after our read. Re-read
    // instead of clearing or returning the newer snapshot optimistically.
    const currentRow = await selectStateRow();
    if (!currentRow) return null;
    row = currentRow;
  }

  // If a second concurrent replacement is also invalid, keep it unusable for
  // this request and let the normal claim/completion path overwrite it.
  return parseStateRow(withoutSnapshot(row), options.accountId);
}

export async function claimLiveSyncRefresh(options: {
  accountId: string;
  credentialGeneration: string;
  now: Date;
  leaseMs: number;
}) {
  validateScope(options.accountId, options.credentialGeneration);
  const expiresAt = futureDate(options.now, options.leaseMs, "leaseMs");
  const claimId = randomUUID();
  const sql = getDatabase();

  const rows = await sql<{ refresh_claim_id: string }[]>`
    with locked_account as materialized (
      select id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for share
    )
    insert into maintainflow_live_workbench_snapshots (
      advertiser_account_id, credential_generation,
      refresh_claim_id, refresh_claimed_at, refresh_claim_expires_at,
      updated_at
    )
    select account.id, ${options.credentialGeneration},
      ${claimId}, ${options.now}, ${expiresAt}, ${options.now}
    from locked_account account
    on conflict (advertiser_account_id, credential_generation) do update set
      refresh_claim_id = ${claimId},
      refresh_claimed_at = ${options.now},
      refresh_claim_expires_at = ${expiresAt},
      updated_at = ${options.now}
    where (
        maintainflow_live_workbench_snapshots.refresh_claim_id is null
        or maintainflow_live_workbench_snapshots.refresh_claim_expires_at
          <= ${options.now}
      )
      and (
        maintainflow_live_workbench_snapshots.retry_after is null
        or maintainflow_live_workbench_snapshots.retry_after <= ${options.now}
      )
    returning refresh_claim_id
  `;
  return rows[0] ? { claimId, expiresAt } : null;
}

export async function renewLiveSyncClaim(options: {
  accountId: string;
  credentialGeneration: string;
  claimId: string;
  now: Date;
  leaseMs: number;
}) {
  validateScope(options.accountId, options.credentialGeneration);
  validateClaimId(options.claimId);
  const expiresAt = futureDate(options.now, options.leaseMs, "leaseMs");
  const sql = getDatabase();
  const rows = await sql<{ refresh_claim_id: string }[]>`
    with locked_account as materialized (
      select id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for share
    )
    update maintainflow_live_workbench_snapshots state set
      refresh_claim_expires_at = ${expiresAt},
      updated_at = ${options.now}
    from locked_account account
    where account.id = state.advertiser_account_id
      and state.credential_generation = ${options.credentialGeneration}
      and state.refresh_claim_id = ${options.claimId}
      and state.refresh_claim_expires_at > ${options.now}
    returning state.refresh_claim_id
  `;
  return Boolean(rows[0]);
}

export async function completeLiveSyncRefresh(options: {
  accountId: string;
  credentialGeneration: string;
  claimId: string;
  snapshot: LiveWorkbenchData;
  now: Date;
  freshForMs: number;
  staleForMs: number;
}) {
  validateScope(options.accountId, options.credentialGeneration);
  validateClaimId(options.claimId);
  const freshUntil = futureDate(options.now, options.freshForMs, "freshForMs");
  const staleUntil = futureDate(options.now, options.staleForMs, "staleForMs");
  if (staleUntil < freshUntil) {
    throw new TypeError("staleForMs must be greater than or equal to freshForMs.");
  }
  const serialized = serializeLiveWorkbenchSnapshot(
    options.snapshot,
    options.accountId,
  );
  const syncedAt = new Date(serialized.snapshot.syncedAt);
  if (syncedAt > freshUntil) {
    throw new TypeError("snapshot.syncedAt cannot be after the fresh-until timestamp.");
  }

  const sql = getDatabase();
  const rows = await sql<{ refresh_claim_id: string }[]>`
    with locked_account as materialized (
      select id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for share
    )
    update maintainflow_live_workbench_snapshots state set
      payload_schema_version = ${LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION},
      snapshot_payload = ${sql.json(
        serialized.envelope as unknown as postgres.JSONValue,
      )},
      snapshot_bytes = ${serialized.bytes},
      detected_signal_count = ${serialized.snapshot.recommendations.length},
      synced_at = ${syncedAt},
      fresh_until = ${freshUntil},
      stale_until = ${staleUntil},
      refresh_claim_id = null,
      refresh_claimed_at = null,
      refresh_claim_expires_at = null,
      consecutive_failures = 0,
      last_failure_code = null,
      last_failed_at = null,
      retry_after = null,
      updated_at = ${options.now}
    from locked_account account
    where account.id = state.advertiser_account_id
      and state.credential_generation = ${options.credentialGeneration}
      and state.refresh_claim_id = ${options.claimId}
      and state.refresh_claim_expires_at > ${options.now}
    returning ${options.claimId}::uuid as refresh_claim_id
  `;
  return Boolean(rows[0]);
}

export async function failLiveSyncRefresh(options: {
  accountId: string;
  credentialGeneration: string;
  claimId: string;
  failureCode: string;
  retryAfter: Date;
  now: Date;
}) {
  validateScope(options.accountId, options.credentialGeneration);
  validateClaimId(options.claimId);
  validateDate(options.now, "now");
  validateDate(options.retryAfter, "retryAfter");
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(options.failureCode)) {
    throw new TypeError(
      "failureCode must be a bounded lowercase machine-readable code.",
    );
  }
  if (options.retryAfter < options.now) {
    throw new TypeError("retryAfter cannot be before now.");
  }

  const sql = getDatabase();
  const rows = await sql<{ refresh_claim_id: string }[]>`
    with locked_account as materialized (
      select id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for share
    )
    update maintainflow_live_workbench_snapshots state set
      refresh_claim_id = null,
      refresh_claimed_at = null,
      refresh_claim_expires_at = null,
      consecutive_failures = least(state.consecutive_failures + 1, 1000000),
      last_failure_code = ${options.failureCode},
      last_failed_at = ${options.now},
      retry_after = ${options.retryAfter},
      updated_at = ${options.now}
    from locked_account account
    where account.id = state.advertiser_account_id
      and state.credential_generation = ${options.credentialGeneration}
      and state.refresh_claim_id = ${options.claimId}
      and state.refresh_claim_expires_at > ${options.now}
    returning ${options.claimId}::uuid as refresh_claim_id
  `;
  return Boolean(rows[0]);
}

export async function pruneExpiredLiveSyncSnapshots(options: {
  now: Date;
  retentionMs: number;
  limit: number;
}) {
  validateDate(options.now, "now");
  if (!Number.isSafeInteger(options.retentionMs) || options.retentionMs <= 0) {
    throw new TypeError(
      "retentionMs must be a positive integer number of milliseconds.",
    );
  }
  const cutoff = new Date(options.now.getTime() - options.retentionMs);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new TypeError("retentionMs produces an invalid timestamp.");
  }
  if (!Number.isFinite(options.limit)) {
    throw new TypeError("limit must be a finite number.");
  }
  const safeLimit = Math.max(1, Math.min(5_000, Math.trunc(options.limit)));
  const sql = getDatabase();
  const rows = await sql<{ advertiser_account_id: string }[]>`
    delete from maintainflow_live_workbench_snapshots state
    where (state.advertiser_account_id, state.credential_generation) in (
      select candidate.advertiser_account_id, candidate.credential_generation
      from maintainflow_live_workbench_snapshots candidate
      where coalesce(candidate.synced_at, candidate.created_at) < ${cutoff}
        and (
          candidate.refresh_claim_id is null
          or candidate.refresh_claim_expires_at <= ${options.now}
        )
      order by
        coalesce(candidate.synced_at, candidate.created_at),
        candidate.advertiser_account_id
      limit ${safeLimit}
      for update skip locked
    )
    returning state.advertiser_account_id
  `;
  return rows.length;
}
