-- Dedicated role for the attribution application on its NEW database.
-- Enable LOGIN and set a password separately using the hosting secret manager.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='maintaincode_app') then
   create role maintaincode_app nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
 end if;
 if exists(select 1 from pg_roles where rolname='maintaincode_app' and (rolsuper or rolbypassrls or rolcreatedb or rolcreaterole or rolreplication)) then
   raise exception 'maintaincode_app has unexpected elevated privileges';
 end if;
end $$;
grant usage on schema public to maintaincode_app;
grant select,insert,update,delete on maintaincode_workspaces,maintaincode_sites,maintaincode_credentials to maintaincode_app;
grant select,insert on maintainflow_organizations,maintainflow_organization_memberships to maintaincode_app;
create policy maintaincode_member_read on maintainflow_organization_memberships for select to maintaincode_app
 using (clerk_user_id=current_setting('maintaincode.actor_id',true));
create policy maintaincode_member_create on maintainflow_organization_memberships for insert to maintaincode_app
 with check (clerk_user_id=current_setting('maintaincode.actor_id',true) and role='owner' and organization_id::text=current_setting('maintaincode.organization_id',true));
create policy maintaincode_organization_read on maintainflow_organizations for select to maintaincode_app
 using (exists(select 1 from maintainflow_organization_memberships m where m.organization_id=id and m.clerk_user_id=current_setting('maintaincode.actor_id',true)));
create policy maintaincode_organization_create on maintainflow_organizations for insert to maintaincode_app
 with check (id::text=current_setting('maintaincode.organization_id',true));
alter role maintaincode_app set search_path=pg_catalog,public;
alter role maintaincode_app set statement_timeout='20s';
alter role maintaincode_app set lock_timeout='10s';
alter role maintaincode_app set idle_in_transaction_session_timeout='30s';
