import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {databaseConfig} from '../server/core/config.js';
import {databaseIdentifier,secureDatabaseConfig,scopeDatabasePool,transaction,closeDatabase} from '../server/core/db.js';
import {buildMigrationSql,readMigrations,scramVerifier} from '../scripts/migrate.js';

const suffix=randomBytes(8).toString('hex'),schema=`folio_qa_${suffix}`,adminRole=`folio_qa_admin_${suffix}`,appRole=`folio_qa_app_${suffix}`,canary=`folio_qa_legacy_${suffix}`;
const adminPassword=randomBytes(32).toString('base64url'),appPassword=randomBytes(32).toString('base64url');
const control=new pg.Pool(process.env.DATABASE_ADMIN_URL?secureDatabaseConfig({connectionString:process.env.DATABASE_ADMIN_URL,max:1}):{...databaseConfig,user:process.env.PGADMINUSER||'folio_admin',max:1});
let administrator:pg.Pool,tenant:pg.Pool;
const workspaceA=randomUUID(),workspaceB=randomUUID(),userId=randomUUID(),parserId=randomUUID(),documentId=randomUUID(),jobId=randomUUID(),schemaId=randomUUID();
let migrationSql:string;
async function apply(sql:string){const client=await control.connect();try{return await client.query(sql);}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
function rolePool(role:string,password:string){
 let config:pg.PoolConfig;
 if(process.env.DATABASE_ADMIN_URL){const url=new URL(process.env.DATABASE_ADMIN_URL);url.username=role;url.password=password;config=secureDatabaseConfig({connectionString:url.toString(),max:1});}
 else config={...databaseConfig,user:role,password,max:1};
 return scopeDatabasePool(new pg.Pool(config),schema);
}

before(async()=>{
 // Test-owned schema/roles only: the public worker cannot see these queued records.
 await control.query(`CREATE TABLE public.${canary}(value text NOT NULL)`);
 await control.query(`INSERT INTO public.${canary} VALUES('owned legacy sentinel')`);
 const migrations=await readMigrations();
 migrationSql=buildMigrationSql(migrations,{schema,adminRole,appRole});
 const initial=buildMigrationSql(migrations,{schema,adminRole,appRole,bootstrap:true})
  .replace('__FOLIO_ADMIN_SCRAM_VERIFIER__',scramVerifier(adminPassword))
  .replace('__FOLIO_APP_SCRAM_VERIFIER__',scramVerifier(appPassword));
 await apply(initial);
 administrator=rolePool(adminRole,adminPassword);tenant=rolePool(appRole,appPassword);
});
after(async()=>{
 await Promise.all([administrator?.end(),tenant?.end(),closeDatabase()]);
 await control.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
 await control.query(`DROP TABLE IF EXISTS public.${canary}`);
 await control.query(`DROP ROLE IF EXISTS ${adminRole}`);await control.query(`DROP ROLE IF EXISTS ${appRole}`);
 await control.end();
});

test('schema identifiers and remote TLS cannot introduce another schema or disable certificate verification',()=>{
 for(const value of ['folio,public','folio;drop table users','"folio"','pg_catalog','auth','storage',''])assert.throws(()=>databaseIdentifier(value));
 assert.equal(databaseIdentifier('folio'),'folio');assert.equal(databaseIdentifier('public'),'public');
 const config=secureDatabaseConfig({connectionString:'postgresql://synthetic:synthetic@pooler.example.test:6543/postgres?sslmode=no-verify'},'SYNTHETIC\\nCA');
 assert.deepEqual(config.ssl,{rejectUnauthorized:true,ca:'SYNTHETIC\nCA'});
 assert.equal(new URL(config.connectionString!).searchParams.has('sslmode'),false);
 assert.deepEqual(secureDatabaseConfig({host:'/private/test/socket'},undefined),{host:'/private/test/socket'});
});

test('fresh isolated migrations are idempotent, preserve legacy tables and never grant runtime access to them',async()=>{
 const before=(await control.query(`SELECT name FROM ${schema}.schema_migrations ORDER BY name`)).rows;
 await apply(migrationSql);
 assert.deepEqual((await control.query(`SELECT name FROM ${schema}.schema_migrations ORDER BY name`)).rows,before);
 assert.deepEqual((await control.query(`SELECT value FROM public.${canary}`)).rows,[{value:'owned legacy sentinel'}]);
 for(const role of [adminRole,appRole]){
  const privileges=(await control.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[role])).rows[0];
  assert.ok(Object.values(privileges).every(value=>value===false));
  assert.equal((await control.query('SELECT has_table_privilege($1,$2,\'SELECT,INSERT,UPDATE,DELETE\') allowed',[role,`public.${canary}`])).rows[0].allowed,false);
  assert.equal((await control.query('SELECT has_schema_privilege($1,$2,\'CREATE\') allowed',[role,schema])).rows[0].allowed,false);
 }
 await assert.rejects(administrator.query(`SELECT * FROM public.${canary}`),/permission denied/);
 await assert.rejects(tenant.query(`SELECT * FROM public.${canary}`),/permission denied/);
});

