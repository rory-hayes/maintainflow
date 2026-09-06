import "server-only";

import { randomUUID } from "node:crypto";

import type postgres from "postgres";
import type { Sql } from "postgres";
import { z } from "zod";

import { storedAdsMutationSchema } from "../audit/approval-schema";
import { getRuntimeDatabase } from "../database/client.server";
import { canWriteAccount, type AccountAccess } from "../tenancy/schema";
import {
  AccountAccessForbiddenError,
  lockCurrentAccountWriteAccess,
} from "../tenancy/store.server";
import {
  CHANGE_INTEGRITY_PROJECTION_VERSION,
  changeIntegrityCandidateSchema,
  changeIntegrityEventDtoSchema,
  changeIntegrityEventPageSchema,
  changeIntegrityFingerprint,
  changeIntegrityOperationEvidenceSchema,
  changeIntegrityReviewStatusSchema,
  changeIntegritySnapshotSchema,
  compareChangeIntegritySnapshots,
  type ChangeIntegrityCandidate,
  type ChangeIntegrityEventDto,
  type ChangeIntegrityEventPage,
  type ChangeIntegrityOperationEvidence,
  type ChangeIntegritySnapshot,
} from "./change-integrity";
import { parseAdsResourcePath } from "./resource-path";

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_APPROVAL_EVIDENCE_ROWS = 500;
const EVENT_INSERT_BATCH_SIZE = 200;

// Sql and TransactionSql share the tagged-query surface used below. Keeping
// the internal helper on TransactionSql avoids TypeScript's incompatible
// callable-overload union while the public boundary still accepts either.
type ChangeIntegrityDatabase = postgres.TransactionSql;

type ChangeIntegrityStateRow = {
  projection_version: number;
  snapshot_fingerprint: string;
  snapshot_payload: unknown;
  snapshot_resource_count: number;
  observed_at: Date;
};

type ApprovalEvidenceRow = {
  id: string;
  entity_id: string;
  status: string;
  request_payload: unknown;
  rollback_payload: unknown;
  applied_at: Date | null;
  rolled_back_at: Date | null;
  apply_provider_attempted_at: Date | null;
  rollback_provider_attempted_at: Date | null;
};

type ChangeIntegrityEventRow = {
  id: string;
  external_account_id: string;
  event_fingerprint: string;
  projection_version: number;
  resource_type: ChangeIntegrityCandidate["resourceType"];
  resource_id: string;
  parent_resource_id: string | null;
  resource_label: string;
  provider_updated_at: number | string | null;
  change_type: ChangeIntegrityCandidate["changeType"];
  classification: ChangeIntegrityCandidate["classification"];
  previous_fingerprint: string | null;
  current_fingerprint: string | null;
  previous_configuration: unknown | null;
  current_configuration: unknown | null;
  changed_field_paths: string[];
  explained_field_paths: string[];
  indeterminate_field_paths: string[];
  unexplained_field_paths: string[];
  matched_operations: unknown;
  baseline_observation_started_at: Date;
  baseline_observed_at: Date;
  detection_started_at: Date;
  detected_at: Date;
  review_status: ChangeIntegrityEventDto["reviewStatus"];
  reviewed_by_name: string | null;
  review_note: string | null;
  reviewed_at: Date | null;
};

type ChangeIntegritySummaryRow = {
  retained_event_count: number;
  open_unexplained_count: number;
  open_indeterminate_count: number;
  consistent_count: number;
  reviewed_count: number;
};

export type RecordChangeIntegritySnapshotResult = {
  baselineCreated: boolean;
  baselineAdvanced: boolean;
  events: ChangeIntegrityEventDto[];
};

export class ChangeIntegrityStoreUnavailableError extends Error {
  constructor(message = "Change-integrity storage is not configured.") {
    super(message);
    this.name = "ChangeIntegrityStoreUnavailableError";
  }
}

export class ChangeIntegrityTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeIntegrityTransitionError";
  }
}

export class ChangeIntegritySnapshotOrderError extends ChangeIntegrityTransitionError {
  constructor(
    message = "The confirmed change-integrity snapshot is older than the durable baseline.",
  ) {
    super(message);
    this.name = "ChangeIntegritySnapshotOrderError";
  }
}

