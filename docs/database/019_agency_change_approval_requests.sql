create table public.maintainflow_change_approval_requests (
  id uuid primary key,
  organization_id uuid not null
    references public.maintainflow_organizations(id),
  advertiser_account_id uuid
    references public.maintainflow_advertiser_accounts(id),
  account_id_snapshot text not null,
  account_name_snapshot text not null,
  source text not null check (source in ('simulator', 'live')),
  recommendation_id text not null,
  recommendation_title text not null,
  entity_id text not null,
  recommendation_fingerprint char(64) not null check (
    recommendation_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  decision_context jsonb not null check (
    jsonb_typeof(decision_context) = 'object'
  ),
  request_payload jsonb not null,
  rollback_payload jsonb not null,
  evidence_payload jsonb not null,
  safeguard text not null,
  requester_operator_id text not null,
  requester_name_snapshot text not null,
  requester_membership_role text not null check (
    requester_membership_role in ('owner', 'admin', 'analyst')
  ),
  request_note text,
  status text not null default 'awaiting_approval' check (
    status in (
      'awaiting_approval',
      'approved',
      'changes_requested',
      'cancelled',
      'expired'
    )
  ),
  decision_operator_id text,
  decision_name_snapshot text,
  decision_membership_role text check (
    decision_membership_role is null
    or decision_membership_role in ('owner', 'admin', 'analyst')
  ),
  decision_note text,
  requested_at timestamptz not null,
  decided_at timestamptz,
  expires_at timestamptz not null,
  version bigint not null default 1 check (version > 0),
  ads_approval_record_id uuid unique
    references public.ads_approval_records(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(account_id_snapshot) between 1 and 255),
  check (char_length(account_name_snapshot) between 1 and 255),
  check (char_length(recommendation_id) between 1 and 255),
  check (char_length(recommendation_title) between 1 and 500),
  check (char_length(entity_id) between 1 and 255),
  check (char_length(safeguard) between 1 and 2000),
  check (char_length(requester_name_snapshot) between 1 and 120),
  check (request_note is null or char_length(request_note) between 1 and 500),
  check (decision_note is null or char_length(decision_note) between 1 and 500),
  check (expires_at > requested_at),
  check (
    status = 'cancelled'
    or decision_operator_id is null
    or decision_operator_id <> requester_operator_id
  ),
  check (
    (
      status in ('awaiting_approval', 'expired')
      and decision_operator_id is null
      and decision_name_snapshot is null
      and decision_membership_role is null
      and decision_note is null
      and decided_at is null
    )
    or (
      status in ('approved', 'changes_requested', 'cancelled')
      and decision_operator_id is not null
      and decision_name_snapshot is not null
      and decision_membership_role is not null
      and decided_at is not null
    )
  ),
  check (
    status <> 'changes_requested'
    or (
      decision_note is not null
      and char_length(decision_note) >= 10
    )
  ),
  check (
    status not in ('approved', 'changes_requested')
    or decision_membership_role in ('owner', 'admin')
  ),
  check (
    source <> 'simulator'
    or (
      advertiser_account_id is null
      and ads_approval_record_id is null
    )
  ),
  check (
    source <> 'live'
    or advertiser_account_id is not null
  ),
  check (
    ads_approval_record_id is null
    or (source = 'live' and status = 'approved')
  )
);

create unique index maintainflow_change_approval_requests_awaiting_idx
  on public.maintainflow_change_approval_requests (
    organization_id,
    source,
    account_id_snapshot,
    recommendation_id,
    entity_id,
    recommendation_fingerprint
  )
  where status = 'awaiting_approval';

create index maintainflow_change_approval_requests_organization_status_idx
  on public.maintainflow_change_approval_requests (
    organization_id,
    status,
    requested_at desc,
    id
  );

create index maintainflow_change_approval_requests_requester_idx
  on public.maintainflow_change_approval_requests (
    requester_operator_id,
    requested_at desc,
    id
  );

create index maintainflow_change_approval_requests_expiry_idx
  on public.maintainflow_change_approval_requests (expires_at, id)
  where status = 'awaiting_approval';

create index maintainflow_change_approval_requests_advertiser_account_idx
  on public.maintainflow_change_approval_requests (advertiser_account_id)
  where advertiser_account_id is not null;

create function public.maintainflow_enforce_change_approval_transition()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_change_approval_transition$
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
    and new.status = 'approved'
    and old.ads_approval_record_id is null
    and new.ads_approval_record_id is not null then
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
      raise exception 'A live execution link cannot rewrite the approval decision';
    end if;
  else
    raise exception 'Terminal approval requests cannot be rewritten';
  end if;

  return new;
end
$maintainflow_change_approval_transition$;

create trigger maintainflow_change_approval_transition_guard
before update on public.maintainflow_change_approval_requests
for each row execute function
  public.maintainflow_enforce_change_approval_transition();

revoke all privileges on function
  public.maintainflow_enforce_change_approval_transition()
from public;

do $maintainflow_revoke_change_request_function_api_roles$
declare
  api_role text;
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
      execute format(
        'revoke all privileges on function public.maintainflow_enforce_change_approval_transition() from %I',
        api_role
      );
    end if;
  end loop;
end
$maintainflow_revoke_change_request_function_api_roles$;

alter table public.maintainflow_change_approval_requests
  enable row level security;

revoke all privileges on table
  public.maintainflow_change_approval_requests
from public;

do $maintainflow_revoke_change_request_data_api_roles$
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
        'revoke all privileges on table public.maintainflow_change_approval_requests from %I',
        api_role
      );
    end if;
  end loop;
end
$maintainflow_revoke_change_request_data_api_roles$;
