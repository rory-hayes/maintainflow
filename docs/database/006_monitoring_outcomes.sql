alter table ads_approval_records
  add column if not exists monitoring_outcome text,
  add column if not exists monitoring_observation jsonb,
  add column if not exists monitoring_evaluated_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_approval_records_monitoring_outcome_check'
      and conrelid = 'ads_approval_records'::regclass
  ) then
    alter table ads_approval_records
      add constraint ads_approval_records_monitoring_outcome_check check (
        monitoring_outcome is null
        or monitoring_outcome in (
          'within_safeguard',
          'safeguard_triggered',
          'insufficient_evidence'
        )
      );
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_approval_records_monitoring_result_check'
      and conrelid = 'ads_approval_records'::regclass
  ) then
    alter table ads_approval_records
      add constraint ads_approval_records_monitoring_result_check check (
        (
          monitoring_outcome is null
          and monitoring_observation is null
          and monitoring_evaluated_at is null
        )
        or (
          monitoring_outcome is not null
          and jsonb_typeof(monitoring_observation) = 'object'
          and monitoring_evaluated_at is not null
        )
      );
  end if;
end $$;

drop index if exists ads_approval_records_monitoring_due_idx;

create index ads_approval_records_monitoring_due_idx
  on ads_approval_records (account_id, monitoring_ends_at, id)
  where monitoring_evaluated_at is null
    and monitoring_started_at is not null
    and status in ('applied', 'rollback_failed');
