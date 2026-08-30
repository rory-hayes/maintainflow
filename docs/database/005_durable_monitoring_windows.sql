alter table ads_approval_records
  add column if not exists monitoring_plan jsonb,
  add column if not exists monitoring_window_days smallint,
  add column if not exists monitoring_started_at timestamptz,
  add column if not exists monitoring_ends_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_approval_records_monitoring_plan_check'
      and conrelid = 'ads_approval_records'::regclass
  ) then
    alter table ads_approval_records
      add constraint ads_approval_records_monitoring_plan_check check (
        (monitoring_plan is null and monitoring_window_days is null)
        or (
          jsonb_typeof(monitoring_plan) = 'object'
          and monitoring_window_days between 1 and 30
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_approval_records_monitoring_dates_check'
      and conrelid = 'ads_approval_records'::regclass
  ) then
    alter table ads_approval_records
      add constraint ads_approval_records_monitoring_dates_check check (
        (monitoring_started_at is null and monitoring_ends_at is null)
        or (
          monitoring_started_at is not null
          and monitoring_ends_at is not null
          and monitoring_ends_at > monitoring_started_at
        )
      );
  end if;
end $$;

create unique index if not exists ads_approval_records_active_recommendation_idx
  on ads_approval_records (account_id, recommendation_id, entity_id)
  where status in (
    'pending',
    'applied',
    'reconciliation_required',
    'rollback_pending',
    'rollback_failed',
    'rollback_reconciliation_required'
  );

create index if not exists ads_approval_records_monitoring_due_idx
  on ads_approval_records (account_id, monitoring_ends_at, id)
  where monitoring_started_at is not null
    and status in (
      'applied',
      'rollback_pending',
      'rollback_failed',
      'rollback_reconciliation_required'
    );
