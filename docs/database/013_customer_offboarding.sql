create table if not exists maintainflow_customer_lifecycle_records (
  id uuid primary key,
  advertiser_account_id uuid not null,
  external_account_id text not null
    check (char_length(external_account_id) between 1 and 255),
  acting_organization_id uuid not null,
  operator_id text not null
    check (char_length(operator_id) between 1 and 255),
  action text not null check (action = 'offboarded'),
  state_fingerprint text not null
    check (state_fingerprint ~ '^[a-f0-9]{64}$'),
  export_sha256 text not null
    check (export_sha256 ~ '^[a-f0-9]{64}$'),
  inventory_counts jsonb not null
    check (jsonb_typeof(inventory_counts) = 'object'),
  provider_revocation_required boolean not null default true,
  completed_at timestamptz not null default now(),
  unique (advertiser_account_id, action),
  unique (external_account_id, action)
);

create index if not exists maintainflow_customer_lifecycle_completed_idx
  on maintainflow_customer_lifecycle_records (completed_at desc, id);
