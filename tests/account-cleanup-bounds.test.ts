import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import pg from 'pg';

// This file runs in its own Node test process. One connection keeps deliberately
// adverse planner settings on every real cleanup/admission query in the test.
const previousMax=process.env.DATABASE_POOL_MAX;
process.env.DATABASE_POOL_MAX='1';
const {adminPool,appPool,databaseSchema,closeDatabase}=await import('../server/core/db.js');
const {config}=await import('../server/core/config.js');
const {cleanupAccountRegistrations,requestVerifiedRegistration}=await import('../server/core/account-registration.js');
const {cleanupEmailVerification,requestEmailVerification}=await import('../server/core/email-verification.js');
const {cleanupAccountRecovery}=await import('../server/core/account-recovery-mail.js');
const {requestPasswordReset}=await import('../server/core/account-recovery.js');
const {cleanupInvitationEmail}=await import('../server/core/invitation-email.js');
const {createPostgresRateLimitStore}=await import('../server/core/rate-limit.js');
const {setAccountEmailSenderForTests}=await import('../server/integrations/account-email.js');
const {encryptSecret,privateIdentifier}=await import('../server/integrations/secrets.js');

type Table=typeof tables[number];
const tables=['account_registration_requests','account_registration_limits','email_verification_requests','email_verification_limits','account_recovery_requests','account_recovery_limits','account_email_outbox','account_security_events','invitation_email_limits','invitation_email_outbox','request_rate_limits'] as const;
const owned=new Map<Table,Set<string>>(),admissionAddresses=new Map<Table,Set<string>>();
const userId=randomUUID(),workspaceId=randomUUID(),invitationId=randomUUID();
const originalFetch=globalThis.fetch;
let guarded=false,fetches=0,sends=0;
const keyColumn=(table:Table)=>table==='request_rate_limits'?'bucket_key':table.endsWith('_limits')?'address_key':'id';
function remember(table:Table,ids:string[]){const values=owned.get(table)??new Set<string>();for(const id of ids)values.add(id);owned.set(table,values);}
function rememberAddress(table:Table,key:string){const values=admissionAddresses.get(table)??new Set<string>();values.add(key);admissionAddresses.set(table,values);}
async function removeOwned(){
 for(const table of tables){
  const ids=[...(owned.get(table)??[])];
  if(ids.length)await adminPool.query(`DELETE FROM ${table} WHERE ${keyColumn(table)}=ANY($1::${keyColumn(table)==='id'?'uuid':'text'}[])`,[ids]);
  const addresses=[...(admissionAddresses.get(table)??[])];
  if(addresses.length)await adminPool.query(`DELETE FROM ${table} WHERE address_key=ANY($1::text[])`,[addresses]);
 }
 owned.clear();admissionAddresses.clear();
}
async function assertIsolatedDatabase(){
 assert.equal(databaseSchema,'public');
 const urlMode=Boolean(adminPool.options.connectionString||appPool.options.connectionString);
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  if(urlMode){
   assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(process.env.DATABASE_ADMIN_URL&&process.env.DATABASE_URL);
   const url=new URL(pool.options.connectionString!);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');
  }else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("SELECT current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];
  assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,urlMode?5432:55432);if(!urlMode)assert.equal(row.address,null);
 }
 // Global cleanup functions must never touch unrelated fixture or application data.
 for(const table of [...tables,'account_recovery_tokens','email_verification_tokens'])assert.equal((await adminPool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0,`${table} must be empty in this isolated suite`);
}
before(async()=>{
 await assertIsolatedDatabase();guarded=true;
 globalThis.fetch=async()=>{fetches++;throw new Error('Network is forbidden in synthetic cleanup fixtures');};
 setAccountEmailSenderForTests({async send(){sends++;throw new Error('Cleanup must not send email');}});
 await adminPool.query("INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,'Synthetic cleanup fixture','not-a-login-credential')",[userId,`owned-cleanup-${userId}@example.test`]);
 await adminPool.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Synthetic cleanup fixture',$2)",[workspaceId,workspaceId]);
 await adminPool.query("INSERT INTO invitations(id,workspace_id,email,role,token_hash,expires_at) VALUES($1,$2,$3,'viewer',$4,clock_timestamp()+interval '1 day')",[invitationId,workspaceId,`owned-invitation-${invitationId}@example.test`,randomBytes(32).toString('hex')]);
});
afterEach(async()=>{if(guarded)await removeOwned();assert.equal(fetches,0);assert.equal(sends,0);});
after(async()=>{
 try{
  if(guarded){await adminPool.query('RESET ALL');await removeOwned();await adminPool.query('DELETE FROM workspaces WHERE id=$1',[workspaceId]);await adminPool.query('DELETE FROM users WHERE id=$1',[userId]);}
  setAccountEmailSenderForTests(undefined);globalThis.fetch=originalFetch;
  if(previousMax===undefined)delete process.env.DATABASE_POOL_MAX;else process.env.DATABASE_POOL_MAX=previousMax;
 }finally{await closeDatabase();}
});

