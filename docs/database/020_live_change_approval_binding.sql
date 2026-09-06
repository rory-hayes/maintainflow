-- Bind every new agency live-write record to the exact independently reviewed
-- packet in the same transaction. Existing approval rows remain readable even
-- though they predate the fingerprint column; every new row must provide it.
alter table public.ads_approval_records
  add column recommendation_approval_fingerprint char(64);

alter table public.ads_approval_records
  add constraint ads_approval_records_approval_fingerprint_check
  check (
    recommendation_approval_fingerprint is null
    or recommendation_approval_fingerprint::text ~ '^[a-f0-9]{64}$'
  );

-- Approved live packets remain historical decisions after their execution
-- window closes or their approver loses eligibility. A separate retirement
-- marker removes those packets from the live uniqueness/execution boundary
-- without rewriting the independent approval decision into another status.
alter table public.maintainflow_change_approval_requests
  add column retired_at timestamptz;

alter table public.maintainflow_change_approval_requests
  add constraint maintainflow_change_approval_requests_retirement_check
  check (
    retired_at is null
    or (
      source = 'live'
      and status = 'approved'
      and ads_approval_record_id is null
    )
  );

create or replace function
  public.maintainflow_enforce_change_approval_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_change_approval_transition$
declare
  current_approver_role text;
begin
  if row(
    new.id,
    new.organization_id,
    new.advertiser_account_id,
    new.account_id_snapshot,
    new.account_name_snapshot,
    new.source,
    new.recommendation_id,
    new.recommendation_title,
    new.entity_id,
    new.recommendation_fingerprint,
    new.decision_context,
    new.request_payload,
    new.rollback_payload,
    new.evidence_payload,
    new.safeguard,
    new.requester_operator_id,
    new.requester_name_snapshot,
    new.requester_membership_role,
    new.request_note,
    new.requested_at,
    new.expires_at,
    new.created_at
  ) is distinct from row(
    old.id,
    old.organization_id,
    old.advertiser_account_id,
    old.account_id_snapshot,
    old.account_name_snapshot,
    old.source,
    old.recommendation_id,
    old.recommendation_title,
    old.entity_id,
    old.recommendation_fingerprint,
    old.decision_context,
    old.request_payload,
    old.rollback_payload,
    old.evidence_payload,
    old.safeguard,
    old.requester_operator_id,
    old.requester_name_snapshot,
    old.requester_membership_role,
    old.request_note,
    old.requested_at,
    old.expires_at,
    old.created_at
  ) then
    raise exception 'Approval request evidence is immutable after creation';
  end if;

  if new.version <> old.version + 1 then
    raise exception 'Approval request updates must advance the version exactly once';
  end if;
  if new.updated_at < old.updated_at then
    raise exception 'Approval request update time cannot move backwards';
  end if;

  if old.status = 'awaiting_approval' then
    if new.retired_at is not null then
      raise exception 'Only an approved live packet can be retired';
    end if;
    if old.ads_approval_record_id is not null
      or new.ads_approval_record_id is not null then
      raise exception
        'An awaiting approval request cannot link an execution record';
    end if;
    if old.source = 'live'
      and old.decision_context ->> 'schemaVersion' is distinct from '2'
      and new.status <> 'expired' then
      raise exception
        'An incompatible live review packet can only be expired';
    end if;
    if new.status not in (
      'approved',
      'changes_requested',
      'cancelled',
      'expired'
    ) then
      raise exception 'Approval requests may leave awaiting approval only once';
    end if;
  elsif old.source = 'live'
    and old.status = 'approved'
    and new.status = 'approved' then
    if row(
      new.decision_operator_id,
      new.decision_name_snapshot,
      new.decision_membership_role,
      new.decision_note,
      new.decided_at
    ) is distinct from row(
      old.decision_operator_id,
      old.decision_name_snapshot,
      old.decision_membership_role,
      old.decision_note,
      old.decided_at
    ) then
      raise exception 'A live approval lifecycle update cannot rewrite the approval decision';
    end if;

    if old.retired_at is null
      and new.retired_at is null
      and old.ads_approval_record_id is null
      and new.ads_approval_record_id is not null then
      -- The separate live-link trigger validates the exact approval record.
      null;
    elsif old.retired_at is null
      and new.retired_at is not null
      and old.ads_approval_record_id is null
      and new.ads_approval_record_id is null then
      select membership.role
        into current_approver_role
      from public.maintainflow_organization_memberships membership
      where membership.organization_id = old.organization_id
        and membership.clerk_user_id = old.decision_operator_id
      for update;

      if old.expires_at > pg_catalog.statement_timestamp()
        and current_approver_role in ('owner', 'admin')
        and old.decision_context ->> 'schemaVersion' = '2' then
        raise exception
          'An approved live packet can be retired only after expiry, approver ineligibility, or decision-schema incompatibility';
      end if;
      if new.retired_at is distinct from pg_catalog.statement_timestamp() then
        raise exception 'Live approval retirement must use database time';
      end if;
    else
      raise exception
        'An approved live packet permits only one exact execution link or one-way retirement';
    end if;
  else
    raise exception 'Terminal approval requests cannot be rewritten';
  end if;

  return new;