export class ChangeIntegrityAuthorizationError extends Error {
  constructor(
    message = "Advertiser write access changed while this integrity event was being reviewed. Refresh before trying again.",
  ) {
    super(message);
    this.name = "ChangeIntegrityAuthorizationError";
  }
}

function isDatabaseAuthorizationChangedError(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "message" in error &&
      (error as { message?: unknown }).message ===
        "Current advertiser write authority is required to review an integrity event",
  );
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new ChangeIntegrityStoreUnavailableError();
  return getRuntimeDatabase(connectionString);
}

function validateAccountId(accountId: string) {
  if (!accountId || accountId.length > 512 || /\s/.test(accountId)) {
    throw new ChangeIntegrityTransitionError(
      "The advertiser account ID must be one bounded non-whitespace identifier.",
    );
  }
}

function snapshotFingerprint(snapshot: ChangeIntegritySnapshot) {
  return changeIntegrityFingerprint({
    projectionVersion: snapshot.projectionVersion,
    accountId: snapshot.accountId,
    observationStartedAt: snapshot.observationStartedAt,
    observedAt: snapshot.observedAt,
    resources: snapshot.resources,
  });
}

function serializedSnapshot(snapshot: ChangeIntegritySnapshot) {
  const serialized = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_SNAPSHOT_BYTES) {
    throw new ChangeIntegrityTransitionError(
      "The change-integrity snapshot exceeds the durable eight-megabyte limit.",
    );
  }
  return { serialized, bytes };
}

function parseStoredSnapshot(
  row: ChangeIntegrityStateRow,
  expectedAccountId: string,
) {
  const snapshot = changeIntegritySnapshotSchema.parse(row.snapshot_payload);
  if (
    row.projection_version !== CHANGE_INTEGRITY_PROJECTION_VERSION ||
    snapshot.accountId !== expectedAccountId ||
    snapshot.resources.length !== row.snapshot_resource_count ||
    Date.parse(snapshot.observedAt) !== row.observed_at.getTime() ||
    snapshotFingerprint(snapshot) !== row.snapshot_fingerprint.trim()
  ) {
    throw new ChangeIntegrityTransitionError(
      "The durable change-integrity baseline failed its integrity checks.",
    );
  }
  return snapshot;
}

function evidenceFromMutation(options: {
  row: ApprovalEvidenceRow;
  mode: "apply" | "rollback";
  certainty: "confirmed" | "indeterminate";
  uncertaintyReason: "provider_outcome" | "snapshot_timing" | null;
  occurredAt: Date;
}): ChangeIntegrityOperationEvidence | null {
  const parsedMutation = storedAdsMutationSchema.safeParse(
    options.mode === "apply"
      ? options.row.request_payload
      : options.row.rollback_payload,
  );
  if (!parsedMutation.success) return null;

  try {
    const parsedPath = parseAdsResourcePath(parsedMutation.data.path);
    if (parsedPath.entityId !== options.row.entity_id) return null;
    const expectedState = parsedPath.action
      ? { status: parsedPath.action === "activate" ? "active" : "paused" }
      : parsedMutation.data.body;
    if (!expectedState) return null;
    const resourceType =
      parsedPath.resource === "campaigns"
        ? "campaign"
        : parsedPath.resource === "ad_groups"
          ? "ad_group"
          : "ad";
    return changeIntegrityOperationEvidenceSchema.parse({
      approvalId: options.row.id,
      resourceType,
      resourceId: parsedPath.entityId,
      mode: options.mode,
      certainty: options.certainty,
      uncertaintyReason: options.uncertaintyReason,
      occurredAt: options.occurredAt.toISOString(),
      expectedState,
    });
  } catch {
    // A legacy or malformed mutation is not evidence that a change was made by
    // MaintainFlow. Conservatively leave the observed path unexplained.
    return null;
  }
}

function isWithinObservationWindow(
  value: Date | null,
  previous: Date,
  current: Date,
): boolean {
  return Boolean(value && value >= previous && value <= current);
}

