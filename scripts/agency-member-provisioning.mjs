import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { hostedDatabaseTlsOptions } from "./database-tls.mjs";

const PROVISIONING_SCHEMA_VERSION =
  "maintainflow.agency-member-provisioning.v1";
const READ_ONLY_TRANSACTION_OPTIONS =
  "isolation level repeatable read read only";
// READ COMMITTED intentionally takes a fresh statement snapshot after a
// contended advisory lock is acquired, so a waiting apply sees the winner's
// membership and fails the stale confirmation check deterministically.
const APPLY_TRANSACTION_OPTIONS = "isolation level read committed";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLERK_USER_ID_PATTERN = /^user_[A-Za-z0-9_-]{1,250}$/;
const CONFIRMATION_TOKEN_PATTERN =
  /^PROVISION-AGENCY-MEMBER:[a-f0-9]{64}$/;
const TARGET_ROLES = new Set(["admin", "analyst"]);

export class AgencyMemberProvisioningSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "AgencyMemberProvisioningSafetyError";
  }
}

function requireSingleValue(values, name) {
  if (values.length !== 1 || !values[0]) {
    throw new AgencyMemberProvisioningSafetyError(
      `${name} must be supplied exactly once.`,
    );
  }
  return values[0];
}

export function parseAgencyMemberProvisioningArgs(argv) {
  const allowedValueFlags = new Set([
    "--organization-id",
    "--acting-operator-id",
    "--target-operator-id",
    "--role",
    "--confirm",
  ]);
  const values = new Map();
  let apply = false;
  let accountAccessAcknowledged = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") {
      if (apply) {
        throw new AgencyMemberProvisioningSafetyError(
          "--apply may be supplied only once.",
        );
      }
      apply = true;
      continue;
    }
    if (argument === "--acknowledge-agency-account-access") {
      if (accountAccessAcknowledged) {
        throw new AgencyMemberProvisioningSafetyError(
          "--acknowledge-agency-account-access may be supplied only once.",
        );
      }
      accountAccessAcknowledged = true;
      continue;
    }
    if (!allowedValueFlags.has(argument)) {
      throw new AgencyMemberProvisioningSafetyError(
        "An unknown or positional argument was supplied.",
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new AgencyMemberProvisioningSafetyError(
        `${argument} requires one value.`,
      );
    }
    const existing = values.get(argument) ?? [];
    existing.push(value);
    values.set(argument, existing);
    index += 1;
  }

  const organizationId = requireSingleValue(
    values.get("--organization-id") ?? [],
    "--organization-id",
  );
  if (!UUID_PATTERN.test(organizationId)) {
    throw new AgencyMemberProvisioningSafetyError(
      "--organization-id must be one exact UUID.",
    );
  }

  const actingOperatorId = requireSingleValue(
    values.get("--acting-operator-id") ?? [],
    "--acting-operator-id",
  );
  if (!CLERK_USER_ID_PATTERN.test(actingOperatorId)) {
    throw new AgencyMemberProvisioningSafetyError(
      "--acting-operator-id must be one exact Clerk user ID beginning with user_ and containing no whitespace or wildcard characters.",
    );
  }

  const targetOperatorId = requireSingleValue(
    values.get("--target-operator-id") ?? [],
    "--target-operator-id",
  );
  if (!CLERK_USER_ID_PATTERN.test(targetOperatorId)) {
    throw new AgencyMemberProvisioningSafetyError(
      "--target-operator-id must be one exact Clerk user ID beginning with user_ and containing no whitespace or wildcard characters.",
    );
  }
  if (actingOperatorId === targetOperatorId) {
    throw new AgencyMemberProvisioningSafetyError(
      "The acting owner cannot provision their own membership.",
    );
  }

  const role = requireSingleValue(values.get("--role") ?? [], "--role");
  if (!TARGET_ROLES.has(role)) {
    throw new AgencyMemberProvisioningSafetyError(
      "--role must be exactly admin or analyst.",
    );
  }

  const confirmations = values.get("--confirm") ?? [];
  if (apply && confirmations.length !== 1) {
    throw new AgencyMemberProvisioningSafetyError(
      "Apply requires one --confirm token from a current dry run.",
    );
  }
  if (!apply && confirmations.length > 0) {
    throw new AgencyMemberProvisioningSafetyError(
      "--confirm is accepted only together with --apply.",
    );
  }
  if (apply && !CONFIRMATION_TOKEN_PATTERN.test(confirmations[0])) {
    throw new AgencyMemberProvisioningSafetyError(
      "--confirm must be the exact token emitted by a current dry run.",
    );
  }
  if (apply && !accountAccessAcknowledged) {
    throw new AgencyMemberProvisioningSafetyError(
      "Apply requires --acknowledge-agency-account-access because organization membership inherits every current and future advertiser-account grant held by the agency.",
    );
  }
  if (!apply && accountAccessAcknowledged) {
    throw new AgencyMemberProvisioningSafetyError(
      "--acknowledge-agency-account-access is accepted only together with --apply.",
    );
  }

  return {
    mode: apply ? "apply" : "dry-run",
    organizationId: organizationId.toLowerCase(),
    actingOperatorId,
    targetOperatorId,
    role,
    confirmationToken: confirmations[0] ?? null,
    accountAccessAcknowledged,
  };
}