end
$maintainflow_change_approval_transition$;

create function public.maintainflow_enforce_ads_approval_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_ads_approval_identity$
begin
  if tg_op = 'INSERT' then
    if new.recommendation_approval_fingerprint is null
      or new.recommendation_approval_fingerprint::text
        !~ '^[a-f0-9]{64}$' then
      raise exception
        'New approval records require an exact recommendation approval fingerprint';
    end if;
    if new.acting_organization_id is null then
      raise exception
        'New approval records require an acting organization';
    end if;
    return new;
  end if;

  if row(
    new.id,
    new.account_id,
    new.operator_id,
    new.acting_organization_id,
    new.actor_membership_role,
    new.actor_account_role,
    new.recommendation_id,
    new.recommendation_title,
    new.entity_id,
    new.recommendation_approval_fingerprint,
    new.request_payload,
    new.rollback_payload,
    new.evidence_payload,
    new.safeguard,
    new.monitoring_plan,
    new.monitoring_window_days,
    new.apply_provider_attempt_id,
    new.created_at
  ) is distinct from row(
    old.id,
    old.account_id,
    old.operator_id,
    old.acting_organization_id,
    old.actor_membership_role,
    old.actor_account_role,
    old.recommendation_id,
    old.recommendation_title,
    old.entity_id,
    old.recommendation_approval_fingerprint,
    old.request_payload,
    old.rollback_payload,
    old.evidence_payload,
    old.safeguard,
    old.monitoring_plan,
    old.monitoring_window_days,
    old.apply_provider_attempt_id,
    old.created_at
  ) then
    raise exception 'Approval identity and evidence are immutable after creation';
  end if;

  return new;
end
$maintainflow_ads_approval_identity$;

create trigger maintainflow_ads_approval_identity_guard
before insert or update on public.ads_approval_records
for each row execute function
  public.maintainflow_enforce_ads_approval_identity();

create function public.maintainflow_enforce_change_approval_insert()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_change_approval_insert$
begin
  if new.status <> 'awaiting_approval'
    or new.version <> 1
    or new.decision_operator_id is not null
    or new.decision_name_snapshot is not null
    or new.decision_membership_role is not null
    or new.decision_note is not null
    or new.decided_at is not null
    or new.retired_at is not null
    or new.ads_approval_record_id is not null
    or (
      new.source = 'live'
      and new.decision_context ->> 'schemaVersion' is distinct from '2'
    ) then
    raise exception
      'New approval requests must start awaiting approval with no decision or execution link';
  end if;

  return new;
end
$maintainflow_change_approval_insert$;

