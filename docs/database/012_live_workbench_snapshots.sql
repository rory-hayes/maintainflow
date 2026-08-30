create table if not exists maintainflow_live_workbench_snapshots (
  advertiser_account_id uuid not null
    references maintainflow_advertiser_accounts(id) on delete cascade,
  credential_generation text not null
    check (
      char_length(credential_generation) between 1 and 255
      and credential_generation !~ '[[:space:]]'
    ),
  payload_schema_version integer,
  snapshot_payload jsonb,
  snapshot_bytes integer,
  synced_at timestamptz,
  fresh_until timestamptz,
  stale_until timestamptz,
  refresh_claim_id uuid,
  refresh_claimed_at timestamptz,
  refresh_claim_expires_at timestamptz,
  consecutive_failures integer not null default 0
    check (consecutive_failures between 0 and 1000000),
  last_failure_code text,
  last_failed_at timestamptz,
  retry_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (advertiser_account_id, credential_generation),
  constraint maintainflow_live_snapshot_payload_check check (
    (
      payload_schema_version is null
      and snapshot_payload is null
      and snapshot_bytes is null
      and synced_at is null
      and fresh_until is null
      and stale_until is null
    )
    or (
      payload_schema_version is not null
      and payload_schema_version > 0
      and snapshot_payload is not null
      and jsonb_typeof(snapshot_payload) = 'object'
      and octet_length(snapshot_payload::text) <= 8388608
      and snapshot_bytes between 1 and 8388608
      and synced_at is not null
      and fresh_until is not null
      and stale_until is not null
      and synced_at <= fresh_until
      and fresh_until <= stale_until
    )
  ),
  constraint maintainflow_live_snapshot_claim_check check (
    (
      refresh_claim_id is null
      and refresh_claimed_at is null
      and refresh_claim_expires_at is null
    )
    or (
      refresh_claim_id is not null
      and refresh_claimed_at is not null
      and refresh_claim_expires_at is not null
      and refresh_claimed_at < refresh_claim_expires_at
    )
  ),
  constraint maintainflow_live_snapshot_failure_check check (
    (
      consecutive_failures = 0
      and last_failure_code is null
      and last_failed_at is null
      and retry_after is null
    )
    or (
      consecutive_failures > 0
      and last_failure_code ~ '^[a-z][a-z0-9_]{0,63}$'
      and last_failed_at is not null
      and retry_after is not null
    )
  )
);

create index if not exists maintainflow_live_workbench_snapshots_retention_idx
  on maintainflow_live_workbench_snapshots (
    synced_at,
    created_at,
    advertiser_account_id
  );