export function changeIntegrityOperationEvidenceFromApprovalRows(options: {
  rows: ApprovalEvidenceRow[];
  evidenceWindowStartedAt: string;
  observationStartedAt: string;
  detectedAt: string;
}): ChangeIntegrityOperationEvidence[] {
  if (options.rows.length > MAX_APPROVAL_EVIDENCE_ROWS) {
    throw new ChangeIntegrityTransitionError(
      "The approval evidence between snapshots exceeds the bounded comparison limit.",
    );
  }
  const previous = new Date(options.evidenceWindowStartedAt);
  const observationStartedAt = new Date(options.observationStartedAt);
  const current = new Date(options.detectedAt);
  const evidence: ChangeIntegrityOperationEvidence[] = [];

  for (const row of options.rows) {
    if (isWithinObservationWindow(row.applied_at, previous, current)) {
      const overlapsObservation = row.applied_at! >= observationStartedAt;
      const operation = evidenceFromMutation({
        row,
        mode: "apply",
        certainty: overlapsObservation ? "indeterminate" : "confirmed",
        uncertaintyReason: overlapsObservation ? "snapshot_timing" : null,
        occurredAt: row.applied_at!,
      });
      if (operation) evidence.push(operation);
    } else if (
      isWithinObservationWindow(
        row.apply_provider_attempted_at,
        previous,
        current,
      ) &&
      row.status !== "failed" &&
      (!row.applied_at || row.applied_at > current)
    ) {
      const operation = evidenceFromMutation({
        row,
        mode: "apply",
        certainty: "indeterminate",
        uncertaintyReason: row.applied_at
          ? "snapshot_timing"
          : "provider_outcome",
        occurredAt: row.apply_provider_attempted_at!,
      });
      if (operation) evidence.push(operation);
    }

    if (isWithinObservationWindow(row.rolled_back_at, previous, current)) {
      const overlapsObservation = row.rolled_back_at! >= observationStartedAt;
      const operation = evidenceFromMutation({
        row,
        mode: "rollback",
        certainty: overlapsObservation ? "indeterminate" : "confirmed",
        uncertaintyReason: overlapsObservation ? "snapshot_timing" : null,
        occurredAt: row.rolled_back_at!,
      });
      if (operation) evidence.push(operation);
    } else if (
      isWithinObservationWindow(
        row.rollback_provider_attempted_at,
        previous,
        current,
      ) &&
      row.status !== "rollback_failed" &&
      (!row.rolled_back_at || row.rolled_back_at > current)
    ) {
      const operation = evidenceFromMutation({
        row,
        mode: "rollback",
        certainty: "indeterminate",
        uncertaintyReason: row.rolled_back_at
          ? "snapshot_timing"
          : "provider_outcome",
        occurredAt: row.rollback_provider_attempted_at!,
      });
      if (operation) evidence.push(operation);
    }
  }

  return z
    .array(changeIntegrityOperationEvidenceSchema)
    .max(MAX_APPROVAL_EVIDENCE_ROWS * 2)
    .parse(
      evidence.sort(
        (left, right) =>
          Date.parse(left.occurredAt) - Date.parse(right.occurredAt) ||
          left.approvalId.localeCompare(right.approvalId) ||
          left.mode.localeCompare(right.mode),
      ),
    );
}

async function loadOperationEvidence(options: {
  database: ChangeIntegrityDatabase;
  accountId: string;
  evidenceWindowStartedAt: string;
  observationStartedAt: string;
  detectedAt: string;
}) {
  const evidenceWindowStartedAt = new Date(options.evidenceWindowStartedAt);
  const detectedAt = new Date(options.detectedAt);
  const rows = await options.database<ApprovalEvidenceRow[]>`
    select
      approval.id,
      approval.entity_id,
      approval.status,
      approval.request_payload,
      approval.rollback_payload,
      approval.applied_at,
      approval.rolled_back_at,
      approval.apply_provider_attempted_at,
      approval.rollback_provider_attempted_at
    from public.ads_approval_records approval
    where approval.account_id = ${options.accountId}
      and (
        (
          approval.applied_at >= ${evidenceWindowStartedAt}
          and approval.applied_at <= ${detectedAt}
        )
        or (
          approval.rolled_back_at >= ${evidenceWindowStartedAt}
          and approval.rolled_back_at <= ${detectedAt}
        )
        or (
          approval.apply_provider_attempted_at >= ${evidenceWindowStartedAt}
          and approval.apply_provider_attempted_at <= ${detectedAt}
          and approval.status <> 'failed'
          and (
            approval.applied_at is null
            or approval.applied_at > ${detectedAt}
          )
        )
        or (
          approval.rollback_provider_attempted_at >= ${evidenceWindowStartedAt}
          and approval.rollback_provider_attempted_at <= ${detectedAt}
          and approval.status <> 'rollback_failed'
          and (
            approval.rolled_back_at is null
            or approval.rolled_back_at > ${detectedAt}
          )
        )
      )
    order by approval.created_at, approval.id
    limit ${MAX_APPROVAL_EVIDENCE_ROWS + 1}
  `;
  return changeIntegrityOperationEvidenceFromApprovalRows({
    rows,
    evidenceWindowStartedAt: options.evidenceWindowStartedAt,
    observationStartedAt: options.observationStartedAt,
    detectedAt: options.detectedAt,
  });
}

