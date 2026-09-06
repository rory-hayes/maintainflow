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
  public.maintainflow_change_approval_requests,
  public.maintainflow_approval_notification_deliveries,
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
  public.maintainflow_ads_config_integrity_state,
  public.maintainflow_ads_config_integrity_events,
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
  public.maintainflow_ads_config_integrity_state,
  public.maintainflow_ads_config_integrity_events,
  public.maintainflow_monitoring_account_schedule
  to maintainflow_app;

-- The request always starts in the database-defined awaiting/version-one
-- state. The runtime cannot provide a decision, terminal status, version,
-- timestamps, or an execution link at insert time.
grant insert (
  id,
  organization_id,
  advertiser_account_id,
  account_id_snapshot,
  account_name_snapshot,
  source,
  recommendation_id,
  recommendation_title,
  entity_id,
  recommendation_fingerprint,
  decision_context,
  request_payload,
  rollback_payload,
  evidence_payload,
  safeguard,
  requester_operator_id,
  requester_name_snapshot,
  requester_membership_role,
  request_note,
  requested_at,
  expires_at
) on table public.maintainflow_change_approval_requests
  to maintainflow_app;

-- The producer supplies only the immutable request/event/recipient identity.
-- Database defaults and the lifecycle trigger own queue and delivery state.
grant insert (
  id,
  approval_request_id,
  organization_id,
  event_type,
  recipient_operator_id,
  recipient_membership_role_snapshot,
  approval_request_version
) on table public.maintainflow_approval_notification_deliveries
  to maintainflow_app;

grant update on table
  public.maintainflow_advertiser_accounts,
  public.maintainflow_advertiser_credentials,
  public.maintainflow_creative_review_state,
  public.maintainflow_rate_limit_buckets,
  public.maintainflow_recommendation_dismissals,
  public.maintainflow_conversion_credentials,
  public.maintainflow_live_workbench_snapshots,
  public.maintainflow_monitoring_account_schedule
  to maintainflow_app;

-- The approval's account, actors, recommendation, reviewed payloads,
-- safeguard, monitoring baseline, apply-attempt identity, and fingerprint are
-- immutable. Only operation, rollback, reconciliation, and monitoring
-- lifecycle state may advance.
grant update (
  status,
  response_payload,
  error_message,
  rollback_operator_id,
  rollback_response_payload,
  rollback_error_message,
  reconciled_by,
  reconciled_at,
  reconciliation_note,
  updated_at,
  applied_at,
  rolled_back_at,
  monitoring_started_at,
  monitoring_ends_at,
  monitoring_outcome,
  monitoring_observation,
  monitoring_evaluated_at,
  monitoring_evaluation_claim_id,
  monitoring_evaluation_claimed_at,
  apply_provider_attempted_at,
  rollback_provider_attempted_at,
  rollback_provider_attempt_id,
  rollback_organization_id,
  rollback_membership_role,
  rollback_account_role,
  reconciled_organization_id,
  reconciled_membership_role,
  reconciled_account_role
) on table public.ads_approval_records
  to maintainflow_app;

-- Approval packets are immutable after insert. The runtime may move only the
-- decision/lifecycle fields; it cannot rewrite the reviewed account, actor,
-- request, rollback, evidence, safeguard, or fingerprint snapshots.
grant update (
  status,
  decision_operator_id,
  decision_name_snapshot,
  decision_membership_role,
  decision_note,
  decided_at,
  version,
  updated_at,
  retired_at,
  ads_approval_record_id
) on table public.maintainflow_change_approval_requests
  to maintainflow_app;

-- Workers provide only bounded lifecycle commands. Migration 021 derives
-- attempts, leases, retry times, provider acceptance, and audit timestamps.
grant update (
  status,
  claim_id,
  provider_message_id,
  last_failure_code,
  provider_event_type,
  provider_event_at,
  cancellation_code
) on table public.maintainflow_approval_notification_deliveries
  to maintainflow_app;

-- The integrity-state account identity and creation time are immutable. The
-- runtime may advance only the versioned confirmed baseline and database-owned
-- update timestamp.
grant update (
  projection_version,
  snapshot_fingerprint,
  snapshot_payload,
  snapshot_resource_count,
  observed_at,
  updated_at
) on table public.maintainflow_ads_config_integrity_state
  to maintainflow_app;

-- Integrity event evidence is immutable. Reviewers may submit only the
-- one-way acknowledgement inputs; migration 022 derives role snapshots and
-- database time after re-checking current account write authority.
grant update (
  review_status,
  reviewed_by_operator_id,
  reviewed_by_name,
  reviewed_by_organization_id,
  review_note
) on table public.maintainflow_ads_config_integrity_events
  to maintainflow_app;

