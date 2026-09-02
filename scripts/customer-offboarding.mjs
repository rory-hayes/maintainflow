import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { hostedDatabaseTlsOptions } from "./database-tls.mjs";

const EXPORT_SCHEMA_VERSION = "maintainflow.customer-offboarding.v1";
const UNRESOLVED_APPROVAL_STATUSES = new Set([
  "pending",
  "reconciliation_required",
  "rollback_pending",
  "rollback_failed",
  "rollback_reconciliation_required",
]);

export class CustomerOffboardingSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "CustomerOffboardingSafetyError";
  }
}

function requireSingleValue(values, name) {
  if (values.length !== 1 || !values[0]) {
    throw new CustomerOffboardingSafetyError(
      `${name} must be supplied exactly once.`,
    );
  }
  return values[0];
}

export function parseCustomerOffboardingArgs(argv) {
  const values = new Map();
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (apply) {
        throw new CustomerOffboardingSafetyError(
          "--apply may be supplied only once.",
        );
      }
      apply = true;
      continue;
    }
    if (
      !new Set([
        "--account-id",
        "--organization-id",
        "--operator-id",
        "--export-file",
        "--confirm",
      ]).has(argument)
    ) {
      throw new CustomerOffboardingSafetyError(
        `Unknown or positional argument: ${argument ?? "<empty>"}.`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new CustomerOffboardingSafetyError(
        `${argument} requires one value.`,
      );
    }
    const existing = values.get(argument) ?? [];
    existing.push(value);
    values.set(argument, existing);
    index += 1;
  }

  const accountId = requireSingleValue(
    values.get("--account-id") ?? [],
    "--account-id",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(accountId)) {
    throw new CustomerOffboardingSafetyError(
      "--account-id must be one exact provider account ID without whitespace or wildcard characters.",
    );
  }
  const organizationId = requireSingleValue(
    values.get("--organization-id") ?? [],
    "--organization-id",
  );
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      organizationId,
    )
  ) {
    throw new CustomerOffboardingSafetyError(
      "--organization-id must be one exact UUID.",
    );
  }
  const operatorId = requireSingleValue(
    values.get("--operator-id") ?? [],
    "--operator-id",
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,254}$/.test(operatorId)) {
    throw new CustomerOffboardingSafetyError(
      "--operator-id must be one exact Clerk user ID.",
    );
  }
  const exportFile = requireSingleValue(
    values.get("--export-file") ?? [],
    "--export-file",
  );
  if (!path.isAbsolute(exportFile)) {
    throw new CustomerOffboardingSafetyError(
      "--export-file must be an absolute path to a new file.",
    );
  }
  const confirmations = values.get("--confirm") ?? [];
  if (apply && confirmations.length !== 1) {
    throw new CustomerOffboardingSafetyError(
      "Destructive apply requires one --confirm token from a current dry run.",
    );
  }
  if (!apply && confirmations.length > 0) {
    throw new CustomerOffboardingSafetyError(
      "--confirm is accepted only together with --apply.",
    );
  }

  return {
    mode: apply ? "apply" : "dry-run",
    accountId,
    organizationId: organizationId.toLowerCase(),
    operatorId,
    exportFile,
    confirmationToken: confirmations[0] ?? null,
  };
}

function normalizeForJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    throw new CustomerOffboardingSafetyError(
      "The export inventory unexpectedly contained binary credential material.",
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
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function canonicalCustomerOffboardingJson(value) {
  return JSON.stringify(normalizeForJson(value));
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function customerOffboardingStateFingerprint(snapshot) {
  return sha256(
    canonicalCustomerOffboardingJson({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      account: snapshot.account,
      actingOrganizationId: snapshot.actingOrganizationId,
      operatorId: snapshot.operatorId,
      actingAuthorization: snapshot.actingAuthorization,
      accountAccess: snapshot.accountAccess,
      advertiserCredentialMetadata: snapshot.advertiserCredentialMetadata,
      conversionCredentialMetadata: snapshot.conversionCredentialMetadata,
      approvals: snapshot.approvals,
      creativeReviewState: snapshot.creativeReviewState,
      creativeReviewEvents: snapshot.creativeReviewEvents,
      recommendationDecisions: snapshot.recommendationDecisions,
      readinessAudits: snapshot.readinessAudits,
      liveWorkbenchSnapshots: snapshot.liveWorkbenchSnapshots,
      monitoringAccountSchedules: snapshot.monitoringAccountSchedules,
    }),
  );
}

export function customerOffboardingConfirmationToken(snapshot) {
  return `OFFBOARD:${snapshot.account.external_account_id}:${customerOffboardingStateFingerprint(snapshot)}`;
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

function inventoryCounts(snapshot) {
  return {
    accessGrants: snapshot.accountAccess.length,
    advertiserCredentials: snapshot.advertiserCredentialMetadata.length,
    conversionCredentials: snapshot.conversionCredentialMetadata.length,
    approvals: snapshot.approvals.length,
    unresolvedApprovals: snapshot.approvals.filter((record) =>
      UNRESOLVED_APPROVAL_STATUSES.has(record.status),
    ).length,
    creativeReviewState: snapshot.creativeReviewState.length,
    creativeReviewEvents: snapshot.creativeReviewEvents.length,
    recommendationDecisions: snapshot.recommendationDecisions.length,
    readinessAudits: snapshot.readinessAudits.length,
    liveWorkbenchSnapshots: snapshot.liveWorkbenchSnapshots.length,
    monitoringAccountSchedules: snapshot.monitoringAccountSchedules.length,
  };
}

function snapshotBlockers(snapshot, evaluatedAt = new Date()) {
  const blockers = [];
  if (snapshot.account.status !== "active") {
    blockers.push("The advertiser account is not active.");
  }
  if (snapshot.account.connection_mode === "environment") {
    blockers.push(
      "The account uses the shared environment credential; rotate or remove that provider key before offboarding.",
    );
  }
  if (snapshot.lifecycleRecords.length > 0) {
    blockers.push("A completed offboarding lifecycle record already exists.");
  }
  const unresolved = snapshot.approvals.filter((record) =>
    UNRESOLVED_APPROVAL_STATUSES.has(record.status),
  );
  if (unresolved.length > 0) {
    blockers.push(
      `${unresolved.length} Ads mutation record(s) require a terminal reconciliation state before credentials can be removed.`,
    );
  }
  const monitoringClaims = snapshot.approvals.filter(
    (record) => record.monitoring_evaluation_claim_id !== null,
  );
  if (monitoringClaims.length > 0) {
    blockers.push(
      `${monitoringClaims.length} monitoring evaluation(s) still hold an active database claim. Let them finish or recover the expired claim before offboarding.`,
    );
  }
  const liveRefreshClaims = snapshot.liveWorkbenchSnapshots.filter(
    (record) => record.refresh_claim_id !== null,
  );
  if (liveRefreshClaims.length > 0) {
    blockers.push(
      `${liveRefreshClaims.length} live account refresh(es) still hold a database claim. Let them finish or recover the expired claim before offboarding.`,
    );
  }
  const monitoringAccountAttempts = snapshot.monitoringAccountSchedules.filter(
    (record) => {
      if (record.current_attempt_id === null) return false;
      if (record.attempt_lease_until === null) return true;
      const leaseUntil = new Date(record.attempt_lease_until).getTime();
      return !Number.isFinite(leaseUntil) || leaseUntil > evaluatedAt.getTime();
    },
  );
  if (monitoringAccountAttempts.length > 0) {
    blockers.push(
      `${monitoringAccountAttempts.length} scheduled monitoring account attempt(s) still hold an unexpired database lease. Let them finish before offboarding.`,
    );
  }
  return blockers;
}

async function loadCustomerOffboardingSnapshot(
  sql,
  { accountId, organizationId, operatorId },
  { lock },
) {
  const accounts = lock
    ? await sql`
        select id, external_account_id, name, owner_organization_id,
          connection_mode, status, created_at, updated_at
        from maintainflow_advertiser_accounts
        where external_account_id = ${accountId}
        for update
      `
    : await sql`
        select id, external_account_id, name, owner_organization_id,
          connection_mode, status, created_at, updated_at
        from maintainflow_advertiser_accounts
        where external_account_id = ${accountId}
      `;
  if (accounts.length !== 1) {
    throw new CustomerOffboardingSafetyError(
      "The exact advertiser account target could not be resolved uniquely.",
    );
  }
  const account = accounts[0];

  const actorRows = lock
    ? await sql`
        select organization.id as organization_id,
          organization.status as organization_status,
          membership.role as membership_role,
          account_access.role as account_role
        from maintainflow_organizations organization
        join maintainflow_organization_memberships membership
          on membership.organization_id = organization.id
        join maintainflow_account_access account_access
          on account_access.organization_id = organization.id
        where organization.id = ${organizationId}
          and membership.clerk_user_id = ${operatorId}
          and account_access.advertiser_account_id = ${account.id}
        for update of organization, membership, account_access
      `
    : await sql`
        select organization.id as organization_id,
          organization.status as organization_status,
          membership.role as membership_role,
          account_access.role as account_role
        from maintainflow_organizations organization
        join maintainflow_organization_memberships membership
          on membership.organization_id = organization.id
        join maintainflow_account_access account_access
          on account_access.organization_id = organization.id
        where organization.id = ${organizationId}
          and membership.clerk_user_id = ${operatorId}
          and account_access.advertiser_account_id = ${account.id}
      `;
  if (actorRows.length !== 1) {
    throw new CustomerOffboardingSafetyError(
      "The exact operator, organization, and advertiser account authority could not be resolved.",
    );
  }
  const actor = actorRows[0];
  if (actor.organization_status !== "active" || actor.membership_role !== "owner") {
    throw new CustomerOffboardingSafetyError(
      "An active organization owner must authorize customer offboarding.",
    );
  }

  const accountAccess = lock
    ? await sql`
        select account_access.organization_id, organization.name as organization_name,
          organization.customer_type, organization.status as organization_status,
          account_access.role, account_access.granted_by,
          account_access.created_at, account_access.updated_at
        from maintainflow_account_access account_access
        join maintainflow_organizations organization
          on organization.id = account_access.organization_id
        where account_access.advertiser_account_id = ${account.id}
        order by account_access.organization_id
        for update of account_access, organization
      `
    : await sql`
        select account_access.organization_id, organization.name as organization_name,
          organization.customer_type, organization.status as organization_status,
          account_access.role, account_access.granted_by,
          account_access.created_at, account_access.updated_at
        from maintainflow_account_access account_access
        join maintainflow_organizations organization
          on organization.id = account_access.organization_id
        where account_access.advertiser_account_id = ${account.id}
        order by account_access.organization_id
      `;

  if (account.owner_organization_id) {
    if (
      account.owner_organization_id !== organizationId ||
      actor.account_role !== "owner"
    ) {
      throw new CustomerOffboardingSafetyError(
        "Only the advertiser owner organization can offboard this account.",
      );
    }
  } else {
    const managers = accountAccess.filter((access) => access.role === "manager");
    if (
      managers.length !== 1 ||
      managers[0].organization_id !== organizationId ||
      actor.account_role !== "manager"
    ) {
      throw new CustomerOffboardingSafetyError(
        "Ownerless agency-managed accounts require exactly one manager organization, matching the acting organization.",
      );
    }
  }

  const advertiserCredentialMetadata = lock
    ? await sql`
        select id, provider, credential_version, status, created_by,
          verified_at, revoked_at, created_at, updated_at
        from maintainflow_advertiser_credentials
        where advertiser_account_id = ${account.id}
        order by credential_version, id
        for update
      `
    : await sql`
        select id, provider, credential_version, status, created_by,
          verified_at, revoked_at, created_at, updated_at
        from maintainflow_advertiser_credentials
        where advertiser_account_id = ${account.id}
        order by credential_version, id
      `;
  const conversionCredentialMetadata = lock
    ? await sql`
        select id, provider, credential_version, status, created_by,
          acting_organization_id, actor_membership_role, actor_account_role,
          validated_at, validation_provider_status, validation_event_count,
          revoked_at, created_at, updated_at
        from maintainflow_conversion_credentials
        where advertiser_account_id = ${account.id}
        order by credential_version, id
        for update
      `
    : await sql`
        select id, provider, credential_version, status, created_by,
          acting_organization_id, actor_membership_role, actor_account_role,
          validated_at, validation_provider_status, validation_event_count,
          revoked_at, created_at, updated_at
        from maintainflow_conversion_credentials
        where advertiser_account_id = ${account.id}
        order by credential_version, id
      `;
  const approvals = lock
    ? await sql`
        select * from ads_approval_records
        where account_id = ${account.external_account_id}
        order by created_at, id
        for update
      `
    : await sql`
        select * from ads_approval_records
        where account_id = ${account.external_account_id}
        order by created_at, id
      `;
  const creativeReviewState = lock
    ? await sql`
        select * from maintainflow_creative_review_state
        where advertiser_account_id = ${account.id}
        order by ad_id
        for update
      `
    : await sql`
        select * from maintainflow_creative_review_state
        where advertiser_account_id = ${account.id}
        order by ad_id
      `;
  const creativeReviewEvents = lock
    ? await sql`
        select * from maintainflow_creative_review_events
        where advertiser_account_id = ${account.id}
        order by detected_at, id
        for update
      `
    : await sql`
        select * from maintainflow_creative_review_events
        where advertiser_account_id = ${account.id}
        order by detected_at, id
      `;
  const recommendationDecisions = lock
    ? await sql`
        select * from maintainflow_recommendation_dismissals
        where advertiser_account_id = ${account.id}
        order by dismissed_at, id
        for update
      `
    : await sql`
        select * from maintainflow_recommendation_dismissals
        where advertiser_account_id = ${account.id}
        order by dismissed_at, id
      `;
  const readinessAudits = lock
    ? await sql`
        select * from maintainflow_readiness_audit_runs
        where advertiser_account_id = ${account.id}
        order by created_at, id
        for update
      `
    : await sql`
        select * from maintainflow_readiness_audit_runs
        where advertiser_account_id = ${account.id}
        order by created_at, id
      `;
  const liveWorkbenchSnapshots = lock
    ? await sql`
        select * from maintainflow_live_workbench_snapshots
        where advertiser_account_id = ${account.id}
        order by credential_generation
        for update
      `
    : await sql`
        select * from maintainflow_live_workbench_snapshots
        where advertiser_account_id = ${account.id}
        order by credential_generation
      `;
  const monitoringAccountSchedules = lock
    ? await sql`
        select * from maintainflow_monitoring_account_schedule
        where advertiser_account_id = ${account.id}
        order by advertiser_account_id
        for update
      `
    : await sql`
        select * from maintainflow_monitoring_account_schedule
        where advertiser_account_id = ${account.id}
        order by advertiser_account_id
      `;
  const lifecycleRecords = await sql`
    select id, advertiser_account_id, external_account_id,
      acting_organization_id, operator_id, action, state_fingerprint,
      export_sha256, inventory_counts, provider_revocation_required,
      completed_at
    from maintainflow_customer_lifecycle_records
    where advertiser_account_id = ${account.id}
       or external_account_id = ${account.external_account_id}
    order by completed_at, id
  `;

  return {
    account,
    actingOrganizationId: organizationId,
    operatorId,
    actingAuthorization: {
      organization_id: actor.organization_id,
      operator_id: operatorId,
      membership_role: actor.membership_role,
      account_role: actor.account_role,
    },
    accountAccess,
    advertiserCredentialMetadata,
    conversionCredentialMetadata,
    approvals,
    creativeReviewState,
    creativeReviewEvents,
    recommendationDecisions,
    readinessAudits,
    liveWorkbenchSnapshots,
    monitoringAccountSchedules,
    lifecycleRecords,
  };
}

function customerOffboardingExport(snapshot, generatedAt) {
  const counts = inventoryCounts(snapshot);
  const fingerprint = customerOffboardingStateFingerprint(snapshot);
  return normalizeForJson({
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt,
    stateFingerprint: fingerprint,
    target: {
      accountId: snapshot.account.external_account_id,
      advertiserAccountId: snapshot.account.id,
      actingOrganizationId: snapshot.actingOrganizationId,
      operatorId: snapshot.operatorId,
    },
    inventory: counts,
    data: {
      account: snapshot.account,
      actingAuthorization: snapshot.actingAuthorization,
      accountAccess: snapshot.accountAccess,
      advertiserCredentialMetadata: snapshot.advertiserCredentialMetadata,
      conversionCredentialMetadata: snapshot.conversionCredentialMetadata,
      approvals: snapshot.approvals,
      creativeReviewState: snapshot.creativeReviewState,
      creativeReviewEvents: snapshot.creativeReviewEvents,
      recommendationDecisions: snapshot.recommendationDecisions,
      readinessAudits: snapshot.readinessAudits,
      liveWorkbenchSnapshots: snapshot.liveWorkbenchSnapshots,
      monitoringAccountSchedules: snapshot.monitoringAccountSchedules,
    },
    notices: [
      "Encrypted credential bytes and decryption keys are excluded from this export.",
      "Provider source credentials must still be revoked in OpenAI Ads Manager.",
      "Historical evidence remains stored until the signed retention schedule authorizes deletion.",
    ],
  });
}

function preparedResult(snapshot, generatedAt = new Date()) {
  const blockers = snapshotBlockers(snapshot, generatedAt);
  const exportDocument = customerOffboardingExport(snapshot, generatedAt);
  const serializedExport = `${JSON.stringify(exportDocument, null, 2)}\n`;
  return {
    snapshot,
    blockers,
    inventory: inventoryCounts(snapshot),
    stateFingerprint: exportDocument.stateFingerprint,
    confirmationToken:
      blockers.length === 0
        ? customerOffboardingConfirmationToken(snapshot)
        : null,
    exportDocument,
    serializedExport,
    exportSha256: sha256(serializedExport),
  };
}

export async function prepareCustomerOffboarding(sql, options) {
  return sql.begin(async (transaction) => {
    await transaction`set transaction read only`;
    const snapshot = await loadCustomerOffboardingSnapshot(
      transaction,
      options,
      { lock: false },
    );
    return preparedResult(snapshot, options.generatedAt ?? new Date());
  });
}

export async function applyCustomerOffboarding(sql, options) {
  if (typeof options.writeValidatedExport !== "function") {
    throw new CustomerOffboardingSafetyError(
      "A validated export writer is required before destructive apply.",
    );
  }
  return sql.begin(async (transaction) => {
    const snapshot = await loadCustomerOffboardingSnapshot(
      transaction,
      options,
      { lock: true },
    );
    const prepared = preparedResult(snapshot, options.generatedAt ?? new Date());
    if (prepared.blockers.length > 0) {
      throw new CustomerOffboardingSafetyError(prepared.blockers.join(" "));
    }
    const expectedToken = customerOffboardingConfirmationToken(snapshot);
    if (!confirmationMatches(expectedToken, options.confirmationToken)) {
      throw new CustomerOffboardingSafetyError(
        "The confirmation token does not match the current locked account inventory. Run a new dry run.",
      );
    }

    await options.writeValidatedExport({
      document: prepared.exportDocument,
      serialized: prepared.serializedExport,
      sha256: prepared.exportSha256,
    });

    const advertiserCredentialsDeleted = await transaction`
      delete from maintainflow_advertiser_credentials
      where advertiser_account_id = ${snapshot.account.id}
      returning id
    `;
    const conversionCredentialsDeleted = await transaction`
      delete from maintainflow_conversion_credentials
      where advertiser_account_id = ${snapshot.account.id}
      returning id
    `;
    const accountAccessDeleted = await transaction`
      delete from maintainflow_account_access
      where advertiser_account_id = ${snapshot.account.id}
      returning organization_id
    `;
    const disconnected = await transaction`
      update maintainflow_advertiser_accounts set
        status = 'disconnected', updated_at = now()
      where id = ${snapshot.account.id}
        and status = 'active'
      returning id
    `;
    if (
      advertiserCredentialsDeleted.length !==
        snapshot.advertiserCredentialMetadata.length ||
      conversionCredentialsDeleted.length !==
        snapshot.conversionCredentialMetadata.length ||
      accountAccessDeleted.length !== snapshot.accountAccess.length ||
      disconnected.length !== 1
    ) {
      throw new CustomerOffboardingSafetyError(
        "The locked offboarding inventory changed before completion; all mutations were rolled back.",
      );
    }

    const lifecycleId = randomUUID();
    await transaction`
      insert into maintainflow_customer_lifecycle_records (
        id, advertiser_account_id, external_account_id,
        acting_organization_id, operator_id, action,
        state_fingerprint, export_sha256, inventory_counts,
        provider_revocation_required, completed_at
      ) values (
        ${lifecycleId}, ${snapshot.account.id},
        ${snapshot.account.external_account_id},
        ${snapshot.actingOrganizationId}, ${snapshot.operatorId},
        'offboarded', ${prepared.stateFingerprint},
        ${prepared.exportSha256},
        ${transaction.json(prepared.inventory)}, true, now()
      )
    `;

    return {
      lifecycleId,
      accountId: snapshot.account.external_account_id,
      advertiserAccountId: snapshot.account.id,
      stateFingerprint: prepared.stateFingerprint,
      exportSha256: prepared.exportSha256,
      inventory: prepared.inventory,
      deleted: {
        accountAccess: accountAccessDeleted.length,
        advertiserCredentials: advertiserCredentialsDeleted.length,
        conversionCredentials: conversionCredentialsDeleted.length,
      },
      providerRevocationRequired: true,
    };
  });
}

export async function writePrivateCustomerExport(filePath, serialized) {
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
      throw new CustomerOffboardingSafetyError(
        "The export file already exists; choose a new absolute path so evidence is never overwritten.",
      );
    }
    throw error;
  }
}

function validatedDatabaseUrl(value) {
  if (!value) {
    throw new CustomerOffboardingSafetyError("DATABASE_URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CustomerOffboardingSafetyError(
      "DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new CustomerOffboardingSafetyError(
      "DATABASE_URL must use the postgres or postgresql protocol.",
    );
  }
  const hosted = !new Set(["", "localhost", "127.0.0.1", "::1"]).has(
    parsed.hostname,
  );
  if (hosted) {
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
      throw new CustomerOffboardingSafetyError(
        "Hosted DATABASE_URL requires exactly one sslmode=verify-full parameter.",
      );
    }
  }
  return { parsed, hosted };
}

