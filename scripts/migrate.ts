import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import pg from 'pg';
import {databaseConfig} from '../server/core/config.js';
import {databaseSchema,databaseIdentifier,quoteIdentifier,secureDatabaseConfig} from '../server/core/db.js';

export type Migration={name:string;sql:string};
export type MigrationOptions={schema:string;adminRole?:string;appRole?:string;bootstrap?:boolean};
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
/** Only generated ASCII passwords are accepted, avoiding SASLprep ambiguity. */
export function scramVerifier(password:string,salt=randomBytes(16)){
 if(!/^[A-Za-z0-9_-]{43,128}$/.test(password)||salt.length!==16)throw new Error('Use a generated URL-safe password and a 16-byte salt.');
 const salted=pbkdf2Sync(password,salt,4096,32,'sha256');
 const clientKey=createHmac('sha256',salted).update('Client Key').digest();
 const storedKey=createHash('sha256').update(clientKey).digest('base64');
 const serverKey=createHmac('sha256',salted).update('Server Key').digest('base64');
 return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}
export async function readMigrations(directory=path.join(process.cwd(),'migrations')):Promise<Migration[]>{
 return Promise.all((await fs.readdir(directory)).filter(name=>/^\d+_[a-z0-9_]+\.sql$/.test(name)).sort().map(async name=>({name,sql:await fs.readFile(path.join(directory,name),'utf8')})));
}

/** SQL Editor payload contains placeholders only, never local environment secrets. */
export function bootstrapSql({schema,adminRole='folio_admin',appRole='folio_app'}:MigrationOptions){
 const s=quoteIdentifier(schema),a=quoteIdentifier(adminRole),u=quoteIdentifier(appRole);
 if(schema==='public'||adminRole===appRole)throw new Error('Bootstrap requires a private schema and distinct runtime roles.');
 return `DO $folio_bootstrap$
DECLARE admin_verifier text:='__FOLIO_ADMIN_SCRAM_VERIFIER__'; app_verifier text:='__FOLIO_APP_SCRAM_VERIFIER__';
BEGIN
 IF admin_verifier !~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$' OR app_verifier !~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$' OR admin_verifier=app_verifier THEN
  RAISE EXCEPTION 'Replace both verifier placeholders with distinct locally generated SCRAM-SHA-256 verifiers.';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN (${literal(adminRole)},${literal(appRole)})) OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=${literal(schema)}) THEN
  RAISE EXCEPTION 'Folio schema or roles already exist. Inspect them and run the migration-only payload; bootstrap never changes existing roles.';
 END IF;
 EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',${literal(adminRole)},admin_verifier);
 EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',${literal(appRole)},app_verifier);
 EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I',${literal(schema)},current_user);
END $folio_bootstrap$;
REVOKE ALL ON SCHEMA ${s} FROM PUBLIC,${a},${u};
GRANT USAGE ON SCHEMA ${s} TO ${a},${u};`;
}