function validatedProvisioningOptions(options, { requireConfirmation }) {
  if (!options || typeof options !== "object") {
    throw new AgencyMemberProvisioningSafetyError(
      "Agency membership provisioning options are required.",
    );
  }
  if (
    typeof options.organizationId !== "string" ||
    !UUID_PATTERN.test(options.organizationId)
  ) {
    throw new AgencyMemberProvisioningSafetyError(
      "organizationId must be one exact UUID.",
    );
  }
  if (
    typeof options.actingOperatorId !== "string" ||
    !CLERK_USER_ID_PATTERN.test(options.actingOperatorId)
  ) {
    throw new AgencyMemberProvisioningSafetyError(
      "actingOperatorId must be one exact Clerk user ID.",
    );
  }
  if (
    typeof options.targetOperatorId !== "string" ||
    !CLERK_USER_ID_PATTERN.test(options.targetOperatorId)
  ) {
    throw new AgencyMemberProvisioningSafetyError(
      "targetOperatorId must be one exact Clerk user ID.",
    );
  }
  if (options.actingOperatorId === options.targetOperatorId) {
    throw new AgencyMemberProvisioningSafetyError(
      "The acting owner cannot provision their own membership.",
    );
  }
  if (!TARGET_ROLES.has(options.role)) {
    throw new AgencyMemberProvisioningSafetyError(
      "role must be exactly admin or analyst.",
    );
  }
  if (
    requireConfirmation &&
    (typeof options.confirmationToken !== "string" ||
      !CONFIRMATION_TOKEN_PATTERN.test(options.confirmationToken))
  ) {
    throw new AgencyMemberProvisioningSafetyError(
      "Apply requires the exact confirmation token emitted by a current dry run.",
    );
  }
  if (requireConfirmation && options.accountAccessAcknowledged !== true) {
    throw new AgencyMemberProvisioningSafetyError(
      "Apply requires explicit acknowledgement that agency membership inherits current and future advertiser-account access.",
    );
  }
  return {
    ...options,
    organizationId: options.organizationId.toLowerCase(),
  };
}

