import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type postgres from "postgres";

import {
  accountAccessSchema,
  canWriteAccount,
  selectBestAccountAccess,
  selectBestAccessPerAccount,
  type AccountAccess,
  type AccountConnectionMode,
  type OrganizationType,
} from "./schema";
import {
  decryptAdsApiKey,
  decryptConversionsApiCredential,
  type ConversionsApiCredential,
  type EncryptedCredential,
  type EncryptedConversionsApiCredential,
} from "../credentials/crypto.server";
import { getRuntimeDatabase } from "../database/client.server";

type AccessRow = {
  organization_id: string;
  organization_name: string;
  organization_type: OrganizationType;
  account_id: string;
  account_name: string;
  connection_mode: AccountConnectionMode;
  membership_role: AccountAccess["membershipRole"];
  account_role: AccountAccess["accountRole"];
};

type CredentialRotationAccessRow = AccessRow & {
  advertiser_account_id: string;
};

type AgencyAccountAttachAuthorizationRow = {
  organization_id: string;
  organization_name: string;
  membership_role: "owner" | "admin";
};

type AdvertiserAccountIdentityRow = {
  id: string;
  external_account_id: string;
  name: string;
  owner_organization_id: string | null;
  connection_mode: AccountConnectionMode;
  status: "active" | "disconnected";
};

type ExistingAgencyAttachmentRow = {
  account_role: "manager";
  credential_id: string;
};

type CredentialRow = {
  id: string;
  external_account_id: string;
  credential_version: number;
  provider: "openai_ads";
  algorithm: "aes-256-gcm";
  key_id: string;
  ciphertext: Buffer;
  initialization_vector: Buffer;
  authentication_tag: Buffer;
};

type ConversionCredentialRow = {
  id: string;
  external_account_id: string;
  provider: "openai_conversions";
  algorithm: "aes-256-gcm";
  key_id: string;
  ciphertext: Buffer;
  initialization_vector: Buffer;
  authentication_tag: Buffer;
};

type ConversionCredentialMetadataRow = {
  credential_version: number;
  validated_at: Date;
  validation_provider_status: number;
  validation_event_count: number;
};

export class TenancyStoreUnavailableError extends Error {
  constructor(message = "Customer tenancy is not configured.") {
    super(message);
    this.name = "TenancyStoreUnavailableError";
  }
}

export class AccountAccessForbiddenError extends Error {
  constructor(message = "This operator does not have access to the connected Ads account.") {
    super(message);
    this.name = "AccountAccessForbiddenError";
  }
}

export class AdvertiserAccountAttachConflictError extends Error {
  constructor(
    message = "This Ads account is already connected to another workspace.",
  ) {
    super(message);
    this.name = "AdvertiserAccountAttachConflictError";
  }
}

export class AdvertiserCredentialUnavailableError extends Error {
  constructor(message = "The advertiser account credential is unavailable.") {
    super(message);
    this.name = "AdvertiserCredentialUnavailableError";
  }
}

export class AdvertiserCredentialChangedError extends AdvertiserCredentialUnavailableError {
  constructor(
    message = "The advertiser credential changed while live data was being reviewed. Refresh before trying again.",
  ) {
    super(message);
    this.name = "AdvertiserCredentialChangedError";
  }
}

export class AdvertiserWriteBlockedError extends Error {
  constructor(
    message = "Resolve the advertiser account's active or uncertain Ads operation before starting another live write.",
  ) {
    super(message);
    this.name = "AdvertiserWriteBlockedError";
  }
}

export class ConversionsCredentialUnavailableError extends Error {
  constructor(message = "The advertiser conversion credential is unavailable.") {
    super(message);
    this.name = "ConversionsCredentialUnavailableError";
  }
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new TenancyStoreUnavailableError();
  return getRuntimeDatabase(connectionString);
}

function parseAccess(row: AccessRow) {
  return accountAccessSchema.parse({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationType: row.organization_type,
    accountId: row.account_id,
    accountName: row.account_name,
    connectionMode: row.connection_mode,
    membershipRole: row.membership_role,
    accountRole: row.account_role,
  });
}

