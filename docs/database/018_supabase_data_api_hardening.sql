-- Add the indexes PostgreSQL needs to enforce the remaining organization
-- foreign keys without scanning their referencing tables.
create index maintainflow_advertiser_accounts_owner_organization_idx
  on public.maintainflow_advertiser_accounts (owner_organization_id)
  where owner_organization_id is not null;

create index ads_approval_records_rollback_organization_idx
  on public.ads_approval_records (rollback_organization_id)
  where rollback_organization_id is not null;

create index ads_approval_records_reconciled_organization_idx
  on public.ads_approval_records (reconciled_organization_id)
  where reconciled_organization_id is not null;

-- MaintainFlow authenticates with Clerk and reaches PostgreSQL only through its
-- server-side postgres.js connection. It does not expose these tables through
-- Supabase Auth/PostgREST, so no Data API role receives a row policy here.
alter table public.ads_approval_records enable row level security;
alter table public.maintainflow_organizations enable row level security;
alter table public.maintainflow_organization_memberships enable row level security;
alter table public.maintainflow_advertiser_accounts enable row level security;
alter table public.maintainflow_account_access enable row level security;
alter table public.maintainflow_advertiser_credentials enable row level security;
alter table public.maintainflow_creative_review_state enable row level security;
alter table public.maintainflow_creative_review_events enable row level security;
alter table public.maintainflow_rate_limit_buckets enable row level security;
alter table public.maintainflow_recommendation_dismissals enable row level security;
alter table public.maintainflow_conversion_credentials enable row level security;
alter table public.maintainflow_readiness_audit_runs enable row level security;
alter table public.maintainflow_live_workbench_snapshots enable row level security;
alter table public.maintainflow_customer_lifecycle_records enable row level security;
alter table public.maintainflow_monitoring_account_schedule enable row level security;
alter table if exists public.maintainflow_schema_migrations enable row level security;

-- Remove ambient access to every current public-schema relation, sequence, and
-- function. Object owners retain their implicit owner privileges.
revoke all privileges on schema public from public;
revoke all privileges on all tables in schema public from public;
revoke all privileges on all sequences in schema public from public;
revoke all privileges on all functions in schema public from public;

-- Supabase supplies these PostgREST roles, while an ordinary local PostgreSQL
-- installation usually does not. Revoke them only when the role exists so the
-- same immutable migration remains portable to the disposable local harness.
do $maintainflow_revoke_data_api_roles$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = api_role
    ) then
      execute format(
        'revoke all privileges on schema public from %I',
        api_role
      );
      execute format(
        'revoke all privileges on all tables in schema public from %I',
        api_role
      );
      execute format(
        'revoke all privileges on all sequences in schema public from %I',
        api_role
      );
      execute format(
        'revoke all privileges on all functions in schema public from %I',
        api_role
      );
    end if;
  end loop;
end
$maintainflow_revoke_data_api_roles$;

-- Secure future objects created by the role applying this migration. Supabase
-- normally applies migrations as postgres; a separate conditional block below
-- also covers postgres when a privileged local migration role applies this file.
alter default privileges in schema public
  revoke all privileges on tables from public;
alter default privileges in schema public
  revoke all privileges on sequences from public;
alter default privileges in schema public
  revoke all privileges on functions from public;

do $maintainflow_revoke_current_role_data_api_defaults$
declare
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role']
  loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = api_role
    ) then
      execute format(
        'alter default privileges in schema public revoke all privileges on tables from %I',
        api_role
      );
      execute format(
        'alter default privileges in schema public revoke all privileges on sequences from %I',
        api_role
      );
      execute format(
        'alter default privileges in schema public revoke all privileges on functions from %I',
        api_role
      );
    end if;
  end loop;
end
$maintainflow_revoke_current_role_data_api_defaults$;

do $maintainflow_revoke_postgres_data_api_defaults$
declare
  api_role text;
  postgres_role_oid oid;
  can_manage_postgres boolean;
begin
  select oid
    into postgres_role_oid
  from pg_catalog.pg_roles
  where rolname = 'postgres';

  can_manage_postgres := postgres_role_oid is not null and (
    current_user = 'postgres'
    or pg_catalog.pg_has_role(current_user, postgres_role_oid, 'MEMBER')
    or exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = current_user
        and rolsuper
    )
  );

  if can_manage_postgres and current_user <> 'postgres' then
    execute 'alter default privileges for role postgres in schema public revoke all privileges on tables from public';
    execute 'alter default privileges for role postgres in schema public revoke all privileges on sequences from public';
    execute 'alter default privileges for role postgres in schema public revoke all privileges on functions from public';

    foreach api_role in array array['anon', 'authenticated', 'service_role']
    loop
      if exists (
        select 1
        from pg_catalog.pg_roles
        where rolname = api_role
      ) then
        execute format(
          'alter default privileges for role postgres in schema public revoke all privileges on tables from %I',
          api_role
        );
        execute format(
          'alter default privileges for role postgres in schema public revoke all privileges on sequences from %I',
          api_role
        );
        execute format(
          'alter default privileges for role postgres in schema public revoke all privileges on functions from %I',
          api_role
        );
      end if;
    end loop;
  end if;
end
$maintainflow_revoke_postgres_data_api_defaults$;