function eventRowToDto(row: ChangeIntegrityEventRow) {
  const candidate = changeIntegrityCandidateSchema.parse({
    eventFingerprint: row.event_fingerprint.trim(),
    accountId: row.external_account_id,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    parentResourceId: row.parent_resource_id,
    resourceLabel: row.resource_label,
    providerUpdatedAt:
      row.provider_updated_at === null
        ? null
        : Number(row.provider_updated_at),
    changeType: row.change_type,
    classification: row.classification,
    previousFingerprint: row.previous_fingerprint?.trim() ?? null,
    currentFingerprint: row.current_fingerprint?.trim() ?? null,
    previousConfiguration: row.previous_configuration,
    currentConfiguration: row.current_configuration,
    changedFieldPaths: row.changed_field_paths,
    explainedFieldPaths: row.explained_field_paths,
    indeterminateFieldPaths: row.indeterminate_field_paths,
    unexplainedFieldPaths: row.unexplained_field_paths,
    matchedOperations: row.matched_operations,
    baselineObservationStartedAt:
      row.baseline_observation_started_at.toISOString(),
    baselineObservedAt: row.baseline_observed_at.toISOString(),
    detectionStartedAt: row.detection_started_at.toISOString(),
    detectedAt: row.detected_at.toISOString(),
  });
  const { eventFingerprint: _eventFingerprint, accountId: _accountId, ...dto } =
    candidate;
  void _eventFingerprint;
  void _accountId;
  return changeIntegrityEventDtoSchema.parse({
    ...dto,
    id: row.id,
    reviewStatus: row.review_status,
    reviewedByName: row.reviewed_by_name,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
  });
}

const eventReturningColumns = `
  event.id,
  account.external_account_id,
  event.event_fingerprint,
  event.projection_version,
  event.resource_type,
  event.resource_id,
  event.parent_resource_id,
  event.resource_label,
  event.provider_updated_at,
  event.change_type,
  event.classification,
  event.previous_fingerprint,
  event.current_fingerprint,
  event.previous_configuration,
  event.current_configuration,
  event.changed_field_paths,
  event.explained_field_paths,
  event.indeterminate_field_paths,
  event.unexplained_field_paths,
  event.matched_operations,
  event.baseline_observation_started_at,
  event.baseline_observed_at,
  event.detection_started_at,
  event.detected_at,
  event.review_status,
  event.reviewed_by_name,
  event.review_note,
  event.reviewed_at
` as const;