async function lockActiveAdvertiserAccount(
  transaction: postgres.TransactionSql,
  accountId: string,
) {
  const [account] = await transaction<{ id: string }[]>`
    select id
    from maintainflow_advertiser_accounts
    where external_account_id = ${accountId}
      and status = 'active'
    for update
  `;
  return account?.id ?? null;
}

export async function verifyTenancyStore() {
  if (!process.env.DATABASE_URL) return false;
  const sql = getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_organizations') is not null
      and to_regclass('public.maintainflow_organization_memberships') is not null
      and to_regclass('public.maintainflow_advertiser_accounts') is not null
      and to_regclass('public.maintainflow_account_access') is not null
    ) as ready
  `;
  return result?.ready === true;
}

export async function verifyCredentialStore() {
  if (!process.env.DATABASE_URL) return false;
  const sql = getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_advertiser_credentials') is not null
    ) as ready
  `;
  return result?.ready === true;
}

export async function verifyAdvertiserAccountAttachStore() {
  if (!process.env.DATABASE_URL) return false;
  const sql = getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_organizations') is not null
      and to_regclass('public.maintainflow_organization_memberships') is not null
      and to_regclass('public.maintainflow_advertiser_accounts') is not null
      and to_regclass('public.maintainflow_account_access') is not null
      and to_regclass('public.maintainflow_advertiser_credentials') is not null
      and to_regclass('public.maintainflow_customer_lifecycle_records') is not null
    ) as ready
  `;
  return result?.ready === true;
}

export async function verifyConversionCredentialStore() {
  if (!process.env.DATABASE_URL) return false;
  const sql = getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_conversion_credentials') is not null
    ) as ready
  `;
  return result?.ready === true;
}

const accessSelection = `
  select
    organization.id as organization_id,
    organization.name as organization_name,
    organization.customer_type as organization_type,
    account.external_account_id as account_id,
    account.name as account_name,
    account.connection_mode as connection_mode,
    membership.role as membership_role,
    account_access.role as account_role
  from maintainflow_organization_memberships membership
  join maintainflow_organizations organization
    on organization.id = membership.organization_id
  join maintainflow_account_access account_access
    on account_access.organization_id = organization.id
  join maintainflow_advertiser_accounts account
    on account.id = account_access.advertiser_account_id
`;

export async function getAccountAccess(operatorId: string, accountId: string) {
  const sql = getDatabase();
  const rows = await sql.unsafe<AccessRow[]>(`${accessSelection}
    where membership.clerk_user_id = $1
      and account.external_account_id = $2
      and organization.status = 'active'
      and account.status = 'active'
  `, [operatorId, accountId]);
  return selectBestAccountAccess(rows.map(parseAccess));
}

export async function listAccountAccesses(operatorId: string) {
  const sql = getDatabase();
  const rows = await sql.unsafe<AccessRow[]>(`${accessSelection}
    where membership.clerk_user_id = $1
      and organization.status = 'active'
      and account.status = 'active'
    order by account.name, organization.name
  `, [operatorId]);
  return selectBestAccessPerAccount(rows.map(parseAccess));
}

export type AdsCredentialMaterial = {
  apiKey: string;
  credentialGeneration: string;
};

function environmentCredentialGeneration(apiKey: string) {
  return `environment:${createHash("sha256").update(apiKey, "utf8").digest("hex")}`;
}