create trigger maintainflow_change_approval_insert_guard
before insert on public.maintainflow_change_approval_requests
for each row execute function
  public.maintainflow_enforce_change_approval_insert();

-- A legacy live decision context cannot carry the complete executable review
-- packet. Expire legacy awaiting rows, and retire legacy or already-expired
-- approvals without rewriting decisions.
update public.maintainflow_change_approval_requests set
  status = 'expired',
  version = version + 1,
  updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
where source = 'live'
  and status = 'awaiting_approval'
  and decision_context ->> 'schemaVersion' is distinct from '2';

update public.maintainflow_change_approval_requests set
  retired_at = pg_catalog.statement_timestamp(),
  version = version + 1,
  updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
where source = 'live'
  and status = 'approved'
  and ads_approval_record_id is null
  and retired_at is null
  and (
    expires_at <= pg_catalog.statement_timestamp()
    or decision_context ->> 'schemaVersion' is distinct from '2'
  );

-- An active unconsumed live packet remains unique while it is awaiting review
-- or approved. Linking or retiring it permits a later fresh packet.
create unique index maintainflow_change_approval_requests_live_unconsumed_idx
  on public.maintainflow_change_approval_requests (
    organization_id,
    advertiser_account_id,
    recommendation_id,
    entity_id,
    recommendation_fingerprint
  )
  where source = 'live'
    and status in ('awaiting_approval', 'approved')
    and ads_approval_record_id is null
    and retired_at is null;

create function public.maintainflow_validate_change_approval_link()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_change_approval_link$
begin
  if old.ads_approval_record_id is null
    and new.ads_approval_record_id is not null then
    if not exists (
      select 1
      from public.ads_approval_records approval
      join public.maintainflow_organizations organization
        on organization.id = new.organization_id
      join public.maintainflow_advertiser_accounts advertiser_account
        on advertiser_account.id = new.advertiser_account_id
      join public.maintainflow_account_access executor_access
        on executor_access.organization_id = new.organization_id
        and executor_access.advertiser_account_id = advertiser_account.id
      join public.maintainflow_organization_memberships executor_membership
        on executor_membership.organization_id = new.organization_id
        and executor_membership.clerk_user_id = approval.operator_id
      join public.maintainflow_organization_memberships reviewer_membership
        on reviewer_membership.organization_id = new.organization_id
        and reviewer_membership.clerk_user_id = new.decision_operator_id
      where approval.id = new.ads_approval_record_id
        and new.source = 'live'
        and new.status = 'approved'
        and new.retired_at is null
        and new.decision_context ->> 'schemaVersion' = '2'
        and new.expires_at > pg_catalog.statement_timestamp()
        and organization.customer_type = 'agency'
        and organization.status = 'active'
        and advertiser_account.status = 'active'
        and advertiser_account.external_account_id = new.account_id_snapshot
        and executor_access.role in ('owner', 'manager')
        and executor_access.role = approval.actor_account_role
        and executor_membership.role in ('owner', 'admin')
        and executor_membership.role = approval.actor_membership_role
        and reviewer_membership.role in ('owner', 'admin')
        and approval.acting_organization_id = new.organization_id
        and approval.account_id = new.account_id_snapshot
        and approval.recommendation_id = new.recommendation_id
        and approval.recommendation_title = new.recommendation_title
        and approval.entity_id = new.entity_id
        and approval.recommendation_approval_fingerprint =
          new.recommendation_fingerprint
        and approval.request_payload = new.request_payload
        and approval.rollback_payload = new.rollback_payload
        and approval.evidence_payload = new.evidence_payload
        and approval.safeguard = new.safeguard
        and approval.monitoring_plan is not distinct from nullif(
          new.decision_context -> 'monitoringPlan',
          'null'::jsonb
        )
        and pg_catalog.to_jsonb(approval.monitoring_window_days)
          is not distinct from nullif(
            new.decision_context #> '{monitoringPlan,windowDays}',
            'null'::jsonb
          )
        and approval.status = 'pending'
        and approval.apply_provider_attempt_id = approval.id
        and approval.apply_provider_attempted_at is null
        and approval.response_payload is null
        and approval.error_message is null
        and approval.applied_at is null
    ) then
      raise exception
        'A live execution link must match one active, unexpired, approved agency packet exactly';
    end if;
  end if;

  return new;