function normalizeForJson(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) {
    throw new AgencyMemberProvisioningSafetyError(
      "The membership state unexpectedly contained binary data.",
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

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function organizationFingerprint(organizationId) {
  return sha256(`maintainflow-agency-organization:${organizationId}`);
}

function targetOperatorFingerprint(targetOperatorId) {
  return sha256(`maintainflow-agency-target-operator:${targetOperatorId}`);
}

export function agencyMemberProvisioningStateFingerprint(snapshot) {
  return sha256(
    canonicalJson({
      schemaVersion: PROVISIONING_SCHEMA_VERSION,
      organization: snapshot.organization,
      actingMembership: snapshot.actingMembership,
      targetMembership: snapshot.targetMembership,
      targetOperatorId: snapshot.targetOperatorId,
      requestedRole: snapshot.requestedRole,
    }),
  );
}

export function agencyMemberProvisioningConfirmationToken(snapshot) {
  return `PROVISION-AGENCY-MEMBER:${agencyMemberProvisioningStateFingerprint(snapshot)}`;
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

function advisoryLockKey(organizationId, targetOperatorId) {
  return `maintainflow:agency-member:${organizationId}:${targetOperatorId}`;
}

export async function verifyAgencyMemberProvisioningDatabaseRole(sql) {
  const [capability] = await sql`
    /* maintainflow:agency-member:operator-capability */
    select current_user as role_name,
      pg_catalog.has_table_privilege(
        current_user,
        'public.maintainflow_organizations',
        'SELECT'
      ) as can_select_organizations,
      pg_catalog.has_table_privilege(
        current_user,
        'public.maintainflow_organizations',
        'UPDATE'
      ) as can_update_organizations,
      pg_catalog.has_table_privilege(
        current_user,
        'public.maintainflow_organization_memberships',
        'SELECT'
      ) as can_select_memberships,
      pg_catalog.has_table_privilege(
        current_user,
        'public.maintainflow_organization_memberships',
        'INSERT'
      ) as can_insert_memberships,
      pg_catalog.has_table_privilege(
        current_user,
        'public.maintainflow_organization_memberships',
        'UPDATE'
      ) as can_update_memberships,
      (
        role.rolsuper
        or role.rolbypassrls
        or (
          organization_table.relowner = role.oid
          and membership_table.relowner = role.oid
        )
      ) as can_bypass_zero_policy_rls
    from pg_catalog.pg_roles role
    join pg_catalog.pg_class organization_table
      on organization_table.oid =
        'public.maintainflow_organizations'::pg_catalog.regclass
    join pg_catalog.pg_class membership_table
      on membership_table.oid =
        'public.maintainflow_organization_memberships'::pg_catalog.regclass
    where role.rolname = current_user
  `;
  if (capability?.role_name === "maintainflow_app") {
    throw new AgencyMemberProvisioningSafetyError(
      "The restricted maintainflow_app runtime role is intentionally refused. Use a short-lived privileged operator database role for this private-beta command.",
    );
  }
  if (
    !capability ||
    capability.can_select_organizations !== true ||
    capability.can_update_organizations !== true ||
    capability.can_select_memberships !== true ||
    capability.can_insert_memberships !== true ||
    capability.can_update_memberships !== true ||
    capability.can_bypass_zero_policy_rls !== true
  ) {
    throw new AgencyMemberProvisioningSafetyError(
      "The database role cannot safely run locked membership provisioning. Use a short-lived operator role with the required table-lock, membership-insert, and row-security authority.",
    );
  }
}

async function loadProvisioningSnapshot(
  sql,
  { organizationId, actingOperatorId, targetOperatorId, role },
  { lock },
) {
  const organizations = lock
    ? await sql`
        /* maintainflow:agency-member:organization:locked */
        select id, name, customer_type, status, created_at, updated_at
        from public.maintainflow_organizations
        where id = ${organizationId}
        for update
      `
    : await sql`
        /* maintainflow:agency-member:organization */
        select id, name, customer_type, status, created_at, updated_at
        from public.maintainflow_organizations
        where id = ${organizationId}
      `;
  if (organizations.length !== 1) {
    throw new AgencyMemberProvisioningSafetyError(
      "The exact agency organization target could not be resolved uniquely.",
    );
  }
  const organization = organizations[0];
  if (
    organization.customer_type !== "agency" ||
    organization.status !== "active"
  ) {
    throw new AgencyMemberProvisioningSafetyError(
      "Membership provisioning requires one active agency organization.",
    );
  }

  const memberships = lock
    ? await sql`
        /* maintainflow:agency-member:memberships:locked */
        select organization_id, clerk_user_id, role, created_at, updated_at
        from public.maintainflow_organization_memberships
        where organization_id = ${organizationId}
          and (
            clerk_user_id = ${actingOperatorId}
            or clerk_user_id = ${targetOperatorId}
          )
        order by clerk_user_id
        for update
      `
    : await sql`
        /* maintainflow:agency-member:memberships */
        select organization_id, clerk_user_id, role, created_at, updated_at
        from public.maintainflow_organization_memberships
        where organization_id = ${organizationId}
          and (
            clerk_user_id = ${actingOperatorId}
            or clerk_user_id = ${targetOperatorId}
          )
        order by clerk_user_id
      `;
  const actingMemberships = memberships.filter(
    (membership) => membership.clerk_user_id === actingOperatorId,
  );
  const targetMemberships = memberships.filter(
    (membership) => membership.clerk_user_id === targetOperatorId,
  );
  if (
    actingMemberships.length !== 1 ||
    actingMemberships[0].role !== "owner"
  ) {
    throw new AgencyMemberProvisioningSafetyError(
      "A current owner of the active agency organization must authorize membership provisioning.",
    );
  }
  if (targetMemberships.length > 1) {
    throw new AgencyMemberProvisioningSafetyError(
      "The target operator membership could not be resolved uniquely.",
    );
  }
  const targetMembership = targetMemberships[0] ?? null;
  if (targetMembership && targetMembership.role !== role) {
    throw new AgencyMemberProvisioningSafetyError(
      "The target operator already has a different membership role. This command never changes roles.",
    );
  }

  return {
    organization,
    actingMembership: actingMemberships[0],
    targetMembership,
    targetOperatorId,
    requestedRole: role,
  };
}

function preparedResult(snapshot) {
  const stateFingerprint = agencyMemberProvisioningStateFingerprint(snapshot);
  return {
    action: snapshot.targetMembership
      ? "already_provisioned"
      : "create_membership",
    stateFingerprint,
    confirmationToken: `PROVISION-AGENCY-MEMBER:${stateFingerprint}`,
    organizationFingerprint: organizationFingerprint(snapshot.organization.id),
    targetOperatorFingerprint: targetOperatorFingerprint(snapshot.targetOperatorId),
    role: snapshot.requestedRole,
  };
}

export async function prepareAgencyMemberProvisioning(sql, options) {
  const validatedOptions = validatedProvisioningOptions(options, {
    requireConfirmation: false,
  });
  return sql.begin(READ_ONLY_TRANSACTION_OPTIONS, async (transaction) => {
    await verifyAgencyMemberProvisioningDatabaseRole(transaction);
    const snapshot = await loadProvisioningSnapshot(
      transaction,
      validatedOptions,
      { lock: false },
    );
    return preparedResult(snapshot);
  });
}

export async function applyAgencyMemberProvisioning(sql, options) {
  const validatedOptions = validatedProvisioningOptions(options, {
    requireConfirmation: true,
  });
  return sql.begin(APPLY_TRANSACTION_OPTIONS, async (transaction) => {
    await verifyAgencyMemberProvisioningDatabaseRole(transaction);
    await transaction`
      /* maintainflow:agency-member:advisory-lock */
      select pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          ${advisoryLockKey(
            validatedOptions.organizationId,
            validatedOptions.targetOperatorId,
          )},
          0
        )
      )
    `;
    const snapshot = await loadProvisioningSnapshot(
      transaction,
      validatedOptions,
      { lock: true },
    );
    const prepared = preparedResult(snapshot);
    if (
      !confirmationMatches(
        prepared.confirmationToken,
        validatedOptions.confirmationToken,
      )
    ) {
      throw new AgencyMemberProvisioningSafetyError(
        "The confirmation token does not match the current locked membership state. Run a new dry run.",
      );
    }

    if (snapshot.targetMembership) {
      return { ...prepared, created: false, idempotent: true };
    }

    const inserted = await transaction`
      /* maintainflow:agency-member:insert */
      insert into public.maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values (
        ${validatedOptions.organizationId},
        ${validatedOptions.targetOperatorId}, ${validatedOptions.role}
      )
      on conflict (organization_id, clerk_user_id) do nothing
      returning organization_id, clerk_user_id, role
    `;
    const currentMemberships = await transaction`
      /* maintainflow:agency-member:target-reread */
      select organization_id, clerk_user_id, role
      from public.maintainflow_organization_memberships
      where organization_id = ${validatedOptions.organizationId}
        and clerk_user_id = ${validatedOptions.targetOperatorId}
      for update
    `;
    if (
      inserted.length !== 1 ||
      currentMemberships.length !== 1 ||
      currentMemberships[0].role !== validatedOptions.role
    ) {
      throw new AgencyMemberProvisioningSafetyError(
        "The membership state changed during apply. No unconfirmed change was accepted; run a new dry run.",
      );
    }

    return { ...prepared, created: true, idempotent: false };
  });
}

function validatedDatabaseUrl(value) {
  if (!value) {
    throw new AgencyMemberProvisioningSafetyError("DATABASE_URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AgencyMemberProvisioningSafetyError(
      "DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new AgencyMemberProvisioningSafetyError(
      "DATABASE_URL must use the postgres or postgresql protocol.",
    );
  }
  for (const [key] of parsed.searchParams) {
    if (new Set(["search_path", "options"]).has(key.toLowerCase())) {
      throw new AgencyMemberProvisioningSafetyError(
        "DATABASE_URL must not override the database search path.",
      );
    }
  }
  const hosted = !new Set(["", "localhost", "127.0.0.1", "::1"]).has(
    parsed.hostname,
  );
  if (hosted) {
    const sslEntries = [...parsed.searchParams].filter(
      ([key]) => key.toLowerCase() === "sslmode",
    );
    if (
      sslEntries.length !== 1 ||
      sslEntries[0][0] !== "sslmode" ||
      sslEntries[0][1] !== "verify-full"
    ) {
      throw new AgencyMemberProvisioningSafetyError(
        "Hosted DATABASE_URL requires exactly one sslmode=verify-full parameter.",
      );
    }
  }
  return { hosted };
}

export function formatAgencyMemberProvisioningFailure(
  error,
  environment = process.env,
  argv = process.argv.slice(2),
) {
  let message =
    error instanceof Error
      ? error.message
      : "Unknown agency membership provisioning failure.";
  const sensitiveValues = [];
  const secretKeyPattern =
    /(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL_KEYRING)/i;
  for (const [key, value] of Object.entries(environment)) {
    if (secretKeyPattern.test(key) && typeof value === "string" && value) {
      sensitiveValues.push(value);
    }
  }
  const sensitiveFlags = new Set([
    "--organization-id",
    "--acting-operator-id",
    "--target-operator-id",
    "--confirm",
  ]);
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (sensitiveFlags.has(argv[index])) sensitiveValues.push(argv[index + 1]);
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
          // URL validation emits fixed messages and never echoes malformed input.
        }
      }
    } catch {
      // URL validation emits fixed messages and never echoes malformed input.
    }
  }
  for (const value of new Set(sensitiveValues.filter(Boolean))) {
    message = message.split(value).join("[REDACTED]");
  }
  return `Agency membership provisioning failed: ${message}`;
}