export async function getAdsCredentialMaterialForAccount(
  accountId: string,
): Promise<AdsCredentialMaterial> {
  const sql = getDatabase();
  const [account] = await sql<
    { connection_mode: AccountConnectionMode }[]
  >`
    select
      connection_mode
    from maintainflow_advertiser_accounts
    where external_account_id = ${accountId}
      and status = 'active'
  `;
  if (!account) throw new AdvertiserCredentialUnavailableError();
  if (account.connection_mode === "environment") {
    const key = process.env.OPENAI_ADS_API_KEY;
    if (!key) throw new AdvertiserCredentialUnavailableError();
    return {
      apiKey: key,
      credentialGeneration: environmentCredentialGeneration(key),
    };
  }

  const [row] = await sql<CredentialRow[]>`
    select
      credential.id,
      account.external_account_id,
      credential.credential_version,
      credential.provider,
      credential.algorithm,
      credential.key_id,
      credential.ciphertext,
      credential.initialization_vector,
      credential.authentication_tag
    from maintainflow_advertiser_credentials credential
    join maintainflow_advertiser_accounts account
      on account.id = credential.advertiser_account_id
    where account.external_account_id = ${accountId}
      and account.status = 'active'
      and credential.status = 'active'
    order by credential.created_at desc
    limit 1
  `;
  if (!row) throw new AdvertiserCredentialUnavailableError();
  return {
    apiKey: decryptAdsApiKey(
      {
        id: row.id,
        provider: row.provider,
        algorithm: row.algorithm,
        keyId: row.key_id,
        ciphertext: row.ciphertext,
        initializationVector: row.initialization_vector,
        authenticationTag: row.authentication_tag,
      },
      row.external_account_id,
    ),
    credentialGeneration: `vault:${row.id}:${row.credential_version}`,
  };
}

export async function getAdsApiKeyForAccount(accountId: string) {
  return (await getAdsCredentialMaterialForAccount(accountId)).apiKey;
}

/**
 * Re-checks live-write authority and the exact credential generation in one
 * transaction. The callback must only claim the durable local action; provider
 * I/O happens after the transaction commits.
 */
export async function withAuthorizedAdsWriteFence<T>(
  options: {
    operatorId: string;
    accountId: string;
    access: AccountAccess;
    expectedCredentialGeneration: string;
    requireClearProviderOperationLedger: boolean;
  },
  operation: (context: {
    transaction: postgres.TransactionSql;
    access: AccountAccess;
    credentialMaterial: AdsCredentialMaterial;
  }) => Promise<T>,
) {
  if (
    options.access.accountId !== options.accountId ||
    !options.expectedCredentialGeneration
  ) {
    throw new AccountAccessForbiddenError(
      "Fresh write access to this advertiser account is required.",
    );
  }

  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const authorized = await lockCurrentAccountWriteAccess({
      transaction,
      operatorId: options.operatorId,
      accountId: options.accountId,
      access: options.access,
      forbiddenMessage:
        "Write access changed while live data was being reviewed. Refresh before trying again.",
    });
    const access = authorized.access;

    if (options.requireClearProviderOperationLedger) {
      const [operationLedger] = await transaction<{ blocked: boolean }[]>`
        select exists (
          select 1
          from ads_approval_records approval
          where approval.account_id = ${options.accountId}
            and approval.status in (
              'pending',
              'reconciliation_required',
              'rollback_pending',
              'rollback_reconciliation_required'
            )
        ) as blocked
      `;
      if (operationLedger?.blocked) {
        throw new AdvertiserWriteBlockedError();
      }
    }

    let credentialMaterial: AdsCredentialMaterial;
    if (access.connectionMode === "environment") {
      const apiKey = process.env.OPENAI_ADS_API_KEY;
      if (!apiKey) throw new AdvertiserCredentialUnavailableError();
      credentialMaterial = {
        apiKey,
        credentialGeneration: environmentCredentialGeneration(apiKey),
      };
    } else {
      const [credential] = await transaction<CredentialRow[]>`
        select
          credential.id,
          account.external_account_id,
          credential.credential_version,
          credential.provider,
          credential.algorithm,
          credential.key_id,
          credential.ciphertext,
          credential.initialization_vector,
          credential.authentication_tag
        from maintainflow_advertiser_credentials credential
        join maintainflow_advertiser_accounts account
          on account.id = credential.advertiser_account_id
        where account.id = ${authorized.advertiserAccountId}
          and account.status = 'active'
          and credential.status = 'active'
        order by credential.credential_version desc
        limit 1
        for update of credential
      `;
      if (!credential) throw new AdvertiserCredentialUnavailableError();
      credentialMaterial = {
        apiKey: decryptAdsApiKey(
          {
            id: credential.id,
            provider: credential.provider,
            algorithm: credential.algorithm,
            keyId: credential.key_id,
            ciphertext: credential.ciphertext,
            initializationVector: credential.initialization_vector,
            authenticationTag: credential.authentication_tag,
          },
          credential.external_account_id,
        ),
        credentialGeneration: `vault:${credential.id}:${credential.credential_version}`,
      };
    }

    if (
      credentialMaterial.credentialGeneration !==
      options.expectedCredentialGeneration
    ) {
      throw new AdvertiserCredentialChangedError();
    }

    const value = await operation({
      transaction,
      access,
      credentialMaterial,
    });
    return { value, access, credentialMaterial };
  });
}

