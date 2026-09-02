import { createHash, timingSafeEqual } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const EVIDENCE_SCHEMA_VERSION = "maintainflow.customer-lifecycle-evidence.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_REFERENCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,254}$/;
const UNRESOLVED_APPROVAL_STATUSES = [
  "pending",
  "reconciliation_required",
  "rollback_pending",
  "rollback_failed",
  "rollback_reconciliation_required",
];

export const RETENTION_PURGE_LIMITS = Object.freeze({
  accessGrants: 100,
  advertiserCredentials: 100,
  conversionCredentials: 100,
  approvals: 10_000,
  creativeReviewState: 100_000,
  creativeReviewEvents: 100_000,
  recommendationDecisions: 100_000,
  readinessAudits: 10_000,
  liveWorkbenchSnapshots: 100,
  monitoringAccountSchedules: 1,
});

export class CustomerLifecycleSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CustomerLifecycleSafetyError";
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeForJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) {
    throw new CustomerLifecycleSafetyError(
      "Lifecycle evidence must not contain binary data.",
    );
  }
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizeForJson(nested)]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(normalizeForJson(value));
}

function requiredSingleValue(values, name) {
  if (values.length !== 1 || !values[0]) {
    throw new CustomerLifecycleSafetyError(
      `${name} must be supplied exactly once.`,
    );
  }
  return values[0];
}

function exactIsoDate(value, name) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new CustomerLifecycleSafetyError(
      `${name} must be an exact UTC ISO-8601 timestamp including milliseconds.`,
    );
  }
  return parsed;
}

function parseValues(argv, allowedValueFlags) {
  const values = new Map();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (apply) {
        throw new CustomerLifecycleSafetyError(
          "--apply may be supplied only once.",
        );
      }
      apply = true;
      continue;
    }
    if (!allowedValueFlags.has(argument)) {
      throw new CustomerLifecycleSafetyError(
        `Unknown or positional argument: ${argument ?? "<empty>"}.`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CustomerLifecycleSafetyError(
        `${argument} requires one value.`,
      );
    }
    const existing = values.get(argument) ?? [];
    existing.push(value);
    values.set(argument, existing);
    index += 1;
  }
  return { values, apply };
}

export function parseCustomerLifecycleArgs(argv) {
  const [operation, ...operationArguments] = argv;
  if (!new Set(["confirm-revocation", "purge-retention"]).has(operation)) {
    throw new CustomerLifecycleSafetyError(
      "The lifecycle operation must be confirm-revocation or purge-retention.",
    );
  }
  const allowedValueFlags = new Set([
    "--lifecycle-id",
    "--evidence-file",
    "--confirm",
    ...(operation === "confirm-revocation"
      ? ["--provider-revoked-at", "--evidence-ref", "--retain-until"]
      : []),
  ]);
  const { values, apply } = parseValues(
    operationArguments,
    allowedValueFlags,
  );

  const lifecycleId = requiredSingleValue(
    values.get("--lifecycle-id") ?? [],
    "--lifecycle-id",
  );
  if (!UUID_PATTERN.test(lifecycleId)) {
    throw new CustomerLifecycleSafetyError(
      "--lifecycle-id must be one exact UUID.",
    );
  }
  const evidenceFile = requiredSingleValue(
    values.get("--evidence-file") ?? [],
    "--evidence-file",
  );
  if (!path.isAbsolute(evidenceFile)) {
    throw new CustomerLifecycleSafetyError(
      "--evidence-file must be an absolute path to a new file.",
    );
  }
  const confirmations = values.get("--confirm") ?? [];
  if (apply && confirmations.length !== 1) {
    throw new CustomerLifecycleSafetyError(
      "Apply requires one --confirm token from a current dry run.",
    );
  }
  if (!apply && confirmations.length > 0) {
    throw new CustomerLifecycleSafetyError(
      "--confirm is accepted only together with --apply.",
    );
  }

  const common = {
    operation,
    mode: apply ? "apply" : "dry-run",
    lifecycleId: lifecycleId.toLowerCase(),
    evidenceFile,
    confirmationToken: confirmations[0] ?? null,
  };
  if (operation === "purge-retention") return common;

  const evidenceReference = requiredSingleValue(
    values.get("--evidence-ref") ?? [],
    "--evidence-ref",
  );
  if (!EVIDENCE_REFERENCE_PATTERN.test(evidenceReference)) {
    throw new CustomerLifecycleSafetyError(
      "--evidence-ref must be an opaque 8-255 character external evidence reference without whitespace.",
    );
  }
  return {
    ...common,
    providerRevokedAt: exactIsoDate(
      requiredSingleValue(
        values.get("--provider-revoked-at") ?? [],
        "--provider-revoked-at",
      ),
      "--provider-revoked-at",
    ),
    evidenceReference,
    retainUntil: exactIsoDate(
      requiredSingleValue(
        values.get("--retain-until") ?? [],
        "--retain-until",
      ),
      "--retain-until",
    ),
  };
}

