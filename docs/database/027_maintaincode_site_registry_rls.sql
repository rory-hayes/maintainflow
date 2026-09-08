-- Supabase's preserved ensure_rls helper may enable RLS when 023 creates this
-- registry. Define the intended server-only boundary explicitly on every host.
-- A public tracker must resolve its site before a tenant context is available;
-- registry writes always occur inside the store's workspace transaction.
alter table public.maintaincode_sites enable row level security;

create policy maintaincode_site_registry_read on public.maintaincode_sites
 for select to maintaincode_app using (true);
create policy maintaincode_site_registry_insert on public.maintaincode_sites
 for insert to maintaincode_app
 with check (organization_id::text = current_setting('maintaincode.organization_id',true));
create policy maintaincode_site_registry_update on public.maintaincode_sites
 for update to maintaincode_app
 using (organization_id::text = current_setting('maintaincode.organization_id',true))
 with check (organization_id::text = current_setting('maintaincode.organization_id',true));
create policy maintaincode_site_registry_delete on public.maintaincode_sites
 for delete to maintaincode_app
 using (organization_id::text = current_setting('maintaincode.organization_id',true));

revoke all on public.maintaincode_sites from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on public.maintaincode_sites from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on public.maintaincode_sites from authenticated; end if;
 if exists(select 1 from pg_roles where rolname='service_role') then revoke all on public.maintaincode_sites from service_role; end if;
end $$;