export async function getConversionsApiCredentialForAccount(
  accountId: string,
): Promise<ConversionsApiCredential> {
  if (!(await verifyConversionCredentialStore())) {
    throw new TenancyStoreUnavailableError(
      "The conversion credential database migration is not ready.",
    );
  }
  const sql = getDatabase();
  const [row] = await sql<ConversionCredentialRow[]>`
    select
      credential.id,
      account.external_account_id,
      credential.provider,
      credential.algorithm,
      credential.key_id,
      credential.ciphertext,
      credential.initialization_vector,
      credential.authentication_tag
    from maintainflow_conversion_credentials credential
    join maintainflow_advertiser_accounts account
      on account.id = credential.advertiser_account_id
    where account.external_account_id = ${accountId}
      and account.status = 'active'
      and credential.status = 'active'
    order by credential.credential_version desc
    limit 1
  `;
  if (!row) throw new ConversionsCredentialUnavailableError();
  return decryptConversionsApiCredential(
    {
      id: row.id,
      provider: row.provider,
      algorithm: row.algorithm,
      keyId: row.key_id,
      ciphertext: row.ciphertext,
      initializationVector: row.initialization_vector,
      authenticationTag: row.authentication_tag,
    },
    row.external_account_id,
  );
}

export async function getConversionsApiCredentialMetadataForAccount(
  accountId: string,
) {
  if (!(await verifyConversionCredentialStore())) {
    throw new TenancyStoreUnavailableError(
      "The conversion credential database migration is not ready.",
    );
  }
  const sql = getDatabase();
  const [row] = await sql<ConversionCredentialMetadataRow[]>`
    select
      credential.credential_version,
      credential.validated_at,
      credential.validation_provider_status,
      credential.validation_event_count
    from maintainflow_conversion_credentials credential
    join maintainflow_advertiser_accounts account
      on account.id = credential.advertiser_account_id
    where account.external_account_id = ${accountId}
      and account.status = 'active'
      and credential.status = 'active'
    order by credential.credential_version desc
    limit 1
  `;
  if (!row) return null;
  return {
    credentialVersion: row.credential_version,
    validatedAt: row.validated_at,
    providerStatus: row.validation_provider_status,
    eventCount: row.validation_event_count,
  };
}

/**
 * Locks and re-checks the exact organization/account authorization path used
 * by a pending durable write. Callers must perform their write in the same
 * transaction so a concurrent role change cannot race the final commit.
 */
