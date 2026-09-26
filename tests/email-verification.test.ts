import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,transaction,closeDatabase} from '../server/core/db.js';
import {config,defaultPlan} from '../server/core/config.js';
import {createSession,hashPassword,hashToken,newToken,verifyPassword} from '../server/core/auth.js';
import {changeAccountPassword,completePasswordReset,requestPasswordReset,processOneAccountRecoveryRequest} from '../server/core/account-recovery.js';
import {cleanupEmailVerification,completeEmailVerification,emailVerificationRequired,emailVerificationStatus,enqueueEmailVerification,invalidVerificationMessage,isEmailVerificationMailValid,processOneEmailVerificationRequest,requestEmailVerification,verificationAccepted} from '../server/core/email-verification.js';
import {processOneAccountEmail} from '../server/core/account-recovery-mail.js';
import {AccountEmailError,setAccountEmailSenderForTests,type AccountEmailMessage} from '../server/integrations/account-email.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../server/integrations/secrets.js';

type Account={id:string;email:string;password:string;hash:string;workspaceId:string};
const accounts:Account[]=[],addresses=new Set<string>(),delivered:AccountEmailMessage[]=[];
const originalFetch=globalThis.fetch,originalPolicy=process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION;
const collect={async send(message:AccountEmailMessage){delivered.push(message);return {providerId:randomUUID()};}};
let app:FastifyInstance,guarded=false,fetches=0,ip=20;
const addr=()=>`192.0.2.${++ip}`;
const key=(email:string)=>privateIdentifier('folio:email-verification:address:v1',email);
const ids=()=>accounts.map(a=>a.id);
async function fixture(label:string,required=false,password='Exact  Password Café  '):Promise<Account>{
 const a={id:randomUUID(),email:`owned-verification-${label}-${randomUUID()}@example.test`,password,hash:await hashPassword(password),workspaceId:randomUUID()};
 accounts.push(a);addresses.add(a.email);
 await transaction(adminPool,async c=>{
  await c.query('INSERT INTO users(id,email,name,password_hash,email_verification_required) VALUES($1,$2,$3,$4,$5)',[a.id,a.email,'Owned verification fixture',a.hash,required]);
  await c.query('INSERT INTO workspaces(id,name,slug,plan) VALUES($1,$2,$3,$4)',[a.workspaceId,'Owned verification workspace',a.workspaceId,JSON.stringify(defaultPlan)]);
  await c.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[a.workspaceId,a.id]);
 });return a;
}
async function makeSession(a:Account){const token=newToken();await adminPool.query("INSERT INTO sessions(user_id,workspace_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[a.id,a.workspaceId,hashToken(token)]);return token;}
async function makeKey(a:Account){const token=`fl_${newToken()}`,id=randomUUID();await adminPool.query("INSERT INTO api_keys(id,workspace_id,user_id,name,prefix,token_hash,scopes) VALUES($1,$2,$3,'Owned verification key','fl_owned',$4,$5)",[id,a.workspaceId,a.id,hashToken(token),JSON.stringify(['documents:read'])]);return {token,id};}
function request(email:string,headers:Record<string,string>={},remoteAddress=addr()){
 addresses.add(email.trim().toLowerCase());return app.inject({method:'POST',url:'/api/auth/email-verification/request',remoteAddress,headers:{origin:config.origin,...headers},payload:{email}});
}
function complete(token:string,password:string,headers:Record<string,string>={}){return app.inject({method:'POST',url:'/api/auth/email-verification/complete',remoteAddress:addr(),headers:{origin:config.origin,...headers},payload:{token,password}});}
async function issue(a:Account){
 await transaction(adminPool,async c=>{
  const {rows:[user]}=await c.query('SELECT id,email,password_hash FROM users WHERE id=$1 FOR UPDATE',[a.id]);
  const {rows:[clock]}=await c.query("SELECT clock_timestamp()+interval '24 hours' AS expiry");
  await enqueueEmailVerification(c,user,clock.expiry);
 });
 const row=(await adminPool.query("SELECT * FROM account_email_outbox WHERE user_id=$1 AND kind='email_verification' ORDER BY created_at DESC,id DESC LIMIT 1",[a.id])).rows[0];
 const payload=JSON.parse(decryptSecret(row.payload_ciphertext));
 const link=new URL(payload.text.match(/https?:\/\/[^\s]+/)![0]);
 const token=new URLSearchParams(link.hash.slice(1)).get('token')!;
 assert.equal(link.pathname,'/verify-email/confirm');assert.equal(link.search,'');assert.equal(payload.to,a.email);assert.equal(payload.subject,'Verify your MaintainFlow email');
 return {row,token,link,payload};
}
async function user(a:Account){return (await adminPool.query('SELECT * FROM users WHERE id=$1',[a.id])).rows[0];}
async function outbox(id:string){return (await adminPool.query('SELECT * FROM account_email_outbox WHERE id=$1',[id])).rows[0];}
async function cooldown(a:Account){await adminPool.query("UPDATE email_verification_limits SET cooldown_until=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(a.email)]);}
async function expire(a:Account){await adminPool.query("UPDATE email_verification_tokens SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[a.id]);}

before(async()=>{
 assert.equal(databaseSchema,'public');const urlMode=Boolean(adminPool.options.connectionString||appPool.options.connectionString);
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  if(urlMode){
   assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(process.env.DATABASE_ADMIN_URL&&process.env.DATABASE_URL);
   const url=new URL(pool.options.connectionString!);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');
  }else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("SELECT current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];
  assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,urlMode?5432:55432);if(!urlMode)assert.equal(row.address,null);
 }
 guarded=true;process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='false';globalThis.fetch=async()=>{fetches++;throw new Error('No network in owned verification fixtures');};setAccountEmailSenderForTests(collect);app=await buildApp();
});
afterEach(async()=>{
 process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='false';setAccountEmailSenderForTests(collect);delivered.length=0;assert.equal(fetches,0);
 if(guarded){
  await adminPool.query('DELETE FROM email_verification_requests WHERE address_key=ANY($1::text[])',[[...addresses].map(key)]);
  await adminPool.query('DELETE FROM account_recovery_requests WHERE address_key=ANY($1::text[])',[[...addresses].map(email=>privateIdentifier('folio:account-recovery:address:v1',email))]);
  await adminPool.query('DELETE FROM account_email_outbox WHERE user_id=ANY($1::uuid[])',[ids()]);
  await adminPool.query('DELETE FROM email_verification_tokens WHERE user_id=ANY($1::uuid[])',[ids()]);
  await adminPool.query('DELETE FROM account_recovery_tokens WHERE user_id=ANY($1::uuid[])',[ids()]);
 }
});
after(async()=>{
 try{
  await app?.close();setAccountEmailSenderForTests(undefined);globalThis.fetch=originalFetch;
  if(originalPolicy===undefined)delete process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION;else process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION=originalPolicy;
  if(guarded){
   await adminPool.query('DELETE FROM email_verification_limits WHERE address_key=ANY($1::text[])',[[...addresses].map(key)]);
   await adminPool.query('DELETE FROM account_recovery_limits WHERE address_key=ANY($1::text[])',[[...addresses].map(email=>privateIdentifier('folio:account-recovery:address:v1',email))]);
   await adminPool.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[accounts.map(a=>a.workspaceId)]);
   await adminPool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids()]);
  }
 }finally{await closeDatabase();}
});

test('verification policy is strict, defaults by environment, and availability cannot disable a persisted requirement',()=>{
 assert.equal(emailVerificationRequired({NODE_ENV:'production'}),true);
 for(const mode of ['test','development',undefined])assert.equal(emailVerificationRequired({NODE_ENV:mode}),false);
 assert.equal(emailVerificationRequired({NODE_ENV:'production',FOLIO_REQUIRE_EMAIL_VERIFICATION:'false'}),false);
 assert.equal(emailVerificationRequired({NODE_ENV:'test',FOLIO_REQUIRE_EMAIL_VERIFICATION:'true'}),true);
 for(const setting of ['','TRUE','1',' true','false '])assert.throws(()=>emailVerificationRequired({FOLIO_REQUIRE_EMAIL_VERIFICATION:setting}),/must be true or false/);
 process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='true';setAccountEmailSenderForTests(null);assert.deepEqual(emailVerificationStatus(),{available:false,requiredForSignup:true});
 process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='invalid';assert.throws(emailVerificationStatus,/must be true or false/);
});

test('required pending accounts receive generic login errors and cannot use seeded sessions or keys before last-used mutation',async()=>{
 const a=await fixture('gated',true),session=await makeSession(a),apiKey=await makeKey(a);
 for(const password of [a.password,'wrong',a.password.trim()]){
  const response=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:addr(),payload:{email:a.email,password}});
  assert.equal(response.statusCode,401);assert.equal(response.json().message,'Email or password is incorrect');assert.equal(response.headers['set-cookie'],undefined);
 }
 let cookies=0;await assert.rejects(createSession({setCookie(){cookies++;}} as unknown as FastifyReply,a.id,a.workspaceId,a.hash),{statusCode:401,message:'Email or password is incorrect'});assert.equal(cookies,0);
 setAccountEmailSenderForTests(null);process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='false';
 for(const url of ['/api/auth/me','/api/workspaces','/api/auth/email-verification'])assert.equal((await app.inject({url,headers:{cookie:`folio_session=${session}`}})).statusCode,401);
 assert.equal((await app.inject({url:'/api/documents',headers:{authorization:`Bearer ${apiKey.token}`}})).statusCode,401);
 assert.equal((await adminPool.query('SELECT last_used_at FROM api_keys WHERE id=$1',[apiKey.id])).rows[0].last_used_at,null);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[a.id])).rows[0].n,1);
});

