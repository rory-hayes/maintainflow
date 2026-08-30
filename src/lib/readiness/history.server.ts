import "server-only";

import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";

import { canWriteAccount, type AccountAccess } from "../tenancy/schema";
import {
  READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION,
  READINESS_HISTORY_RULESET_VERSION,
  READINESS_HISTORY_SCANNER_VERSION,
  READINESS_HISTORY_SOURCE_CHECKED_AT,
  readinessAuditHistoryEntrySchema,
  sanitizeReadinessAuditForHistory,
  type ReadinessAuditHistoryEntry,
} from "./history";
import type { ReadinessAudit } from "./schema";

type ReadinessAuditHistoryRow = {
  id: string;
  external_account_id: string;
  audit_payload: unknown;
  payload_schema_version: number;
  ruleset_version: string;
  scanner_version: string;
  source_checked_at: string;
  target_association: "manual_unverified" | "provider_destination";
  provider_resource_type: "campaign" | "ad_group" | "ad" | null;
  provider_resource_id: string | null;
  query_parameters_redacted: boolean;
  created_at: Date;
};

let database: Sql | undefined;

export class ReadinessHistoryStoreUnavailableError extends Error {
  constructor(message = "Readiness history storage is not configured.") {
    super(message);
    this.name = "ReadinessHistoryStoreUnavailableError";
  }
}

export class ReadinessHistoryTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadinessHistoryTransitionError";
  }
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new ReadinessHistoryStoreUnavailableError();

  database ??= postgres(connectionString, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 2,
    prepare: false,
  });
  return database;
}

function parseHistoryRow(
  row: ReadinessAuditHistoryRow,
): ReadinessAuditHistoryEntry {
  return readinessAuditHistoryEntrySchema.parse({
    id: row.id,
    accountId: row.external_account_id,
    audit: row.audit_payload,
    payloadSchemaVersion: row.payload_schema_version,
    rulesetVersion: row.ruleset_version,
    scannerVersion: row.scanner_version,
    sourceCheckedAt: row.source_checked_at,
    targetAssociation: {
      type: row.target_association,
      providerResourceType: row.provider_resource_type,
      providerResourceId: row.provider_resource_id,
    },
    queryParametersRedacted: row.query_parameters_redacted,
    recordedAt: row.created_at.toISOString(),
  });
}

export async function verifyReadinessHistoryStore() {
  if (!process.env.DATABASE_URL) return false;
  const sql = getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_readiness_audit_runs') is not null
      and to_regclass(
        'public.maintainflow_readiness_audit_runs_account_idx'
      ) is not null
      and to_regclass(
        'public.maintainflow_readiness_audit_runs_actor_org_idx'
      ) is not null
    ) as ready
  `;
  return result?.ready === true;
}

export async function recordReadinessAuditRun(options: {
  accountId: string;
  operatorId: string;
  access: AccountAccess;
  audit: ReadinessAudit;
}) {
  if (
    options.access.accountId !== options.accountId ||
    !canWriteAccount(options.access)
  ) {
    throw new ReadinessHistoryTransitionError(
      "Account manager or owner access is required to save readiness history.",
    );
  }
  const sanitized = sanitizeReadinessAuditForHistory(options.audit);
  const audit = sanitized.audit;
  const sql = getDatabase();
  const id = randomUUID();
  const rows = await sql<ReadinessAuditHistoryRow[]>`
    insert into maintainflow_readiness_audit_runs (
      id,
      advertiser_account_id,
      operator_id,
      acting_organization_id,
      actor_membership_role,
      actor_account_role,
      payload_schema_version,
      ruleset_version,
      scanner_version,
      source_checked_at,
      target_association,
      provider_resource_type,
      provider_resource_id,
      query_parameters_redacted,
      requested_url,
      final_url,
      scanned_at,
      score,
      verdict,
      audit_payload
    )
    select
      ${id},
      account.id,
      ${options.operatorId},
      membership.organization_id,
      membership.role,
      account_access.role,
      ${READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION},
      ${READINESS_HISTORY_RULESET_VERSION},
      ${READINESS_HISTORY_SCANNER_VERSION},
      ${READINESS_HISTORY_SOURCE_CHECKED_AT},
      'manual_unverified',
      null,
      null,
      ${sanitized.queryParametersRedacted},
      ${audit.requestedUrl},
      ${audit.finalUrl},
      ${audit.scannedAt},
      ${audit.score},
      ${audit.verdict},
      ${sql.json(audit as postgres.JSONValue)}
    from maintainflow_advertiser_accounts account
    join maintainflow_account_access account_access
      on account_access.advertiser_account_id = account.id
      and account_access.organization_id = ${options.access.organizationId}
      and account_access.role in ('owner', 'manager')
    join maintainflow_organization_memberships membership
      on membership.organization_id = account_access.organization_id
      and membership.clerk_user_id = ${options.operatorId}
      and membership.role in ('owner', 'admin')
    join maintainflow_organizations organization
      on organization.id = membership.organization_id
      and organization.status = 'active'
    where account.external_account_id = ${options.accountId}
      and account.status = 'active'
    returning
      id,
      ${options.accountId}::text as external_account_id,
      audit_payload,
      payload_schema_version,
      ruleset_version,
      scanner_version,
      source_checked_at::text,
      target_association,
      provider_resource_type,
      provider_resource_id,
      query_parameters_redacted,
      created_at
  `;
  const [inserted] = rows;
  if (!inserted) {
    throw new ReadinessHistoryTransitionError(
      "Account write access changed before the readiness audit could be saved.",
    );
  }
  return parseHistoryRow(inserted);
}

export async function listReadinessAuditRuns(options: {
  accountId: string;
  operatorId: string;
  access: Pick<AccountAccess, "organizationId" | "accountId">;
  limit?: number;
}) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ReadinessHistoryTransitionError(
      "Readiness history limit must be between 1 and 50.",
    );
  }
  const sql = getDatabase();
  const rows = await sql<ReadinessAuditHistoryRow[]>`
    select
      run.id,
      account.external_account_id,
      run.audit_payload,
      run.payload_schema_version,
      run.ruleset_version,
      run.scanner_version,
      run.source_checked_at::text,
      run.target_association,
      run.provider_resource_type,
      run.provider_resource_id,
      run.query_parameters_redacted,
      run.created_at
    from maintainflow_readiness_audit_runs run
    join maintainflow_advertiser_accounts account
      on account.id = run.advertiser_account_id
    where account.external_account_id = ${options.accountId}
      and account.status = 'active'
      and account.external_account_id = ${options.access.accountId}
      and exists (
        select 1
        from maintainflow_account_access account_access
        join maintainflow_organization_memberships membership
          on membership.organization_id = account_access.organization_id
          and membership.clerk_user_id = ${options.operatorId}
        join maintainflow_organizations organization
          on organization.id = membership.organization_id
          and organization.status = 'active'
        where account_access.advertiser_account_id = account.id
          and account_access.organization_id = ${options.access.organizationId}
      )
    order by run.created_at desc, run.id desc
    limit ${limit}
  `;
  return rows.map(parseHistoryRow);
}
