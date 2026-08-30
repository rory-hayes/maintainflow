alter table ads_approval_records
  add column if not exists monitoring_evaluation_claim_id uuid,
  add column if not exists monitoring_evaluation_claimed_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'ads_approval_records_monitoring_claim_check'
      and conrelid = 'ads_approval_records'::regclass
  ) then
    alter table ads_approval_records
      add constraint ads_approval_records_monitoring_claim_check check (
        (
          monitoring_evaluation_claim_id is null
          and monitoring_evaluation_claimed_at is null
        )
        or (
          monitoring_evaluation_claim_id is not null
          and monitoring_evaluation_claimed_at is not null
          and monitoring_evaluated_at is null
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

create index if not exists ads_approval_records_monitoring_global_due_idx
  on ads_approval_records (monitoring_ends_at, account_id, id)
  where monitoring_evaluated_at is null
    and monitoring_started_at is not null
    and status in ('applied', 'rollback_failed');
