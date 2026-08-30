create table if not exists maintainflow_readiness_audit_runs (
  id uuid primary key,
  advertiser_account_id uuid not null
    references maintainflow_advertiser_accounts(id) on delete cascade,
  operator_id text not null,
  acting_organization_id uuid not null
    references maintainflow_organizations(id),
  actor_membership_role text not null
    check (actor_membership_role in ('owner', 'admin', 'analyst')),
  actor_account_role text not null
    check (actor_account_role in ('owner', 'manager', 'viewer')),
  payload_schema_version integer not null default 1
    check (payload_schema_version > 0),
  ruleset_version text not null,
  scanner_version text not null,
  source_checked_at date not null,
  target_association text not null default 'manual_unverified'
    check (target_association in ('manual_unverified', 'provider_destination')),
  provider_resource_type text
    check (provider_resource_type is null or provider_resource_type in ('campaign', 'ad_group', 'ad')),
  provider_resource_id text,
  query_parameters_redacted boolean not null default false,
  requested_url text not null
    check (char_length(requested_url) between 1 and 2048),
  final_url text not null
    check (char_length(final_url) between 1 and 2048),
  scanned_at timestamptz not null,
  score smallint not null
    check (score between 0 and 100),
  verdict text not null
    check (verdict in ('ready', 'needs_work', 'not_ready')),
  audit_payload jsonb not null
    check (jsonb_typeof(audit_payload) = 'object'),
  created_at timestamptz not null default now(),
  check (audit_payload ->> 'requestedUrl' = requested_url),
  check (audit_payload ->> 'finalUrl' = final_url),
  check ((audit_payload ->> 'score')::smallint = score),
  check (audit_payload ->> 'verdict' = verdict),
  check (
    (target_association = 'manual_unverified'
      and provider_resource_type is null and provider_resource_id is null)
    or
    (target_association = 'provider_destination'
      and provider_resource_type is not null and provider_resource_id is not null)
  )
);

create index if not exists maintainflow_readiness_audit_runs_account_idx
  on maintainflow_readiness_audit_runs (
    advertiser_account_id,
    created_at desc,
    id desc
  );

create index if not exists maintainflow_readiness_audit_runs_actor_org_idx
  on maintainflow_readiness_audit_runs (
    acting_organization_id,
    created_at desc
  );
