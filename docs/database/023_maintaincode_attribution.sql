-- MaintainCode data is separate from legacy ad operations. No production writes.
create table maintaincode_workspaces (
  organization_id uuid primary key references maintainflow_organizations(id),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
create table maintaincode_sites (
  id uuid primary key,
  organization_id uuid not null references maintaincode_workspaces(organization_id) on delete cascade,
  origin text not null,
  unique(organization_id,id)
);
create index maintaincode_sites_organization on maintaincode_sites(organization_id);
create table maintaincode_credentials (
  organization_id uuid not null references maintaincode_workspaces(organization_id) on delete cascade,
  provider text not null check(provider in ('hubspot','openai')),
  sealed jsonb not null,
  primary key(organization_id,provider)
);
alter table maintaincode_workspaces enable row level security;
alter table maintaincode_workspaces force row level security;
alter table maintaincode_credentials enable row level security;
alter table maintaincode_credentials force row level security;
create policy maintaincode_workspace_isolation on maintaincode_workspaces
 using (organization_id::text = current_setting('maintaincode.organization_id',true))
 with check (organization_id::text = current_setting('maintaincode.organization_id',true));
create policy maintaincode_credential_isolation on maintaincode_credentials
 using (organization_id::text = current_setting('maintaincode.organization_id',true))
 with check (organization_id::text = current_setting('maintaincode.organization_id',true));
revoke all on maintaincode_workspaces,maintaincode_sites,maintaincode_credentials from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='maintainflow_app') then
 grant select,insert,update,delete on maintaincode_workspaces,maintaincode_sites,maintaincode_credentials to maintainflow_app;
 end if;
end $$;