export async function lockCurrentAccountWriteAccess(options: {
  transaction: postgres.TransactionSql;
  operatorId: string;
  accountId: string;
  access: AccountAccess;
  forbiddenMessage: string;
}) {
  if (options.access.accountId !== options.accountId) {
    throw new AccountAccessForbiddenError(options.forbiddenMessage);
  }

  const advertiserAccountId = await lockActiveAdvertiserAccount(
    options.transaction,
    options.accountId,
  );
  if (!advertiserAccountId) {
    throw new AccountAccessForbiddenError(options.forbiddenMessage);
  }
  const [row] = await options.transaction<CredentialRotationAccessRow[]>`
    select
      account.id as advertiser_account_id,
      organization.id as organization_id,
      organization.name as organization_name,
      organization.customer_type as organization_type,
      account.external_account_id as account_id,
      account.name as account_name,
      account.connection_mode as connection_mode,
      membership.role as membership_role,
      account_access.role as account_role
    from maintainflow_organizations organization
    join maintainflow_organization_memberships membership
      on membership.organization_id = organization.id
    join maintainflow_account_access account_access
      on account_access.organization_id = organization.id
    join maintainflow_advertiser_accounts account
      on account.id = account_access.advertiser_account_id
    where organization.id = ${options.access.organizationId}
      and organization.status = 'active'
      and membership.clerk_user_id = ${options.operatorId}
      and membership.role in ('owner', 'admin')
      and account.id = ${advertiserAccountId}
      and account.status = 'active'
      and account_access.role in ('owner', 'manager')
    for update of organization, membership, account_access
  `;
  if (!row) {
    throw new AccountAccessForbiddenError(options.forbiddenMessage);
  }

  const access = parseAccess(row);
  if (!canWriteAccount(access)) {
    throw new AccountAccessForbiddenError(options.forbiddenMessage);
  }
  return { advertiserAccountId: row.advertiser_account_id, access };
}

export async function rotateAdsApiCredential(options: {
  operatorId: string;
  accountId: string;
  access: AccountAccess;
  credential: EncryptedCredential;
  verifiedAt: Date;
}) {
  if (!(await verifyCredentialStore())) {
    throw new TenancyStoreUnavailableError(
      "The advertiser credential database migration is not ready.",
    );
  }
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const authorized = await lockCurrentAccountWriteAccess({
      transaction,
      operatorId: options.operatorId,
      accountId: options.accountId,
      access: options.access,
      forbiddenMessage:
        "This operator cannot replace credentials for this Ads account.",
    });

    const [versionRow] = await transaction<{ next_version: number }[]>`
      select coalesce(max(credential_version), 0)::int + 1 as next_version
      from maintainflow_advertiser_credentials
      where advertiser_account_id = ${authorized.advertiserAccountId}
    `;
    const nextVersion = versionRow?.next_version ?? 1;

    await transaction`
      update maintainflow_advertiser_credentials set
        status = 'revoked', revoked_at = now(), updated_at = now()
      where advertiser_account_id = ${authorized.advertiserAccountId}
        and status = 'active'
    `;
    await transaction`
      insert into maintainflow_advertiser_credentials (
        id, advertiser_account_id, provider, algorithm, key_id,
        credential_version, ciphertext, initialization_vector,
        authentication_tag, created_by, verified_at
      ) values (
        ${options.credential.id}, ${authorized.advertiserAccountId},
        ${options.credential.provider},
        ${options.credential.algorithm}, ${options.credential.keyId},
        ${nextVersion}, ${options.credential.ciphertext},
        ${options.credential.initializationVector},
        ${options.credential.authenticationTag}, ${options.operatorId},
        ${options.verifiedAt}
      )
    `;
    await transaction`
      update maintainflow_advertiser_accounts set
        connection_mode = 'vault', updated_at = now()
      where id = ${authorized.advertiserAccountId}
    `;

    return { credentialVersion: nextVersion, verifiedAt: options.verifiedAt };
  });
}

