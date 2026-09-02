alter table ads_approval_records
  add column if not exists apply_provider_attempted_at timestamptz,
  add column if not exists rollback_provider_attempted_at timestamptz,
  add column if not exists apply_provider_attempt_id uuid,
  add column if not exists rollback_provider_attempt_id uuid;

-- Every apply approval is its own immutable attempt generation. Rollback can be
-- retried on the same approval, so each rollback claim receives a fresh UUID.
update ads_approval_records
set apply_provider_attempt_id = id
where apply_provider_attempt_id is null;

-- Rows created by an older release cannot prove whether a provider request was
-- sent, so migrate every still-pending legacy intent into the conservative
-- attempted state before automated recovery is enabled.
update ads_approval_records
set apply_provider_attempted_at = coalesce(
  apply_provider_attempted_at,
  updated_at
)
where status = 'pending';

update ads_approval_records
set rollback_provider_attempted_at = coalesce(
  rollback_provider_attempted_at,
  updated_at
), rollback_provider_attempt_id = coalesce(
  rollback_provider_attempt_id,
  gen_random_uuid()
)
where status = 'rollback_pending';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'ads_approval_records'::regclass
      and conname = 'ads_approval_records_apply_attempt_marker_pair'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_records_apply_attempt_marker_pair
      check (
        apply_provider_attempted_at is null
        or apply_provider_attempt_id is not null
      );
  end if;
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'ads_approval_records'::regclass
      and conname = 'ads_approval_records_rollback_attempt_marker_pair'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_records_rollback_attempt_marker_pair
      check (
        rollback_provider_attempted_at is null
        or rollback_provider_attempt_id is not null
      );
  end if;
end
$$;

create index if not exists ads_approval_records_stale_operation_idx
  on ads_approval_records (updated_at, id)
  where status in ('pending', 'rollback_pending');
