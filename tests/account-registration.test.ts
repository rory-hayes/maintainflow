import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,transaction,closeDatabase} from '../server/core/db.js';
import {config,defaultPlan} from '../server/core/config.js';
import {hashPassword,verifyPassword} from '../server/core/auth.js';
import {requestVerifiedRegistration,requiredSignupAccepted,RegistrationUnavailableError,processOneAccountRegistration,cleanupAccountRegistrations} from '../server/core/account-registration.js';
import {setAccountEmailSenderForTests} from '../server/integrations/account-email.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../server/integrations/secrets.js';

const emails=new Set<string>();
const originalFetch=globalThis.fetch,originalRequired=process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION;
let app:FastifyInstance,guarded=false,fetches=0,sends=0,ip=10;
const sender={async send(){sends++;return {providerId:randomUUID()};}};
const key=(email:string)=>privateIdentifier('folio:account-registration:address:v1',email);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function fields(label:string){
 const email=`owned-registration-${label}-${randomUUID()}@example.test`;emails.add(email);
 return {email,password:'Private registration Café  ',name:'Owned registration name',workspaceName:`Owned registration ${label}`};
}
type Fields=ReturnType<typeof fields>;
async function requestRows(email:string){return (await adminPool.query('SELECT * FROM account_registration_requests WHERE address_key=$1 ORDER BY created_at,id',[key(email)])).rows;}
async function userRow(email:string){return (await adminPool.query('SELECT * FROM users WHERE email=$1',[email])).rows[0];}
async function insertExisting(f:Fields,c?:PoolClient){
 const hash=await hashPassword('Existing private password');
 const insert=async(client:PoolClient)=>(await client.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING *',[f.email,'Original name',hash])).rows[0];
 return c?insert(c):transaction(adminPool,insert);
}
async function cooldown(email:string){await adminPool.query("UPDATE account_registration_limits SET cooldown_until=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(email)]);}
function register(f:Fields){return app.inject({method:'POST',url:'/api/auth/register',remoteAddress:`192.0.2.${++ip}`,headers:{origin:config.origin},payload:f});}
async function ownedCleanup(){
 const addresses=[...emails];
 await adminPool.query('DELETE FROM account_registration_requests WHERE address_key=ANY($1::text[])',[addresses.map(key)]);
 await adminPool.query('DELETE FROM account_registration_limits WHERE address_key=ANY($1::text[])',[addresses.map(key)]);
 // Every address is a new randomized fixture identity. Remove only workspaces
 // created for these identities, never a shared queue or unrelated account.
 await adminPool.query('DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email=ANY($1::text[])))',[addresses]);
 await adminPool.query('DELETE FROM users WHERE email=ANY($1::text[])',[addresses]);
}
function interceptConnections(intercept:(text:string,args:any[],run:()=>Promise<any>)=>Promise<any>){
 const connect=adminPool.connect.bind(adminPool);
 (adminPool as any).connect=(callback?:any)=>{
  const pending=connect().then(client=>{
   const query=client.query.bind(client);
   return new Proxy(client,{get(target,property){
   if(property==='query')return (text:any,...args:any[])=>{
    const done=typeof args.at(-1)==='function'?args.pop():undefined;
    const result=typeof text==='string'?intercept(text,args,()=> (query as any)(text,...args)):(query as any)(text,...args);
    if(done){void Promise.resolve(result).then(value=>done(null,value),error=>done(error));return;}return result;
   };
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
   }});
  });
  if(callback){void pending.then(client=>callback(null,client,client.release),error=>callback(error));return;}return pending;
 };
 return ()=>{(adminPool as any).connect=connect;};
}

before(async()=>{
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
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_registration_requests')).rows[0].n,0,'The isolated suite requires an empty registration queue before any worker or cap fixture');
 guarded=true;process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='true';
 globalThis.fetch=async()=>{fetches++;throw new Error('Network is forbidden in registration fixtures');};
 setAccountEmailSenderForTests(sender);app=await buildApp();
});
afterEach(async()=>{setAccountEmailSenderForTests(sender);assert.equal(fetches,0);assert.equal(sends,0);if(guarded)await ownedCleanup();});
after(async()=>{
 try{await app?.close();setAccountEmailSenderForTests(undefined);globalThis.fetch=originalFetch;
  if(originalRequired===undefined)delete process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION;else process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION=originalRequired;
  if(guarded)await ownedCleanup();
 }finally{await closeDatabase();}
});

test('required public signup returns the same 202 without account reads, cookies, or account identity',async()=>{
 const known=fields('known'),fresh=fields('fresh'),existing=await insertExisting(known);
 const restore=interceptConnections(async(text,args,run)=>{
  assert.doesNotMatch(text,/\busers\b/i,'Public admission must not resolve account existence');
  assert.equal(JSON.stringify(args).includes(fresh.password),false,'Raw password never enters SQL parameters');return run();
 });
 try{for(const f of [known,fresh]){const response=await register(f);assert.equal(response.statusCode,202);assert.deepEqual(response.json(),requiredSignupAccepted);assert.equal(response.headers['set-cookie'],undefined);}}
 finally{restore();}
 assert.equal(await userRow(fresh.email),undefined);assert.equal((await requestRows(known.email)).length,1);assert.equal((await requestRows(fresh.email)).length,1);
 assert.equal(await processOneAccountRegistration(),true);assert.equal(await processOneAccountRegistration(),true);assert.equal(await processOneAccountRegistration(),false);
 assert.deepEqual(await userRow(known.email),existing);
 assert.equal((await adminPool.query('SELECT 1 FROM memberships WHERE user_id=$1',[existing.id])).rowCount,0);
 assert.equal((await adminPool.query('SELECT 1 FROM account_email_outbox WHERE user_id=$1',[existing.id])).rowCount,0);
});

test('encrypted admission provisions exactly one required account, default workspace and fixed-expiry verification mail atomically',async()=>{
 const f=fields('private');assert.deepEqual(await requestVerifiedRegistration(f),requiredSignupAccepted);
 const [request]=await requestRows(f.email),serialized=JSON.stringify(request),payload=JSON.parse(decryptSecret(request.payload_ciphertext));
 for(const secret of [f.email,f.password,f.name,f.workspaceName,payload.passwordHash])assert.equal(serialized.includes(secret),false);
 assert.deepEqual(Object.keys(payload).sort(),['email','name','passwordHash','workspaceName']);
 assert.equal(await verifyPassword(f.password,payload.passwordHash),true);assert.equal(Object.hasOwn(request,'user_id'),false);
 assert.ok(Math.abs(request.expires_at.getTime()-request.created_at.getTime()-86_400_000)<20);
 // A delayed request retains its deadline instead of gaining another 24h.
 await adminPool.query("UPDATE account_registration_requests SET created_at=clock_timestamp()-interval '23 hours',expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[request.id]);
 const expiry=(await requestRows(f.email))[0].expires_at;
 assert.equal(await processOneAccountRegistration(),true);
 const user=await userRow(f.email);assert.equal(user.name,f.name);assert.equal(user.password_hash,payload.passwordHash);assert.equal(user.email_verification_required,true);assert.equal(user.email_verified_at,null);
 const memberships=(await adminPool.query('SELECT m.role,w.* FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=$1',[user.id])).rows;
 assert.equal(memberships.length,1);assert.equal(memberships[0].role,'owner');assert.equal(memberships[0].name,f.workspaceName);assert.deepEqual(memberships[0].plan,defaultPlan);
 const messages=(await adminPool.query('SELECT * FROM account_email_outbox WHERE user_id=$1',[user.id])).rows;assert.equal(messages.length,1);assert.equal(messages[0].kind,'email_verification');assert.deepEqual(messages[0].expires_at,expiry);
 const message=JSON.parse(decryptSecret(messages[0].payload_ciphertext));assert.equal(message.to,f.email);assert.equal(message.text.includes(f.password),false);
 const tokens=(await adminPool.query('SELECT * FROM email_verification_tokens WHERE user_id=$1',[user.id])).rows;assert.equal(tokens.length,1);assert.deepEqual(tokens[0].expires_at,expiry);
 assert.equal((await adminPool.query('SELECT 1 FROM sessions WHERE user_id=$1',[user.id])).rowCount,0);assert.equal((await requestRows(f.email)).length,0);
});

test('concurrent admission and same-address worker races cannot duplicate or overwrite an account',async()=>{
 const f=fields('concurrent');const results=await Promise.all([requestVerifiedRegistration(f),requestVerifiedRegistration({...f,name:'Competing name'})]);
 assert.deepEqual(results,[requiredSignupAccepted,requiredSignupAccepted]);const [request]=await requestRows(f.email);assert.ok(request);assert.equal((await requestRows(f.email)).length,1);
 const original=JSON.parse(decryptSecret(request.payload_ciphertext)),other={...original,name:'Later queued name',passwordHash:await hashPassword('Different queued password')};
 await adminPool.query('INSERT INTO account_registration_requests(address_key,payload_ciphertext,expires_at) VALUES($1,$2,$3)',[key(f.email),encryptSecret(JSON.stringify(other)),request.expires_at]);
 let arrivals=0,release!:()=>void;const both=new Promise<void>(resolve=>{release=resolve;});
 const restore=interceptConnections(async(text,_args,run)=>{if(text.startsWith('INSERT INTO users(')){arrivals++;if(arrivals===2)release();await both;}return run();});
 try{assert.deepEqual(await Promise.all([processOneAccountRegistration(),processOneAccountRegistration()]),[true,true]);}finally{restore();}
 assert.equal(arrivals,2);const users=(await adminPool.query('SELECT * FROM users WHERE email=$1',[f.email])).rows;assert.equal(users.length,1);
 const winner=users[0];assert.ok([original.passwordHash,other.passwordHash].includes(winner.password_hash));assert.equal(winner.name,winner.password_hash===original.passwordHash?original.name:other.name);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM memberships WHERE user_id=$1',[winner.id])).rows[0].n,1);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_email_outbox WHERE user_id=$1',[winner.id])).rows[0].n,1);assert.equal((await requestRows(f.email)).length,0);
});

test('a late transactional failure rolls back provisioning and preserves the encrypted request for a safe retry',async()=>{
 const f=fields('rollback');await requestVerifiedRegistration(f);const [request]=await requestRows(f.email);
 const name=`owned_registration_${randomUUID().replaceAll('-','')}`;
 await adminPool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND email='${f.email}') THEN RAISE EXCEPTION 'Owned registration audit rollback'; END IF; RETURN NEW; END$$`);
 await adminPool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON account_security_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await assert.rejects(processOneAccountRegistration(),/Owned registration audit rollback/);assert.equal(await userRow(f.email),undefined);assert.deepEqual(await requestRows(f.email),[request]);assert.equal((await adminPool.query('SELECT 1 FROM workspaces WHERE name=$1',[f.workspaceName])).rowCount,0);}
 finally{await adminPool.query(`DROP TRIGGER ${name} ON account_security_events`);await adminPool.query(`DROP FUNCTION ${name}()`);}
 assert.equal(await processOneAccountRegistration(),true);const user=await userRow(f.email);assert.ok(user);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_email_outbox WHERE user_id=$1',[user.id])).rows[0].n,1);
});

test('expired, malformed and address-mismatched envelopes are discarded without account creation',async()=>{
 const expired=fields('expired'),corrupt=fields('corrupt'),mismatch=fields('mismatch');
 for(const f of [expired,corrupt,mismatch])await requestVerifiedRegistration(f);
 await adminPool.query("UPDATE account_registration_requests SET created_at=clock_timestamp()-interval '25 hours',expires_at=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(expired.email)]);
 await adminPool.query("UPDATE account_registration_requests SET payload_ciphertext='invalid ciphertext' WHERE address_key=$1",[key(corrupt.email)]);
 await adminPool.query('UPDATE account_registration_requests SET payload_ciphertext=$2 WHERE address_key=$1',[key(mismatch.email),encryptSecret(JSON.stringify({email:corrupt.email,name:'Mismatched',workspaceName:'Mismatched',passwordHash:await hashPassword(mismatch.password)}))]);
 for(let i=0;i<3;i++)assert.equal(await processOneAccountRegistration(),true);
 for(const f of [expired,corrupt,mismatch]){assert.equal(await userRow(f.email),undefined);assert.equal((await requestRows(f.email)).length,0);}
});

test('expiry is rechecked after a blocked unique-email insert and cannot create a late account',async()=>{
 const f=fields('late');await requestVerifiedRegistration(f);
 await adminPool.query("UPDATE account_registration_requests SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()+interval '400 milliseconds' WHERE address_key=$1",[key(f.email)]);
 const blocker=await adminPool.connect();await blocker.query('BEGIN');await insertExisting(f,blocker);
 const pending=processOneAccountRegistration();
 try{
  let waiting=false;for(let i=0;i<100;i++){
   const row=(await adminPool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO users(email,name,password_hash,email_verification_required)%') AS waiting")).rows[0];
   if(row.waiting){waiting=true;break;}await pause(10);
  }assert.equal(waiting,true,'The owned worker must reach the unique email wait');
  for(let i=0;i<100;i++){if((await adminPool.query('SELECT expires_at<=clock_timestamp() AS expired FROM account_registration_requests WHERE address_key=$1',[key(f.email)])).rows[0].expired)break;await pause(10);}
  await blocker.query('ROLLBACK');
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 assert.equal(await pending,true);assert.equal(await userRow(f.email),undefined);assert.equal((await requestRows(f.email)).length,0);
});

test('expiry during workspace provisioning rolls back the entire new account before discarding its request',async()=>{
 const f=fields('workspace-expiry');await requestVerifiedRegistration(f);
 await adminPool.query("UPDATE account_registration_requests SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()+interval '400 milliseconds' WHERE address_key=$1",[key(f.email)]);
 const blocker=await adminPool.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE workspaces IN SHARE MODE');
 const pending=processOneAccountRegistration();
 try{
  let waiting=false;for(let i=0;i<100;i++){
   const row=(await adminPool.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query='INSERT INTO workspaces(name,slug,plan) VALUES($1,$2,$3) RETURNING id') AS waiting")).rows[0];
   if(row.waiting){waiting=true;break;}await pause(10);
  }assert.equal(waiting,true,'Provisioning must block after inserting its new user');
  for(let i=0;i<100;i++){if((await adminPool.query('SELECT expires_at<=clock_timestamp() AS expired FROM account_registration_requests WHERE address_key=$1',[key(f.email)])).rows[0].expired)break;await pause(10);}
  await blocker.query('ROLLBACK');
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 assert.equal(await pending,true);assert.equal(await userRow(f.email),undefined);assert.equal((await requestRows(f.email)).length,0);
 assert.equal((await adminPool.query('SELECT 1 FROM workspaces WHERE name=$1',[f.workspaceName])).rowCount,0);
});

test('address cooldown and five-per-hour limits suppress uniformly, including the expired-row cleanup race',async()=>{
 const f=fields('rates');await requestVerifiedRegistration(f);
 for(let i=0;i<3;i++)assert.deepEqual(await requestVerifiedRegistration(f),requiredSignupAccepted);
 assert.equal((await requestRows(f.email)).length,1);
 for(let i=0;i<6;i++){await cooldown(f.email);assert.deepEqual(await requestVerifiedRegistration(f),requiredSignupAccepted);}
 assert.equal((await requestRows(f.email)).length,5);
 await adminPool.query("UPDATE account_registration_limits SET expires_at=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(f.email)]);
 const cleaner=await adminPool.connect();let insertions=0,removed=0;
 const restore=interceptConnections(async(text,_args,run)=>{const result=await run();if(text.startsWith('INSERT INTO account_registration_limits')&&++insertions===1){assert.equal(result.rowCount,0);removed=(await cleaner.query('DELETE FROM account_registration_limits WHERE address_key=$1 AND expires_at<=clock_timestamp()',[key(f.email)])).rowCount??0;}return result;});
 try{assert.deepEqual(await requestVerifiedRegistration(f),requiredSignupAccepted);}finally{restore();cleaner.release();}
 assert.equal(removed,1);assert.equal(insertions,2);assert.equal((await requestRows(f.email)).length,6);
 assert.equal((await adminPool.query('SELECT grants FROM account_registration_limits WHERE address_key=$1',[key(f.email)])).rows[0].grants,1);
});

test('global queue admission is atomic at 5000 and full or disabled service does not consume address grants',async()=>{
 const bulk=fields('cap-bulk'),a=fields('cap-a'),b=fields('cap-b'),known=fields('cap-known');await insertExisting(known);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_registration_requests')).rows[0].n,0);
 await adminPool.query(`INSERT INTO account_registration_requests(address_key,payload_ciphertext,expires_at) SELECT $1,$2,clock_timestamp()+interval '24 hours' FROM generate_series(1,4999)`,[key(bulk.email),encryptSecret('{}')]);
 const results=await Promise.allSettled([requestVerifiedRegistration(a),requestVerifiedRegistration(b)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const rejected=results.find(r=>r.status==='rejected');assert.ok(rejected?.status==='rejected'&&rejected.reason instanceof RegistrationUnavailableError);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_registration_requests')).rows[0].n,5000);
 const loser=results[0].status==='rejected'?a:b;assert.equal((await adminPool.query('SELECT 1 FROM account_registration_limits WHERE address_key=$1',[key(loser.email)])).rowCount,0);
 for(const f of [known,loser]){const response=await register(f);assert.equal(response.statusCode,503);assert.equal(response.headers['set-cookie'],undefined);assert.equal((await adminPool.query('SELECT 1 FROM account_registration_limits WHERE address_key=$1',[key(f.email)])).rowCount,0);}
 await adminPool.query('DELETE FROM account_registration_requests WHERE address_key=ANY($1::text[])',[[bulk,a,b].map(f=>key(f.email))]);
 setAccountEmailSenderForTests(null);for(const f of [known,loser]){await assert.rejects(requestVerifiedRegistration(f),RegistrationUnavailableError);assert.equal((await register(f)).statusCode,503);}
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_registration_requests')).rows[0].n,0);assert.equal(await userRow(loser.email),undefined);
});

test('bounded cleanup scrubs expired envelopes during outages and request tables are backend-only',async()=>{
 const f=fields('cleanup'),valid=fields('cleanup-valid');await requestVerifiedRegistration(valid);
 await adminPool.query(`INSERT INTO account_registration_requests(address_key,payload_ciphertext,created_at,expires_at)
  SELECT $1,$2,clock_timestamp()-interval '25 hours',clock_timestamp()-interval '1 hour' FROM generate_series(1,101)`,[key(f.email),encryptSecret('{}')]);
 setAccountEmailSenderForTests(null);assert.equal(await processOneAccountRegistration(),false);
 await cleanupAccountRegistrations();assert.equal((await requestRows(f.email)).length,1);assert.equal((await requestRows(valid.email)).length,1);
 await cleanupAccountRegistrations();assert.equal((await requestRows(f.email)).length,0);assert.equal(await userRow(f.email),undefined);
 for(const table of ['account_registration_requests','account_registration_limits']){
  await assert.rejects(appPool.query(`SELECT * FROM ${table}`),/permission denied/);
  const row=(await adminPool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0];assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);
 }
});