end
$maintainflow_change_approval_link$;

create trigger maintainflow_change_approval_execution_binding_guard
before update on public.maintainflow_change_approval_requests
for each row execute function
  public.maintainflow_validate_change_approval_link();

create function public.maintainflow_require_agency_approval_binding()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_require_agency_approval_binding$
declare
  acting_organization_type text;
  acting_organization_status text;
  valid_binding_count integer;
begin
  select organization.customer_type, organization.status
    into acting_organization_type, acting_organization_status
  from public.maintainflow_organizations organization
  where organization.id = new.acting_organization_id;

  if acting_organization_type is null
    or acting_organization_status <> 'active' then
    raise exception
      'New approval records require an active acting organization';
  end if;

  if acting_organization_type = 'agency' then
    select count(*)::integer
      into valid_binding_count
    from public.maintainflow_change_approval_requests request
    join public.maintainflow_advertiser_accounts advertiser_account
      on advertiser_account.id = request.advertiser_account_id
    join public.maintainflow_account_access executor_access
      on executor_access.organization_id = request.organization_id
      and executor_access.advertiser_account_id = advertiser_account.id
    join public.maintainflow_organization_memberships executor_membership
      on executor_membership.organization_id = request.organization_id
      and executor_membership.clerk_user_id = new.operator_id
    join public.maintainflow_organization_memberships reviewer_membership
      on reviewer_membership.organization_id = request.organization_id
      and reviewer_membership.clerk_user_id = request.decision_operator_id
    where request.ads_approval_record_id = new.id
      and request.source = 'live'
      and request.status = 'approved'
      and request.retired_at is null
      and request.decision_context ->> 'schemaVersion' = '2'
      and request.expires_at > pg_catalog.statement_timestamp()
      and request.organization_id = new.acting_organization_id
      and advertiser_account.status = 'active'
      and advertiser_account.external_account_id = request.account_id_snapshot
      and executor_access.role in ('owner', 'manager')
      and executor_access.role = new.actor_account_role
      and executor_membership.role in ('owner', 'admin')
      and executor_membership.role = new.actor_membership_role
      and reviewer_membership.role in ('owner', 'admin')
      and new.account_id = request.account_id_snapshot
      and new.recommendation_id = request.recommendation_id
      and new.recommendation_title = request.recommendation_title
      and new.entity_id = request.entity_id
      and new.recommendation_approval_fingerprint =
        request.recommendation_fingerprint
      and new.request_payload = request.request_payload
      and new.rollback_payload = request.rollback_payload
      and new.evidence_payload = request.evidence_payload
      and new.safeguard = request.safeguard
      and new.monitoring_plan is not distinct from nullif(
        request.decision_context -> 'monitoringPlan',
        'null'::jsonb
      )
      and pg_catalog.to_jsonb(new.monitoring_window_days)
        is not distinct from nullif(
          request.decision_context #> '{monitoringPlan,windowDays}',
          'null'::jsonb
        )
      and new.status = 'pending'
      and new.apply_provider_attempt_id = new.id
      and new.apply_provider_attempted_at is null
      and new.response_payload is null
      and new.error_message is null
      and new.applied_at is null;

    if valid_binding_count <> 1 then
      raise exception
        'Every new agency approval requires exactly one valid live approval request at commit';
    end if;
  elsif acting_organization_type = 'advertiser' then
    select count(*)::integer
      into valid_binding_count
    from public.maintainflow_advertiser_accounts advertiser_account
    join public.maintainflow_account_access executor_access
      on executor_access.organization_id = new.acting_organization_id
      and executor_access.advertiser_account_id = advertiser_account.id
    join public.maintainflow_organization_memberships executor_membership
      on executor_membership.organization_id = new.acting_organization_id
      and executor_membership.clerk_user_id = new.operator_id
    where advertiser_account.external_account_id = new.account_id
      and advertiser_account.owner_organization_id =
        new.acting_organization_id
      and advertiser_account.status = 'active'
      and executor_access.role in ('owner', 'manager')
      and executor_access.role = new.actor_account_role
      and executor_membership.role in ('owner', 'admin')
      and executor_membership.role = new.actor_membership_role;

    if valid_binding_count <> 1 then
      raise exception
        'A direct-advertiser approval requires exact current account ownership and write access';
    end if;

    if exists (
      select 1
      from public.maintainflow_change_approval_requests request
      where request.ads_approval_record_id = new.id
    ) then
      raise exception
        'Direct-advertiser approvals cannot consume an agency approval request';
    end if;
  else
    raise exception 'Approval records require a supported organization type';
  end if;

  return null;