export async function rotateConversionsApiCredential(options: {
  operatorId: string;
  accountId: string;
  access: AccountAccess;
  credential: EncryptedConversionsApiCredential;
  validatedAt: Date;
  validation: {
    providerStatus: number;
    eventCount: number;
  };
}) {
  if (
    !Number.isInteger(options.validation.providerStatus) ||
    options.validation.providerStatus < 200 ||
    options.validation.providerStatus > 299 ||
    !Number.isInteger(options.validation.eventCount) ||
    options.validation.eventCount < 1 ||
    options.validation.eventCount > 1_000
  ) {
    throw new ConversionsCredentialUnavailableError(
      "Valid dry-run evidence is required before replacing measurement credentials.",
    );
  }
  if (!(await verifyConversionCredentialStore())) {
    throw new TenancyStoreUnavailableError(
      "The conversion credential database migration is not ready.",
    );
  }

  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const authorized = await lockCurrentAccountWriteAccess({
      transaction,
      operatorId: options.operatorId,
      accountId: options.accountId,
      access: options.access,
      forbiddenMessage:
        "This operator cannot replace measurement credentials for this Ads account.",
    });

    const [versionRow] = await transaction<{ next_version: number }[]>`
      select coalesce(max(credential_version), 0)::int + 1 as next_version
      from maintainflow_conversion_credentials
      where advertiser_account_id = ${authorized.advertiserAccountId}
    `;
    const nextVersion = versionRow?.next_version ?? 1;

    await transaction`
      update maintainflow_conversion_credentials set
        status = 'revoked', revoked_at = now(), updated_at = now()
      where advertiser_account_id = ${authorized.advertiserAccountId}
        and status = 'active'
    `;
    await transaction`
      insert into maintainflow_conversion_credentials (
        id, advertiser_account_id, provider, algorithm, key_id,
        credential_version, ciphertext, initialization_vector,
        authentication_tag, created_by, acting_organization_id,
        actor_membership_role, actor_account_role, validated_at,
        validation_provider_status, validation_event_count
      ) values (
        ${options.credential.id}, ${authorized.advertiserAccountId},
        ${options.credential.provider},
        ${options.credential.algorithm}, ${options.credential.keyId},
        ${nextVersion}, ${options.credential.ciphertext},
        ${options.credential.initializationVector},
        ${options.credential.authenticationTag}, ${options.operatorId},
        ${authorized.access.organizationId},
        ${authorized.access.membershipRole},
        ${authorized.access.accountRole}, ${options.validatedAt},
        ${options.validation.providerStatus}, ${options.validation.eventCount}
      )
    `;

    return { credentialVersion: nextVersion, validatedAt: options.validatedAt };
  });
}

async function lockAdvertiserAccountIdentity(
  transaction: postgres.TransactionSql,
  externalAccountId: string,
) {
  await transaction`
    select pg_advisory_xact_lock(
      hashtextextended(${`maintainflow:advertiser-account:${externalAccountId}`}, 0)
    )
  `;
  const [account] = await transaction<AdvertiserAccountIdentityRow[]>`
    select id, external_account_id, name, owner_organization_id,
      connection_mode, status
    from maintainflow_advertiser_accounts
    where external_account_id = ${externalAccountId}
    for update
  `;
  return account ?? null;
}

async function lockAgencyAccountAttachAuthorization(
  transaction: postgres.TransactionSql,
  operatorId: string,
  organizationId: string,
) {
  const [authorization] =
    await transaction<AgencyAccountAttachAuthorizationRow[]>`
      select organization.id as organization_id,
        organization.name as organization_name,
        membership.role as membership_role
      from maintainflow_organizations organization
      join maintainflow_organization_memberships membership
        on membership.organization_id = organization.id
      where organization.id = ${organizationId}
        and organization.customer_type = 'agency'
        and organization.status = 'active'
        and membership.clerk_user_id = ${operatorId}
        and membership.role in ('owner', 'admin')
      for update of organization, membership
    `;
  if (!authorization) {
    throw new AccountAccessForbiddenError(
      "An active agency owner or admin must connect advertiser accounts.",
    );
  }
  return authorization;
}

export async function requireAgencyAccountAttachAuthorization(
  operatorId: string,
  organizationId: string,
) {
  if (!(await verifyTenancyStore())) {
    throw new TenancyStoreUnavailableError(
      "The customer tenancy database migration is not ready.",
    );
  }
  const sql = getDatabase();
  const [authorization] =
    await sql<AgencyAccountAttachAuthorizationRow[]>`
      select organization.id as organization_id,
        organization.name as organization_name,
        membership.role as membership_role
      from maintainflow_organizations organization
      join maintainflow_organization_memberships membership
        on membership.organization_id = organization.id
      where organization.id = ${organizationId}
        and organization.customer_type = 'agency'
        and organization.status = 'active'
        and membership.clerk_user_id = ${operatorId}
        and membership.role in ('owner', 'admin')
    `;
  if (!authorization) {
    throw new AccountAccessForbiddenError(
      "An active agency owner or admin must connect advertiser accounts.",
    );
  }
  return {
    organizationId: authorization.organization_id,
    organizationName: authorization.organization_name,
    membershipRole: authorization.membership_role,
  };
}

