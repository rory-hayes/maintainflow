-- Narrow current-recipient check for opted-in workspace reports. No auth table
-- access or user details are granted to the application or Supabase Data API.
create function public.maintaincode_notification_recipient_valid(
  workspace_id uuid, actor_id text, recipient_email text
) returns boolean
language plpgsql stable security definer
set search_path = pg_catalog
as $$
declare allowed boolean := false;
begin
  if workspace_id is null or actor_id is null or recipient_email is null
     or current_setting('maintaincode.organization_id', true) is distinct from workspace_id::text
     or current_setting('maintaincode.actor_id', true) is distinct from actor_id
     or to_regclass('auth.users') is null then
    return false;
  end if;
  -- Dynamic resolution keeps disposable non-Supabase databases fail-closed.
  -- Identifiers are fixed; all caller values use bound parameters.
  execute 'select exists (
    select 1 from auth.users u
    join public.maintainflow_organization_memberships m on m.clerk_user_id = u.id::text
    join public.maintainflow_organizations o on o.id = m.organization_id
    where o.id = $1 and o.status = ''active''
      and m.clerk_user_id = $2 and m.role in (''owner'', ''admin'')
      and u.email = $3 and u.email_confirmed_at is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= current_timestamp)
  )' into allowed using workspace_id, actor_id, recipient_email;
  return coalesce(allowed, false);
end;
$$;
revoke all on function public.maintaincode_notification_recipient_valid(uuid,text,text) from public;
-- Supabase may have default function grants; remove every non-owner grant.
do $$
declare recipient record;
begin
  for recipient in
    select distinct r.rolname from pg_proc p
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    join pg_roles r on r.oid = a.grantee
    where p.oid = 'public.maintaincode_notification_recipient_valid(uuid,text,text)'::regprocedure
      and r.oid <> p.proowner and r.rolname <> 'maintaincode_app'
  loop
    execute format('revoke all on function public.maintaincode_notification_recipient_valid(uuid,text,text) from %I', recipient.rolname);
  end loop;
end;
$$;
grant execute on function public.maintaincode_notification_recipient_valid(uuid,text,text) to maintaincode_app;
