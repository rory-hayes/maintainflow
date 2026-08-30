create table if not exists maintainflow_conversion_credentials (
  id uuid primary key,
  advertiser_account_id uuid not null
    references maintainflow_advertiser_accounts(id) on delete cascade,
  provider text not null
    check (provider = 'openai_conversions'),
  algorithm text not null
    check (algorithm = 'aes-256-gcm'),
  key_id text not null,
  credential_version integer not null default 1
    check (credential_version > 0),
  ciphertext bytea not null,
  initialization_vector bytea not null
    check (octet_length(initialization_vector) = 12),
  authentication_tag bytea not null
    check (octet_length(authentication_tag) = 16),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  created_by text not null,
  acting_organization_id uuid not null
    references maintainflow_organizations(id),
  actor_membership_role text not null
    check (actor_membership_role in ('owner', 'admin', 'analyst')),
  actor_account_role text not null
    check (actor_account_role in ('owner', 'manager', 'viewer')),
  validated_at timestamptz not null,
  validation_provider_status smallint not null
    check (validation_provider_status between 200 and 299),
  validation_event_count integer not null
    check (validation_event_count between 1 and 1000),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (advertiser_account_id, credential_version),
  check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create unique index if not exists maintainflow_active_conversion_credential_idx
  on maintainflow_conversion_credentials (advertiser_account_id)
  where status = 'active';

create index if not exists maintainflow_conversion_credentials_history_idx
  on maintainflow_conversion_credentials (
    advertiser_account_id,
    credential_version desc
  );

create index if not exists maintainflow_conversion_credentials_actor_org_idx
  on maintainflow_conversion_credentials (
    acting_organization_id,
    created_at desc
  );