export async function attachAdvertiserAccountToAgency(options: {
  operatorId: string;
  organizationId: string;
  accountId: string;
  accountName: string;
  credential: EncryptedCredential;
  verifiedAt: Date;
}) {
  if (!(await verifyAdvertiserAccountAttachStore())) {
    throw new TenancyStoreUnavailableError(
      "The advertiser account connection database migrations are not ready.",
    );
  }

  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const existingAccount = await lockAdvertiserAccountIdentity(
      transaction,
      options.accountId,
    );
    const authorization = await lockAgencyAccountAttachAuthorization(
      transaction,
      options.operatorId,
      options.organizationId,
    );
    const [lifecycle] = existingAccount
      ? await transaction<{ id: string }[]>`
          select id
          from maintainflow_customer_lifecycle_records
          where advertiser_account_id = ${existingAccount.id}
             or external_account_id = ${options.accountId}
          limit 1
        `
      : await transaction<{ id: string }[]>`
          select id
          from maintainflow_customer_lifecycle_records
          where external_account_id = ${options.accountId}
          limit 1
        `;

    if (existingAccount?.status === "disconnected" || lifecycle) {
      throw new AdvertiserAccountAttachConflictError(
        "This Ads account was previously disconnected and cannot be reconnected automatically.",
      );
    }

    if (existingAccount) {
      if (
        existingAccount.status !== "active" ||
        existingAccount.owner_organization_id !== null ||
        existingAccount.connection_mode !== "vault"
      ) {
        throw new AdvertiserAccountAttachConflictError();
      }
      const [existingAttachment] =
        await transaction<ExistingAgencyAttachmentRow[]>`
          select account_access.role as account_role,
            credential.id as credential_id
          from maintainflow_account_access account_access
          join maintainflow_advertiser_credentials credential
            on credential.advertiser_account_id =
              account_access.advertiser_account_id
          where account_access.organization_id = ${options.organizationId}
            and account_access.advertiser_account_id = ${existingAccount.id}
            and account_access.role = 'manager'
            and credential.provider = 'openai_ads'
            and credential.status = 'active'
          for update of account_access, credential
        `;
      if (!existingAttachment) {
        throw new AdvertiserAccountAttachConflictError();
      }
      return {
        created: false,
        credentialUpdated: false,
        access: accountAccessSchema.parse({
          organizationId: authorization.organization_id,
          organizationName: authorization.organization_name,
          organizationType: "agency",
          accountId: existingAccount.external_account_id,
          accountName: existingAccount.name,
          connectionMode: existingAccount.connection_mode,
          membershipRole: authorization.membership_role,
          accountRole: existingAttachment.account_role,
        }),
      };
    }

    const advertiserAccountId = randomUUID();
    await transaction`
      insert into maintainflow_advertiser_accounts (
        id, external_account_id, name, owner_organization_id, connection_mode
      ) values (
        ${advertiserAccountId}, ${options.accountId}, ${options.accountName},
        null, 'vault'
      )
    `;
    await transaction`
      insert into maintainflow_account_access (
        organization_id, advertiser_account_id, role, granted_by
      ) values (
        ${options.organizationId}, ${advertiserAccountId}, 'manager',
        ${options.operatorId}
      )
    `;
    await transaction`
      insert into maintainflow_advertiser_credentials (
        id, advertiser_account_id, provider, algorithm, key_id,
        ciphertext, initialization_vector, authentication_tag,
        created_by, verified_at
      ) values (
        ${options.credential.id}, ${advertiserAccountId},
        ${options.credential.provider}, ${options.credential.algorithm},
        ${options.credential.keyId}, ${options.credential.ciphertext},
        ${options.credential.initializationVector},
        ${options.credential.authenticationTag}, ${options.operatorId},
        ${options.verifiedAt}
      )
    `;

    return {
      created: true,
      credentialUpdated: true,
      access: accountAccessSchema.parse({
        organizationId: authorization.organization_id,
        organizationName: authorization.organization_name,
        organizationType: "agency",
        accountId: options.accountId,
        accountName: options.accountName,
        connectionMode: "vault",
        membershipRole: authorization.membership_role,
        accountRole: "manager",
      }),
    };
  });
}