export function formatCustomerOffboardingFailure(error, environment = process.env) {
  let message =
    error instanceof Error ? error.message : "Unknown customer offboarding failure.";
  const secretKeyPattern =
    /(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL_KEYRING)/i;
  for (const [key, value] of Object.entries(environment)) {
    if (!secretKeyPattern.test(key) || typeof value !== "string" || !value) {
      continue;
    }
    message = message.split(value).join("[REDACTED]");
  }
  if (typeof environment.DATABASE_URL === "string") {
    try {
      const parsed = new URL(environment.DATABASE_URL);
      for (const encodedValue of [parsed.username, parsed.password]) {
        if (!encodedValue) continue;
        const values = new Set([encodedValue]);
        try {
          values.add(decodeURIComponent(encodedValue));
        } catch {
          // URL validation emits a fixed message and never echoes malformed input.
        }
        for (const value of values) {
          if (value) message = message.split(value).join("[REDACTED]");
        }
      }
    } catch {
      // URL validation emits a fixed message and never echoes malformed input.
    }
  }
  return `Customer offboarding failed: ${message}`;
}

export async function runCustomerOffboardingCli({
  argv = process.argv.slice(2),
  environment = process.env,
  connect = postgres,
} = {}) {
  const options = parseCustomerOffboardingArgs(argv);
  const { hosted } = validatedDatabaseUrl(environment.DATABASE_URL);
  const database = connect(environment.DATABASE_URL, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    prepare: false,
    connection: {
      application_name: "maintainflow-customer-offboarding",
      search_path: "public",
    },
    ...hostedDatabaseTlsOptions({
      hosted,
      environment,
      createError: (message) => new CustomerOffboardingSafetyError(message),
    }),
  });
  try {
    if (options.mode === "dry-run") {
      const prepared = await prepareCustomerOffboarding(database, options);
      await writePrivateCustomerExport(
        options.exportFile,
        prepared.serializedExport,
      );
      console.log("Customer offboarding dry run completed without database changes.");
      console.log(`Account: ${options.accountId}`);
      console.log(`Export: ${options.exportFile}`);
      console.log(`Access grants: ${prepared.inventory.accessGrants}`);
      console.log(
        `Encrypted credential rows: ${prepared.inventory.advertiserCredentials + prepared.inventory.conversionCredentials}`,
      );
      console.log(`Historical approval rows retained: ${prepared.inventory.approvals}`);
      if (prepared.blockers.length > 0) {
        for (const blocker of prepared.blockers) console.log(`Blocker: ${blocker}`);
        return 2;
      }
      console.log(`Confirmation token: ${prepared.confirmationToken}`);
      return 0;
    }

    const result = await applyCustomerOffboarding(database, {
      ...options,
      writeValidatedExport: ({ serialized }) =>
        writePrivateCustomerExport(options.exportFile, serialized),
    });
    console.log("Customer offboarding completed transactionally.");
    console.log(`Account: ${result.accountId}`);
    console.log(`Lifecycle record: ${result.lifecycleId}`);
    console.log(`Export: ${options.exportFile}`);
    console.log(`Export SHA-256: ${result.exportSha256}`);
    console.log(
      "Provider source credentials must now be revoked in OpenAI Ads Manager.",
    );
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
    process.exitCode = await runCustomerOffboardingCli();
  } catch (error) {
    console.error(formatCustomerOffboardingFailure(error, process.env));
    process.exitCode = 1;
  }
}
