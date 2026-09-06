-- Credential-independent OpenAI Ads configuration baselines and immutable
-- evidence of material changes observed between two confirmed snapshots.
-- A snapshot comparison can prove consistency with a MaintainFlow operation;
-- it cannot identify an external actor or provide real-time detection.
create table public.maintainflow_ads_config_integrity_state (
  advertiser_account_id uuid primary key
    references public.maintainflow_advertiser_accounts(id) on delete cascade,
  projection_version smallint not null check (projection_version = 1),
  snapshot_fingerprint char(64) not null
    check (snapshot_fingerprint::text ~ '^[a-f0-9]{64}$'),
  snapshot_payload jsonb not null
    check (
      jsonb_typeof(snapshot_payload) = 'object'
      and octet_length(snapshot_payload::text) between 2 and 8388608
    ),
  snapshot_resource_count integer not null
    check (snapshot_resource_count between 1 and 10001),
  observed_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  check (updated_at >= created_at)
);

create index maintainflow_ads_config_integrity_state_observed_idx
  on public.maintainflow_ads_config_integrity_state (
    observed_at,
    advertiser_account_id
  );

create table public.maintainflow_ads_config_integrity_events (
  id uuid primary key,
  advertiser_account_id uuid not null
    references public.maintainflow_advertiser_accounts(id) on delete cascade,
  event_fingerprint char(64) not null
    check (event_fingerprint::text ~ '^[a-f0-9]{64}$'),
  projection_version smallint not null check (projection_version = 1),
  resource_type text not null check (
    resource_type in ('ad_account', 'campaign', 'ad_group', 'ad')
  ),
  resource_id text not null
    check (char_length(resource_id) between 1 and 512),
  parent_resource_id text
    check (
      parent_resource_id is null
      or char_length(parent_resource_id) between 1 and 512
    ),
  resource_label text not null
    check (char_length(resource_label) between 1 and 1000),
  provider_updated_at bigint check (provider_updated_at >= 0),
  change_type text not null check (
    change_type in ('created', 'updated', 'removed')
  ),
  classification text not null check (
    classification in (
      'maintainflow_consistent',
      'unexplained',
      'indeterminate'
    )
  ),
  previous_fingerprint char(64)
    check (
      previous_fingerprint is null
      or previous_fingerprint::text ~ '^[a-f0-9]{64}$'
    ),
  current_fingerprint char(64)
    check (
      current_fingerprint is null
      or current_fingerprint::text ~ '^[a-f0-9]{64}$'
    ),
  previous_configuration jsonb
    check (
      previous_configuration is null
      or (
        jsonb_typeof(previous_configuration) = 'object'
        and octet_length(previous_configuration::text) <= 1048576
      )
    ),
  current_configuration jsonb
    check (
      current_configuration is null
      or (
        jsonb_typeof(current_configuration) = 'object'
        and octet_length(current_configuration::text) <= 1048576
      )
    ),
  changed_field_paths text[] not null,
  explained_field_paths text[] not null default '{}',
  indeterminate_field_paths text[] not null default '{}',
  unexplained_field_paths text[] not null default '{}',
  matched_operations jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(matched_operations) = 'array'
      and jsonb_array_length(matched_operations) <= 100
      and octet_length(matched_operations::text) <= 262144
    ),
  baseline_observation_started_at timestamptz not null,
  baseline_observed_at timestamptz not null,
  detection_started_at timestamptz not null,
  detected_at timestamptz not null,
  review_status text not null default 'open' check (
    review_status in ('not_required', 'open', 'reviewed')
  ),
  reviewed_by_operator_id text
    check (
      reviewed_by_operator_id is null
      or char_length(reviewed_by_operator_id) between 1 and 255
    ),
  reviewed_by_name text
    check (
      reviewed_by_name is null
      or char_length(reviewed_by_name) between 1 and 120
    ),
  reviewed_by_organization_id uuid
    references public.maintainflow_organizations(id),
  reviewer_membership_role text check (
    reviewer_membership_role is null
    or reviewer_membership_role in ('owner', 'admin')
  ),
  reviewer_account_role text check (
    reviewer_account_role is null
    or reviewer_account_role in ('owner', 'manager')
  ),
  review_note text
    check (review_note is null or char_length(review_note) between 10 and 1000),
  reviewed_at timestamptz,
  created_at timestamptz not null default pg_catalog.statement_timestamp(),
  updated_at timestamptz not null default pg_catalog.statement_timestamp(),
  constraint maintainflow_ads_config_integrity_event_dedupe_key
    unique (advertiser_account_id, event_fingerprint),
  constraint maintainflow_ads_config_integrity_event_state_check check (
    (
      change_type = 'created'
      and previous_fingerprint is null
      and previous_configuration is null
      and current_fingerprint is not null
      and current_configuration is not null
    )
    or (
      change_type = 'updated'
      and previous_fingerprint is not null
      and previous_configuration is not null
      and current_fingerprint is not null
      and current_configuration is not null
      and previous_fingerprint <> current_fingerprint
    )
    or (
      change_type = 'removed'
      and previous_fingerprint is not null
      and previous_configuration is not null
      and current_fingerprint is null
      and current_configuration is null
    )
  ),
  constraint maintainflow_ads_config_integrity_path_partition_check check (
    cardinality(changed_field_paths) between 1 and 2000
    and cardinality(explained_field_paths) <= 2000
    and cardinality(indeterminate_field_paths) <= 2000
    and cardinality(unexplained_field_paths) <= 2000
    and explained_field_paths <@ changed_field_paths
    and indeterminate_field_paths <@ changed_field_paths
    and unexplained_field_paths <@ changed_field_paths
    and not (explained_field_paths && indeterminate_field_paths)
    and not (explained_field_paths && unexplained_field_paths)
    and not (indeterminate_field_paths && unexplained_field_paths)
    and changed_field_paths <@ (
      explained_field_paths
      || indeterminate_field_paths
      || unexplained_field_paths
    )
    and cardinality(changed_field_paths) =
      cardinality(explained_field_paths)
      + cardinality(indeterminate_field_paths)
      + cardinality(unexplained_field_paths)
    and (
      (
        classification = 'maintainflow_consistent'
        and cardinality(explained_field_paths) > 0
        and cardinality(indeterminate_field_paths) = 0
        and cardinality(unexplained_field_paths) = 0
      )
      or (
        classification = 'indeterminate'
        and cardinality(indeterminate_field_paths) > 0
        and cardinality(unexplained_field_paths) = 0
      )
      or (
        classification = 'unexplained'
        and cardinality(unexplained_field_paths) > 0
      )
    )
  ),
  constraint maintainflow_ads_config_integrity_review_check check (
    (
      review_status = 'not_required'
      and classification = 'maintainflow_consistent'
      and reviewed_by_operator_id is null
      and reviewed_by_name is null
      and reviewed_by_organization_id is null
      and reviewer_membership_role is null
      and reviewer_account_role is null
      and review_note is null
      and reviewed_at is null
    )
    or (
      review_status = 'open'
      and classification in ('unexplained', 'indeterminate')
      and reviewed_by_operator_id is null
      and reviewed_by_name is null
      and reviewed_by_organization_id is null
      and reviewer_membership_role is null
      and reviewer_account_role is null
      and review_note is null
      and reviewed_at is null
    )
    or (
      review_status = 'reviewed'
      and classification in ('unexplained', 'indeterminate')
      and reviewed_by_operator_id is not null
      and reviewed_by_name is not null
      and reviewed_by_organization_id is not null
      and reviewer_membership_role is not null
      and reviewer_account_role is not null
      and review_note is not null
      and reviewed_at is not null
      and reviewed_at >= created_at
    )
  ),
  check (
    baseline_observation_started_at <= baseline_observed_at
    and baseline_observed_at <= detection_started_at
    and detection_started_at <= detected_at
  ),
  check (updated_at >= created_at)
);