end
$maintainflow_require_agency_approval_binding$;

create constraint trigger maintainflow_ads_approval_agency_binding_guard
after insert on public.ads_approval_records
deferrable initially deferred
for each row execute function
  public.maintainflow_require_agency_approval_binding();

-- PostgreSQL requires UPDATE privilege on at least one column of every table
-- named by SELECT ... FOR UPDATE. The runtime role receives one key-column
-- privilege on each immutable authorization table in its separate role setup.
-- These guards make that privilege lock-only: a no-op update may acquire the
-- same row lock, but any material value change by the runtime login is rejected.
create function public.maintainflow_enforce_runtime_lock_only_update()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_runtime_lock_only_update$
begin
  if (
    session_user = 'maintainflow_app'
    or current_user = 'maintainflow_app'
  ) and new is distinct from old then
    raise exception
      'The MaintainFlow runtime may lock authorization rows but cannot change them';
  end if;

  return new;
end
$maintainflow_runtime_lock_only_update$;

create trigger maintainflow_organizations_runtime_lock_only_guard
before update on public.maintainflow_organizations
for each row execute function
  public.maintainflow_enforce_runtime_lock_only_update();

create trigger maintainflow_memberships_runtime_lock_only_guard
before update on public.maintainflow_organization_memberships
for each row execute function
  public.maintainflow_enforce_runtime_lock_only_update();

create trigger maintainflow_account_access_runtime_lock_only_guard
before update on public.maintainflow_account_access
for each row execute function
  public.maintainflow_enforce_runtime_lock_only_update();

revoke all privileges on function
  public.maintainflow_enforce_ads_approval_identity()
from public;
revoke all privileges on function
  public.maintainflow_enforce_change_approval_insert()
from public;
revoke all privileges on function
  public.maintainflow_validate_change_approval_link()
from public;
revoke all privileges on function
  public.maintainflow_require_agency_approval_binding()
from public;
revoke all privileges on function
  public.maintainflow_enforce_runtime_lock_only_update()
from public;
revoke all privileges on function
  public.maintainflow_enforce_change_approval_transition()
from public;

do $maintainflow_revoke_live_approval_function_roles$
declare
  api_role text;
  function_name text;
begin
  foreach api_role in array array[
    'anon',
    'authenticated',
    'service_role',
    'maintainflow_app'
  ]
  loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = api_role
    ) then
      foreach function_name in array array[
        'maintainflow_enforce_ads_approval_identity',
        'maintainflow_enforce_change_approval_insert',
        'maintainflow_validate_change_approval_link',
        'maintainflow_require_agency_approval_binding',
        'maintainflow_enforce_runtime_lock_only_update',
        'maintainflow_enforce_change_approval_transition'
      ]
      loop
        execute format(
          'revoke all privileges on function public.%I() from %I',
          function_name,
          api_role
        );
      end loop;
    end if;
  end loop;
end
$maintainflow_revoke_live_approval_function_roles$;