async function insertCandidates(
  database: ChangeIntegrityDatabase,
  advertiserAccountId: string,
  externalAccountId: string,
  candidates: ChangeIntegrityCandidate[],
) {
  const inserted: ChangeIntegrityEventDto[] = [];
  for (
    let offset = 0;
    offset < candidates.length;
    offset += EVENT_INSERT_BATCH_SIZE
  ) {
    const rows = candidates
      .slice(offset, offset + EVENT_INSERT_BATCH_SIZE)
      .map((candidate) => ({
        id: randomUUID(),
        advertiser_account_id: advertiserAccountId,
        event_fingerprint: candidate.eventFingerprint,
        projection_version: CHANGE_INTEGRITY_PROJECTION_VERSION,
        resource_type: candidate.resourceType,
        resource_id: candidate.resourceId,
        parent_resource_id: candidate.parentResourceId,
        resource_label: candidate.resourceLabel,
        provider_updated_at: candidate.providerUpdatedAt,
        change_type: candidate.changeType,
        classification: candidate.classification,
        previous_fingerprint: candidate.previousFingerprint,
        current_fingerprint: candidate.currentFingerprint,
        previous_configuration: candidate.previousConfiguration,
        current_configuration: candidate.currentConfiguration,
        changed_field_paths: candidate.changedFieldPaths,
        explained_field_paths: candidate.explainedFieldPaths,
        indeterminate_field_paths: candidate.indeterminateFieldPaths,
        unexplained_field_paths: candidate.unexplainedFieldPaths,
        matched_operations: candidate.matchedOperations,
        baseline_observation_started_at:
          candidate.baselineObservationStartedAt,
        baseline_observed_at: candidate.baselineObservedAt,
        detection_started_at: candidate.detectionStartedAt,
        detected_at: candidate.detectedAt,
      }));
    const eventRows = await database<ChangeIntegrityEventRow[]>`
      with candidates as materialized (
        select *
        from pg_catalog.jsonb_to_recordset(
          ${database.json(rows as postgres.JSONValue)}
        ) as candidate(
          id uuid,
          advertiser_account_id uuid,
          event_fingerprint char(64),
          projection_version smallint,
          resource_type text,
          resource_id text,
          parent_resource_id text,
          resource_label text,
          provider_updated_at bigint,
          change_type text,
          classification text,
          previous_fingerprint char(64),
          current_fingerprint char(64),
          previous_configuration jsonb,
          current_configuration jsonb,
          changed_field_paths text[],
          explained_field_paths text[],
          indeterminate_field_paths text[],
          unexplained_field_paths text[],
          matched_operations jsonb,
          baseline_observation_started_at timestamptz,
          baseline_observed_at timestamptz,
          detection_started_at timestamptz,
          detected_at timestamptz
        )
      ),
      inserted as (
        insert into public.maintainflow_ads_config_integrity_events (
          id,
          advertiser_account_id,
          event_fingerprint,
          projection_version,
          resource_type,
          resource_id,
          parent_resource_id,
          resource_label,
          provider_updated_at,
          change_type,
          classification,
          previous_fingerprint,
          current_fingerprint,
          previous_configuration,
          current_configuration,
          changed_field_paths,
          explained_field_paths,
          indeterminate_field_paths,
          unexplained_field_paths,
          matched_operations,
          baseline_observation_started_at,
          baseline_observed_at,
          detection_started_at,
          detected_at
        )
        select
          id,
          advertiser_account_id,
          event_fingerprint,
          projection_version,
          resource_type,
          resource_id,
          parent_resource_id,
          resource_label,
          provider_updated_at,
          change_type,
          classification,
          previous_fingerprint,
          current_fingerprint,
          previous_configuration,
          current_configuration,
          changed_field_paths,
          explained_field_paths,
          indeterminate_field_paths,
          unexplained_field_paths,
          matched_operations,
          baseline_observation_started_at,
          baseline_observed_at,
          detection_started_at,
          detected_at
        from candidates
        on conflict (advertiser_account_id, event_fingerprint) do nothing
        returning *
      )
      select
        inserted.*,
        ${externalAccountId}::text as external_account_id
      from inserted
      order by inserted.detected_at, inserted.id
    `;
    inserted.push(...eventRows.map(eventRowToDto));
  }
  return inserted;
}