create index maintainflow_ads_config_integrity_events_account_idx
  on public.maintainflow_ads_config_integrity_events (
    advertiser_account_id,
    (review_status = 'open') desc,
    detected_at desc,
    id desc
  );

create index maintainflow_ads_config_integrity_events_open_idx
  on public.maintainflow_ads_config_integrity_events (
    advertiser_account_id,
    detected_at desc,
    id desc
  )
  where review_status = 'open';

create index maintainflow_ads_config_integrity_events_reviewer_org_idx
  on public.maintainflow_ads_config_integrity_events (
    reviewed_by_organization_id,
    reviewed_at desc
  )
  where reviewed_by_organization_id is not null;

-- Event evidence is immutable. Only an open unexplained or indeterminate event
-- may advance once to reviewed, and the database re-checks current account
-- write authority before recording the reviewer snapshots.
create function public.maintainflow_enforce_ads_config_integrity_event()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $maintainflow_ads_config_integrity_event$
declare
  current_membership_role text;
  current_account_role text;
begin
  if tg_op = 'INSERT' then
    if exists (
      select 1
      from (
        select 'changed' as path_list, path
        from unnest(new.changed_field_paths) as path_value(path)
        union all
        select 'explained', path
        from unnest(new.explained_field_paths) as path_value(path)
        union all
        select 'indeterminate', path
        from unnest(new.indeterminate_field_paths) as path_value(path)
        union all
        select 'unexplained', path
        from unnest(new.unexplained_field_paths) as path_value(path)
      ) field_path
      group by field_path.path_list, field_path.path
      having field_path.path is null or count(*) > 1
    ) then
      raise exception using
        errcode = '23514',
        message = 'Change-integrity field paths must be unique within each list';
    end if;

    if exists (
      select 1
      from unnest(
        new.changed_field_paths
        || new.explained_field_paths
        || new.indeterminate_field_paths
        || new.unexplained_field_paths
      ) as field_path(path)
      where char_length(field_path.path) not between 1 and 512
    ) then
      raise exception using
        errcode = '23514',
        message = 'Change-integrity field paths must contain 1 to 512 characters';
    end if;

    new.review_status := case
      when new.classification = 'maintainflow_consistent'
        then 'not_required'
      else 'open'
    end;
    new.reviewed_by_operator_id := null;
    new.reviewed_by_name := null;
    new.reviewed_by_organization_id := null;
    new.reviewer_membership_role := null;
    new.reviewer_account_role := null;
    new.review_note := null;
    new.reviewed_at := null;
    return new;
  end if;

  if row(
    new.id,
    new.advertiser_account_id,
    new.event_fingerprint,
    new.projection_version,
    new.resource_type,
    new.resource_id,
    new.parent_resource_id,
    new.resource_label,
    new.provider_updated_at,
    new.change_type,
    new.classification,
    new.previous_fingerprint,
    new.current_fingerprint,
    new.previous_configuration,
    new.current_configuration,
    new.changed_field_paths,
    new.explained_field_paths,
    new.indeterminate_field_paths,
    new.unexplained_field_paths,
    new.matched_operations,
    new.baseline_observation_started_at,
    new.baseline_observed_at,
    new.detection_started_at,
    new.detected_at,
    new.created_at
  ) is distinct from row(
    old.id,
    old.advertiser_account_id,
    old.event_fingerprint,
    old.projection_version,
    old.resource_type,
    old.resource_id,
    old.parent_resource_id,
    old.resource_label,
    old.provider_updated_at,
    old.change_type,
    old.classification,
    old.previous_fingerprint,
    old.current_fingerprint,
    old.previous_configuration,
    old.current_configuration,
    old.changed_field_paths,
    old.explained_field_paths,
    old.indeterminate_field_paths,
    old.unexplained_field_paths,
    old.matched_operations,
    old.baseline_observation_started_at,
    old.baseline_observed_at,
    old.detection_started_at,
    old.detected_at,
    old.created_at
  ) then
    raise exception 'Change-integrity event evidence is immutable';
  end if;

  if old.review_status <> 'open'
    or new.review_status <> 'reviewed'
    or new.reviewed_by_operator_id is null
    or new.reviewed_by_name is null
    or new.reviewed_by_organization_id is null
    or new.review_note is null then
    raise exception 'Only one open-to-reviewed integrity transition is allowed';
  end if;

  select membership.role, account_access.role
    into current_membership_role, current_account_role
  from public.maintainflow_organizations organization
  join public.maintainflow_organization_memberships membership
    on membership.organization_id = organization.id
    and membership.clerk_user_id = new.reviewed_by_operator_id
  join public.maintainflow_account_access account_access
    on account_access.organization_id = organization.id
    and account_access.advertiser_account_id = new.advertiser_account_id
  where organization.id = new.reviewed_by_organization_id
    and organization.status = 'active'
    and membership.role in ('owner', 'admin')
    and account_access.role in ('owner', 'manager')
  for share of organization, membership, account_access;

  if not found then
    raise exception 'Current advertiser write authority is required to review an integrity event';
  end if;

  new.reviewer_membership_role := current_membership_role;
  new.reviewer_account_role := current_account_role;
  new.reviewed_at := pg_catalog.statement_timestamp();
  new.updated_at := greatest(old.updated_at, pg_catalog.statement_timestamp());
  return new;
