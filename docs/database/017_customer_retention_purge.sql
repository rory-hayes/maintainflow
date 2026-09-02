alter table maintainflow_customer_lifecycle_records
  alter column advertiser_account_id drop not null,
  alter column external_account_id drop not null,
  alter column acting_organization_id drop not null,
  alter column operator_id drop not null,
  add column if not exists provider_revoked_at timestamptz,
  add column if not exists provider_revocation_confirmed_at timestamptz,
  add column if not exists provider_revocation_evidence_ref text,
  add column if not exists provider_revocation_confirmation_sha256 text,
  add column if not exists retain_until timestamptz not null
    default 'infinity'::timestamptz,
  add column if not exists purge_completed_at timestamptz,
  add column if not exists purge_evidence_sha256 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'maintainflow_customer_lifecycle_provider_revocation_check'
      and conrelid = 'maintainflow_customer_lifecycle_records'::regclass
  ) then
    alter table maintainflow_customer_lifecycle_records
      add constraint maintainflow_customer_lifecycle_provider_revocation_check
      check (
        (
          provider_revocation_required
          and provider_revoked_at is null
          and provider_revocation_confirmed_at is null
          and provider_revocation_evidence_ref is null
          and provider_revocation_confirmation_sha256 is null
          and purge_completed_at is null
          and purge_evidence_sha256 is null
        )
        or (
          not provider_revocation_required
          and provider_revoked_at is not null
          and provider_revocation_confirmed_at is not null
          and provider_revoked_at <= provider_revocation_confirmed_at
          and provider_revocation_confirmed_at >= completed_at
          and provider_revocation_evidence_ref is not null
          and provider_revocation_evidence_ref
            ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,254}$'
          and provider_revocation_confirmation_sha256
            ~ '^[a-f0-9]{64}$'
          and retain_until <> 'infinity'::timestamptz
          and retain_until >= completed_at
        )
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'maintainflow_customer_lifecycle_purge_state_check'
      and conrelid = 'maintainflow_customer_lifecycle_records'::regclass
  ) then
    alter table maintainflow_customer_lifecycle_records
      add constraint maintainflow_customer_lifecycle_purge_state_check
      check (
        (
          purge_completed_at is null
          and purge_evidence_sha256 is null
          and advertiser_account_id is not null
          and external_account_id is not null
          and acting_organization_id is not null
          and operator_id is not null
        )
        or (
          purge_completed_at is not null
          and not provider_revocation_required
          and purge_completed_at >= retain_until
          and purge_evidence_sha256 ~ '^[a-f0-9]{64}$'
          and advertiser_account_id is null
          and external_account_id is null
          and acting_organization_id is null
          and operator_id is null
        )
      );
  end if;
end
$$;

create index if not exists maintainflow_customer_lifecycle_retention_due_idx
  on maintainflow_customer_lifecycle_records (retain_until, id)
  where not provider_revocation_required
    and purge_completed_at is null
    and retain_until <> 'infinity'::timestamptz;
