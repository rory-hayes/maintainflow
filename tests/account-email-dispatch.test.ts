import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {adminPool,appPool,databaseSchema,transaction,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashPassword} from '../server/core/auth.js';
import {requestVerifiedRegistration} from '../server/core/account-registration.js';
import {requestEmailVerification,enqueueEmailVerification} from '../server/core/email-verification.js';
import {enqueuePasswordChanged,requestPasswordReset,processOneAccountRecoveryRequest} from '../server/core/account-recovery.js';
import {processOneAccountEmail} from '../server/core/account-recovery-mail.js';
import {runAccountEmailWorker} from '../server/core/account-email-worker.js';
import {AccountEmailError,setAccountEmailSenderForTests,type AccountEmailMessage} from '../server/integrations/account-email.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../server/integrations/secrets.js';

const addresses=new Set<string>(),sent:AccountEmailMessage[]=[];
const queues=[['account_registration_requests','folio:account-registration:address:v1'],['email_verification_requests','folio:email-verification:address:v1'],['account_recovery_requests','folio:account-recovery:address:v1']] as const;
const limits=[['account_registration_limits','folio:account-registration:address:v1'],['email_verification_limits','folio:email-verification:address:v1'],['account_recovery_limits','folio:account-recovery:address:v1']] as const;
const originalFetch=globalThis.fetch;
let verified=false,networkCalls=0;
const sender={async send(message:AccountEmailMessage){assert.ok(addresses.has(message.to));sent.push(message);return {providerId:randomUUID()};}};
function address(){const email=`owned-dispatch-${randomUUID()}@example.test`;addresses.add(email);return email;}
async function fixture(){const email=address();return (await adminPool.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id,email,password_hash',[email,'Owned dispatch fixture',await hashPassword('Owned dispatch password')])).rows[0];}
async function counts(){return Promise.all(queues.map(async([table])=>(await adminPool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number));}
async function signup(){await requestVerifiedRegistration({email:address(),name:'Owned pending fixture',workspaceName:'Owned queue fixture',password:'Owned pending password'});}
before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const urlMode=Boolean(pool.options.connectionString);
  if(urlMode){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');const url=new URL(pool.options.connectionString!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("SELECT current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,urlMode?5432:55432);if(!urlMode)assert.equal(row.address,null);
 }
 assert.deepEqual(await counts(),[0,0,0]);
 assert.equal((await adminPool.query("SELECT count(*)::int n FROM account_email_outbox WHERE state IN ('pending','sending')")).rows[0].n,0);
 verified=true;globalThis.fetch=async()=>{networkCalls++;throw new Error('External transport forbidden in owned dispatch tests');};setAccountEmailSenderForTests(sender);
});
afterEach(async()=>{
 setAccountEmailSenderForTests(sender);
 if(verified){
  for(const [table,purpose] of [...queues,...limits])await adminPool.query(`DELETE FROM ${table} WHERE address_key=ANY($1::text[])`,[[...addresses].map(email=>privateIdentifier(purpose,email))]);
  await adminPool.query('DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email=ANY($1::text[])))',[[...addresses]]);
  await adminPool.query('DELETE FROM users WHERE email=ANY($1::text[])',[[...addresses]]);
 }
 sent.length=0;assert.equal(networkCalls,0);
});
after(async()=>{setAccountEmailSenderForTests(undefined);globalThis.fetch=originalFetch;await closeDatabase();});

test('a retained failing registration cannot block ready reset mail or peers, backs off when idle, and retries after repair',{timeout:15_000},async()=>{
 // This first dispatch test also exercises the cold-start registration cursor.
 const recovery=await fixture(),pendingEmail=address(),workspaceName=`Owned dispatch repair ${randomUUID()}`;
 await requestVerifiedRegistration({email:pendingEmail,name:'Owned pending repair',workspaceName,password:'Owned pending password'});
 const key=privateIdentifier('folio:account-registration:address:v1',pendingEmail);
 const request=(await adminPool.query('SELECT * FROM account_registration_requests WHERE address_key=$1',[key])).rows[0];
 await requestPasswordReset(recovery.email);assert.equal(await processOneAccountRecoveryRequest(),true);
 const ready=(await adminPool.query("SELECT id FROM account_email_outbox WHERE user_id=$1 AND kind='password_reset' AND state='pending'",[recovery.id])).rows[0];assert.ok(ready);
 const name=`owned_dispatch_${randomUUID().replaceAll('-','')}`,sequence=`${name}_attempts`;
 const attempts=async()=>Number((await adminPool.query(`SELECT last_value FROM ${sequence}`)).rows[0].last_value);
 const retained=async()=>{
  assert.deepEqual((await adminPool.query('SELECT * FROM account_registration_requests WHERE address_key=$1',[key])).rows,[request]);
  assert.equal((await adminPool.query('SELECT 1 FROM users WHERE email=$1',[pendingEmail])).rowCount,0);
  assert.equal((await adminPool.query('SELECT 1 FROM workspaces WHERE name=$1',[workspaceName])).rowCount,0);
 };
 try{
  // Sequence increments survive rollback, so the bound is measured against
  // actual resolver attempts rather than an implementation mock.
  await adminPool.query(`CREATE SEQUENCE ${sequence}`);
  await adminPool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND email='${pendingEmail}') THEN PERFORM nextval('${sequence}'); RAISE EXCEPTION 'Owned dispatch database failure'; END IF; RETURN NEW; END$$`);
  await adminPool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON account_security_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  assert.equal(await processOneAccountEmail(),true);assert.equal(await attempts(),1);await retained();
  assert.equal(sent.length,1);assert.equal(sent[0].to,recovery.email);assert.equal(sent[0].subject,'Reset your MaintainFlow password');
  assert.deepEqual((await adminPool.query('SELECT state,attempts,payload_ciphertext FROM account_email_outbox WHERE id=$1',[ready.id])).rows[0],{state:'accepted',attempts:1,payload_ciphertext:null});
  await assert.rejects(processOneAccountEmail(),error=>error instanceof Error&&error.message==='Account email request processing failed.'&&error.cause===undefined);
  assert.equal(await attempts(),2);await retained();assert.equal(sent.length,1);
  // A peer may legitimately consume an unknown-address request without mail.
  // That is still useful progress and must not be replaced by the other error.
  await requestEmailVerification(address());assert.equal(await processOneAccountEmail(),true);
  assert.equal(await attempts(),3);assert.deepEqual(await counts(),[1,0,0]);assert.equal(sent.length,1);await retained();
  const controller=new AbortController(),starts:number[]=[],failures:number[]=[];
  const timeout=setTimeout(()=>controller.abort(),2000);
  try{
   await runAccountEmailWorker(controller.signal,{idleMs:60,async processOne(budget){starts.push(performance.now());return processOneAccountEmail(budget);},onError(){failures.push(performance.now());if(failures.length===2)controller.abort();}});
  }finally{clearTimeout(timeout);controller.abort();}
  assert.equal(starts.length,2);assert.equal(failures.length,2);assert.ok(starts[1]-failures[0]>=45,'failed resolver units must wait for the idle backoff');
  assert.equal(await attempts(),5);await retained();assert.equal(sent.length,1);
 }finally{
  await adminPool.query(`DROP TRIGGER IF EXISTS ${name} ON account_security_events`);
  await adminPool.query(`DROP FUNCTION IF EXISTS ${name}()`);
  await adminPool.query(`DROP SEQUENCE IF EXISTS ${sequence}`);
 }
 assert.equal(await processOneAccountEmail(),true);assert.deepEqual(await counts(),[0,0,0]);
 assert.equal(sent.length,2);assert.equal(sent[1].to,pendingEmail);assert.equal(sent[1].subject,'Verify your MaintainFlow email');
 assert.deepEqual((await adminPool.query('SELECT email_verification_required,email_verified_at FROM users WHERE email=$1',[pendingEmail])).rows[0],{email_verification_required:true,email_verified_at:null});
 assert.equal(await processOneAccountEmail(),false);
});

test('one durable mail unit admits at most one request and three busy queues each progress within three units',async()=>{
 const verify=await fixture(),recover=await fixture();
 await signup();await signup();await signup();await requestEmailVerification(verify.email);await requestPasswordReset(recover.email);
 assert.deepEqual(await counts(),[3,1,1]);
 const initial=await counts();
 for(let unit=0;unit<3;unit++){
  const before=await counts();assert.equal(await processOneAccountEmail(),true);const after=await counts();
  assert.equal(before.reduce((a,b)=>a+b,0)-after.reduce((a,b)=>a+b,0),1);assert.equal(sent.length,unit+1);
 }
 const after=await counts();assert.deepEqual(initial.map((n,i)=>n-after[i]),[1,1,1]);
 for(let unit=0;unit<2;unit++)assert.equal(await processOneAccountEmail(),true);
 assert.deepEqual(await counts(),[0,0,0]);assert.equal(sent.length,5);assert.equal(await processOneAccountEmail(),false);
 assert.equal(sent.filter(message=>message.subject==='Reset your MaintainFlow password').length,1);
 assert.equal(sent.filter(message=>message.subject==='Verify your MaintainFlow email').length,4);
 const rows=(await adminPool.query('SELECT email_verification_required,email_verified_at FROM users WHERE email=ANY($1::text[]) AND name=$2',[[...addresses],'Owned pending fixture'])).rows;
 assert.equal(rows.length,3);for(const row of rows){assert.equal(row.email_verification_required,true);assert.equal(row.email_verified_at,null);}
});

test('disabled sender still cleans expired encrypted requests in every queue without provisioning or sending',async()=>{
 const user=await fixture();await signup();await requestEmailVerification(user.email);await requestPasswordReset(user.email);
 assert.deepEqual(await counts(),[1,1,1]);
 for(const [table,purpose] of queues)await adminPool.query(`UPDATE ${table} SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE address_key=ANY($1::text[])`,[[...addresses].map(email=>privateIdentifier(purpose,email))]);
 setAccountEmailSenderForTests(null);assert.equal(await processOneAccountEmail(),false);assert.deepEqual(await counts(),[0,0,0]);assert.equal(sent.length,0);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM users WHERE email=ANY($1::text[])',[[...addresses]])).rows[0].n,1);
});

test('outbox kind and subject must match exactly before transport, with owned token revoked on terminal failure',async()=>{
 const user=await fixture();
 await transaction(adminPool,async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);await enqueueEmailVerification(c,user,new Date(Date.now()+60_000));});
 await adminPool.query("UPDATE account_email_outbox SET payload_ciphertext=$2 WHERE user_id=$1 AND kind='email_verification'",[user.id,encryptSecret(JSON.stringify({to:user.email,subject:'Your MaintainFlow password was changed',text:'Owned mismatched subject fixture'}))]);
 assert.equal(await processOneAccountEmail(),true);assert.equal(sent.length,0);
 const row=(await adminPool.query('SELECT state,failure_code,payload_ciphertext,verification_token_id FROM account_email_outbox WHERE user_id=$1',[user.id])).rows[0];assert.deepEqual(row,{state:'failed',failure_code:'invalid_message',payload_ciphertext:null,verification_token_id:null});
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM email_verification_tokens WHERE user_id=$1',[user.id])).rows[0].n,0);
});

for(const kind of ['password_reset','password_changed','email_verification'] as const){
 test(`legacy encrypted ${kind} mail is accepted without changing its retry payload`,async()=>{
  const user=await fixture(),calls:AccountEmailMessage[]=[];
  if(kind==='password_reset'){await requestPasswordReset(user.email);assert.equal(await processOneAccountRecoveryRequest(),true);}
  else await transaction(adminPool,async c=>{
   await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
   if(kind==='password_changed')await enqueuePasswordChanged(c,user);
   else await enqueueEmailVerification(c,user,new Date(Date.now()+60_000));
  });
  const row=(await adminPool.query('SELECT * FROM account_email_outbox WHERE user_id=$1 AND kind=$2',[user.id,kind])).rows[0];
  const payload=JSON.parse(decryptSecret(row.payload_ciphertext));
  assert.match(payload.subject,/MaintainFlow/);assert.match(payload.text,/MaintainFlow/);
  payload.subject=payload.subject.replaceAll('MaintainFlow','Folio');payload.text=payload.text.replaceAll('MaintainFlow','Folio');
  const ciphertext=encryptSecret(JSON.stringify(payload));
  await adminPool.query('UPDATE account_email_outbox SET payload_ciphertext=$2 WHERE id=$1',[row.id,ciphertext]);
  setAccountEmailSenderForTests({async send(message){calls.push(message);if(calls.length===1)throw new AccountEmailError('temporary_failure',true);return {providerId:randomUUID()};}});
  assert.equal(await processOneAccountEmail(),true);
  assert.deepEqual((await adminPool.query('SELECT state,payload_ciphertext FROM account_email_outbox WHERE id=$1',[row.id])).rows[0],{state:'pending',payload_ciphertext:ciphertext});
  await adminPool.query('UPDATE account_email_outbox SET available_at=clock_timestamp() WHERE id=$1',[row.id]);
  assert.equal(await processOneAccountEmail(),true);
  const expected={...payload,idempotencyKey:`folio-account-email/${row.id}`};assert.deepEqual(calls,[expected,expected]);
  assert.deepEqual((await adminPool.query('SELECT state,attempts,payload_ciphertext FROM account_email_outbox WHERE id=$1',[row.id])).rows[0],{state:'accepted',attempts:2,payload_ciphertext:null});
 });
}