async function insertRows(table:Table,count:number,expired:boolean){
 const column=keyColumn(table),ids=Array.from({length:count},()=>column==='id'?randomUUID():randomBytes(32).toString('hex'));
 remember(table,ids);
 const expires=expired?"clock_timestamp()-interval '1 hour'":"clock_timestamp()+interval '1 day'";
 if(table.endsWith('_requests')){
  await adminPool.query(`INSERT INTO ${table}(id,address_key,payload_ciphertext,created_at,expires_at)
   SELECT id,$2,$3,clock_timestamp()-interval '2 days',${expires} FROM unnest($1::uuid[]) id`,[ids,randomBytes(32).toString('hex'),encryptSecret('{}')]);
 }else if(table.endsWith('_limits')&&table!=='request_rate_limits'){
  await adminPool.query(`INSERT INTO ${table}(address_key,window_started_at,grants,cooldown_until,expires_at)
   SELECT id,clock_timestamp()-interval '2 hours',1,clock_timestamp()-interval '1 hour',${expires} FROM unnest($1::text[]) id`,[ids]);
 }else if(table==='request_rate_limits'){
  await adminPool.query(`INSERT INTO request_rate_limits(bucket_key,hits,expires_at) SELECT id,1,${expires} FROM unnest($1::text[]) id`,[ids]);
 }else if(table==='account_security_events'){
  await adminPool.query(`INSERT INTO account_security_events(id,user_id,action,created_at)
   SELECT id,$2,'password_changed',clock_timestamp()-interval '${expired?'91 days':'1 day'}' FROM unnest($1::uuid[]) id`,[ids,userId]);
 }else if(table==='account_email_outbox'){
  await adminPool.query(`INSERT INTO account_email_outbox(id,user_id,kind,state,created_at,expires_at,finished_at)
   SELECT id,$2,'password_changed','accepted',clock_timestamp()-interval '10 days',clock_timestamp()-interval '9 days',clock_timestamp()-interval '${expired?'8 days':'1 day'}' FROM unnest($1::uuid[]) id`,[ids,userId]);
 }else if(table==='invitation_email_outbox'){
  // The most recent delivery remains useful even after the seven-day cutoff.
  await adminPool.query(`INSERT INTO invitation_email_outbox(id,invitation_id,workspace_id,token_hash,state,created_at,expires_at,finished_at)
   SELECT id,$2,$3,$4,'accepted',clock_timestamp()-interval '${expired?'10 days':'9 days'}',clock_timestamp()-interval '8 days',clock_timestamp()-interval '8 days' FROM unnest($1::uuid[]) id`,[ids,invitationId,workspaceId,randomBytes(32).toString('hex')]);
 }
 return ids;
}
async function prepare(table:Table,count=101){
 assert.equal((await adminPool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
 // Model the small stale statistics seen after an emptied queue is refilled.
 // VACUUM touches only this verified-empty synthetic table, never other data.
 await adminPool.query(`VACUUM ${table}`);
 const [valid]=await insertRows(table,1,false);
 await adminPool.query(`ANALYZE ${table}`);
 const expired=await insertRows(table,count,true);
 // Without a materialized selector, this legal plan can reevaluate the locking
 // subquery after each deletion and exceed LIMIT 100. These settings expose it
 // deterministically; they are confined to this isolated one-connection process.
 await adminPool.query('SET enable_hashjoin=off; SET enable_mergejoin=off; SET enable_material=off; SET enable_hashagg=off; SET enable_sort=off; SET statement_timeout=\'5s\'; SET lock_timeout=\'500ms\'');
 return {valid,expired};
}
async function remaining(table:Table,ids:string[]){return (await adminPool.query(`SELECT ${keyColumn(table)} AS id FROM ${table} WHERE ${keyColumn(table)}=ANY($1::${keyColumn(table)==='id'?'uuid':'text'}[])`,[ids])).rows.map(row=>row.id as string);}
async function assertBounded(table:Table,cleanup:()=>Promise<unknown>){
 let fixture=await prepare(table);
 await cleanup();assert.equal((await remaining(table,fixture.expired)).length,1,'First invocation removes exactly 100 of 101 eligible rows');assert.deepEqual(await remaining(table,[fixture.valid]),[fixture.valid]);
 await cleanup();assert.equal((await remaining(table,fixture.expired)).length,0);assert.deepEqual(await remaining(table,[fixture.valid]),[fixture.valid]);
 await removeOwned();
 fixture=await prepare(table,102);
 // A separate real connection owns one expired row while cleanup skips it.
 const blocker=new pg.Client(adminPool.options);await blocker.connect();
 try{
  await blocker.query('BEGIN');await blocker.query(`SELECT ${keyColumn(table)} FROM ${table} WHERE ${keyColumn(table)}=$1 FOR UPDATE`,[fixture.expired[0]]);
  await cleanup();assert.equal((await remaining(table,fixture.expired)).length,2);assert.deepEqual(await remaining(table,[fixture.expired[0]]),[fixture.expired[0]]);
  await cleanup();assert.deepEqual(await remaining(table,fixture.expired),[fixture.expired[0]]);assert.deepEqual(await remaining(table,[fixture.valid]),[fixture.valid]);
  await blocker.query('ROLLBACK');
  await cleanup();assert.equal((await remaining(table,fixture.expired)).length,0);assert.deepEqual(await remaining(table,[fixture.valid]),[fixture.valid]);
 }finally{await blocker.query('ROLLBACK');await blocker.end();}
}

for(const [table,cleanup] of [
 ['account_registration_requests',cleanupAccountRegistrations],['account_registration_limits',cleanupAccountRegistrations],
 ['email_verification_requests',cleanupEmailVerification],['email_verification_limits',cleanupEmailVerification],
 ['account_recovery_requests',cleanupAccountRecovery],['account_recovery_limits',cleanupAccountRecovery],
 ['account_email_outbox',cleanupAccountRecovery],['account_security_events',cleanupAccountRecovery],
 ['invitation_email_limits',cleanupInvitationEmail],['invitation_email_outbox',cleanupInvitationEmail],
] as const){test(`synthetic ${table} cleanup keeps its batch bound, valid rows and locked rows under a rescan plan`,async()=>assertBounded(table,cleanup));}

for(const [table,namespace,admit] of [
 ['account_registration_requests','folio:account-registration:address:v1',(email:string)=>requestVerifiedRegistration({email,password:'Synthetic cleanup password',name:'Synthetic fixture',workspaceName:'Synthetic fixture'})],
 ['email_verification_requests','folio:email-verification:address:v1',requestEmailVerification],
 ['account_recovery_requests','folio:account-recovery:address:v1',requestPasswordReset],
] as const){
 test(`synthetic ${table} admission keeps its independent cleanup bounded`,async()=>{
  const fixture=await prepare(table),email=`owned-cleanup-admission-${randomUUID()}@example.test`,address=privateIdentifier(namespace,email);
  rememberAddress(table,address);rememberAddress(table.replace('_requests','_limits') as Table,address);
  await admit(email);assert.equal((await remaining(table,fixture.expired)).length,1);assert.deepEqual(await remaining(table,[fixture.valid]),[fixture.valid]);
  assert.equal((await adminPool.query(`SELECT count(*)::int n FROM ${table} WHERE address_key=$1`,[address])).rows[0].n,1);
 });
}

test('synthetic request-rate-limit cleanup remains bounded and skips locked counters while increments work',async()=>{
 const namespace=`owned-cleanup-${randomUUID()}`,key=randomBytes(32).toString('hex');
 const database={query:async(text:string,values?:unknown[])=>{
  if(text.includes('INSERT INTO request_rate_limits')&&typeof values?.[0]==='string')remember('request_rate_limits',[values[0]]);
  return adminPool.query(text,values);
 }};
 const increment=async()=>{
  const Store=createPostgresRateLimitStore({database:database as Pick<pg.Pool,'query'>,namespace}),store=new Store({timeWindow:60_000,max:10});
  const result=await new Promise<{current:number;ttl:number}>((resolve,reject)=>store.incr(key,(error,result)=>error?reject(error):resolve(result!)));
  assert.ok(result.current>=1&&result.ttl>0);
 };
 await assertBounded('request_rate_limits',increment);
});