test('legacy access remains unverified and personal verification status is available to a viewer but never an API key',async()=>{
 const a=await fixture('legacy'),session=await makeSession(a),apiKey=await makeKey(a);
 await adminPool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1",[a.id]);
 process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='true';setAccountEmailSenderForTests(null);
 const me=await app.inject({url:'/api/auth/me',headers:{cookie:`folio_session=${session}`}});assert.equal(me.statusCode,200);assert.equal(me.json().user.emailVerifiedAt,null);assert.equal(me.json().user.emailVerificationRequired,false);
 const status=await app.inject({url:'/api/auth/email-verification',headers:{cookie:`folio_session=${session}`}});assert.deepEqual(status.json(),{verified:false,verifiedAt:null,available:false});
 assert.equal((await app.inject({url:'/api/auth/email-verification',headers:{authorization:`Bearer ${apiKey.token}`}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/documents',headers:{authorization:`Bearer ${apiKey.token}`}})).statusCode,200);
});

test('token-only and wrong-password confirmation cannot activate attacker-known credentials; passwords preserve case and spaces',async()=>{
 const a=await fixture('proof',true),issued=await issue(a);
 for(const payload of [{token:issued.token},{token:issued.token,password:''},{token:issued.token,password:a.password.trim()},{token:issued.token,password:a.password.toLowerCase()},{token:issued.token,password:a.password,extra:true},{token:'bad',password:a.password}]){
  const response=await app.inject({method:'POST',url:'/api/auth/email-verification/complete',remoteAddress:addr(),payload});assert.equal(response.statusCode,400);assert.equal(response.json().message,invalidVerificationMessage);assert.equal(response.headers['set-cookie'],undefined);
 }
 assert.equal((await user(a)).email_verified_at,null);assert.equal((await outbox(issued.row.id)).state,'pending');
 assert.equal((await complete(issued.token,a.password)).statusCode,200);assert.ok((await user(a)).email_verified_at);
 const short=await fixture('short',true,'x'),shortLink=await issue(short);assert.deepEqual(await completeEmailVerification(shortLink.token,'x'),{ok:true});
});

test('successful verification atomically revokes this user sessions and both token purposes, preserving keys and unrelated accounts',async()=>{
 const a=await fixture('complete'),b=await fixture('unrelated'),session=await makeSession(a),otherSession=await makeSession(a),unrelated=await makeSession(b),apiKey=await makeKey(a);
 const first=await issue(a),second=await issue(a);await requestPasswordReset(a.email);assert.equal(await processOneAccountRecoveryRequest(),true);
 const before=(await adminPool.query('SELECT row_to_json(w) value FROM workspaces w WHERE id=$1',[a.workspaceId])).rows[0].value;
 const response=await complete(first.token,a.password,{cookie:`folio_session=${unrelated}`});assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{ok:true});assert.equal(response.headers['set-cookie'],undefined);
 const record=await user(a);assert.ok(record.email_verified_at);assert.equal(record.password_hash,a.hash);assert.equal(record.password_changed_at,null);assert.equal(record.email_verification_required,false);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[a.id])).rows[0].n,0);
 for(const token of [session,otherSession])assert.equal((await app.inject({url:'/api/auth/me',headers:{cookie:`folio_session=${token}`}})).statusCode,401);
 assert.equal((await app.inject({url:'/api/auth/me',headers:{cookie:`folio_session=${unrelated}`}})).statusCode,200);
 for(const table of ['email_verification_tokens','account_recovery_tokens'])assert.equal((await adminPool.query(`SELECT count(*)::int n FROM ${table} WHERE user_id=$1`,[a.id])).rows[0].n,0);
 const rows=(await adminPool.query('SELECT state,payload_ciphertext,lease_owner,lease_until FROM account_email_outbox WHERE user_id=$1',[a.id])).rows;assert.equal(rows.length,3);for(const row of rows)assert.deepEqual(row,{state:'cancelled',payload_ciphertext:null,lease_owner:null,lease_until:null});
 const event=(await adminPool.query("SELECT sessions_revoked,tokens_invalidated FROM account_security_events WHERE user_id=$1 AND action='email_verified'",[a.id])).rows[0];assert.deepEqual(event,{sessions_revoked:2,tokens_invalidated:3});
 assert.equal((await complete(second.token,a.password)).statusCode,400);
 assert.equal((await app.inject({url:'/api/documents',headers:{authorization:`Bearer ${apiKey.token}`}})).statusCode,200);assert.equal((await adminPool.query('SELECT revoked_at FROM api_keys WHERE id=$1',[apiKey.id])).rows[0].revoked_at,null);
 assert.deepEqual((await adminPool.query('SELECT row_to_json(w) value FROM workspaces w WHERE id=$1',[a.workspaceId])).rows[0].value,before);
 const login=await app.inject({method:'POST',url:'/api/auth/login',remoteAddress:addr(),payload:{email:a.email,password:a.password}});assert.equal(login.statusCode,200);assert.ok(login.json().user.emailVerifiedAt);
});