function confirmationMatches(expected, received) {
  if (typeof received !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function lifecycleFingerprint(lifecycleId) {
  return sha256(`maintainflow-customer-lifecycle:${lifecycleId}`);
}

function revocationConfirmationToken(record, options) {
  return `RECORD-EXTERNAL-REVOCATION:${sha256(
    canonicalJson({
      lifecycleId: record.id,
      advertiserAccountId: record.advertiser_account_id,
      externalAccountId: record.external_account_id,
      stateFingerprint: record.state_fingerprint,
      providerRevokedAt: options.providerRevokedAt,
      evidenceReference: options.evidenceReference,
      retainUntil: options.retainUntil,
    }),
  )}`;
}

function purgeConfirmationToken(record, inventory) {
  return `PURGE-RETAINED-DATA:${sha256(
    canonicalJson({
      lifecycleId: record.id,
      advertiserAccountId: record.advertiser_account_id,
      externalAccountId: record.external_account_id,
      stateFingerprint: record.state_fingerprint,
      exportSha256: record.export_sha256,
      providerRevokedAt: record.provider_revoked_at,
      providerRevocationConfirmedAt: record.provider_revocation_confirmed_at,
      providerEvidenceRef: record.provider_revocation_evidence_ref,
      retainUntil: record.retain_until,
      inventory,
    }),
  )}`;
}

function prepareSerializedEvidence(document, sensitiveValues) {
  const serialized = `${JSON.stringify(normalizeForJson(document), null, 2)}\n`;
  for (const value of sensitiveValues) {
    if (
      (typeof value === "string" || typeof value === "number") &&
      String(value).length > 0 &&
      serialized.includes(String(value))
    ) {
      throw new CustomerLifecycleSafetyError(
        "Lifecycle evidence unexpectedly contained a customer or operator identifier.",
      );
    }
  }
  if (
    /"(?:api[_-]?key|credential|ciphertext|password|secret|token)"\s*:/i.test(
      serialized,
    )
  ) {
    throw new CustomerLifecycleSafetyError(
      "Lifecycle evidence unexpectedly contained secret-bearing fields.",
    );
  }
  return { serialized, sha256: sha256(serialized) };
}

async function loadLifecycleRecord(sql, lifecycleId, { lock = false } = {}) {
  const rows = lock
    ? await sql`
        select id, advertiser_account_id, external_account_id,
          acting_organization_id, operator_id, action, state_fingerprint,
          export_sha256, inventory_counts, provider_revocation_required,
          completed_at, provider_revoked_at,
          provider_revocation_confirmed_at,
          provider_revocation_evidence_ref,
          provider_revocation_confirmation_sha256, retain_until,
          purge_completed_at, purge_evidence_sha256
        from maintainflow_customer_lifecycle_records
        where id = ${lifecycleId}
        for update
      `
    : await sql`
        select id, advertiser_account_id, external_account_id,
          acting_organization_id, operator_id, action, state_fingerprint,
          export_sha256, inventory_counts, provider_revocation_required,
          completed_at, provider_revoked_at,
          provider_revocation_confirmed_at,
          provider_revocation_evidence_ref,
          provider_revocation_confirmation_sha256, retain_until,
          purge_completed_at, purge_evidence_sha256
        from maintainflow_customer_lifecycle_records
        where id = ${lifecycleId}
      `;
  if (rows.length !== 1) {
    throw new CustomerLifecycleSafetyError(
      "The exact customer lifecycle target could not be resolved uniquely.",
    );
  }
  return rows[0];
}

async function loadAccount(sql, advertiserAccountId, { lock = false } = {}) {
  if (!advertiserAccountId) {
    throw new CustomerLifecycleSafetyError(
      "The lifecycle target has already been de-identified by a completed purge.",
    );
  }
  const rows = lock
    ? await sql`
        select id, external_account_id, status
        from maintainflow_advertiser_accounts
        where id = ${advertiserAccountId}
        for update
      `
    : await sql`
        select id, external_account_id, status
        from maintainflow_advertiser_accounts
        where id = ${advertiserAccountId}
      `;
  if (rows.length !== 1) {
    throw new CustomerLifecycleSafetyError(
      "The disconnected advertiser account for this lifecycle record is missing.",
    );
  }
  return rows[0];
}

function recordSensitiveValues(record) {
  return [
    record.id,
    record.advertiser_account_id,
    record.external_account_id,
    record.acting_organization_id,
    record.operator_id,
    record.provider_revocation_evidence_ref,
  ];
}

function buildRevocationPlan(record, account, options) {
  const now = options.confirmedAt ?? new Date();
  const blockers = [];
  if (record.action !== "offboarded" || account.status !== "disconnected") {
    blockers.push("The account has not completed the transactional offboarding step.");
  }
  if (
    record.purge_completed_at ||
    !record.advertiser_account_id ||
    !record.external_account_id
  ) {
    blockers.push("The retained customer data has already been purged.");
  }
  if (!record.provider_revocation_required) {
    blockers.push("External provider revocation has already been recorded.");
  }
  if (options.providerRevokedAt.getTime() > now.getTime()) {
    blockers.push("The external provider revocation time cannot be in the future.");
  }
  if (options.retainUntil.getTime() < record.completed_at.getTime()) {
    blockers.push("The retention deadline cannot precede completed offboarding.");
  }

  const evidenceReferenceSha256 = sha256(options.evidenceReference);
  const document = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    operation: "provider_revocation_confirmation",
    generatedAt: now,
    lifecycleFingerprint: lifecycleFingerprint(record.id),
    offboardingStateFingerprint: record.state_fingerprint,
    providerAction: "completed_externally_no_provider_api_call",
    providerRevokedAt: options.providerRevokedAt,
    providerEvidenceReferenceSha256: evidenceReferenceSha256,
    retainUntil: options.retainUntil,
    blockers,
  };
  const preparedEvidence = prepareSerializedEvidence(document, [
    ...recordSensitiveValues(record),
    options.evidenceReference,
  ]);
  return {
    blockers,
    confirmationToken:
      blockers.length === 0 ? revocationConfirmationToken(record, options) : null,
    evidenceReferenceSha256,
    document,
    serializedEvidence: preparedEvidence.serialized,
    evidenceSha256: preparedEvidence.sha256,
  };
}

export async function prepareProviderRevocationConfirmation(sql, options) {
  return sql.begin(async (transaction) => {
    await transaction`set transaction read only`;
    const record = await loadLifecycleRecord(transaction, options.lifecycleId);
    const account = await loadAccount(transaction, record.advertiser_account_id);
    return buildRevocationPlan(record, account, options);
  });
}

export async function applyProviderRevocationConfirmation(sql, options) {
  if (typeof options.writeValidatedEvidence !== "function") {
    throw new CustomerLifecycleSafetyError(
      "A validated evidence writer is required before recording provider revocation.",
    );
  }
  const confirmedAt = options.confirmedAt ?? new Date();
  const effectiveOptions = { ...options, confirmedAt };
  return sql.begin(async (transaction) => {
    await transaction`set local lock_timeout = '5s'`;
    await transaction`set local statement_timeout = '30s'`;
    const initial = await loadLifecycleRecord(transaction, options.lifecycleId);
    const account = await loadAccount(
      transaction,
      initial.advertiser_account_id,
      { lock: true },
    );
    const record = await loadLifecycleRecord(transaction, options.lifecycleId, {
      lock: true,
    });
    if (
      record.advertiser_account_id !== account.id ||
      record.external_account_id !== account.external_account_id
    ) {
      throw new CustomerLifecycleSafetyError(
        "The locked lifecycle target no longer matches its advertiser account.",
      );
    }
    const plan = buildRevocationPlan(record, account, effectiveOptions);
    if (plan.blockers.length > 0) {
      throw new CustomerLifecycleSafetyError(plan.blockers.join(" "));
    }
    if (!confirmationMatches(plan.confirmationToken, options.confirmationToken)) {
      throw new CustomerLifecycleSafetyError(
        "The confirmation token does not match the current revocation evidence. Run a new dry run.",
      );
    }
    await options.writeValidatedEvidence({
      document: plan.document,
      serialized: plan.serializedEvidence,
      sha256: plan.evidenceSha256,
    });
    const updated = await transaction`
      update maintainflow_customer_lifecycle_records set
        provider_revocation_required = false,
        provider_revoked_at = ${effectiveOptions.providerRevokedAt},
        provider_revocation_confirmed_at = ${confirmedAt},
        provider_revocation_evidence_ref = ${effectiveOptions.evidenceReference},
        provider_revocation_confirmation_sha256 = ${plan.evidenceSha256},
        retain_until = ${effectiveOptions.retainUntil}
      where id = ${record.id}
        and provider_revocation_required
        and purge_completed_at is null
      returning id
    `;
    if (updated.length !== 1) {
      throw new CustomerLifecycleSafetyError(
        "The revocation lifecycle state changed before completion; the transaction was rolled back.",
      );
    }
    return {
      lifecycleFingerprint: lifecycleFingerprint(record.id),
      evidenceSha256: plan.evidenceSha256,
      providerRevokedAt: effectiveOptions.providerRevokedAt,
      retainUntil: effectiveOptions.retainUntil,
    };
  });
}

async function loadBoundedPurgeInventory(sql, record) {
  const accountId = record.advertiser_account_id;
  const externalAccountId = record.external_account_id;
  const [counts] = await sql`
    select
      (select count(*)::int from (
        select 1 from maintainflow_account_access
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.accessGrants + 1}
      ) rows) as access_grants,
      (select count(*)::int from (
        select 1 from maintainflow_advertiser_credentials
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.advertiserCredentials + 1}
      ) rows) as advertiser_credentials,
      (select count(*)::int from (
        select 1 from maintainflow_conversion_credentials
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.conversionCredentials + 1}
      ) rows) as conversion_credentials,
      (select count(*)::int from (
        select 1 from ads_approval_records
        where account_id = ${externalAccountId}
        limit ${RETENTION_PURGE_LIMITS.approvals + 1}
      ) rows) as approvals,
      (select count(*)::int from (
        select 1 from maintainflow_creative_review_state
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.creativeReviewState + 1}
      ) rows) as creative_review_state,
      (select count(*)::int from (
        select 1 from maintainflow_creative_review_events
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.creativeReviewEvents + 1}
      ) rows) as creative_review_events,
      (select count(*)::int from (
        select 1 from maintainflow_recommendation_dismissals
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.recommendationDecisions + 1}
      ) rows) as recommendation_decisions,
      (select count(*)::int from (
        select 1 from maintainflow_readiness_audit_runs
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.readinessAudits + 1}
      ) rows) as readiness_audits,
      (select count(*)::int from (
        select 1 from maintainflow_live_workbench_snapshots
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.liveWorkbenchSnapshots + 1}
      ) rows) as live_workbench_snapshots,
      (select count(*)::int from (
        select 1 from maintainflow_monitoring_account_schedule
        where advertiser_account_id = ${accountId}
        limit ${RETENTION_PURGE_LIMITS.monitoringAccountSchedules + 1}
      ) rows) as monitoring_account_schedules,
      (select count(*)::int from (
        select 1 from ads_approval_records
        where account_id = ${externalAccountId}
          and status in ${sql(UNRESOLVED_APPROVAL_STATUSES)}
        limit 2
      ) rows) as unresolved_approvals
  `;
  return {
    accessGrants: counts.access_grants,
    advertiserCredentials: counts.advertiser_credentials,
    conversionCredentials: counts.conversion_credentials,
    approvals: counts.approvals,
    creativeReviewState: counts.creative_review_state,
    creativeReviewEvents: counts.creative_review_events,
    recommendationDecisions: counts.recommendation_decisions,
    readinessAudits: counts.readiness_audits,
    liveWorkbenchSnapshots: counts.live_workbench_snapshots,
    monitoringAccountSchedules: counts.monitoring_account_schedules,
    unresolvedApprovals: counts.unresolved_approvals,
  };
}

function buildPurgePlan(record, account, inventory, options) {
  const now = options.now ?? new Date();
  const blockers = [];
  if (record.action !== "offboarded" || account.status !== "disconnected") {
    blockers.push("The account has not completed the transactional offboarding step.");
  }
  if (record.purge_completed_at) {
    blockers.push("The retained customer data has already been purged.");
  }
  if (
    record.provider_revocation_required ||
    !record.provider_revoked_at ||
    !record.provider_revocation_confirmed_at ||
    !record.provider_revocation_evidence_ref ||
    !record.provider_revocation_confirmation_sha256
  ) {
    blockers.push(
      "Externally completed provider revocation has not been recorded with evidence.",
    );
  }
  if (
    !(record.retain_until instanceof Date) ||
    !Number.isFinite(record.retain_until.getTime())
  ) {
    blockers.push("A finite retention deadline has not been recorded.");
  } else if (now.getTime() < record.retain_until.getTime()) {
    blockers.push("The recorded retention deadline has not elapsed.");
  }
  for (const [name, maximum] of Object.entries(RETENTION_PURGE_LIMITS)) {
    if (inventory[name] > maximum) {
      blockers.push(
        `The ${name} inventory exceeds its bounded purge limit of ${maximum}.`,
      );
    }
  }
  if (
    inventory.accessGrants > 0 ||
    inventory.advertiserCredentials > 0 ||
    inventory.conversionCredentials > 0
  ) {
    blockers.push(
      "The disconnected account regained access or credential rows after offboarding; investigate before purging.",
    );
  }
  if (inventory.unresolvedApprovals > 0) {
    blockers.push(
      "Provider mutation evidence still has an unresolved state and must be reconciled before purging.",
    );
  }

  const boundedInventory = Object.fromEntries(
    Object.keys(RETENTION_PURGE_LIMITS).map((name) => [name, inventory[name]]),
  );
  const document = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    operation: "retention_purge",
    generatedAt: now,
    lifecycleFingerprint: lifecycleFingerprint(record.id),
    offboardingStateFingerprint: record.state_fingerprint,
    providerRevocationConfirmationSha256:
      record.provider_revocation_confirmation_sha256,
    retainUntil: record.retain_until,
    boundedInventory,
    blockers,
  };
  const preparedEvidence = prepareSerializedEvidence(
    document,
    recordSensitiveValues(record),
  );
  return {
    blockers,
    inventory: boundedInventory,
    confirmationToken:
      blockers.length === 0 ? purgeConfirmationToken(record, inventory) : null,
    document,
    serializedEvidence: preparedEvidence.serialized,
    evidenceSha256: preparedEvidence.sha256,
  };
}