-- PostgreSQL checks UPDATE privilege for SELECT ... FOR UPDATE. These single
-- key-column grants permit row locking on the immutable authorization tables;
-- migration 020's BEFORE UPDATE guards reject every material runtime change.
grant update (id) on table public.maintainflow_organizations
  to maintainflow_app;
grant update (organization_id) on table
  public.maintainflow_organization_memberships
  to maintainflow_app;
grant update (organization_id) on table public.maintainflow_account_access
  to maintainflow_app;

grant delete on table
  public.maintainflow_rate_limit_buckets,
  public.maintainflow_live_workbench_snapshots
  to maintainflow_app;

do $maintainflow_runtime_invariants$
declare
  expected_tables text[] := array[
    'ads_approval_records',
    'maintainflow_change_approval_requests',
    'maintainflow_approval_notification_deliveries',
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
    'maintainflow_ads_config_integrity_state',
    'maintainflow_ads_config_integrity_events',
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

  if has_table_privilege(
    'maintainflow_app',
    'public.maintainflow_change_approval_requests',
    'INSERT'
  ) then
    raise exception 'Approval requests unexpectedly have table-level INSERT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.maintainflow_change_approval_requests'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname <> all(array[
        'id',
        'organization_id',
        'advertiser_account_id',
        'account_id_snapshot',
        'account_name_snapshot',
        'source',
        'recommendation_id',
        'recommendation_title',
        'entity_id',
        'recommendation_fingerprint',
        'decision_context',
        'request_payload',
        'rollback_payload',
        'evidence_payload',
        'safeguard',
        'requester_operator_id',
        'requester_name_snapshot',
        'requester_membership_role',
        'request_note',
        'requested_at',
        'expires_at'
      ])
      and has_column_privilege(
        'maintainflow_app',
        'public.maintainflow_change_approval_requests',
        attribute.attname,
        'INSERT'
      )
  ) then
    raise exception 'A database-owned approval-request column is insertable';
  end if;

  if exists (
    select 1
    from unnest(array[
      'id',
      'organization_id',
      'advertiser_account_id',
      'account_id_snapshot',
      'account_name_snapshot',
      'source',
      'recommendation_id',
      'recommendation_title',
      'entity_id',
      'recommendation_fingerprint',
      'decision_context',
      'request_payload',
      'rollback_payload',
      'evidence_payload',
      'safeguard',
      'requester_operator_id',
      'requester_name_snapshot',
      'requester_membership_role',
      'request_note',
      'requested_at',
      'expires_at'
    ]) expected_column(column_name)
    where not has_column_privilege(
      'maintainflow_app',
      'public.maintainflow_change_approval_requests',
      expected_column.column_name,
      'INSERT'
    )
  ) then
    raise exception 'A required approval-request input column is not insertable';
  end if;

  if has_table_privilege(
    'maintainflow_app',
    'public.maintainflow_approval_notification_deliveries',
    'INSERT'
  ) then
    raise exception
      'Approval notifications unexpectedly have table-level INSERT';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.maintainflow_approval_notification_deliveries'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname <> all(array[
        'id',
        'approval_request_id',
        'organization_id',
        'event_type',
        'recipient_operator_id',
        'recipient_membership_role_snapshot',
        'approval_request_version'
      ])
      and has_column_privilege(
        'maintainflow_app',
        'public.maintainflow_approval_notification_deliveries',
        attribute.attname,
        'INSERT'
      )
  ) then
    raise exception
      'A database-owned approval-notification column is insertable';
  end if;

  if exists (
    select 1
    from unnest(array[
      'id',
      'approval_request_id',
      'organization_id',
      'event_type',
      'recipient_operator_id',
      'recipient_membership_role_snapshot',
      'approval_request_version'
    ]) expected_column(column_name)
    where not has_column_privilege(
      'maintainflow_app',
      'public.maintainflow_approval_notification_deliveries',
      expected_column.column_name,
      'INSERT'
    )
  ) then
    raise exception
      'A required approval-notification identity column is not insertable';
  end if;

  if has_table_privilege(
    'maintainflow_app',
    'public.maintainflow_change_approval_requests',
    'UPDATE'
  ) then
    raise exception 'Approval requests unexpectedly have table-level UPDATE';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.maintainflow_change_approval_requests'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname <> all(array[
        'status',
        'decision_operator_id',
        'decision_name_snapshot',
        'decision_membership_role',
        'decision_note',
        'decided_at',
        'version',
        'updated_at',
        'retired_at',
        'ads_approval_record_id'
      ])
      and has_column_privilege(
        'maintainflow_app',
        'public.maintainflow_change_approval_requests',
        attribute.attname,
        'UPDATE'
      )
  ) then
    raise exception 'An immutable approval-request column is updateable';
  end if;

  if exists (
    select 1
    from unnest(array[
      'status',
      'decision_operator_id',
      'decision_name_snapshot',
      'decision_membership_role',
      'decision_note',
      'decided_at',
      'version',
      'updated_at',
      'retired_at',
      'ads_approval_record_id'
    ]) expected_column(column_name)
    where not has_column_privilege(
      'maintainflow_app',
      'public.maintainflow_change_approval_requests',
      expected_column.column_name,
      'UPDATE'
    )
  ) then
    raise exception 'An approval-request lifecycle column is not updateable';
  end if;

  if has_table_privilege(
    'maintainflow_app',
    'public.maintainflow_approval_notification_deliveries',
    'UPDATE'
  ) then
    raise exception
      'Approval notifications unexpectedly have table-level UPDATE';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.maintainflow_approval_notification_deliveries'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname <> all(array[
        'status',
        'claim_id',
        'provider_message_id',
        'last_failure_code',
        'provider_event_type',
        'provider_event_at',
        'cancellation_code'
      ])
      and has_column_privilege(
        'maintainflow_app',
        'public.maintainflow_approval_notification_deliveries',
        attribute.attname,
        'UPDATE'
      )
  ) then
    raise exception
      'An immutable approval-notification column is updateable';
  end if;

  if exists (
    select 1
    from unnest(array[
      'status',
      'claim_id',
      'provider_message_id',
      'last_failure_code',
      'provider_event_type',
      'provider_event_at',
      'cancellation_code'
    ]) expected_column(column_name)
    where not has_column_privilege(
      'maintainflow_app',
      'public.maintainflow_approval_notification_deliveries',
      expected_column.column_name,
      'UPDATE'
    )
  ) then
    raise exception
      'An approval-notification lifecycle command column is not updateable';
  end if;

  if has_table_privilege(
    'maintainflow_app',
    'public.maintainflow_ads_config_integrity_state',
    'UPDATE'
  ) then
    raise exception
      'Change-integrity state unexpectedly has table-level UPDATE';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.maintainflow_ads_config_integrity_state'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname <> all(array[
        'projection_version',
        'snapshot_fingerprint',
        'snapshot_payload',
        'snapshot_resource_count',
        'observed_at',
        'updated_at'
      ])
      and has_column_privilege(
        'maintainflow_app',
        'public.maintainflow_ads_config_integrity_state',
        attribute.attname,
        'UPDATE'
      )
  ) then
    raise exception 'Immutable change-integrity state is updateable';
  end if;

  if exists (
    select 1
    from unnest(array[
      'projection_version',
      'snapshot_fingerprint',
      'snapshot_payload',
      'snapshot_resource_count',
      'observed_at',
      'updated_at'
    ]) expected_column(column_name)
    where not has_column_privilege(
      'maintainflow_app',
      'public.maintainflow_ads_config_integrity_state',
      expected_column.column_name,
      'UPDATE'
    )
  ) then
    raise exception 'A change-integrity baseline field is not updateable';
  end if;

  if has_table_privilege(
    'maintainflow_app',
    'public.maintainflow_ads_config_integrity_events',
    'UPDATE'
  ) then
    raise exception
      'Change-integrity events unexpectedly have table-level UPDATE';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid =
      'public.maintainflow_ads_config_integrity_events'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname <> all(array[
        'review_status',
        'reviewed_by_operator_id',
        'reviewed_by_name',
        'reviewed_by_organization_id',
        'review_note'
      ])
      and has_column_privilege(
        'maintainflow_app',
        'public.maintainflow_ads_config_integrity_events',
        attribute.attname,
        'UPDATE'
      )
  ) then
    raise exception 'Immutable change-integrity evidence is updateable';
  end if;

  if exists (
    select 1
    from unnest(array[
      'review_status',
      'reviewed_by_operator_id',
      'reviewed_by_name',
      'reviewed_by_organization_id',
      'review_note'
    ]) expected_column(column_name)
    where not has_column_privilege(
      'maintainflow_app',
      'public.maintainflow_ads_config_integrity_events',
      expected_column.column_name,
      'UPDATE'
    )
  ) then
    raise exception 'A change-integrity review input is not updateable';
  end if;

  if has_table_privilege(
    'maintainflow_app',
    'public.ads_approval_records',
    'UPDATE'
  ) then
    raise exception 'Approval records unexpectedly have table-level UPDATE';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.ads_approval_records'::regclass
      and attribute.attnum > 0
      and not attribute.attisdropped
      and attribute.attname <> all(array[
        'status',
        'response_payload',
        'error_message',
        'rollback_operator_id',
        'rollback_response_payload',
        'rollback_error_message',
        'reconciled_by',
        'reconciled_at',
        'reconciliation_note',
        'updated_at',
        'applied_at',
        'rolled_back_at',
        'monitoring_started_at',
        'monitoring_ends_at',
        'monitoring_outcome',
        'monitoring_observation',
        'monitoring_evaluated_at',
        'monitoring_evaluation_claim_id',
        'monitoring_evaluation_claimed_at',
        'apply_provider_attempted_at',
        'rollback_provider_attempted_at',
        'rollback_provider_attempt_id',
        'rollback_organization_id',
        'rollback_membership_role',
        'rollback_account_role',
        'reconciled_organization_id',
        'reconciled_membership_role',
        'reconciled_account_role'
      ])
      and has_column_privilege(
        'maintainflow_app',
        'public.ads_approval_records',
        attribute.attname,
        'UPDATE'
      )
  ) then
    raise exception 'An immutable approval-record column is updateable';
  end if;

  if exists (
    select 1
    from unnest(array[
      'status',
      'response_payload',
      'error_message',
      'rollback_operator_id',
      'rollback_response_payload',
      'rollback_error_message',
      'reconciled_by',
      'reconciled_at',
      'reconciliation_note',
      'updated_at',
      'applied_at',
      'rolled_back_at',
      'monitoring_started_at',
      'monitoring_ends_at',
      'monitoring_outcome',
      'monitoring_observation',
      'monitoring_evaluated_at',
      'monitoring_evaluation_claim_id',
      'monitoring_evaluation_claimed_at',
      'apply_provider_attempted_at',
      'rollback_provider_attempted_at',
      'rollback_provider_attempt_id',
      'rollback_organization_id',
      'rollback_membership_role',
      'rollback_account_role',
      'reconciled_organization_id',
      'reconciled_membership_role',
      'reconciled_account_role'
    ]) expected_column(column_name)
    where not has_column_privilege(
      'maintainflow_app',
      'public.ads_approval_records',
      expected_column.column_name,
      'UPDATE'
    )
  ) then
    raise exception 'An approval-record lifecycle column is not updateable';
  end if;

  if exists (
    with expected_lock_grant(table_name, column_name) as (
      values
        ('maintainflow_organizations', 'id'),
        ('maintainflow_organization_memberships', 'organization_id'),
        ('maintainflow_account_access', 'organization_id')
    )
    select 1
    from expected_lock_grant expected
    where has_table_privilege(
        'maintainflow_app',
        format('public.%I', expected.table_name),
        'UPDATE'
      )
      or not has_column_privilege(
        'maintainflow_app',
        format('public.%I', expected.table_name),
        expected.column_name,
        'UPDATE'
      )
  ) then
    raise exception 'A lock-only authorization grant is missing or too broad';
  end if;

  if exists (
    with expected_lock_grant(table_name, column_name) as (
      values
        ('maintainflow_organizations', 'id'),
        ('maintainflow_organization_memberships', 'organization_id'),
        ('maintainflow_account_access', 'organization_id')
    )
    select 1
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation
      on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    left join expected_lock_grant expected
      on expected.table_name = relation.relname
      and expected.column_name = attribute.attname
    where namespace.nspname = 'public'
      and relation.relname in (
        'maintainflow_organizations',
        'maintainflow_organization_memberships',
        'maintainflow_account_access'
      )
      and attribute.attnum > 0
      and not attribute.attisdropped
      and expected.column_name is null
      and has_column_privilege(
        'maintainflow_app',
        relation.oid,
        attribute.attname,
        'UPDATE'
      )
  ) then
    raise exception 'An authorization table has a non-lock UPDATE grant';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_trigger trigger
    join pg_catalog.pg_class relation
      on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and (relation.relname, trigger.tgname) in (
        (
          'maintainflow_organizations',
          'maintainflow_organizations_runtime_lock_only_guard'
        ),
        (
          'maintainflow_organization_memberships',
          'maintainflow_memberships_runtime_lock_only_guard'
        ),
        (
          'maintainflow_account_access',
          'maintainflow_account_access_runtime_lock_only_guard'
        )
      )
      and not trigger.tgisinternal
      and trigger.tgenabled = 'O'
  ) <> 3 then
    raise exception 'A runtime lock-only authorization guard is missing';
  end if;
end
$maintainflow_runtime_invariants$;

commit;