test('concurrent confirmation of separate issued tokens has one winner and one audit',async()=>{
 const a=await fixture('concurrent',true),one=await issue(a),two=await issue(a);
 const results=await Promise.allSettled([completeEmailVerification(one.token,a.password),completeEmailVerification(two.token,a.password)]);
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);const failure=results.find(result=>result.status==='rejected') as PromiseRejectedResult;assert.equal(failure.reason.message,invalidVerificationMessage);
 assert.equal((await adminPool.query("SELECT count(*)::int n FROM account_security_events WHERE user_id=$1 AND action='email_verified'",[a.id])).rows[0].n,1);
});

test('token binding rejects changed email, stale credentials and cross-purpose use without password or verification mutation',async()=>{
 const a=await fixture('bindings'),issued=await issue(a);
 await adminPool.query('UPDATE users SET email=$2 WHERE id=$1',[a.id,`changed-${a.email}`]);assert.equal((await complete(issued.token,a.password)).statusCode,400);
 await adminPool.query('UPDATE users SET email=$2,password_hash=$3 WHERE id=$1',[a.id,a.email,await hashPassword(a.password)]);assert.equal((await complete(issued.token,a.password)).statusCode,400);
 await adminPool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[a.id,a.hash]);
 await requestPasswordReset(a.email);await processOneAccountRecoveryRequest();const reset=(await adminPool.query("SELECT payload_ciphertext FROM account_email_outbox WHERE user_id=$1 AND kind='password_reset'",[a.id])).rows[0];
 const resetLink=new URL(JSON.parse(decryptSecret(reset.payload_ciphertext)).text.match(/https?:\/\/[^\s]+/)![0]);const resetToken=new URLSearchParams(resetLink.hash.slice(1)).get('token')!;
 assert.equal((await complete(resetToken,a.password)).statusCode,400);await assert.rejects(completePasswordReset(issued.token,'New password cannot cross purpose'),{statusCode:400});
 await assert.rejects(adminPool.query("UPDATE email_verification_tokens SET purpose='password_reset' WHERE user_id=$1",[a.id]),/check constraint/);
 assert.equal((await user(a)).email_verified_at,null);assert.equal((await user(a)).password_hash,a.hash);
});