export async function prepareRetentionPurge(sql, options) {
  return sql.begin(async (transaction) => {
    await transaction`set transaction read only`;
    const record = await loadLifecycleRecord(transaction, options.lifecycleId);
    const account = await loadAccount(transaction, record.advertiser_account_id);
    const inventory = await loadBoundedPurgeInventory(transaction, record);
    return buildPurgePlan(record, account, inventory, options);
  });
}

async function deleteRetentionInventory(transaction, record) {
  const accountId = record.advertiser_account_id;
  const externalAccountId = record.external_account_id;
  const approvals = await transaction`
    delete from ads_approval_records
    where account_id = ${externalAccountId}
    returning id
  `;
  const creativeReviewEvents = await transaction`
    delete from maintainflow_creative_review_events
    where advertiser_account_id = ${accountId}
    returning id
  `;
  const creativeReviewState = await transaction`
    delete from maintainflow_creative_review_state
    where advertiser_account_id = ${accountId}
    returning ad_id
  `;
  const recommendationDecisions = await transaction`
    delete from maintainflow_recommendation_dismissals
    where advertiser_account_id = ${accountId}
    returning id
  `;
  const readinessAudits = await transaction`
    delete from maintainflow_readiness_audit_runs
    where advertiser_account_id = ${accountId}
    returning id
  `;
  const liveWorkbenchSnapshots = await transaction`
    delete from maintainflow_live_workbench_snapshots
    where advertiser_account_id = ${accountId}
    returning credential_generation
  `;
  const monitoringAccountSchedules = await transaction`
    delete from maintainflow_monitoring_account_schedule
    where advertiser_account_id = ${accountId}
    returning advertiser_account_id
  `;
  const conversionCredentials = await transaction`
    delete from maintainflow_conversion_credentials
    where advertiser_account_id = ${accountId}
    returning id
  `;
  const advertiserCredentials = await transaction`
    delete from maintainflow_advertiser_credentials
    where advertiser_account_id = ${accountId}
    returning id
  `;
  const accessGrants = await transaction`
    delete from maintainflow_account_access
    where advertiser_account_id = ${accountId}
    returning organization_id
  `;
  return {
    accessGrants: accessGrants.length,
    advertiserCredentials: advertiserCredentials.length,
    conversionCredentials: conversionCredentials.length,
    approvals: approvals.length,
    creativeReviewState: creativeReviewState.length,
    creativeReviewEvents: creativeReviewEvents.length,
    recommendationDecisions: recommendationDecisions.length,
    readinessAudits: readinessAudits.length,
    liveWorkbenchSnapshots: liveWorkbenchSnapshots.length,
    monitoringAccountSchedules: monitoringAccountSchedules.length,
  };
}

