import "server-only";

import { randomUUID } from "node:crypto";

import postgres, { type Sql } from "postgres";

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

type CredentialRow = {
  id: string;
  external_account_id: string;
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

let database: Sql | undefined;

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

export class AdvertiserCredentialUnavailableError extends Error {
  constructor(message = "The advertiser account credential is unavailable.") {
    super(message);
    this.name = "AdvertiserCredentialUnavailableError";
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
  database ??= postgres(connectionString, {
    connect_timeout: 10,
    idle_timeout: 20,
    max: 2,
    prepare: false,
  });
  return database;
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

export async function getAdsApiKeyForAccount(accountId: string) {
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
    return key;
  }

  const [row] = await sql<CredentialRow[]>`
    select
      credential.id,
      account.external_account_id,
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
  return decryptAdsApiKey(
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

export async function rotateAdsApiCredential(options: {
  operatorId: string;
  accountId: string;
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
    const [account] = await transaction<{ id: string }[]>`
      select id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for update
    `;
    if (!account) throw new AdvertiserCredentialUnavailableError();

    const [versionRow] = await transaction<{ next_version: number }[]>`
      select coalesce(max(credential_version), 0)::int + 1 as next_version
      from maintainflow_advertiser_credentials
      where advertiser_account_id = ${account.id}
    `;
    const nextVersion = versionRow?.next_version ?? 1;

    await transaction`
      update maintainflow_advertiser_credentials set
        status = 'revoked', revoked_at = now(), updated_at = now()
      where advertiser_account_id = ${account.id}
        and status = 'active'
    `;
    await transaction`
      insert into maintainflow_advertiser_credentials (
        id, advertiser_account_id, provider, algorithm, key_id,
        credential_version, ciphertext, initialization_vector,
        authentication_tag, created_by, verified_at
      ) values (
        ${options.credential.id}, ${account.id}, ${options.credential.provider},
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
      where id = ${account.id}
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
    options.access.accountId !== options.accountId ||
    !canWriteAccount(options.access)
  ) {
    throw new AccountAccessForbiddenError(
      "This operator cannot replace measurement credentials for this Ads account.",
    );
  }
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
    const [account] = await transaction<{ id: string }[]>`
      select id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for update
    `;
    if (!account) throw new ConversionsCredentialUnavailableError();

    const [versionRow] = await transaction<{ next_version: number }[]>`
      select coalesce(max(credential_version), 0)::int + 1 as next_version
      from maintainflow_conversion_credentials
      where advertiser_account_id = ${account.id}
    `;
    const nextVersion = versionRow?.next_version ?? 1;

    await transaction`
      update maintainflow_conversion_credentials set
        status = 'revoked', revoked_at = now(), updated_at = now()
      where advertiser_account_id = ${account.id}
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
        ${options.credential.id}, ${account.id}, ${options.credential.provider},
        ${options.credential.algorithm}, ${options.credential.keyId},
        ${nextVersion}, ${options.credential.ciphertext},
        ${options.credential.initializationVector},
        ${options.credential.authenticationTag}, ${options.operatorId},
        ${options.access.organizationId}, ${options.access.membershipRole},
        ${options.access.accountRole}, ${options.validatedAt},
        ${options.validation.providerStatus}, ${options.validation.eventCount}
      )
    `;

    return { credentialVersion: nextVersion, validatedAt: options.validatedAt };
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
    const [existing] = await transaction<{ id: string }[]>`
      select id from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
      for update
    `;
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