test('an audit failure rolls back verification, every session, token and encrypted mail change',async()=>{
 const a=await fixture('rollback'),issued=await issue(a),session=await makeSession(a),connect=adminPool.connect.bind(adminPool);
 (adminPool as any).connect=async(callback?:any)=>{if(callback)return (connect as any)(callback);const c=await connect(),query=c.query.bind(c);return new Proxy(c,{get(target,property){if(property==='query')return (sql:any,...args:any[])=>{if(typeof sql==='string'&&sql.includes("VALUES($1,'email_verified'"))throw new Error('Owned audit rollback');return (query as any)(sql,...args);};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});};
 try{await assert.rejects(completeEmailVerification(issued.token,a.password),/Owned audit rollback/);}finally{(adminPool as any).connect=connect;}
 assert.equal((await user(a)).email_verified_at,null);assert.equal((await outbox(issued.row.id)).state,'pending');assert.ok((await outbox(issued.row.id)).payload_ciphertext);
 assert.equal((await adminPool.query('SELECT 1 FROM sessions WHERE token_hash=$1',[hashToken(session)])).rowCount,1);assert.equal((await adminPool.query('SELECT 1 FROM email_verification_tokens WHERE user_id=$1',[a.id])).rowCount,1);
 assert.deepEqual(await completeEmailVerification(issued.token,a.password),{ok:true});
});

test('expiry is read from the database after the user lock, and password proof is rechecked after a concurrent hash change',async()=>{
 const a=await fixture('clock'),issued=await issue(a),connect=adminPool.connect.bind(adminPool);let changed=false;
 (adminPool as any).connect=async(callback?:any)=>{if(callback)return (connect as any)(callback);const c=await connect(),query=c.query.bind(c);return new Proxy(c,{get(target,property){if(property==='query')return async(sql:any,...args:any[])=>{const result=await (query as any)(sql,...args);if(sql==='SELECT id,email,password_hash,email_verified_at FROM users WHERE id=$1 FOR UPDATE'&&!changed){changed=true;await query("UPDATE email_verification_tokens SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp() WHERE user_id=$1",[a.id]);}return result;};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});};
 try{await assert.rejects(completeEmailVerification(issued.token,a.password),{statusCode:400,message:invalidVerificationMessage});}finally{(adminPool as any).connect=connect;}assert.equal(changed,true);assert.equal((await user(a)).email_verified_at,null);
 const b=await fixture('stale-proof'),link=await issue(b),cleaner=await connect();let swapped=false;const newHash=await hashPassword('Concurrent new password');
 (adminPool as any).connect=async(callback?:any)=>{if(callback)return (connect as any)(callback);const c=await connect(),query=c.query.bind(c);return new Proxy(c,{get(target,property){if(property==='query')return async(sql:any,...args:any[])=>{if(sql==='SELECT id,email,password_hash,email_verified_at FROM users WHERE id=$1 FOR UPDATE'&&!swapped){swapped=true;await cleaner.query('UPDATE users SET password_hash=$2 WHERE id=$1',[b.id,newHash]);}return (query as any)(sql,...args);};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});};
 try{await assert.rejects(completeEmailVerification(link.token,b.password),{statusCode:400,message:invalidVerificationMessage});}finally{(adminPool as any).connect=connect;cleaner.release();}assert.equal(swapped,true);assert.equal((await user(b)).email_verified_at,null);assert.equal((await user(b)).password_hash,newHash);
});

test('public resend admission has no account lookup and returns one encrypted asynchronous response for known, unknown and verified accounts',async()=>{
 const a=await fixture('resend'),b=await fixture('already'),unknown=`owned-verification-missing-${randomUUID()}@example.test`;await adminPool.query('UPDATE users SET email_verified_at=clock_timestamp() WHERE id=$1',[b.id]);
 const connect=adminPool.connect.bind(adminPool);
 (adminPool as any).connect=async(callback?:any)=>{if(callback)return (connect as any)(callback);const c=await connect(),query=c.query.bind(c);return new Proxy(c,{get(target,property){if(property==='query')return (sql:any,...args:any[])=>{if(typeof sql==='string'&&/\busers\b/i.test(sql))throw new Error('Public verification admission must not query users');return (query as any)(sql,...args);};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});};
 try{for(const email of [a.email,b.email,unknown]){addresses.add(email);assert.deepEqual(await requestEmailVerification(email),verificationAccepted);}}finally{(adminPool as any).connect=connect;}
 const rows=(await adminPool.query('SELECT * FROM email_verification_requests WHERE address_key=ANY($1::text[])',[[a.email,b.email,unknown].map(key)])).rows;assert.equal(rows.length,3);for(const row of rows){assert.ok(row.payload_ciphertext);assert.equal(JSON.stringify(row).includes('@'),false);assert.equal(Object.hasOwn(row,'user_id'),false);assert.ok(Math.abs((row.expires_at-row.created_at)-24*60*60_000)<=10);}
 assert.equal((await adminPool.query('SELECT 1 FROM email_verification_tokens WHERE user_id=$1',[a.id])).rowCount,0);assert.equal(delivered.length,0);
 while(await processOneEmailVerificationRequest()){}
 assert.equal((await adminPool.query('SELECT 1 FROM email_verification_tokens WHERE user_id=$1',[a.id])).rowCount,1);assert.equal((await adminPool.query('SELECT 1 FROM email_verification_tokens WHERE user_id=$1',[b.id])).rowCount,0);
 const again=await request(`  ${a.email.toUpperCase()}  `);assert.equal(again.statusCode,202);assert.deepEqual(again.json(),verificationAccepted);assert.equal(again.headers['set-cookie'],undefined);
});

test('cooldown and hourly limits suppress uniformly, including the expired-limit cleanup race',async()=>{
 const a=await fixture('limits');for(let i=0;i<8;i++){await requestEmailVerification(a.email);if(i>0)await cooldown(a);}
 assert.equal((await adminPool.query('SELECT grants FROM email_verification_limits WHERE address_key=$1',[key(a.email)])).rows[0].grants,5);assert.equal((await adminPool.query('SELECT count(*)::int n FROM email_verification_requests WHERE address_key=$1',[key(a.email)])).rows[0].n,5);
 const b=await fixture('limit-race');await adminPool.query("INSERT INTO email_verification_limits VALUES($1,clock_timestamp()-interval '2 hours',5,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour')",[key(b.email)]);
 const connect=adminPool.connect.bind(adminPool),cleaner=await connect();let inserts=0,removed=0;
 (adminPool as any).connect=async(callback?:any)=>{if(callback)return (connect as any)(callback);const c=await connect(),query=c.query.bind(c);return new Proxy(c,{get(target,property){if(property==='query')return async(sql:any,...args:any[])=>{const result=await (query as any)(sql,...args);if(typeof sql==='string'&&sql.startsWith('INSERT INTO email_verification_limits')&&++inserts===1){assert.equal(result.rowCount,0);removed=(await cleaner.query('DELETE FROM email_verification_limits WHERE address_key IN (SELECT address_key FROM email_verification_limits WHERE address_key=$1 AND expires_at<=clock_timestamp() FOR UPDATE SKIP LOCKED)',[key(b.email)])).rowCount??0;}return result;};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});};
 try{await requestEmailVerification(b.email);}finally{(adminPool as any).connect=connect;cleaner.release();}assert.equal(removed,1);assert.equal(inserts,2);assert.equal((await adminPool.query('SELECT grants FROM email_verification_limits WHERE address_key=$1',[key(b.email)])).rows[0].grants,1);
});

test('the full 5000-request queue rejects known and unknown addresses with one safe service error and no address grant',async()=>{
 const a=await fixture('cap');assert.equal((await adminPool.query('SELECT count(*)::int n FROM email_verification_requests')).rows[0].n,0);
 await adminPool.query("INSERT INTO email_verification_requests(address_key,payload_ciphertext,expires_at) SELECT $1,$2,clock_timestamp()+interval '24 hours' FROM generate_series(1,5000)",[key(a.email),encryptSecret(JSON.stringify({email:a.email}))]);
 for(const email of [a.email,`owned-verification-cap-missing-${randomUUID()}@example.test`]){const response=await request(email);assert.equal(response.statusCode,503);assert.equal(response.json().error,'email_verification_unavailable');assert.equal((await adminPool.query('SELECT 1 FROM email_verification_limits WHERE address_key=$1',[key(email)])).rowCount,0);}
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM email_verification_requests')).rows[0].n,5000);
});

test('queued resend deadlines never extend and password changes cancel issued verification without verifying the email',async()=>{
 const a=await fixture('changed'),session=await makeSession(a),issued=await issue(a);await requestEmailVerification(a.email);
 await changeAccountPassword(a.id,session,a.password,'Changed password after verification request');assert.equal((await user(a)).email_verified_at,null);assert.equal((await outbox(issued.row.id)).state,'cancelled');assert.equal(await processOneEmailVerificationRequest(),true);assert.equal((await adminPool.query('SELECT 1 FROM email_verification_tokens WHERE user_id=$1',[a.id])).rowCount,0);
 const b=await fixture('deadline');await requestEmailVerification(b.email);await adminPool.query("UPDATE email_verification_requests SET created_at=clock_timestamp()-interval '23 hours',expires_at=clock_timestamp()+interval '1 hour' WHERE address_key=$1",[key(b.email)]);
 const deadline=(await adminPool.query('SELECT expires_at FROM email_verification_requests WHERE address_key=$1',[key(b.email)])).rows[0].expires_at;await processOneEmailVerificationRequest();assert.equal((await adminPool.query('SELECT expires_at FROM email_verification_tokens WHERE user_id=$1',[b.id])).rows[0].expires_at.getTime(),deadline.getTime());
 const expired=await fixture('request-expired');await requestEmailVerification(expired.email);await adminPool.query("UPDATE email_verification_requests SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(expired.email)]);assert.equal(await processOneEmailVerificationRequest(),true);assert.equal((await adminPool.query('SELECT 1 FROM email_verification_tokens WHERE user_id=$1',[expired.id])).rowCount,0);
});

test('verification invalidates pre-verification queued resets while a later reset works and never changes verification truth',async()=>{
 const a=await fixture('reset-cutoff'),issued=await issue(a);await requestPasswordReset(a.email);await completeEmailVerification(issued.token,a.password);const verified=(await user(a)).email_verified_at;
 assert.equal(await processOneAccountRecoveryRequest(),true);assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rowCount,0);
 await adminPool.query("UPDATE account_recovery_limits SET cooldown_until=clock_timestamp()-interval '1 second' WHERE address_key=$1",[privateIdentifier('folio:account-recovery:address:v1',a.email)]);await requestPasswordReset(a.email);await processOneAccountRecoveryRequest();
 const row=(await adminPool.query("SELECT payload_ciphertext FROM account_email_outbox WHERE user_id=$1 AND kind='password_reset'",[a.id])).rows[0];const link=new URL(JSON.parse(decryptSecret(row.payload_ciphertext)).text.match(/https?:\/\/[^\s]+/)![0]);await completePasswordReset(new URLSearchParams(link.hash.slice(1)).get('token')!,'Password changed after verification');assert.equal((await user(a)).email_verified_at.getTime(),verified.getTime());
 const pending=await fixture('reset-pending',true),pendingLink=await issue(pending);await requestPasswordReset(pending.email);await processOneAccountRecoveryRequest();const reset=(await adminPool.query("SELECT payload_ciphertext FROM account_email_outbox WHERE user_id=$1 AND kind='password_reset'",[pending.id])).rows[0];const resetLink=new URL(JSON.parse(decryptSecret(reset.payload_ciphertext)).text.match(/https?:\/\/[^\s]+/)![0]);await completePasswordReset(new URLSearchParams(resetLink.hash.slice(1)).get('token')!,'Pending password reset remains gated');assert.equal((await user(pending)).email_verified_at,null);assert.equal((await outbox(pendingLink.row.id)).state,'cancelled');
});

test('valid confirmation works while sending is unavailable; origin, validation, and throttling errors remain actionable',async()=>{
 const a=await fixture('outage',true),issued=await issue(a);setAccountEmailSenderForTests(null);
 const unavailable=await request(a.email);assert.equal(unavailable.statusCode,503);assert.equal(unavailable.json().error,'email_verification_unavailable');assert.equal((await complete(issued.token,a.password)).statusCode,200);
 for(const headers of [{origin:'https://unrelated.example.test'},{'sec-fetch-site':'cross-site'}] as Record<string,string>[])assert.equal((await request(a.email,headers)).statusCode,403);
 assert.equal((await request('bad')).statusCode,400);
 const address='198.51.100.211';for(let i=0;i<30;i++)assert.equal((await request('bad',{},address)).statusCode,400);
 const throttled=await request(a.email,{},address);assert.equal(throttled.statusCode,429);assert.ok(throttled.headers['retry-after']);
});

test('verification mail uses stable provider idempotency, retries safely and is fenced from a late acknowledgement after password change',async()=>{
 const a=await fixture('mail-retry'),issued=await issue(a);let calls=0,firstKey='';
 setAccountEmailSenderForTests({async send(message){calls++;assert.equal(message.subject,'Verify your MaintainFlow email');assert.equal(message.to,a.email);if(!firstKey)firstKey=message.idempotencyKey;else assert.equal(message.idempotencyKey,firstKey);if(calls===1)throw new AccountEmailError('temporary_failure',true);return {providerId:randomUUID()};}});
 assert.equal(await processOneAccountEmail(),true);assert.equal((await outbox(issued.row.id)).state,'pending');assert.ok((await outbox(issued.row.id)).payload_ciphertext);await adminPool.query('UPDATE account_email_outbox SET available_at=clock_timestamp() WHERE id=$1',[issued.row.id]);assert.equal(await processOneAccountEmail(),true);assert.equal(calls,2);assert.equal((await outbox(issued.row.id)).state,'accepted');assert.equal((await outbox(issued.row.id)).payload_ciphertext,null);assert.equal((await adminPool.query('SELECT 1 FROM email_verification_tokens WHERE user_id=$1',[a.id])).rowCount,1);
 const b=await fixture('mail-late'),session=await makeSession(b),link=await issue(b);let started!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});setAccountEmailSenderForTests({async send(){started();await gate;return {providerId:randomUUID()};}});
 const work=processOneAccountEmail();await entered;await changeAccountPassword(b.id,session,b.password,'Changed during captured provider call');release();assert.equal(await work,true);assert.equal((await outbox(link.row.id)).state,'cancelled');assert.equal((await outbox(link.row.id)).payload_ciphertext,null);assert.equal((await user(b)).email_verified_at,null);
});

test('mail validity binds the exact email and credential and bounded cleanup erases expired token payloads even with sending disabled',async()=>{
 const a=await fixture('cleanup'),issued=await issue(a),record=await user(a);
 await transaction(adminPool,async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[a.id]);assert.equal(await isEmailVerificationMailValid(c,record,issued.row.verification_token_id),true);assert.equal(await isEmailVerificationMailValid(c,{...record,email:`changed-${a.email}`},issued.row.verification_token_id),false);assert.equal(await isEmailVerificationMailValid(c,{...record,email_verified_at:new Date()},issued.row.verification_token_id),false);});
 await expire(a);await requestEmailVerification(a.email);await adminPool.query("UPDATE email_verification_requests SET created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(a.email)]);await adminPool.query("UPDATE email_verification_limits SET expires_at=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(a.email)]);setAccountEmailSenderForTests(null);await cleanupEmailVerification();
 assert.equal((await outbox(issued.row.id)).state,'cancelled');assert.equal((await outbox(issued.row.id)).payload_ciphertext,null);assert.equal((await outbox(issued.row.id)).verification_token_id,null);
 for(const table of ['email_verification_requests','email_verification_limits'])assert.equal((await adminPool.query(`SELECT 1 FROM ${table} WHERE address_key=$1`,[key(a.email)])).rowCount,0);assert.equal((await user(a)).email_verified_at,null);
 const b=await fixture('budget'),live=await issue(b);await expire(b);await assert.rejects(cleanupEmailVerification({signal:AbortSignal.abort()}),/Worker time budget reached/);assert.equal((await outbox(live.row.id)).state,'pending');
});