async function recordWithinDatabase(options: {
  database: ChangeIntegrityDatabase;
  snapshot: ChangeIntegritySnapshot;
  operations?: ChangeIntegrityOperationEvidence[];
}): Promise<RecordChangeIntegritySnapshotResult> {
  const snapshot = changeIntegritySnapshotSchema.parse(options.snapshot);
  validateAccountId(snapshot.accountId);
  const serialized = serializedSnapshot(snapshot);
  const currentFingerprint = snapshotFingerprint(snapshot);
  const observedAt = new Date(snapshot.observedAt);
  const [account] = await options.database<{ id: string }[]>`
    select account.id
    from public.maintainflow_advertiser_accounts account
    where account.external_account_id = ${snapshot.accountId}
      and account.status = 'active'
    for update
  `;
  if (!account) {
    throw new ChangeIntegrityStoreUnavailableError(
      "The active advertiser account is unavailable for change-integrity storage.",
    );
  }

  const [state] = await options.database<ChangeIntegrityStateRow[]>`
    select
      state.projection_version,
      state.snapshot_fingerprint,
      state.snapshot_payload,
      state.snapshot_resource_count,
      state.observed_at
    from public.maintainflow_ads_config_integrity_state state
    where state.advertiser_account_id = ${account.id}
    for update
  `;
  if (!state) {
    await options.database`
      insert into public.maintainflow_ads_config_integrity_state (
        advertiser_account_id,
        projection_version,
        snapshot_fingerprint,
        snapshot_payload,
        snapshot_resource_count,
        observed_at
      ) values (
        ${account.id},
        ${CHANGE_INTEGRITY_PROJECTION_VERSION},
        ${currentFingerprint},
        ${options.database.json(
          JSON.parse(serialized.serialized) as postgres.JSONValue,
        )},
        ${snapshot.resources.length},
        ${observedAt}
      )
    `;
    return { baselineCreated: true, baselineAdvanced: true, events: [] };
  }

  const previous = parseStoredSnapshot(state, snapshot.accountId);
  if (observedAt < state.observed_at) throw new ChangeIntegritySnapshotOrderError();
  if (observedAt.getTime() === state.observed_at.getTime()) {
    if (currentFingerprint !== state.snapshot_fingerprint.trim()) {
      throw new ChangeIntegritySnapshotOrderError(
        "A different change-integrity snapshot already exists for this observation time.",
      );
    }
    return { baselineCreated: false, baselineAdvanced: false, events: [] };
  }

  const operations = options.operations
    ? z
        .array(changeIntegrityOperationEvidenceSchema)
        .max(MAX_APPROVAL_EVIDENCE_ROWS * 2)
        .parse(options.operations)
    : await loadOperationEvidence({
        database: options.database,
        accountId: snapshot.accountId,
        evidenceWindowStartedAt: previous.observationStartedAt,
        observationStartedAt: snapshot.observationStartedAt,
        detectedAt: snapshot.observedAt,
      });
  const candidates = compareChangeIntegritySnapshots({
    previous,
    current: snapshot,
    operations,
  });
  const events = await insertCandidates(
    options.database,
    account.id,
    snapshot.accountId,
    candidates,
  );

  await options.database`
    update public.maintainflow_ads_config_integrity_state set
      projection_version = ${CHANGE_INTEGRITY_PROJECTION_VERSION},
      snapshot_fingerprint = ${currentFingerprint},
      snapshot_payload = ${options.database.json(
        JSON.parse(serialized.serialized) as postgres.JSONValue,
      )},
      snapshot_resource_count = ${snapshot.resources.length},
      observed_at = ${observedAt},
      updated_at = pg_catalog.statement_timestamp()
    where advertiser_account_id = ${account.id}
  `;
  return { baselineCreated: false, baselineAdvanced: true, events };
}

export async function recordChangeIntegritySnapshot(
  options: {
    snapshot: ChangeIntegritySnapshot;
    operations?: ChangeIntegrityOperationEvidence[];
  },
  database?: Sql | postgres.TransactionSql,
) {
  if (database) {
    if ("begin" in database && typeof database.begin === "function") {
      return database.begin((transaction) =>
        recordWithinDatabase({ ...options, database: transaction }),
      );
    }
    return recordWithinDatabase({
      ...options,
      database: database as postgres.TransactionSql,
    });
  }
  const sql = getDatabase();
  return sql.begin((transaction) =>
    recordWithinDatabase({ ...options, database: transaction }),
  );
}

