-- MaintainFlow runtime role and exact object grants.
-- Run as the database owner after all application migrations. This file never
-- sets a password; provision or rotate that through a separate secret-bearing
-- operator session, then verify the role through /api/ready.

begin;

do $maintainflow_runtime_role$
declare
  app_oid oid;
  operator_oid oid;
  operator_can_administer boolean;
begin
  select oid, (rolsuper or (rolcreaterole and rolbypassrls))
    into operator_oid, operator_can_administer
  from pg_catalog.pg_roles
  where rolname = current_user;

  if not coalesce(operator_can_administer, false) then
    raise exception 'The executing role cannot safely provision maintainflow_app';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_roles where rolname = 'maintainflow_app'
  ) then
    create role maintainflow_app login noinherit bypassrls connection limit 10;
  end if;

  select oid into app_oid
  from pg_catalog.pg_roles
  where rolname = 'maintainflow_app';

  if exists (
    select 1
    from pg_catalog.pg_roles
    where oid = app_oid
      and (rolsuper or rolcreatedb or rolcreaterole or rolreplication)
  ) then
    raise exception 'maintainflow_app has prohibited elevated attributes';
  end if;

  if exists (
    select 1 from pg_catalog.pg_auth_members where member = app_oid
  ) then
    raise exception 'maintainflow_app has an unexpected role membership';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles member_role
      on member_role.oid = membership.member
    where membership.roleid = app_oid
      and (
        member_role.rolname <> 'postgres'
        or not membership.admin_option
        or membership.inherit_option
        or membership.set_option
      )
  ) then
    raise exception 'maintainflow_app has an unexpected incoming membership';
  end if;
end
$maintainflow_runtime_role$;

alter role maintainflow_app
  with login noinherit bypassrls connection limit 10;
alter role maintainflow_app set search_path = pg_catalog, public;
-- Supavisor transaction mode does not preserve client session SET commands.
-- Role defaults therefore provide the production-enforced query bounds.
alter role maintainflow_app set statement_timeout = '20s';
alter role maintainflow_app set lock_timeout = '18s';
alter role maintainflow_app set idle_in_transaction_session_timeout = '30s';

do $maintainflow_runtime_database$
begin
  execute format(
    'revoke all privileges on database %I from maintainflow_app',
    current_database()
  );
  execute format(
    'grant connect on database %I to maintainflow_app',
    current_database()
  );
end
$maintainflow_runtime_database$;

revoke all privileges on schema public from maintainflow_app;
revoke all privileges on all tables in schema public from maintainflow_app;
revoke all privileges on all sequences in schema public from maintainflow_app;
revoke all privileges on all functions in schema public from maintainflow_app;

-- Table-level REVOKE does not remove stale column ACLs. Clear every current
-- public-table column before applying the reviewed table-level grants.
do $maintainflow_runtime_column_privileges$
declare
  target record;
begin
  for target in
    select namespace.nspname as schema_name,
      relation.relname as table_name,
      string_agg(format('%I', attribute.attname), ', ' order by attribute.attnum)
        as column_names
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = relation.oid
    where namespace.nspname = 'public'
      and relation.relkind in ('r', 'p')
      and attribute.attnum > 0
      and not attribute.attisdropped
    group by namespace.nspname, relation.relname
  loop
    execute format(
      'revoke all privileges (%s) on table %I.%I from maintainflow_app',
      target.column_names,
      target.schema_name,
      target.table_name
    );
  end loop;
end
$maintainflow_runtime_column_privileges$;

alter default privileges in schema public
  revoke all privileges on tables from maintainflow_app;
alter default privileges in schema public
  revoke all privileges on sequences from maintainflow_app;
alter default privileges in schema public
  revoke all privileges on functions from maintainflow_app;

grant usage on schema public to maintainflow_app;

grant select on table
  public.ads_approval_records,
  public.maintainflow_organizations,
  public.maintainflow_organization_memberships,
  public.maintainflow_advertiser_accounts,
  public.maintainflow_account_access,
  public.maintainflow_advertiser_credentials,
  public.maintainflow_creative_review_state,
  public.maintainflow_creative_review_events,
  public.maintainflow_rate_limit_buckets,
  public.maintainflow_recommendation_dismissals,
  public.maintainflow_conversion_credentials,
  public.maintainflow_readiness_audit_runs,
  public.maintainflow_live_workbench_snapshots,
  public.maintainflow_customer_lifecycle_records,
  public.maintainflow_monitoring_account_schedule,
  public.maintainflow_schema_migrations
  to maintainflow_app;

grant insert on table
  public.ads_approval_records,
  public.maintainflow_organizations,
  public.maintainflow_organization_memberships,
  public.maintainflow_advertiser_accounts,
  public.maintainflow_account_access,
  public.maintainflow_advertiser_credentials,
  public.maintainflow_creative_review_state,
  public.maintainflow_creative_review_events,
  public.maintainflow_rate_limit_buckets,
  public.maintainflow_recommendation_dismissals,
  public.maintainflow_conversion_credentials,
  public.maintainflow_readiness_audit_runs,
  public.maintainflow_live_workbench_snapshots,
  public.maintainflow_monitoring_account_schedule
  to maintainflow_app;

grant update on table
  public.ads_approval_records,
  public.maintainflow_advertiser_accounts,
  public.maintainflow_advertiser_credentials,
  public.maintainflow_creative_review_state,
  public.maintainflow_rate_limit_buckets,
  public.maintainflow_recommendation_dismissals,
  public.maintainflow_conversion_credentials,
  public.maintainflow_live_workbench_snapshots,
  public.maintainflow_monitoring_account_schedule
  to maintainflow_app;

grant delete on table
  public.maintainflow_rate_limit_buckets,
  public.maintainflow_live_workbench_snapshots
  to maintainflow_app;

do $maintainflow_runtime_invariants$
declare
  expected_tables text[] := array[
    'ads_approval_records',
    'maintainflow_organizations',
    'maintainflow_organization_memberships',
    'maintainflow_advertiser_accounts',
    'maintainflow_account_access',
    'maintainflow_advertiser_credentials',
    'maintainflow_creative_review_state',
    'maintainflow_creative_review_events',
    'maintainflow_rate_limit_buckets',
    'maintainflow_recommendation_dismissals',
    'maintainflow_conversion_credentials',
    'maintainflow_readiness_audit_runs',
    'maintainflow_live_workbench_snapshots',
    'maintainflow_customer_lifecycle_records',
    'maintainflow_monitoring_account_schedule',
    'maintainflow_schema_migrations'
  ];
  app_oid oid := (
    select oid from pg_catalog.pg_roles where rolname = 'maintainflow_app'
  );
begin
  if not coalesce((
    select role.rolconfig @> array[
      'statement_timeout=20s',
      'lock_timeout=18s',
      'idle_in_transaction_session_timeout=30s'
    ]::text[]
    from pg_catalog.pg_roles role
    where role.oid = app_oid
  ), false) then
    raise exception 'maintainflow_app role timeout invariant failed';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(expected_tables)
      and relation.relkind in ('r', 'p')
      and relation.relrowsecurity
      and relation.relowner <> app_oid
  ) <> cardinality(expected_tables) then
    raise exception 'Expected all MaintainFlow tables to use RLS with a separate owner';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_policy policy
    join pg_catalog.pg_class relation on relation.oid = policy.polrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = any(expected_tables)
  ) then
    raise exception 'MaintainFlow zero-policy RLS invariant failed';
  end if;
end
$maintainflow_runtime_invariants$;

commit;
