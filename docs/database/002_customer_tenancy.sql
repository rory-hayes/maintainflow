create table if not exists maintainflow_organizations (
  id uuid primary key,
  name text not null,
  customer_type text not null check (customer_type in ('advertiser', 'agency')),
  status text not null default 'active' check (status in ('active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists maintainflow_organization_memberships (
  organization_id uuid not null references maintainflow_organizations(id),
  clerk_user_id text not null,
  role text not null check (role in ('owner', 'admin', 'analyst')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, clerk_user_id)
);

create table if not exists maintainflow_advertiser_accounts (
  id uuid primary key,
  external_account_id text not null unique,
  name text not null,
  owner_organization_id uuid references maintainflow_organizations(id),
  connection_mode text not null check (connection_mode in ('environment')),
  status text not null default 'active' check (status in ('active', 'disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists maintainflow_account_access (
  organization_id uuid not null references maintainflow_organizations(id),
  advertiser_account_id uuid not null references maintainflow_advertiser_accounts(id),
  role text not null check (role in ('owner', 'manager', 'viewer')),
  granted_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, advertiser_account_id)
);

alter table ads_approval_records
  add column if not exists acting_organization_id uuid references maintainflow_organizations(id),
  add column if not exists actor_membership_role text,
  add column if not exists actor_account_role text,
  add column if not exists rollback_organization_id uuid references maintainflow_organizations(id),
  add column if not exists rollback_membership_role text,
  add column if not exists rollback_account_role text,
  add column if not exists reconciled_organization_id uuid references maintainflow_organizations(id),
  add column if not exists reconciled_membership_role text,
  add column if not exists reconciled_account_role text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ads_approval_actor_membership_role_check'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_actor_membership_role_check
      check (actor_membership_role is null or actor_membership_role in ('owner', 'admin', 'analyst'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ads_approval_actor_account_role_check'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_actor_account_role_check
      check (actor_account_role is null or actor_account_role in ('owner', 'manager', 'viewer'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ads_approval_rollback_membership_role_check'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_rollback_membership_role_check
      check (rollback_membership_role is null or rollback_membership_role in ('owner', 'admin', 'analyst'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ads_approval_rollback_account_role_check'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_rollback_account_role_check
      check (rollback_account_role is null or rollback_account_role in ('owner', 'manager', 'viewer'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ads_approval_reconciled_membership_role_check'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_reconciled_membership_role_check
      check (reconciled_membership_role is null or reconciled_membership_role in ('owner', 'admin', 'analyst'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'ads_approval_reconciled_account_role_check'
  ) then
    alter table ads_approval_records
      add constraint ads_approval_reconciled_account_role_check
      check (reconciled_account_role is null or reconciled_account_role in ('owner', 'manager', 'viewer'));
  end if;
end
$$;

create index if not exists maintainflow_memberships_user_idx
  on maintainflow_organization_memberships (clerk_user_id, organization_id);

create index if not exists maintainflow_account_access_account_idx
  on maintainflow_account_access (advertiser_account_id, organization_id);

create index if not exists ads_approval_records_organization_created_idx
  on ads_approval_records (acting_organization_id, created_at desc);