export function buildMigrationSql(migrations:Migration[],options:MigrationOptions){
 const schema=databaseIdentifier(options.schema),adminRole=databaseIdentifier(options.adminRole??'folio_admin','role'),appRole=databaseIdentifier(options.appRole??'folio_app','role');
 const s=quoteIdentifier(schema),a=quoteIdentifier(adminRole),u=quoteIdentifier(appRole),isolated=schema!=='public';
 if(adminRole===appRole)throw new Error('Administrator and tenant runtime roles must be distinct.');
 const parts=['BEGIN;',...(options.bootstrap?[bootstrapSql({schema,adminRole,appRole})]:[]),
  `SET LOCAL search_path=${s},pg_catalog,pg_temp;`,
  `SELECT pg_advisory_xact_lock(hashtextextended(${literal(`folio:migrations:${schema}`)},0));`,
  `DO $folio_schema_guard$ BEGIN IF current_schema() IS DISTINCT FROM ${literal(schema)} THEN RAISE EXCEPTION 'The selected application schema must exist before migration.'; END IF; END $folio_schema_guard$;`,
 ];
 if(isolated)parts.push(`DO $folio_roles_guard$
DECLARE role_name text; role_row record;
BEGIN
 FOREACH role_name IN ARRAY ARRAY[${literal(adminRole)},${literal(appRole)}] LOOP
  SELECT * INTO role_row FROM pg_roles WHERE rolname=role_name;
  IF NOT FOUND OR NOT role_row.rolcanlogin OR role_row.rolsuper OR role_row.rolcreatedb OR role_row.rolcreaterole OR role_row.rolinherit OR role_row.rolreplication OR role_row.rolbypassrls THEN
   RAISE EXCEPTION 'Folio runtime roles must be existing restricted login roles without superuser, inheritance, or RLS bypass.';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=${literal(schema)} AND nspowner=role_row.oid) OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relowner=role_row.oid) THEN
   RAISE EXCEPTION 'Runtime roles must not own the application schema or its relations. Use a separate migration identity.';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','auth','storage') AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(role_row.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE')) THEN
   RAISE EXCEPTION 'A new runtime role inherits access to legacy application tables. Review existing PUBLIC grants before proceeding.';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','auth','storage') AND p.prosecdef AND has_schema_privilege(role_row.oid,n.oid,'USAGE') AND has_function_privilege(role_row.oid,p.oid,'EXECUTE')) THEN
   RAISE EXCEPTION 'A new runtime role can execute a legacy SECURITY DEFINER function. Review existing function grants before proceeding.';
  END IF;
 END LOOP;
 IF pg_has_role(${literal(appRole)},${literal(adminRole)},'MEMBER') THEN RAISE EXCEPTION 'Tenant role must not be a member of the backend administrator role.'; END IF;
END $folio_roles_guard$;`);
 parts.push('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz DEFAULT now());');
 for(const migration of migrations){
  if(!/^\d+_[a-z0-9_]+\.sql$/.test(migration.name))throw new Error('Invalid migration filename.');
  const tag=`folio_sql_${migration.name.replaceAll('.','_')}`;
  const sql=migration.sql.replace(/\bfolio_app\b/g,appRole);
  if(sql.includes(`$${tag}$`))throw new Error('Migration contains reserved SQL delimiter.');
  parts.push(`DO $folio_apply$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM ${s}.schema_migrations WHERE name=${literal(migration.name)}) THEN
  EXECUTE $${tag}$${sql}$${tag}$;
  INSERT INTO ${s}.schema_migrations(name) VALUES(${literal(migration.name)});
 END IF;
END $folio_apply$;`);
 }
 parts.push(`GRANT USAGE ON SCHEMA ${s} TO ${u};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${s} TO ${u};
REVOKE ALL ON ${s}.users,${s}.sessions,${s}.memberships,${s}.workspaces,${s}.schema_migrations FROM ${u};
GRANT SELECT ON ${s}.workspaces TO ${u};
REVOKE ALL ON ${s}.provider_events FROM ${u};
REVOKE UPDATE,DELETE ON ${s}.document_events FROM ${u};`);
 if(isolated)parts.push(`REVOKE ALL ON SCHEMA ${s} FROM PUBLIC;
REVOKE CREATE ON SCHEMA ${s} FROM ${a},${u};
REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${s} TO ${a};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${s} TO ${a};
GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${s} TO ${a},${u};
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${a},${u};
REVOKE ALL ON ${s}.schema_migrations FROM ${a},${u};
REVOKE UPDATE,DELETE ON ${s}.document_events FROM ${a};
DO $folio_policies$
DECLARE relation record; api_role text;
BEGIN
 FOREACH api_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=api_role) THEN
   EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I',${literal(schema)},api_role);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I',${literal(schema)},api_role);
   EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I',${literal(schema)},api_role);
   EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I',${literal(schema)},api_role);
  END IF;
 END LOOP;
 FOR relation IN SELECT c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(schema)} AND c.relkind IN ('r','p') LOOP
  IF relation.relname NOT IN ('users','sessions','memberships','provider_events','schema_migrations') AND (NOT relation.relrowsecurity OR NOT relation.relforcerowsecurity) THEN
   RAISE EXCEPTION 'Application tenant table % must enable and force RLS.',relation.relname;
  END IF;
  IF relation.relrowsecurity THEN
   EXECUTE format('DROP POLICY IF EXISTS folio_backend_admin ON %I.%I',${literal(schema)},relation.relname);
   EXECUTE format('CREATE POLICY folio_backend_admin ON %I.%I TO %I USING(true) WITH CHECK(true)',${literal(schema)},relation.relname,${literal(adminRole)});
  END IF;
 END LOOP;
END $folio_policies$;`);
 parts.push('COMMIT;');return parts.join('\n\n')+'\n';
}

async function main(){
 const migrations=await readMigrations();
 const options:MigrationOptions={schema:databaseSchema,adminRole:process.env.DATABASE_ADMIN_ROLE,appRole:process.env.DATABASE_APP_ROLE};
 if(process.argv.includes('--sql')){
  if(databaseSchema==='public')throw new Error('SQL Editor output requires an explicit private DATABASE_SCHEMA.');
  process.stdout.write(buildMigrationSql(migrations,{...options,bootstrap:!process.argv.includes('--existing')}));return;
 }
 if(databaseSchema!=='public'&&!process.env.DATABASE_MIGRATION_URL)throw new Error('Private schema migration requires a separate DATABASE_MIGRATION_URL. Runtime credentials cannot perform migrations.');
 const connectionString=process.env.DATABASE_MIGRATION_URL??process.env.DATABASE_ADMIN_URL;
 const pool=new pg.Pool(secureDatabaseConfig(connectionString?{connectionString,max:1}:{...databaseConfig,user:process.env.PGADMINUSER||'folio_admin',max:1}));
 const client=await pool.connect();
 try{await client.query(buildMigrationSql(migrations,options));console.log(`Verified ${migrations.length} migrations in application schema ${databaseSchema}.`);}
 catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();await pool.end();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