test('direct pool and checked-out client queries reset schema and bounded timeouts for every transaction',async()=>{
 for(let index=0;index<3;index++){
  const result=await administrator.query("SELECT current_schema() schema,current_setting('statement_timeout') statement_timeout,current_setting('lock_timeout') lock_timeout");
  assert.deepEqual(result.rows[0],{schema,statement_timeout:'10s',lock_timeout:'5s'});
 }
 const client=await administrator.connect();
 try{
  assert.equal((await client.query('SELECT current_schema() schema')).rows[0].schema,schema);
  await client.query('BEGIN');
  assert.equal((await client.query('SELECT current_schema() schema')).rows[0].schema,schema);
  await client.query('SAVEPOINT owned_checkpoint');await client.query('ROLLBACK TO SAVEPOINT owned_checkpoint');
  await client.query('COMMIT');
  assert.equal((await client.query('SELECT current_schema() schema')).rows[0].schema,schema);
 }finally{client.release();}
 await assert.rejects(administrator.query({name:'unsupported_session_statement',text:'SELECT 1'}),/unnamed SQL/);
});

test('migration refuses indirect legacy access through PUBLIC-executable SECURITY DEFINER functions',async()=>{
 await control.query(`CREATE FUNCTION public.${canary}() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS 'SELECT value FROM public.${canary} LIMIT 1'`);
 try{
  assert.equal((await administrator.query(`SELECT public.${canary}() value`)).rows[0].value,'owned legacy sentinel');
  await assert.rejects(apply(migrationSql),/legacy SECURITY DEFINER function/);
  assert.deepEqual((await control.query(`SELECT value FROM public.${canary}`)).rows,[{value:'owned legacy sentinel'}]);
 }finally{await control.query(`DROP FUNCTION public.${canary}()`);}
});

test('restricted administrator operates across workspaces while tenant context cannot leak after commit or rollback',async()=>{
 await administrator.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[userId,`owned-${suffix}@example.test`,'Owned isolation fixture','unusable-fixture-hash']);
 for(const id of [workspaceA,workspaceB])await administrator.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[id,'Owned isolation workspace',id]);
 assert.equal((await administrator.query('SELECT id FROM workspaces')).rowCount,2);
 assert.equal((await tenant.query('SELECT id FROM workspaces')).rowCount,0);
 for(const id of [workspaceA,workspaceB,workspaceA]){
  const rows=await transaction(tenant,async client=>{await client.query("SELECT set_config('app.workspace_id',$1,true)",[id]);return (await client.query('SELECT id FROM workspaces')).rows;});
  assert.deepEqual(rows,[{id}]);assert.equal((await tenant.query('SELECT id FROM workspaces')).rowCount,0);
 }
 await assert.rejects(transaction(tenant,async client=>{await client.query("SELECT set_config('app.workspace_id',$1,true)",[workspaceA]);await client.query('SELECT missing_owned_column FROM workspaces');}),/does not exist/);
 assert.equal((await tenant.query('SELECT id FROM workspaces')).rowCount,0);
 await assert.rejects(tenant.query('SELECT * FROM users'),/permission denied/);
 await assert.rejects(administrator.query('CREATE TABLE unauthorized_runtime_ddl(id int)'),/permission denied/);
});

test('document journal uses the trigger table schema and supports non-bypass administrator claims',async()=>{
 await transaction(tenant,async client=>{
  await client.query("SELECT set_config('app.workspace_id',$1,true)",[workspaceA]);
  await client.query('INSERT INTO parsers(id,workspace_id,name) VALUES($1,$2,$3)',[parserId,workspaceA,'Owned isolated parser']);
  await client.query('INSERT INTO schema_versions(id,workspace_id,parser_id,version,schema,created_by) VALUES($1,$2,$3,1,$4,$5)',[schemaId,workspaceA,parserId,JSON.stringify({fields:[]}),userId]);
  await client.query("INSERT INTO documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count) VALUES($1,$2,$3,'owned.txt','text/plain',1,'owned-isolation-sha',$4,'received',1)",[documentId,workspaceA,parserId,`${workspaceA}/${documentId}`]);
  await client.query('INSERT INTO jobs(id,workspace_id,document_id,schema_version_id,config) VALUES($1,$2,$3,$4,$5)',[jobId,workspaceA,documentId,schemaId,JSON.stringify({mode:'rules'})]);
  await client.query("UPDATE documents SET status='queued' WHERE id=$1",[documentId]);
 });
 await administrator.query("UPDATE documents SET status='processing' WHERE id=$1",[documentId]);
 const events=(await administrator.query('SELECT state,operation_id FROM document_events WHERE document_id=$1 ORDER BY sequence',[documentId])).rows;
 assert.deepEqual(events,[{state:'received',operation_id:null},{state:'queued',operation_id:jobId},{state:'processing',operation_id:jobId}]);
 await assert.rejects(administrator.query('UPDATE document_events SET state=state WHERE document_id=$1',[documentId]),/permission denied/);
});

test('releasing an unfinished scoped transaction rolls it back instead of returning contaminated state',async()=>{
 const id=randomUUID(),client=await administrator.connect();
 await client.query('BEGIN');await client.query('INSERT INTO workspaces(id,name,slug) VALUES($1,$2,$3)',[id,'Abandoned transaction fixture',id]);
 client.release();
 assert.equal((await administrator.query('SELECT id FROM workspaces WHERE id=$1',[id])).rowCount,0);
 assert.equal((await administrator.query('SELECT current_schema() schema')).rows[0].schema,schema);
});