end
$maintainflow_ads_config_integrity_event$;

create trigger maintainflow_ads_config_integrity_event_guard
before insert or update
on public.maintainflow_ads_config_integrity_events
for each row execute function
  public.maintainflow_enforce_ads_config_integrity_event();

alter table public.maintainflow_ads_config_integrity_state
  enable row level security;
alter table public.maintainflow_ads_config_integrity_events
  enable row level security;

revoke all privileges on table
  public.maintainflow_ads_config_integrity_state,
  public.maintainflow_ads_config_integrity_events
from public;
revoke all privileges on function
  public.maintainflow_enforce_ads_config_integrity_event()
from public;

do $maintainflow_revoke_ads_config_integrity_roles$
declare
  target_role text;
begin
  foreach target_role in array array[
    'anon',
    'authenticated',
    'service_role',
    'maintainflow_app'
  ]
  loop
    if exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = target_role
    ) then
      execute format(
        'revoke all privileges on table public.maintainflow_ads_config_integrity_state from %I',
        target_role
      );
      execute format(
        'revoke all privileges on table public.maintainflow_ads_config_integrity_events from %I',
        target_role
      );
      execute format(
        'revoke all privileges on function public.maintainflow_enforce_ads_config_integrity_event() from %I',
        target_role
      );
    end if;
  end loop;
end
$maintainflow_revoke_ads_config_integrity_roles$;