export async function verifyChangeIntegrityStore(
  database?: Sql | postgres.TransactionSql,
) {
  if (!database && !process.env.DATABASE_URL) return false;
  const sql = database ?? getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass(
        'public.maintainflow_ads_config_integrity_state'
      ) is not null
      and to_regclass(
        'public.maintainflow_ads_config_integrity_events'
      ) is not null
      and to_regclass(
        'public.maintainflow_ads_config_integrity_events_account_idx'
      ) is not null
      and to_regclass(
        'public.maintainflow_ads_config_integrity_events_open_idx'
      ) is not null
      and to_regprocedure(
        'public.maintainflow_enforce_ads_config_integrity_event()'
      ) is not null
      and exists (
        select 1
        from pg_catalog.pg_trigger integrity_trigger
        join pg_catalog.pg_class integrity_table
          on integrity_table.oid = integrity_trigger.tgrelid
        join pg_catalog.pg_namespace integrity_namespace
          on integrity_namespace.oid = integrity_table.relnamespace
        where integrity_trigger.tgname =
          'maintainflow_ads_config_integrity_event_guard'
          and integrity_namespace.nspname = 'public'
          and integrity_table.relname =
            'maintainflow_ads_config_integrity_events'
          and integrity_trigger.tgfoid = to_regprocedure(
            'public.maintainflow_enforce_ads_config_integrity_event()'
          )
          and not integrity_trigger.tgisinternal
          and integrity_trigger.tgenabled in ('O', 'A')
          and (integrity_trigger.tgtype & 1) = 1
          and (integrity_trigger.tgtype & 2) = 2
          and (integrity_trigger.tgtype & 4) = 4
          and (integrity_trigger.tgtype & 16) = 16
      )
    ) as ready
  `;
  return result?.ready === true;
}

export async function listChangeIntegrityEvents(
  options: {
    accountId: string;
    limit?: number;
    reviewStatus?: ChangeIntegrityEventDto["reviewStatus"];
    cursor?: {
      reviewStatus: ChangeIntegrityEventDto["reviewStatus"];
      detectedAt: string;
      id: string;
    };
  },
  database?: Sql | postgres.TransactionSql,
): Promise<ChangeIntegrityEventPage> {
  validateAccountId(options.accountId);
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ChangeIntegrityTransitionError(
      "Change-integrity event limit must be between 1 and 100.",
    );
  }
  const reviewStatus = options.reviewStatus
    ? changeIntegrityReviewStatusSchema.parse(options.reviewStatus)
    : null;
  const cursor = options.cursor
    ? z
        .object({
          reviewStatus: changeIntegrityReviewStatusSchema,
          detectedAt: z.string().datetime(),
          id: z.string().uuid(),
        })
        .strict()
        .parse(options.cursor)
    : null;
  const cursorOpen = cursor ? cursor.reviewStatus === "open" : null;
  const cursorDetectedAt = cursor ? new Date(cursor.detectedAt) : null;
  const cursorId = cursor?.id ?? null;
  const sql = (database ?? getDatabase()) as postgres.TransactionSql;
  const [baseline] = await sql<{ observed_at: Date }[]>`
    select state.observed_at
    from public.maintainflow_ads_config_integrity_state state
    join public.maintainflow_advertiser_accounts account
      on account.id = state.advertiser_account_id
    where account.external_account_id = ${options.accountId}
      and account.status = 'active'
  `;
  const [summary] = await sql<ChangeIntegritySummaryRow[]>`
    select
      count(*)::int as retained_event_count,
      count(*) filter (
        where event.review_status = 'open'
          and event.classification = 'unexplained'
      )::int as open_unexplained_count,
      count(*) filter (
        where event.review_status = 'open'
          and event.classification = 'indeterminate'
      )::int as open_indeterminate_count,
      count(*) filter (
        where event.classification = 'maintainflow_consistent'
      )::int as consistent_count,
      count(*) filter (
        where event.review_status = 'reviewed'
      )::int as reviewed_count
    from public.maintainflow_ads_config_integrity_events event
    join public.maintainflow_advertiser_accounts account
      on account.id = event.advertiser_account_id
    where account.external_account_id = ${options.accountId}
      and account.status = 'active'
  `;
  const rows = await sql<ChangeIntegrityEventRow[]>`
    select ${sql.unsafe(eventReturningColumns)}
    from public.maintainflow_ads_config_integrity_events event
    join public.maintainflow_advertiser_accounts account
      on account.id = event.advertiser_account_id
    where account.external_account_id = ${options.accountId}
      and account.status = 'active'
      and (
        ${reviewStatus}::text is null
        or event.review_status = ${reviewStatus}
      )
      and (
        ${cursorDetectedAt}::timestamptz is null
        or (event.review_status = 'open') < ${cursorOpen}::boolean
        or (
          (event.review_status = 'open') = ${cursorOpen}::boolean
          and (event.detected_at, event.id) < (
            ${cursorDetectedAt}::timestamptz,
            ${cursorId}::uuid
          )
        )
      )
    order by
      (event.review_status = 'open') desc,
      event.detected_at desc,
      event.id desc
    limit ${limit + 1}
  `;
  return changeIntegrityEventPageSchema.parse({
    events: rows.slice(0, limit).map(eventRowToDto),
    hasMore: rows.length > limit,
    summary: {
      baselineReady: Boolean(baseline),
      lastCheckedAt: baseline?.observed_at.toISOString() ?? null,
      retainedEventCount: summary?.retained_event_count ?? 0,
      openUnexplainedCount: summary?.open_unexplained_count ?? 0,
      openIndeterminateCount: summary?.open_indeterminate_count ?? 0,
      consistentCount: summary?.consistent_count ?? 0,
      reviewedCount: summary?.reviewed_count ?? 0,
    },
  });
}

const reviewerNameSchema = z.string().trim().min(1).max(120);
const reviewNoteSchema = z.string().trim().min(10).max(1_000);

type AcknowledgeChangeIntegrityEventOptions = {
  accountId: string;
  eventId: string;
  operatorId: string;
  reviewerName: string;
  access: AccountAccess;
  note: string;
};

async function acknowledgeWithinDatabase(
  options: AcknowledgeChangeIntegrityEventOptions,
  database: postgres.TransactionSql,
) {
  let advertiserAccountId: string;
  try {
    const authorized = await lockCurrentAccountWriteAccess({
      transaction: database,
      operatorId: options.operatorId,
      accountId: options.accountId,
      access: options.access,
      forbiddenMessage:
        "Current advertiser write authority is required to review an integrity event",
    });
    advertiserAccountId = authorized.advertiserAccountId;
  } catch (error) {
    if (
      error instanceof AccountAccessForbiddenError ||
      isDatabaseAuthorizationChangedError(error)
    ) {
      throw new ChangeIntegrityAuthorizationError();
    }
    throw error;
  }

  let rows: ChangeIntegrityEventRow[];
  try {
    rows = await database<ChangeIntegrityEventRow[]>`
      update public.maintainflow_ads_config_integrity_events event set
        review_status = 'reviewed',
        reviewed_by_operator_id = ${options.operatorId},
        reviewed_by_name = ${options.reviewerName},
        reviewed_by_organization_id = ${options.access.organizationId},
        review_note = ${options.note}
      from public.maintainflow_advertiser_accounts account
      where event.id = ${options.eventId}
        and event.advertiser_account_id = ${advertiserAccountId}
        and event.advertiser_account_id = account.id
        and account.external_account_id = ${options.accountId}
        and account.status = 'active'
        and event.review_status = 'open'
      returning ${database.unsafe(eventReturningColumns)}
    `;
  } catch (error) {
    if (isDatabaseAuthorizationChangedError(error)) {
      throw new ChangeIntegrityAuthorizationError();
    }
    throw error;
  }
  const [row] = rows;
  if (!row) {
    throw new ChangeIntegrityTransitionError(
      "This open change-integrity event was not found in the connected account.",
    );
  }
  return eventRowToDto(row);
}

export async function acknowledgeChangeIntegrityEvent(
  options: AcknowledgeChangeIntegrityEventOptions,
  database?: Sql | postgres.TransactionSql,
) {
  validateAccountId(options.accountId);
  const eventId = z.string().uuid().parse(options.eventId);
  const reviewerName = reviewerNameSchema.parse(options.reviewerName);
  const note = reviewNoteSchema.parse(options.note);
  if (
    options.access.accountId !== options.accountId ||
    !canWriteAccount(options.access)
  ) {
    throw new ChangeIntegrityTransitionError(
      "Current account manager or owner access is required to review an integrity event.",
    );
  }
  const validatedOptions = {
    ...options,
    eventId,
    reviewerName,
    note,
  };
  if (database) {
    if ("begin" in database && typeof database.begin === "function") {
      return database.begin((transaction) =>
        acknowledgeWithinDatabase(validatedOptions, transaction),
      );
    }
    return acknowledgeWithinDatabase(
      validatedOptions,
      database as postgres.TransactionSql,
    );
  }
  const sql = getDatabase();
  return sql.begin((transaction) =>
    acknowledgeWithinDatabase(validatedOptions, transaction),
  );
}