export async function applyRetentionPurge(sql, options) {
  if (typeof options.writeValidatedEvidence !== "function") {
    throw new CustomerLifecycleSafetyError(
      "A validated evidence writer is required before retention purge apply.",
    );
  }
  const completedAt = options.now ?? new Date();
  const effectiveOptions = { ...options, now: completedAt };
  return sql.begin(async (transaction) => {
    await transaction`set local lock_timeout = '5s'`;
    await transaction`set local statement_timeout = '30s'`;
    const initial = await loadLifecycleRecord(transaction, options.lifecycleId);
    const account = await loadAccount(
      transaction,
      initial.advertiser_account_id,
      { lock: true },
    );
    const record = await loadLifecycleRecord(transaction, options.lifecycleId, {
      lock: true,
    });
    if (
      record.advertiser_account_id !== account.id ||
      record.external_account_id !== account.external_account_id
    ) {
      throw new CustomerLifecycleSafetyError(
        "The locked lifecycle target no longer matches its advertiser account.",
      );
    }
    const inventory = await loadBoundedPurgeInventory(transaction, record);
    const plan = buildPurgePlan(record, account, inventory, effectiveOptions);
    if (plan.blockers.length > 0) {
      throw new CustomerLifecycleSafetyError(plan.blockers.join(" "));
    }
    if (!confirmationMatches(plan.confirmationToken, options.confirmationToken)) {
      throw new CustomerLifecycleSafetyError(
        "The confirmation token does not match the current retained inventory. Run a new dry run.",
      );
    }
    await options.writeValidatedEvidence({
      document: plan.document,
      serialized: plan.serializedEvidence,
      sha256: plan.evidenceSha256,
    });

    const deleted = await deleteRetentionInventory(transaction, record);
    for (const name of Object.keys(RETENTION_PURGE_LIMITS)) {
      if (deleted[name] !== plan.inventory[name]) {
        throw new CustomerLifecycleSafetyError(
          "The locked retention inventory changed before completion; all mutations were rolled back.",
        );
      }
    }
    const removedAccounts = await transaction`
      delete from maintainflow_advertiser_accounts
      where id = ${record.advertiser_account_id}
        and external_account_id = ${record.external_account_id}
        and status = 'disconnected'
      returning id
    `;
    if (removedAccounts.length !== 1) {
      throw new CustomerLifecycleSafetyError(
        "The disconnected advertiser account changed before purge completion.",
      );
    }
    const lifecycleRows = await transaction`
      update maintainflow_customer_lifecycle_records set
        advertiser_account_id = null,
        external_account_id = null,
        acting_organization_id = null,
        operator_id = null,
        purge_completed_at = ${completedAt},
        purge_evidence_sha256 = ${plan.evidenceSha256}
      where id = ${record.id}
        and purge_completed_at is null
      returning id
    `;
    if (lifecycleRows.length !== 1) {
      throw new CustomerLifecycleSafetyError(
        "The lifecycle receipt changed before purge completion; all mutations were rolled back.",
      );
    }
    return {
      lifecycleFingerprint: lifecycleFingerprint(record.id),
      evidenceSha256: plan.evidenceSha256,
      completedAt,
      deleted,
    };
  });
}

