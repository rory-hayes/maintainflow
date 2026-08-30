alter table maintainflow_advertiser_accounts
  drop constraint if exists maintainflow_advertiser_accounts_connection_mode_check;

alter table maintainflow_advertiser_accounts
  add constraint maintainflow_advertiser_accounts_connection_mode_check
  check (connection_mode in ('environment', 'vault'));

create table if not exists maintainflow_advertiser_credentials (
  id uuid primary key,
  advertiser_account_id uuid not null references maintainflow_advertiser_accounts(id),
  provider text not null check (provider = 'openai_ads'),
  algorithm text not null check (algorithm = 'aes-256-gcm'),
  key_id text not null,
  credential_version integer not null default 1 check (credential_version > 0),
  ciphertext bytea not null,
  initialization_vector bytea not null,
  authentication_tag bytea not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by text not null,
  verified_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists maintainflow_active_account_credential_idx
  on maintainflow_advertiser_credentials (advertiser_account_id)
  where status = 'active';

create index if not exists maintainflow_credentials_account_created_idx
  on maintainflow_advertiser_credentials (advertiser_account_id, created_at desc);
