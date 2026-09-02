create table if not exists maintainflow_monitoring_account_schedule (
  advertiser_account_id uuid primary key
    references maintainflow_advertiser_accounts(id) on delete cascade,
  current_attempt_id uuid,
  attempt_count bigint not null default 0 check (attempt_count >= 0),
  consecutive_failures integer not null default 0
    check (consecutive_failures >= 0),
  last_attempted_at timestamptz,
  last_succeeded_at timestamptz,
  last_failed_at timestamptz,
  attempt_lease_until timestamptz,
  backoff_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint maintainflow_monitoring_account_attempt_lease_check check (
    (
      current_attempt_id is null
      and attempt_lease_until is null
    )
    or (
      current_attempt_id is not null
      and last_attempted_at is not null
      and attempt_lease_until is not null
      and attempt_lease_until > last_attempted_at
    )
  ),
  constraint maintainflow_monitoring_account_attempt_count_check check (
    (attempt_count = 0 and last_attempted_at is null)
    or (attempt_count > 0 and last_attempted_at is not null)
  ),
  constraint maintainflow_monitoring_account_backoff_check check (
    backoff_until is null
    or (
      consecutive_failures > 0
      and last_failed_at is not null
      and backoff_until > last_failed_at
    )
  )
);

create index if not exists maintainflow_monitoring_account_schedule_due_idx
  on maintainflow_monitoring_account_schedule (
    backoff_until,
    attempt_lease_until,
    last_attempted_at,
    advertiser_account_id
  );