export async function writePrivateLifecycleEvidence(filePath, serialized) {
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(filePath).catch(() => {});
    }
    if (error?.code === "EEXIST") {
      throw new CustomerLifecycleSafetyError(
        "The evidence file already exists; choose a new absolute path so evidence is never overwritten.",
      );
    }
    throw error;
  }
}

function validatedDatabaseUrl(value) {
  if (!value) {
    throw new CustomerLifecycleSafetyError("DATABASE_URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CustomerLifecycleSafetyError(
      "DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new CustomerLifecycleSafetyError(
      "DATABASE_URL must use the postgres or postgresql protocol.",
    );
  }
  const hosted = !new Set(["", "localhost", "127.0.0.1", "::1"]).has(
    parsed.hostname,
  );
  if (hosted) {
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
      throw new CustomerLifecycleSafetyError(
        "Hosted DATABASE_URL requires exactly one sslmode=verify-full parameter.",
      );
    }
  }
  return { hosted };
}

export function formatCustomerLifecycleFailure(
  error,
  environment = process.env,
  argv = process.argv.slice(2),
) {
  let message =
    error instanceof Error ? error.message : "Unknown customer lifecycle failure.";
  const secretKeyPattern =
    /(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL_KEYRING)/i;
  const sensitiveValues = [];
  for (const [key, value] of Object.entries(environment)) {
    if (secretKeyPattern.test(key) && typeof value === "string" && value) {
      sensitiveValues.push(value);
    }
  }
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (
      new Set([
        "--lifecycle-id",
        "--evidence-ref",
        "--confirm",
        "--evidence-file",
      ]).has(argv[index])
    ) {
      sensitiveValues.push(argv[index + 1]);
    }
  }
  if (typeof environment.DATABASE_URL === "string") {
    try {
      const parsed = new URL(environment.DATABASE_URL);
      for (const value of [parsed.username, parsed.password]) {
        if (!value) continue;
        sensitiveValues.push(value);
        try {
          sensitiveValues.push(decodeURIComponent(value));
        } catch {
          // URL validation uses fixed failure messages.
        }
      }
    } catch {
      // URL validation uses fixed failure messages.
    }
  }
  for (const value of new Set(sensitiveValues.filter(Boolean))) {
    message = message.split(value).join("[REDACTED]");
  }
  return `Customer lifecycle operation failed: ${message}`;
}

