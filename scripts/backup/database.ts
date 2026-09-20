import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Writable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import pg from 'pg';
import {to as copyTo,from as copyFrom} from 'pg-copy-streams';
import {backupLimits,readPrivateFile,hashFile} from './files.js';
import {BackupError} from './errors.js';
import {backupWatchdog} from './watchdog.js';
import {readMigrations,buildMigrationSql,databaseIdentifier,quoteIdentifier,type Migration} from '../migration-sql.js';
import type {BackupConfig,BackupDatabaseManifest,BackupObjectReference,BackupPayloadFile,BackupTable,BackupSequence} from './types.js';

const failure=(message:string)=>new BackupError('BACKUP_DATABASE',`Backup database: ${message}`);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const qualified=(schema:string,table:string)=>`${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
const knownSequence='document_events_sequence_seq';
const runtimePrivileges=['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'];
function assert(condition:unknown,message:string):asserts condition {if(!condition)throw failure(message);}
function safeNumber(value:unknown){const result=Number(value);assert(Number.isSafeInteger(result)&&result>=0,'A database count is outside the supported range.');return result;}

async function connection(config:BackupConfig){
 databaseIdentifier(config.schema);databaseIdentifier(config.adminRole,'role');databaseIdentifier(config.appRole,'role');
 assert(config.adminRole!==config.appRole&&![config.adminRole,config.appRole].includes(config.database.user),'Use a separate backup/migration identity and distinct restricted runtime roles.');
 const c=config.database;let password='';
 if(c.passwordFile)password=(await readPrivateFile(c.passwordFile,16384)).toString('utf8').replace(/\r?\n$/,'');
 const local=c.host.startsWith('/')||['localhost','127.0.0.1','::1','[::1]'].includes(c.host);
 const ca=c.sslCaFile?await fs.readFile(c.sslCaFile,'utf8'):undefined;
 const client=new pg.Client({host:c.host,port:c.port,database:c.database,user:c.user,password,ssl:ca||!local?{rejectUnauthorized:true,...(ca?{ca}:{})}:false,application_name:'folio_backup',connectionTimeoutMillis:10000});
 client.on('error',()=>{ /* Subsequent required database checks fail closed; never log server contents. */ });
 try{await client.connect();return client;}catch{await client.end().catch(()=>{});throw failure('Could not connect with the explicit backup database configuration.');}
}
async function noOtherClients(client:pg.Client,config?:BackupConfig){
 await client.query('SELECT pg_stat_clear_snapshot()');
 const result=await client.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid() AND backend_type='client backend' AND ($1::text[] IS NULL OR usename=ANY($1::text[]))",[config?.databaseProfile==='managed-source'?[config.adminRole,config.appRole,config.database.user]:null]);
 assert(result.rows[0].n===0,'Stop all other clients connected to this database before backup or restore.');
 assert((await client.query('SELECT 1 FROM pg_prepared_xacts WHERE database=current_database() LIMIT 1')).rowCount===0,'Prepared transactions prevent a quiesced backup or restore.');
}
async function identity(client:pg.Client){
 const result=await client.query("SELECT current_setting('server_version_num')::int version,current_setting('server_encoding') encoding,(SELECT system_identifier::text FROM pg_control_system()) system_identifier,(SELECT oid::text FROM pg_database WHERE datname=current_database()) database_oid,current_user");
 const row=result.rows[0];assert(Math.floor(row.version/10000)===17,'Only PostgreSQL 17 databases are supported.');assert(row.encoding==='UTF8','Only UTF8 databases are supported.');
 const role=(await client.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert(role?.rolsuper||role?.rolbypassrls,'The backup/migration identity must bypass RLS to read every row.');
 return {postgresMajor:17,encoding:row.encoding as string,sourceIdentity:sha(`${row.system_identifier}:${row.database_oid}`),owner:row.current_user as string};
}
async function managedQuiescence(client:pg.Client,config:BackupConfig){
 if(config.databaseProfile!=='managed-source')return;
 assert(config.schema!=='public','Managed capture requires a private application schema.');
 const s=quoteIdentifier(config.schema);
 const active=await client.query(`SELECT
  EXISTS(SELECT 1 FROM ${s}.jobs WHERE state='processing') OR
  EXISTS(SELECT 1 FROM ${s}.schema_suggestions WHERE state='processing') OR
  EXISTS(SELECT 1 FROM ${s}.split_suggestions WHERE state='processing' OR write_until>clock_timestamp() OR staging_expires_at>clock_timestamp()) OR
  EXISTS(SELECT 1 FROM ${s}.provider_events WHERE status='processing') OR
  EXISTS(SELECT 1 FROM ${s}.webhook_deliveries WHERE status='delivering') OR
  EXISTS(SELECT 1 FROM ${s}.account_email_outbox WHERE state='sending') OR
  EXISTS(SELECT 1 FROM ${s}.invitation_email_outbox WHERE state='sending') OR
  EXISTS(SELECT 1 FROM ${s}.direct_uploads WHERE state='finalizing' OR cleanup_after>clock_timestamp()) OR
  EXISTS(SELECT 1 FROM ${s}.intake_files WHERE lease_expires_at>clock_timestamp()) active`);
 assert(active.rows[0]?.active===false,'Drain all in-flight work and wait for signed upload/writer capabilities to expire before managed capture.');
}
async function roles(client:pg.Client,config:BackupConfig){
 const rows=(await client.query('SELECT oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1::text[])',[[config.adminRole,config.appRole]])).rows;
 assert(rows.length===2&&rows.every(r=>r.rolcanlogin&&!r.rolsuper&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolinherit&&!r.rolreplication&&!r.rolbypassrls),'Both runtime roles must be existing restricted LOGIN NOINHERIT roles without elevated privileges.');
 assert((await client.query('SELECT 1 FROM pg_auth_members WHERE member=ANY($1::oid[]) LIMIT 1',[rows.map(r=>r.oid)])).rowCount===0,'Runtime role memberships are not supported.');
 assert((await client.query('SELECT 1 FROM pg_namespace WHERE nspowner=ANY($1::oid[]) UNION ALL SELECT 1 FROM pg_class WHERE relowner=ANY($1::oid[]) UNION ALL SELECT 1 FROM pg_proc WHERE proowner=ANY($1::oid[]) LIMIT 1',[rows.map(r=>r.oid)])).rowCount===0,'Runtime roles must not own database objects.');
}
function migrationTables(migrations:Migration[]){
 const names=new Set<string>(['schema_migrations']);
 for(const m of migrations)for(const match of m.sql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)\s*\(/gi))names.add(databaseIdentifier(match[1]));
 return [...names].sort();
}
async function migrationsAt(client:pg.Client,config:BackupConfig,migrations:Migration[]){
 const rows=(await client.query(`SELECT name FROM ${qualified(config.schema,'schema_migrations')} ORDER BY name`)).rows;
 const expected=migrations.map(m=>({name:m.name,sha256:sha(m.sql)}));
 assert(same(rows.map(r=>r.name),expected.map(m=>m.name)),'Applied migrations must match every current checked-in migration exactly.');return expected;
}
async function catalogue(client:pg.Client,config:BackupConfig,expected:string[],countRows=true):Promise<BackupTable[]>{
 const rows=(await client.query("SELECT c.oid,c.relname,c.relkind,c.relpersistence,c.relispartition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY c.relname",[config.schema])).rows;
 assert(rows.every(r=>r.relkind==='S'||(r.relkind==='r'&&r.relpersistence==='p'&&!r.relispartition)),'Unsupported views, partitions, foreign or unlogged relations exist in the application schema.');
 assert(same(rows.filter(r=>r.relkind==='r').map(r=>r.relname),expected),'Application tables differ from the checked-in migration catalogue.');
 assert(same(rows.filter(r=>r.relkind==='S').map(r=>r.relname),[knownSequence]),'Application sequences differ from the supported migration catalogue.');
 const tables:BackupTable[]=[];
 for(const row of rows.filter(r=>r.relkind==='r')){
  const columns=(await client.query("SELECT attname name,format_type(atttypid,atttypmod) type,attgenerated generated,attidentity identity,atttypid::int type_oid FROM pg_attribute WHERE attrelid=$1 AND attnum>0 AND NOT attisdropped ORDER BY attnum",[row.oid])).rows;
  for(const column of columns){assert([16,17,20,23,25,1009,1184,1700,2950,2951,3802].includes(column.type_oid),'An application column uses a type outside the supported built-in migration types.');delete column.type_oid;databaseIdentifier(column.name);assert(column.generated===''&&['','a','d'].includes(column.identity),'Stored generated columns are not supported.');}
  const keys=(await client.query("SELECT a.attname FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,position) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum WHERE i.indrelid=$1 AND i.indisprimary ORDER BY k.position",[row.oid])).rows.map(r=>r.attname as string);
  assert(keys.length>0,'Every application table must have a primary key.');
  const count=countRows?safeNumber((await client.query(`SELECT count(*)::text n FROM ${qualified(config.schema,row.relname)}`)).rows[0].n):0;
  tables.push({name:row.relname,columns,primaryKey:keys,rows:count});
 }
 return tables;
}
async function sequences(client:pg.Client,config:BackupConfig):Promise<BackupSequence[]>{
 const row=(await client.query(`SELECT last_value::text,is_called FROM ${qualified(config.schema,knownSequence)}`)).rows[0];return [{name:knownSequence,lastValue:row.last_value,isCalled:row.is_called}];
}
function normalized(value:unknown,config:BackupConfig,owner:string):unknown {
 if(typeof value==='string'){
  if(value===config.adminRole)return '$admin';if(value===config.appRole)return '$app';if(value===owner)return '$owner';
  return value.replaceAll(`${quoteIdentifier(config.schema)}.`, '$schema.').replaceAll(`${config.schema}.`,'$schema.');
 }
 if(Array.isArray(value))return value.map(v=>normalized(v,config,owner));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalized(v,config,owner)]));
 return value;
}
/** Actual ACLs, definitions and constraint/trigger state must equal a clean migration template. */
async function security(client:pg.Client,config:BackupConfig,_owner:string){
 const schema=(await client.query('SELECT oid,pg_get_userbyid(nspowner) owner FROM pg_namespace WHERE nspname=$1',[config.schema])).rows[0];assert(schema,'The application schema does not exist.');const {oid,owner}=schema;
 const tables=(await client.query("SELECT c.relname name,c.relrowsecurity rls,c.relforcerowsecurity force,pg_get_userbyid(c.relowner) owner FROM pg_class c WHERE c.relnamespace=$1 AND c.relkind='r' ORDER BY c.relname",[oid])).rows;
 const columns=(await client.query("SELECT c.relname table_name,a.attname name,a.attnotnull not_null,pg_get_expr(d.adbin,d.adrelid) default_value,a.attacl::text acl FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE c.relnamespace=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",[oid])).rows;
 assert(columns.every(c=>c.acl===null),'Column-specific grants are not supported.');
 const constraints=(await client.query("SELECT c.relname table_name,x.conname name,x.contype type,x.condeferrable deferrable,x.condeferred deferred,x.convalidated validated,pg_get_constraintdef(x.oid,true) definition FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid WHERE c.relnamespace=$1 ORDER BY c.relname,x.conname",[oid])).rows;
 const indexes=(await client.query("SELECT c.relname table_name,i.relname name,pg_get_indexdef(i.oid) definition FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid WHERE c.relnamespace=$1 ORDER BY c.relname,i.relname",[oid])).rows;
 const policies=(await client.query("SELECT c.relname table_name,p.polname name,p.polpermissive permissive,p.polcmd command,ARRAY(SELECT CASE WHEN r=0 THEN 'PUBLIC' ELSE pg_get_userbyid(r)::text END FROM unnest(p.polroles) r ORDER BY r) roles,pg_get_expr(p.polqual,p.polrelid) using_expression,pg_get_expr(p.polwithcheck,p.polrelid) check_expression FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace=$1 ORDER BY c.relname,p.polname",[oid])).rows;
 const triggers=(await client.query("SELECT c.relname table_name,t.tgname name,t.tgenabled enabled,pg_get_triggerdef(t.oid,true) definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=$1 AND NOT t.tgisinternal ORDER BY c.relname,t.tgname",[oid])).rows;
 assert(triggers.length===1&&triggers[0].table_name==='documents'&&triggers[0].name==='document_status_journal'&&triggers[0].enabled==='O','The journal trigger differs from the supported migration template.');
 const internalTriggers=(await client.query("SELECT c.relname table_name,t.tgenabled enabled,t.tgtype type,t.tgdeferrable deferrable,t.tginitdeferred deferred,x.conname constraint_name,p.proname function_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid LEFT JOIN pg_constraint x ON x.oid=t.tgconstraint WHERE c.relnamespace=$1 AND t.tgisinternal ORDER BY c.relname,x.conname,p.proname,t.tgtype",[oid])).rows;
 const sequenceDefinitions=(await client.query("SELECT c.relname name,format_type(s.seqtypid,NULL) type,s.seqstart::text start,s.seqincrement::text increment,s.seqmax::text maximum,s.seqmin::text minimum,s.seqcache::text cache,s.seqcycle cycle FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid WHERE c.relnamespace=$1 ORDER BY c.relname",[oid])).rows;
 const functions=(await client.query("SELECT p.proname name,pg_get_function_identity_arguments(p.oid) arguments,pg_get_functiondef(p.oid) definition,p.prosecdef security_definer,p.proconfig config,pg_get_userbyid(p.proowner) owner FROM pg_proc p WHERE p.pronamespace=$1 ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)",[oid])).rows;
 const acl=(await client.query("SELECT object_kind,name,CASE WHEN grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END grantee,pg_get_userbyid(grantor) grantor,privilege_type,is_grantable FROM (SELECT 'schema' object_kind,n.nspname name,x.* FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) x WHERE n.oid=$1 UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'table' END,c.relname,x.* FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner))) x WHERE c.relnamespace=$1 AND c.relkind IN ('r','S') UNION ALL SELECT 'function',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',x.* FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE p.pronamespace=$1) q ORDER BY object_kind,name,grantee,grantor,privilege_type",[oid])).rows;
 // Schema-specific defaults would silently widen permissions on future migrations.
 assert((await client.query('SELECT 1 FROM pg_default_acl WHERE (defaclnamespace=$1 OR defaclnamespace=0) AND ($2::text IS NULL OR defaclrole=(SELECT oid FROM pg_roles WHERE rolname=$2)) LIMIT 1',[oid,config.databaseProfile==='managed-source'?owner:null])).rowCount===0,'Custom default privileges are not supported.');
 // No runtime role may receive effective permissions through inherited PUBLIC grants beyond its explicit ACL.
 const effective=[];
 for(const role of [config.adminRole,config.appRole]){
  const relations=(await client.query("SELECT c.relname name,ARRAY(SELECT p FROM unnest($3::text[]) p WHERE has_table_privilege($2,c.oid,p) ORDER BY p) privileges FROM pg_class c WHERE c.relnamespace=$1 AND c.relkind='r' ORDER BY c.relname",[oid,role,runtimePrivileges])).rows;
  effective.push({role,relations,schema:(await client.query("SELECT has_schema_privilege($1,$2,'CREATE') can_create,has_schema_privilege($1,$2,'USAGE') can_use",[role,config.schema])).rows[0]});
 }
 const normalizedAcl=(normalized(acl.map(r=>({...r,name:r.object_kind==='schema'?'$schema':r.name})),config,owner) as unknown[]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
 const data=normalized({tables,columns,constraints,indexes,policies:policies.map(p=>({...p,roles:(normalized(p.roles,config,owner) as string[]).sort()})),triggers,internalTriggers,sequenceDefinitions,functions,acl:normalizedAcl,effective},config,owner);
 return {sha256:sha(JSON.stringify(data)),tables,constraints,triggers};
}
async function installedWatchdog(client:pg.Client,config:BackupConfig){
 const rows=(await client.query("SELECT p.prosrc body,p.prosecdef definer,p.provolatile volatility,p.proconfig config,p.prorettype=16 boolean_result,p.pronargs,p.prokind kind,l.lanname language,pg_get_userbyid(p.proowner) owner,pg_get_userbyid(n.nspowner) schema_owner FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname=$1 AND p.proname='worker_has_runnable_work'",[config.schema])).rows;
 if(!rows.length)return undefined;
 const expected=await backupWatchdog(config.schema,config.adminRole,config.appRole),row=rows[0];
 assert(rows.length===1&&row.body===expected.body&&row.definer===false&&row.volatility==='s'&&same(row.config,['search_path=pg_catalog'])&&row.boolean_result&&row.pronargs===0&&row.kind==='f'&&row.language==='sql'&&row.owner===row.schema_owner,'The operational watchdog differs from the reviewed checked-in invoker function.');
 const acl=await client.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname=$1 AND p.proname='worker_has_runnable_work' AND a.grantee<>p.proowner LIMIT 1",[config.schema]);
 assert(acl.rowCount===0,'The operational watchdog must remain executable only by its owner.');return expected.sha256;
}
async function objectReferences(client:pg.Client,config:BackupConfig){
 const s=quoteIdentifier(config.schema),rows=(await client.query(`SELECT workspace_id::text workspace_id,storage_key key,true required,byte_size::text byte_size,sha256 FROM ${s}.documents UNION ALL SELECT workspace_id::text,source_storage_key,true,source_byte_size::text,source_sha256 FROM ${s}.pdf_splits WHERE source_storage_key IS NOT NULL UNION ALL SELECT workspace_id::text,source_storage_key,true,source_byte_size::text,source_sha256 FROM ${s}.archive_imports WHERE source_storage_key IS NOT NULL UNION ALL SELECT workspace_id::text,source_storage_key,state IN ('queued','processing','ready') AND source_released_at IS NULL,expected_bytes::text,source_sha256 FROM ${s}.split_suggestions WHERE source_storage_key IS NOT NULL UNION ALL SELECT workspace_id::text,staging_storage_key,false,NULL,NULL FROM ${s}.split_suggestions WHERE staging_storage_key IS NOT NULL UNION ALL SELECT workspace_id::text,storage_key,false,NULL,NULL FROM ${s}.intake_files UNION ALL SELECT workspace_id::text,storage_key,false,NULL,NULL FROM ${s}.direct_uploads UNION ALL SELECT workspace_id::text,storage_key,false,NULL,NULL FROM ${s}.file_deletions`)).rows;
 const found=new Map<string,BackupObjectReference>();
 for(const row of rows){assert(typeof row.key==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.key),'A stored object reference is invalid.');
  assert(row.key.split('/')[0]===row.workspace_id,'A stored object reference belongs to a different workspace.');
  const item:BackupObjectReference={key:row.key,required:row.required};if(row.required){item.byteSize=safeNumber(row.byte_size);assert(/^[a-f0-9]{64}$/.test(row.sha256),'A stored object digest is invalid.');item.sha256=row.sha256;}
  const old=found.get(item.key);assert(!old?.required||!item.required||(old.sha256===item.sha256&&old.byteSize===item.byteSize),'Conflicting required object references exist.');if(!old||item.required)found.set(item.key,item);
 }return [...found.values()].sort((a,b)=>a.key.localeCompare(b.key));
}
function compareObjectReferences(actual:BackupObjectReference[],expected:BackupObjectReference[]){
 const canonical=(items:BackupObjectReference[])=>{
  assert(new Set(items.map(o=>o.key)).size===items.length,'The backup object inventory contains duplicate references.');
  return items.map(o=>({key:o.key,required:o.required,...(o.required?{byteSize:o.byteSize,sha256:o.sha256}:{})})).sort((a,b)=>a.key.localeCompare(b.key));
 };
 assert(same(canonical(actual),canonical(expected)),'Database object references differ from the backup object inventory.');
}
const copySql=(schema:string,table:BackupTable)=>`COPY (SELECT ${table.columns.map(c=>quoteIdentifier(c.name)).join(',')} FROM ${qualified(schema,table.name)} ORDER BY ${table.primaryKey.map(quoteIdentifier).join(',')}) TO STDOUT WITH (FORMAT binary)`;
async function hashCopy(client:pg.Client,schema:string,table:BackupTable,outputPath?:string,maxBytes=backupLimits.payloadBytes):Promise<BackupPayloadFile>{
 const hash=createHash('sha256');let bytes=0;
 const meter=new Transform({transform(chunk:Buffer,_encoding,callback){bytes+=chunk.length;if(bytes>maxBytes){callback(failure('The streamed table payload exceeds the remaining backup byte budget.'));return;}hash.update(chunk);callback(null,chunk);}});
 const destination=outputPath?createWriteStream(outputPath,{flags:'wx',mode:0o600}):new Writable({write(_chunk,_encoding,callback){callback();}});
 await pipeline(client.query(copyTo(copySql(schema,table))),meter,destination);
 return {name:`tables/${table.name}.bin`,bytes,sha256:hash.digest('hex')};
}
async function beginSnapshot(client:pg.Client,config:BackupConfig,names:string[]){
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 await client.query(`SET LOCAL search_path=${quoteIdentifier(config.schema)},pg_catalog; SET LOCAL statement_timeout='10min'; SET LOCAL lock_timeout='5s'; SET LOCAL row_security=off;`);
 // LOCK is deliberately the first command that can acquire a relation snapshot.
 await client.query(`LOCK TABLE ${names.map(n=>qualified(config.schema,n)).join(',')} IN SHARE MODE NOWAIT`);
}

export async function openSourceDatabase(config:BackupConfig,migrationsDirectory:string){
 const client=await connection(config);let closed=false,writtenBytes=0;
 try{
  const migrations=await readMigrations(migrationsDirectory),names=migrationTables(migrations),ident=await identity(client);await roles(client,config);await noOtherClients(client,config);
  // Discover and reject unknown relations before opening the repeatable-read snapshot.
  await catalogue(client,config,names,false);await beginSnapshot(client,config,names);await noOtherClients(client,config);await managedQuiescence(client,config);
  const watchdogSha256=await installedWatchdog(client,config);
  const tables=await catalogue(client,config,names),sequence=await sequences(client,config),permissions=await security(client,config,ident.owner);
  const manifest:BackupDatabaseManifest={schema:config.schema,postgresMajor:ident.postgresMajor,encoding:ident.encoding,sourceIdentity:ident.sourceIdentity,tables,sequences:sequence,migrations:await migrationsAt(client,config,migrations),securitySha256:permissions.sha256,...(watchdogSha256?{watchdogSha256}:{})};
  const objects=await objectReferences(client,config);
  return {manifest,objects,async writeTable(name:string,outputPath:string,maxBytes=backupLimits.payloadBytes){assert(!closed,'The backup snapshot is closed.');const table=tables.find(t=>t.name===name);assert(table,'Unknown backup table.');try{assert(Number.isSafeInteger(maxBytes)&&maxBytes>=0,'The remaining backup byte budget is invalid.');const file=await hashCopy(client,config.schema,table,outputPath,Math.min(maxBytes,backupLimits.payloadBytes-writtenBytes));writtenBytes+=file.bytes;return file;}catch{throw failure('A table could not be copied to the private backup payload.');}},async verifyQuiescence(){assert(!closed,'The backup snapshot is closed.');await noOtherClients(client,config);await managedQuiescence(client,config);assert((await installedWatchdog(client,config))===watchdogSha256,'The watchdog changed during capture.');assert(same(await sequences(client,config),sequence),'A sequence changed while the backup snapshot was open.');},async close(){if(closed)return;closed=true;try{await client.query('ROLLBACK');}finally{await client.end();}}};
 }catch(error){await client.query('ROLLBACK').catch(()=>{});await client.end().catch(()=>{});if(error instanceof Error&&error.message.startsWith('Backup database:'))throw error;throw failure('Source preflight or snapshot failed. Verify migration privileges and the complete current schema.');}
}

function validateManifest(config:BackupConfig,manifest:BackupDatabaseManifest,migrations:Migration[]){
 assert(manifest.schema===config.schema,'Source and destination application schema names must match.');assert(manifest.postgresMajor===17&&manifest.encoding==='UTF8','The backup PostgreSQL format is unsupported.');
 assert(/^[a-f0-9]{64}$/.test(manifest.sourceIdentity)&&/^[a-f0-9]{64}$/.test(manifest.securitySha256),'The database manifest identity is invalid.');
 assert(same(manifest.migrations,migrations.map(m=>({name:m.name,sha256:sha(m.sql)}))),'Backup migration hashes differ from the checked-in migration set.');
 assert(same(manifest.tables.map(t=>t.name),migrationTables(migrations)),'Backup tables differ from the checked-in migration catalogue.');
 for(const table of manifest.tables){safeNumber(table.rows);assert(table.columns.length>0&&table.primaryKey.length>0,'A backup table shape is invalid.');for(const col of table.columns)databaseIdentifier(col.name);for(const key of table.primaryKey)databaseIdentifier(key);}
 assert(manifest.sequences.length===1&&manifest.sequences[0].name===knownSequence&&/^[1-9][0-9]*$/.test(manifest.sequences[0].lastValue)&&typeof manifest.sequences[0].isCalled==='boolean','The backup sequence state is invalid.');
}
function compareTables(actual:BackupTable[],expected:BackupTable[],rows=true){
 const shape=(items:BackupTable[])=>items.map(t=>({...t,rows:rows?t.rows:0}));assert(same(shape(actual),shape(expected)),'Database column types, primary keys or row counts differ from the backup.');
}
async function verifyPayloads(client:pg.Client,config:BackupConfig,manifest:BackupDatabaseManifest,tableDirectory:string){
 for(const table of manifest.tables){const expected=await hashFile(path.join(tableDirectory,`${table.name}.bin`)),actual=await hashCopy(client,config.schema,table);assert(expected.bytes===actual.bytes&&expected.sha256===actual.sha256,'Restored table bytes differ from the backup payload.');}
}
async function freshTarget(client:pg.Client,config:BackupConfig){
 await noOtherClients(client);
 const others=(await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' LIMIT 1")).rowCount;
 assert(!others,'Restore requires a fresh database without any user relations.');
 assert((await client.query("SELECT 1 FROM pg_extension WHERE extname<>'plpgsql' LIMIT 1")).rowCount===0,'Restore requires a fresh database without added extensions.');
 assert((await client.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' LIMIT 1")).rowCount===0,'Restore requires a fresh database without user functions.');
 assert((await client.query("SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' UNION ALL SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' LIMIT 1")).rowCount===0,'Restore requires a fresh database without user types or collations.');
 assert((await client.query("SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname NOT IN ('information_schema','public',$1) LIMIT 1",[config.schema])).rowCount===0,'Restore target has unexpected user schemas.');
}
export async function restoreDatabase(config:BackupConfig,manifest:BackupDatabaseManifest,tableDirectory:string,migrationsDirectory:string,expectedObjects?:BackupObjectReference[]):Promise<void>{
 assert(!config.databaseProfile&&!config.sourceStorage,'Managed-source settings are capture-only; restore requires a fresh dedicated destination.');
 const migrations=await readMigrations(migrationsDirectory);validateManifest(config,manifest,migrations);const client=await connection(config);let committed=false,commitAttempted=false;
 try{
  const ident=await identity(client);assert(ident.sourceIdentity!==manifest.sourceIdentity,'The restore destination is the source database, even if connection aliases differ.');await roles(client,config);await freshTarget(client,config);
  await client.query('BEGIN');await client.query(`SET LOCAL statement_timeout='10min'; SET LOCAL lock_timeout='5s'; SET LOCAL search_path=${quoteIdentifier(config.schema)},pg_catalog; SET LOCAL row_security=off;`);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(config.schema)} AUTHORIZATION CURRENT_USER`);
  assert((await client.query('SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) owned FROM pg_namespace WHERE nspname=$1',[config.schema])).rows[0]?.owned,'The migration identity must own the empty destination schema.');
  await client.query(buildMigrationSql(migrations,{schema:config.schema,adminRole:config.adminRole,appRole:config.appRole,transaction:false}));
  if(manifest.watchdogSha256){const watchdog=await backupWatchdog(config.schema,config.adminRole,config.appRole);assert(watchdog.sha256===manifest.watchdogSha256,'The backup watchdog does not match this checkout.');await client.query(watchdog.sql);}
  compareTables(await catalogue(client,config,migrationTables(migrations),false),manifest.tables,false);
  const before=await security(client,config,ident.owner);assert(before.sha256===manifest.securitySha256,'Backup permissions, constraints or definitions differ from the clean migration template.');
  const foreignKeys=before.constraints.filter(c=>c.type==='f');
  for(const c of foreignKeys)await client.query(`ALTER TABLE ${qualified(config.schema,c.table_name)} ALTER CONSTRAINT ${quoteIdentifier(c.name)} DEFERRABLE INITIALLY DEFERRED`);
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  for(const table of before.tables.filter(t=>t.force))await client.query(`ALTER TABLE ${qualified(config.schema,table.name)} NO FORCE ROW LEVEL SECURITY`);
  await client.query(`ALTER TABLE ${qualified(config.schema,'documents')} DISABLE TRIGGER ${quoteIdentifier('document_status_journal')}`);
  await client.query(`DELETE FROM ${qualified(config.schema,'schema_migrations')}`);
  for(const table of manifest.tables){const input=path.join(tableDirectory,`${table.name}.bin`);const stat=await fs.lstat(input);assert(stat.isFile()&&!stat.isSymbolicLink(),'A table payload must be a regular file.');await pipeline(createReadStream(input),client.query(copyFrom(`COPY ${qualified(config.schema,table.name)} (${table.columns.map(c=>quoteIdentifier(c.name)).join(',')}) FROM STDIN WITH (FORMAT binary)`)));}
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  for(const c of foreignKeys)await client.query(`ALTER TABLE ${qualified(config.schema,c.table_name)} ALTER CONSTRAINT ${quoteIdentifier(c.name)} ${c.deferrable?`DEFERRABLE INITIALLY ${c.deferred?'DEFERRED':'IMMEDIATE'}`:'NOT DEFERRABLE INITIALLY IMMEDIATE'}`);
  await client.query(`ALTER TABLE ${qualified(config.schema,'documents')} ENABLE TRIGGER ${quoteIdentifier('document_status_journal')}`);
  for(const table of before.tables.filter(t=>t.force))await client.query(`ALTER TABLE ${qualified(config.schema,table.name)} FORCE ROW LEVEL SECURITY`);
  for(const sequence of manifest.sequences)await client.query('SELECT setval($1::regclass,$2::bigint,$3::boolean)',[qualified(config.schema,sequence.name),sequence.lastValue,sequence.isCalled]);
  compareTables(await catalogue(client,config,migrationTables(migrations)),manifest.tables);assert(same(await sequences(client,config),manifest.sequences),'Restored sequence state differs from the backup.');
  assert(same(await migrationsAt(client,config,migrations),manifest.migrations),'Restored migration records differ from the backup.');assert((await security(client,config,ident.owner)).sha256===manifest.securitySha256,'Restore changed permissions, constraints or trigger behavior.');
  if(expectedObjects)compareObjectReferences(await objectReferences(client,config),expectedObjects);
  await verifyPayloads(client,config,manifest,tableDirectory);await roles(client,config);await noOtherClients(client,config);commitAttempted=true;await client.query('COMMIT');committed=true;
 }catch(error){if(!committed)await client.query('ROLLBACK').catch(()=>{});if(commitAttempted&&!committed)throw new BackupError('BACKUP_COMMIT_UNCERTAIN','Backup database: Restore commit confirmation was lost. Keep the destination inactive and verify it before retrying or activating.');if(error instanceof Error&&error.message.startsWith('Backup database:'))throw error;throw failure('Restore failed; the fresh destination transaction was rolled back. Database contents are never included in diagnostics.');}finally{await client.end().catch(()=>{});}
}
export async function verifyRestoredDatabase(config:BackupConfig,manifest:BackupDatabaseManifest,tableDirectory:string,migrationsDirectory:string,expectedObjects?:BackupObjectReference[]):Promise<void>{
 assert(!config.databaseProfile&&!config.sourceStorage,'Managed-source settings are capture-only; verification requires a dedicated destination.');
 const migrations=await readMigrations(migrationsDirectory);validateManifest(config,manifest,migrations);const source=await openSourceDatabase(config,migrationsDirectory);
 try{if(expectedObjects)compareObjectReferences(source.objects,expectedObjects);assert(source.manifest.sourceIdentity!==manifest.sourceIdentity,'Verification destination is the source database.');compareTables(source.manifest.tables,manifest.tables);assert(source.manifest.securitySha256===manifest.securitySha256&&source.manifest.watchdogSha256===manifest.watchdogSha256&&same(source.manifest.sequences,manifest.sequences),'Restored security or sequence state differs from the backup.');
  // The snapshot holds SHARE locks while binary COPY is compared using private temporary files.
  const temp=await fs.mkdtemp(path.join(tableDirectory,'.verify-'));try{await fs.chmod(temp,0o700);for(const table of manifest.tables){const file=path.join(temp,`${table.name}.bin`),actual=await source.writeTable(table.name,file),expected=await hashFile(path.join(tableDirectory,`${table.name}.bin`));assert(actual.bytes===expected.bytes&&actual.sha256===expected.sha256,'Restored table bytes differ from the backup payload.');}}finally{await fs.rm(temp,{recursive:true,force:true});}
  await source.verifyQuiescence();
 }finally{await source.close();}
}
