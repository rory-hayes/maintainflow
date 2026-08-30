create table if not exists maintainflow_recommendation_dismissals (
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
  recommendation_id text not null,
  recommendation_title text not null,
  entity_id text not null,
  recommendation_fingerprint text not null
    check (recommendation_fingerprint ~ '^[a-f0-9]{64}$'),
  recommendation_payload jsonb not null
    check (jsonb_typeof(recommendation_payload) = 'object'),
  reason text not null
    check (char_length(btrim(reason)) between 5 and 500),
  dismissed_at timestamptz not null default now(),
  restored_by text,
  restored_organization_id uuid references maintainflow_organizations(id),
  restored_membership_role text
    check (restored_membership_role is null or restored_membership_role in ('owner', 'admin', 'analyst')),
  restored_account_role text
    check (restored_account_role is null or restored_account_role in ('owner', 'manager', 'viewer')),
  restored_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (restored_at is null and restored_by is null and restored_organization_id is null
      and restored_membership_role is null and restored_account_role is null)
    or
    (restored_at is not null and restored_by is not null and restored_organization_id is not null
      and restored_membership_role is not null and restored_account_role is not null)
  )
);

create unique index if not exists maintainflow_recommendation_dismissals_active_idx
  on maintainflow_recommendation_dismissals (
    advertiser_account_id,
    recommendation_id,
    entity_id,
    recommendation_fingerprint
  )
  where restored_at is null;

create index if not exists maintainflow_recommendation_dismissals_account_idx
  on maintainflow_recommendation_dismissals (
    advertiser_account_id,
    dismissed_at desc
  )
  where restored_at is null;

create index if not exists maintainflow_recommendation_dismissals_history_idx
  on maintainflow_recommendation_dismissals (
    advertiser_account_id,
    dismissed_at desc,
    id desc
  );

create index if not exists maintainflow_recommendation_dismissals_actor_org_idx
  on maintainflow_recommendation_dismissals (
    acting_organization_id,
    dismissed_at desc
  );

create index if not exists maintainflow_recommendation_dismissals_restored_org_idx
  on maintainflow_recommendation_dismissals (restored_organization_id)
  where restored_organization_id is not null;
