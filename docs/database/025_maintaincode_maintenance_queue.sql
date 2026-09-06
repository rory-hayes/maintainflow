-- Only scheduling metadata is globally enumerable by the server runtime.
-- Workspace state and provider credentials retain their existing tenant RLS.
create table public.maintaincode_maintenance_queue (
  organization_id uuid primary key references public.maintaincode_workspaces(organization_id) on delete cascade,
  next_due_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_status text not null default 'pending' check(last_status in ('pending','complete','partial','failed')),
  consecutive_failures integer not null default 0 check(consecutive_failures between 0 and 1000000),
  check ((lease_token is null) = (lease_until is null))
);
create index maintaincode_maintenance_due on public.maintaincode_maintenance_queue(next_due_at,organization_id);
revoke all on public.maintaincode_maintenance_queue from public;
-- Authenticated/anon Supabase Data API roles must not enumerate the queue.
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on public.maintaincode_maintenance_queue from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on public.maintaincode_maintenance_queue from authenticated; end if;
end $$;
grant select,update on public.maintaincode_maintenance_queue to maintaincode_app;

-- A fixed trigger registers a successful workspace insert; the application cannot
-- insert arbitrary queue IDs or use this function to read another tenant's state.
create function public.maintaincode_enqueue_workspace() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 insert into public.maintaincode_maintenance_queue(organization_id) values(new.organization_id)
 on conflict(organization_id) do nothing;
 return new;
end $$;
revoke all on function public.maintaincode_enqueue_workspace() from public;
create trigger maintaincode_workspace_maintenance_registration
 after insert on public.maintaincode_workspaces
 for each row execute function public.maintaincode_enqueue_workspace();
insert into public.maintaincode_maintenance_queue(organization_id)
 select organization_id from public.maintaincode_workspaces on conflict(organization_id) do nothing;