export async function runCustomerLifecycleCli({
  argv = process.argv.slice(2),
  environment = process.env,
} = {}) {
  const options = parseCustomerLifecycleArgs(argv);
  const { hosted } = validatedDatabaseUrl(environment.DATABASE_URL);
  const database = postgres(environment.DATABASE_URL, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    prepare: false,
    connection: {
      application_name: "maintainflow-customer-lifecycle",
      search_path: "public",
    },
    ...(hosted ? { ssl: "verify-full" } : {}),
  });
  try {
    const writer = ({ serialized }) =>
      writePrivateLifecycleEvidence(options.evidenceFile, serialized);
    if (options.operation === "confirm-revocation") {
      if (options.mode === "dry-run") {
        const plan = await prepareProviderRevocationConfirmation(
          database,
          options,
        );
        await writer({ serialized: plan.serializedEvidence });
        console.log(
          "Provider revocation confirmation dry run completed without database changes.",
        );
        console.log("Mode-0600 evidence was written without customer identifiers.");
        if (plan.blockers.length > 0) {
          for (const blocker of plan.blockers) console.log(`Blocker: ${blocker}`);
          return 2;
        }
        console.log(`Confirmation token: ${plan.confirmationToken}`);
        return 0;
      }
      const result = await applyProviderRevocationConfirmation(database, {
        ...options,
        writeValidatedEvidence: writer,
      });
      console.log(
        "Externally completed provider revocation was recorded; no provider API call was made.",
      );
      console.log(`Lifecycle fingerprint: ${result.lifecycleFingerprint}`);
      console.log(`Evidence SHA-256: ${result.evidenceSha256}`);
      return 0;
    }

    if (options.mode === "dry-run") {
      const plan = await prepareRetentionPurge(database, options);
      await writer({ serialized: plan.serializedEvidence });
      console.log(
        "Customer retention purge dry run completed without database changes.",
      );
      console.log("Mode-0600 evidence was written without customer identifiers.");
      for (const [name, count] of Object.entries(plan.inventory)) {
        console.log(`${name}: ${count}`);
      }
      if (plan.blockers.length > 0) {
        for (const blocker of plan.blockers) console.log(`Blocker: ${blocker}`);
        return 2;
      }
      console.log(`Confirmation token: ${plan.confirmationToken}`);
      return 0;
    }
    const result = await applyRetentionPurge(database, {
      ...options,
      writeValidatedEvidence: writer,
    });
    console.log(
      "Retention purge completed; shared organizations and memberships were preserved.",
    );
    console.log(`Lifecycle fingerprint: ${result.lifecycleFingerprint}`);
    console.log(`Evidence SHA-256: ${result.evidenceSha256}`);
    for (const [name, count] of Object.entries(result.deleted)) {
      console.log(`${name}: ${count}`);
    }
    return 0;
  } finally {
    await database.end({ timeout: 5 });
  }
}

const isDirectInvocation =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectInvocation) {
  try {
    process.exitCode = await runCustomerLifecycleCli();
  } catch (error) {
    console.error(
      formatCustomerLifecycleFailure(error, process.env, process.argv.slice(2)),
    );
    process.exitCode = 1;
  }
}
