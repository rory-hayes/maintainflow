-- One stable JSON cell. Read-only; no user rows, password hashes or query text.
-- Use a privileged read-only transaction with SET LOCAL row_security=off so
-- RLS-filtered counts cannot be mistaken for an empty database.
-- Capture timestamp/project identity outside this SELECT. Compare JSONB values.
with public_relations as (
 select c.*,n.nspname from pg_catalog.pg_class c
 join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public'
), app_roles as (
 select oid from pg_catalog.pg_roles where rolname in ('maintainflow_app','maintaincode_app')
), acl_entries as (
 select 'relation'::text as object_kind, c.relname::text as object_name,
        null::text as subobject, c.relowner as owner,a.*
 from public_relations c cross join lateral pg_catalog.aclexplode(c.relacl) a
 union all
 select 'column',c.relname,a.attname,c.relowner,x.*
 from public_relations c join pg_catalog.pg_attribute a on a.attrelid=c.oid
 cross join lateral pg_catalog.aclexplode(a.attacl) x
 union all
 select 'schema',n.nspname,null,n.nspowner,a.* from pg_catalog.pg_namespace n
 cross join lateral pg_catalog.aclexplode(n.nspacl) a where n.nspname='public'
 union all
 select 'routine',p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')',null,p.proowner,a.*
 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 cross join lateral pg_catalog.aclexplode(p.proacl) a where n.nspname='public'
 union all
 select 'type',t.typname,null,t.typowner,a.* from pg_catalog.pg_type t
 join pg_catalog.pg_namespace n on n.oid=t.typnamespace
 cross join lateral pg_catalog.aclexplode(t.typacl) a where n.nspname='public'
)
select jsonb_build_object(
 'formatVersion',1,
 'applicationCatalog',jsonb_build_object(
   'relations',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
     select c.relname as name,c.relkind::text as kind,c.relpersistence::text as persistence,
       pg_get_userbyid(c.relowner) as owner,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,
       c.relreplident::text as replica_identity,c.relispartition as is_partition,
       c.reloptions as options,c.relacl is not null as has_explicit_acl,
       case when c.relkind in ('v','m') then md5(pg_get_viewdef(c.oid,true)) end as view_definition_md5,
       case when c.relispartition then pg_get_expr(c.relpartbound,c.oid,true) end as partition_bound,
       case when c.relkind='p' then pg_get_partkeydef(c.oid) end as partition_key
     from public_relations c where c.relkind in ('r','p','v','m','S','f')
   ) x),'[]'::jsonb),
   'columns',coalesce((select jsonb_agg(to_jsonb(x) order by x.table_name,x.position) from (
     select c.relname as table_name,a.attnum as position,a.attname as name,
       pg_catalog.format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as not_null,
       a.attidentity::text as identity_kind,a.attgenerated::text as generated_kind,
       a.attisdropped as is_dropped,a.attacl is not null as has_explicit_acl,
       pg_get_expr(d.adbin,d.adrelid,true) as default_expression,
       cn.nspname||'.'||co.collname as collation,
       a.attstorage::text as storage,a.attcompression::text as compression
     from public_relations c join pg_catalog.pg_attribute a on a.attrelid=c.oid and a.attnum>0
     left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
     left join pg_catalog.pg_collation co on co.oid=a.attcollation
     left join pg_catalog.pg_namespace cn on cn.oid=co.collnamespace
     where c.relkind in ('r','p','v','m','f')
   ) x),'[]'::jsonb),
   'constraints',coalesce((select jsonb_agg(to_jsonb(x) order by x.table_name,x.name) from (
     select c.relname as table_name,k.conname as name,k.contype::text as kind,
       k.convalidated as validated,k.condeferrable as deferrable,k.condeferred as initially_deferred,
       k.connoinherit as no_inherit,pg_get_constraintdef(k.oid,true) as definition
     from pg_catalog.pg_constraint k join public_relations c on c.oid=k.conrelid
   ) x),'[]'::jsonb),
   'indexes',coalesce((select jsonb_agg(to_jsonb(x) order by x.table_name,x.name) from (
     select t.relname as table_name,c.relname as name,i.indisunique as is_unique,
       i.indisprimary as is_primary,i.indisvalid as is_valid,i.indisready as is_ready,
       i.indisreplident as replica_identity,pg_get_indexdef(i.indexrelid,0,true) as definition,
       c.reloptions as options
     from pg_catalog.pg_index i join public_relations t on t.oid=i.indrelid
     join pg_catalog.pg_class c on c.oid=i.indexrelid
   ) x),'[]'::jsonb),
   'policies',coalesce((select jsonb_agg(to_jsonb(x) order by x.table_name,x.name) from (
     select tablename as table_name,policyname as name,permissive,roles,cmd as command,qual,with_check
     from pg_catalog.pg_policies where schemaname='public'
   ) x),'[]'::jsonb),
   'triggers',coalesce((select jsonb_agg(to_jsonb(x) order by x.table_name,x.name,x.constraint_name,x.type,x.function) from (
     select c.relname as table_name,case when t.tgisinternal then null else t.tgname end as name,
       constraint_info.conname as constraint_name,t.tgenabled::text as enabled,
       t.tgisinternal as internal,t.tgtype as type,
       n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' as function,
       case when not t.tgisinternal then md5(pg_get_triggerdef(t.oid,true)) end as definition_md5,md5(t.tgargs::text) as arguments_md5
     from pg_catalog.pg_trigger t join public_relations c on c.oid=t.tgrelid
     left join pg_catalog.pg_constraint constraint_info on constraint_info.oid=t.tgconstraint
     join pg_catalog.pg_proc p on p.oid=t.tgfoid join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   ) x),'[]'::jsonb),
   'types',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
     select t.typname as name,t.typtype::text as kind,pg_get_userbyid(t.typowner) as owner,
       t.typnotnull as not_null,t.typcategory::text as category,
       case when t.typbasetype<>0 then pg_catalog.format_type(t.typbasetype,t.typtypmod) end as base_type,
       t.typdefault as default_expression,t.typacl is not null as has_explicit_acl,
       (select array_agg(e.enumlabel order by e.enumsortorder) from pg_catalog.pg_enum e where e.enumtypid=t.oid) as enum_values
     from pg_catalog.pg_type t join pg_catalog.pg_namespace n on n.oid=t.typnamespace where n.nspname='public'
   ) x),'[]'::jsonb),
   'sequences',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
     select c.relname as name,pg_catalog.format_type(s.seqtypid,null) as type,
       s.seqstart as start,s.seqincrement as increment,s.seqmax as maximum,
       s.seqmin as minimum,s.seqcache as cache,s.seqcycle as cycle
     from pg_catalog.pg_sequence s join public_relations c on c.oid=s.seqrelid
   ) x),'[]'::jsonb),
   'publicExtensions',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
     select e.extname as name,e.extversion as version,pg_get_userbyid(e.extowner) as owner
     from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where n.nspname='public'
   ) x),'[]'::jsonb),
   'foreignKeysIntoPublic',coalesce((select jsonb_agg(to_jsonb(x) order by x.source_schema,x.source_table,x.name) from (
     select sn.nspname as source_schema,s.relname as source_table,k.conname as name,
       target.relname as target_table,pg_get_constraintdef(k.oid,true) as definition
     from pg_catalog.pg_constraint k join public_relations target on target.oid=k.confrelid
     join pg_catalog.pg_class s on s.oid=k.conrelid join pg_catalog.pg_namespace sn on sn.oid=s.relnamespace
     where k.contype='f' and sn.nspname<>'public'
   ) x),'[]'::jsonb)
 ),
 'permissions',jsonb_build_object(
   'publicSchemaOwner',(select pg_get_userbyid(nspowner) from pg_catalog.pg_namespace where nspname='public'),
   'databaseAclExplicit',(select datacl is not null from pg_catalog.pg_database where datname=current_database()),
   'databaseAcl',coalesce((select jsonb_agg(to_jsonb(x) order by x.grantee collate "C",x.grantor collate "C",x.privilege collate "C") from (
     select pg_get_userbyid(d.datdba) as owner,
       case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       pg_get_userbyid(a.grantor) as grantor,a.privilege_type as privilege,a.is_grantable as grantable
     from pg_catalog.pg_database d cross join lateral pg_catalog.aclexplode(d.datacl) a
     where d.datname=current_database()
   ) x),'[]'::jsonb),
   'acl',coalesce((select jsonb_agg(to_jsonb(x) order by x.object_kind,x.object_name,x.subobject,x.grantee,x.grantor,x.privilege_type) from (
     select object_kind,object_name,subobject,pg_get_userbyid(owner) as owner,
       case when grantee=0 then 'PUBLIC' else pg_get_userbyid(grantee) end as grantee,
       pg_get_userbyid(grantor) as grantor,privilege_type,is_grantable
     from acl_entries
   ) x),'[]'::jsonb),
   'defaultAcl',coalesce((select jsonb_agg(to_jsonb(x) order by x.owner,x.schema_name,x.object_kind,x.grantee,x.grantor,x.privilege_type) from (
     select pg_get_userbyid(d.defaclrole) as owner,coalesce(n.nspname,'*') as schema_name,
       d.defaclobjtype::text as object_kind,
       case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
       pg_get_userbyid(a.grantor) as grantor,a.privilege_type,a.is_grantable
     from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace
     cross join lateral pg_catalog.aclexplode(d.defaclacl) a
     where d.defaclnamespace=0 or n.nspname='public' or a.grantee in(select oid from app_roles)
   ) x),'[]'::jsonb),
   'runtimeRoles',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
     select r.rolname as name,r.rolsuper as superuser,r.rolinherit as inherit,
       r.rolcreaterole as create_role,r.rolcreatedb as create_db,r.rolcanlogin as login,
       r.rolreplication as replication,r.rolbypassrls as bypass_rls,r.rolconnlimit as connection_limit,
       (select array_agg(case when split_part(v,'=',1) in ('search_path','statement_timeout','lock_timeout','idle_in_transaction_session_timeout') then v else split_part(v,'=',1)||'=<md5:'||md5(v)||'>' end order by v) from unnest(r.rolconfig) v) as config
     from pg_catalog.pg_roles r where r.oid in(select oid from app_roles)
   ) x),'[]'::jsonb),
   'runtimeMemberships',coalesce((select jsonb_agg(to_jsonb(x) order by x.granted_role,x.member,x.grantor) from (
     select pg_get_userbyid(m.roleid) as granted_role,pg_get_userbyid(m.member) as member,
       pg_get_userbyid(m.grantor) as grantor,m.admin_option,m.inherit_option,m.set_option
     from pg_catalog.pg_auth_members m where m.roleid in(select oid from app_roles) or m.member in(select oid from app_roles)
   ) x),'[]'::jsonb),
   'runtimeSharedDependencies',coalesce((select jsonb_agg(to_jsonb(x) order by x.role_name,x.dependency_type,x.object_type,x.object_names::text,x.object_args::text) from (
     select pg_get_userbyid(d.refobjid) as role_name,d.deptype::text as dependency_type,
       case when d.dbid=0 then 'shared' else 'current_database' end as database_scope,
       identified.type as object_type,identified.object_names,identified.object_args
     from pg_catalog.pg_shdepend d
     cross join lateral pg_catalog.pg_identify_object_as_address(d.classid,d.objid,d.objsubid) identified
     where d.refclassid='pg_catalog.pg_authid'::regclass and d.refobjid in(select oid from app_roles)
       and (d.dbid=0 or d.dbid=(select oid from pg_catalog.pg_database where datname=current_database()))
   ) x),'[]'::jsonb)
 ),
 'routines',coalesce((select jsonb_agg(to_jsonb(x) order by x.name,x.arguments) from (
   select p.proname as name,pg_get_function_identity_arguments(p.oid) as arguments,
     pg_get_function_result(p.oid) as result,pg_get_userbyid(p.proowner) as owner,l.lanname as language,
     p.prokind::text as kind,p.prosecdef as security_definer,p.proleakproof as leakproof,
     p.proisstrict as strict,p.provolatile::text as volatility,p.proparallel::text as parallel,
     p.procost as cost,p.prorows as rows,p.prosupport::regproc::text as support,
     p.proacl is not null as has_explicit_acl,
     (select array_agg(case when split_part(v,'=',1)='search_path' then v else split_part(v,'=',1)||'=<md5:'||md5(v)||'>' end order by v) from unnest(p.proconfig) v) as config,
     octet_length(p.prosrc) as body_bytes,md5(p.prosrc) as body_md5,
     md5(coalesce(p.probin,'')) as binary_md5,
     case when p.proname='rls_auto_enable' and p.pronargs=0 and md5(p.prosrc)='99be20677b456ea8d3be47bdd44fb369' then p.prosrc end as pinned_official_helper_body
   from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
   join pg_catalog.pg_language l on l.oid=p.prolang where n.nspname='public'
 ) x),'[]'::jsonb),
 'eventTriggers',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from (
   select t.evtname as name,t.evtevent as event,pg_get_userbyid(t.evtowner) as owner,
     t.evtenabled::text as enabled,t.evttags as tags,n.nspname as function_schema,
     p.proname as function_name,pg_get_function_identity_arguments(p.oid) as function_arguments,
     md5(p.prosrc) as function_body_md5
   from pg_catalog.pg_event_trigger t join pg_catalog.pg_proc p on p.oid=t.evtfoid
   join pg_catalog.pg_namespace n on n.oid=p.pronamespace
 ) x),'[]'::jsonb),
 'migrationLedger',(select jsonb_agg(jsonb_build_object('name',migration_name,'checksumSha256',checksum_sha256) order by migration_name) from public.maintainflow_schema_migrations),
 'applicationRowCounts',jsonb_build_object(
   'ads_approval_records',(select count(*) from public.ads_approval_records),
   'maintainflow_account_access',(select count(*) from public.maintainflow_account_access),
   'maintainflow_advertiser_accounts',(select count(*) from public.maintainflow_advertiser_accounts),
   'maintainflow_advertiser_credentials',(select count(*) from public.maintainflow_advertiser_credentials),
   'maintainflow_conversion_credentials',(select count(*) from public.maintainflow_conversion_credentials),
   'maintainflow_creative_review_events',(select count(*) from public.maintainflow_creative_review_events),
   'maintainflow_creative_review_state',(select count(*) from public.maintainflow_creative_review_state),
   'maintainflow_customer_lifecycle_records',(select count(*) from public.maintainflow_customer_lifecycle_records),
   'maintainflow_live_workbench_snapshots',(select count(*) from public.maintainflow_live_workbench_snapshots),
   'maintainflow_monitoring_account_schedule',(select count(*) from public.maintainflow_monitoring_account_schedule),
   'maintainflow_organization_memberships',(select count(*) from public.maintainflow_organization_memberships),
   'maintainflow_organizations',(select count(*) from public.maintainflow_organizations),
   'maintainflow_rate_limit_buckets',(select count(*) from public.maintainflow_rate_limit_buckets),
   'maintainflow_readiness_audit_runs',(select count(*) from public.maintainflow_readiness_audit_runs),
   'maintainflow_recommendation_dismissals',(select count(*) from public.maintainflow_recommendation_dismissals)
 ),
 'emptyCounts',jsonb_build_object(
   'authUsers',(select count(*) from auth.users),
   'authIdentities',(select count(*) from auth.identities),
   'authSessions',(select count(*) from auth.sessions),
   'storageBuckets',(select count(*) from storage.buckets),
   'storageObjects',(select count(*) from storage.objects),
   'legacyLoginSessions',(select count(*) from pg_catalog.pg_stat_activity where usename='maintainflow_app')
 )
) as catalog