export async function requireAccountAccess(
  operatorId: string,
  accountId: string,
  capability: "read" | "write",
) {
  if (!(await verifyTenancyStore())) {
    throw new TenancyStoreUnavailableError(
      "The customer tenancy database migration is not ready.",
    );
  }
  const access = await getAccountAccess(operatorId, accountId);
  if (!access || (capability === "write" && !canWriteAccount(access))) {
    throw new AccountAccessForbiddenError(
      capability === "write"
        ? "This operator has review-only access to the connected Ads account."
        : undefined,
    );
  }
  return access;
}

export async function bootstrapWorkspace(options: {
  operatorId: string;
  organizationName: string;
  organizationType: OrganizationType;
  accountId: string;
  accountName: string;
  connection?:
    | { mode: "environment" }
    | {
        mode: "vault";
        credential: EncryptedCredential;
        verifiedAt: Date;
      };
}) {
  if (!(await verifyTenancyStore())) {
    throw new TenancyStoreUnavailableError(
      "The customer tenancy database migration is not ready.",
    );
  }
  if (
    options.connection?.mode === "vault" &&
    !(await verifyCredentialStore())
  ) {
    throw new TenancyStoreUnavailableError(
      "The advertiser credential database migration is not ready.",
    );
  }
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const existing = await lockAdvertiserAccountIdentity(
      transaction,
      options.accountId,
    );
    if (existing) {
      throw new AccountAccessForbiddenError(
        "This Ads account is already claimed. An existing workspace owner must grant access.",
      );
    }

    const organizationId = randomUUID();
    const advertiserAccountId = randomUUID();
    const ownerOrganizationId =
      options.organizationType === "advertiser" ? organizationId : null;
    const accountRole =
      options.organizationType === "advertiser" ? "owner" : "manager";
    const connection = options.connection ?? { mode: "environment" as const };

    await transaction`
      insert into maintainflow_organizations (id, name, customer_type)
      values (${organizationId}, ${options.organizationName}, ${options.organizationType})
    `;
    await transaction`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values (${organizationId}, ${options.operatorId}, 'owner')
    `;
    await transaction`
      insert into maintainflow_advertiser_accounts (
        id, external_account_id, name, owner_organization_id, connection_mode
      ) values (
        ${advertiserAccountId}, ${options.accountId}, ${options.accountName},
        ${ownerOrganizationId}, ${connection.mode}
      )
    `;
    await transaction`
      insert into maintainflow_account_access (
        organization_id, advertiser_account_id, role, granted_by
      ) values (
        ${organizationId}, ${advertiserAccountId}, ${accountRole}, ${options.operatorId}
      )
    `;
    if (connection.mode === "vault") {
      await transaction`
        insert into maintainflow_advertiser_credentials (
          id, advertiser_account_id, provider, algorithm, key_id,
          ciphertext, initialization_vector, authentication_tag,
          created_by, verified_at
        ) values (
          ${connection.credential.id}, ${advertiserAccountId},
          ${connection.credential.provider}, ${connection.credential.algorithm},
          ${connection.credential.keyId}, ${connection.credential.ciphertext},
          ${connection.credential.initializationVector},
          ${connection.credential.authenticationTag}, ${options.operatorId},
          ${connection.verifiedAt}
        )
      `;
    }

    return accountAccessSchema.parse({
      organizationId,
      organizationName: options.organizationName,
      organizationType: options.organizationType,
      accountId: options.accountId,
      accountName: options.accountName,
      connectionMode: connection.mode,
      membershipRole: "owner",
      accountRole,
    });
  });
}