export async function runAgencyMemberProvisioningCli({
  argv = process.argv.slice(2),
  environment = process.env,
  connect = postgres,
  output = console,
} = {}) {
  const options = parseAgencyMemberProvisioningArgs(argv);
  const { hosted } = validatedDatabaseUrl(environment.DATABASE_URL);
  const database = connect(environment.DATABASE_URL, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    max_pipeline: 0,
    prepare: false,
    connection: {
      application_name: "maintainflow-agency-member-provisioning",
      idle_in_transaction_session_timeout: 15_000,
      lock_timeout: 10_000,
      search_path: "public",
      statement_timeout: 20_000,
    },
    ...hostedDatabaseTlsOptions({
      hosted,
      environment,
      createError: (message) =>
        new AgencyMemberProvisioningSafetyError(message),
    }),
  });

  try {
    if (options.mode === "dry-run") {
      const prepared = await prepareAgencyMemberProvisioning(database, options);
      output.log(
        "Agency membership dry run completed without database changes.",
      );
      output.log(`Action: ${prepared.action}`);
      output.log(`Role: ${prepared.role}`);
      output.log(
        `Organization fingerprint: ${prepared.organizationFingerprint}`,
      );
      output.log(
        `Target operator fingerprint: ${prepared.targetOperatorFingerprint}`,
      );
      output.log(
        "Precondition: the target must already exist in Clerk and be admitted to this private beta.",
      );
      output.log(
        "This command does not create a Clerk user, send an invitation or email, or call an external API.",
      );
      output.log(
        "Access warning: organization membership inherits every current and future advertiser-account grant held by this agency; admin may receive live-write authority when the account and release gates permit it.",
      );
      output.log(
        "Operator boundary: use only a short-lived privileged database role; maintainflow_app is intentionally refused.",
      );
      output.log(`Confirmation token: ${prepared.confirmationToken}`);
      return 0;
    }

    const result = await applyAgencyMemberProvisioning(database, options);
    output.log(
      result.created
        ? "Agency membership was provisioned transactionally."
        : "Agency membership already matched; no database change was required.",
    );
    output.log(`Role: ${result.role}`);
    output.log(`Organization fingerprint: ${result.organizationFingerprint}`);
    output.log(
      `Target operator fingerprint: ${result.targetOperatorFingerprint}`,
    );
    output.log(
      "No Clerk user was created, no invitation or email was sent, and no external API was called.",
    );
    output.log(
      "Agency-wide advertiser-account access was explicitly acknowledged for this trusted member.",
    );
    output.log(
      "The restricted maintainflow_app runtime role was not used or granted broader privileges.",
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
    process.exitCode = await runAgencyMemberProvisioningCli();
  } catch (error) {
    console.error(
      formatAgencyMemberProvisioningFailure(
        error,
        process.env,
        process.argv.slice(2),
      ),
    );
    process.exitCode = 1;
  }
}
