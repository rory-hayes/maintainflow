import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,transaction,closeDatabase} from '../server/core/db.js';
import {config,defaultPlan} from '../server/core/config.js';
import {createSession,hashPassword,hashToken,newToken,verifyPassword} from '../server/core/auth.js';
import {changeAccountPassword,completePasswordReset,invalidResetMessage,recoveryAccepted,requestPasswordReset,processOneAccountRecoveryRequest} from '../server/core/account-recovery.js';
import {cleanupAccountRecovery,processOneAccountEmail} from '../server/core/account-recovery-mail.js';
import {AccountEmailError,setAccountEmailSenderForTests,type AccountEmailMessage} from '../server/integrations/account-email.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../server/integrations/secrets.js';
import {buildMigrationSql,readMigrations} from '../scripts/migrate.js';

type Account={id:string;email:string;password:string;hash:string;workspaceId:string};
const accounts:Account[]=[],addresses=new Set<string>(),delivered:AccountEmailMessage[]=[];
let app:FastifyInstance,verified=false,ip=10,fetches=0;
const originalFetch=globalThis.fetch;
const collect={async send(message:AccountEmailMessage){delivered.push(message);return {providerId:randomUUID()};}};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const ids=()=>accounts.map(account=>account.id);
async function fixture(label:string):Promise<Account>{
 const a={id:randomUUID(),email:`owned-recovery-${label}-${randomUUID()}@example.test`,password:'Owned Recovery  Café  ',hash:'',workspaceId:randomUUID()};
 a.hash=await hashPassword(a.password);accounts.push(a);addresses.add(a.email);
 await transaction(adminPool,async c=>{
  await c.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[a.id,a.email,'Owned recovery fixture',a.hash]);
  await c.query('INSERT INTO workspaces(id,name,slug,plan) VALUES($1,$2,$3,$4)',[a.workspaceId,'Owned recovery workspace',a.workspaceId,JSON.stringify(defaultPlan)]);
  await c.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[a.workspaceId,a.id]);
 });return a;
}
const address=()=>`192.0.2.${++ip}`;
function request(email:string,remoteAddress=address(),headers:Record<string,string>={}){
 addresses.add(email.trim().toLowerCase());return app.inject({method:'POST',url:'/api/auth/password-reset/request',remoteAddress,headers:{origin:config.origin,...headers},payload:{email}});
}
function complete(token:string,newPassword='Changed exact Café password',remoteAddress=address()){
 return app.inject({method:'POST',url:'/api/auth/password-reset/complete',remoteAddress,headers:{origin:config.origin},payload:{token,newPassword}});
}
async function issue(a:Account){
 await requestPasswordReset(a.email);
 while(await processOneAccountRecoveryRequest()){}
 const row=(await adminPool.query("SELECT * FROM account_email_outbox WHERE user_id=$1 AND kind='password_reset' ORDER BY created_at DESC,id DESC LIMIT 1",[a.id])).rows[0];
 assert.ok(row);const payload=JSON.parse(decryptSecret(row.payload_ciphertext));const link=new URL(payload.text.match(/https?:\/\/[^\s]+/)![0]);
 const token=new URLSearchParams(link.hash.slice(1)).get('token')!;assert.match(token,/^[A-Za-z0-9_-]{43}$/);
 return {row,token,link,payload};
}
async function cooldown(a:Account){await adminPool.query("UPDATE account_recovery_limits SET cooldown_until=clock_timestamp()-interval '1 second' WHERE address_key=$1",[privateIdentifier('folio:account-recovery:address:v1',a.email)]);}
async function makeSession(a:Account){const token=newToken();await adminPool.query("INSERT INTO sessions(user_id,workspace_id,token_hash,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[a.id,a.workspaceId,hashToken(token)]);return token;}
async function outbox(id:string){return (await adminPool.query('SELECT * FROM account_email_outbox WHERE id=$1',[id])).rows[0];}
async function ownedSnapshot(a:Account){return (await adminPool.query(`SELECT (SELECT count(*) FROM memberships WHERE user_id=$1)::int memberships,
 (SELECT row_to_json(w) FROM workspaces w WHERE id=$2) workspace,(SELECT count(*) FROM documents WHERE workspace_id=$2)::int documents,
 (SELECT count(*) FROM usage_ledger WHERE workspace_id=$2)::int usage`,[a.id,a.workspaceId])).rows[0];}
async function expire(a:Account){await adminPool.query("UPDATE account_recovery_tokens SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[a.id]);}
async function lockUser(a:Account){const c=await adminPool.connect();await c.query('BEGIN');await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[a.id]);return c;}
async function waitForCredentialLock(){
 for(let i=0;i<100;i++){
  const row=(await adminPool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query='SELECT id,email,password_hash FROM users WHERE id=$1 FOR UPDATE'")).rows[0];
  if(row.n>0)return;await pause(10);
 }throw new Error('Owned credential operation did not reach its user lock');
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
 verified=true;globalThis.fetch=async()=>{fetches++;throw new Error('No network in owned account recovery fixtures');};setAccountEmailSenderForTests(collect);app=await buildApp();
});
afterEach(async()=>{
 setAccountEmailSenderForTests(collect);delivered.length=0;assert.equal(fetches,0);
 if(verified){await adminPool.query('DELETE FROM account_recovery_requests WHERE address_key=ANY($1::text[])',[[...addresses].map(email=>privateIdentifier('folio:account-recovery:address:v1',email))]);await adminPool.query('DELETE FROM account_email_outbox WHERE user_id=ANY($1::uuid[])',[ids()]);await adminPool.query('DELETE FROM account_recovery_tokens WHERE user_id=ANY($1::uuid[])',[ids()]);}
});
after(async()=>{
 try{
  await app?.close();setAccountEmailSenderForTests(undefined);globalThis.fetch=originalFetch;
  if(verified){
   await adminPool.query('DELETE FROM account_recovery_limits WHERE address_key=ANY($1::text[])',[[...addresses].map(email=>privateIdentifier('folio:account-recovery:address:v1',email))]);
   await adminPool.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[accounts.map(a=>a.workspaceId)]);
   await adminPool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[ids()]);
  }
 }finally{await closeDatabase();}
});

test('known and unknown requests have one response, address cooldown/hour limits and no immediate delivery',async()=>{
 const a=await fixture('uniform'),unknown=`owned-missing-${randomUUID()}@example.test`;
 const before=await ownedSnapshot(a),session=await makeSession(a);
 for(const email of [a.email,unknown]){
  const response=await request(`  ${email.toUpperCase()}  `);assert.equal(response.statusCode,202);assert.deepEqual(response.json(),recoveryAccepted);assert.equal(response.headers['set-cookie'],undefined);
  for(let i=0;i<3;i++){const again=await request(email);assert.equal(again.statusCode,202);assert.deepEqual(again.json(),recoveryAccepted);}
 }
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rows[0].n,0);
 while(await processOneAccountRecoveryRequest()){}
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rows[0].n,1);
 assert.equal(delivered.length,0);assert.deepEqual(await ownedSnapshot(a),before);assert.equal((await adminPool.query('SELECT 1 FROM sessions WHERE token_hash=$1',[hashToken(session)])).rowCount,1);
 for(let i=0;i<6;i++){await cooldown(a);assert.deepEqual((await request(a.email)).json(),recoveryAccepted);}
 while(await processOneAccountRecoveryRequest()){}
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rows[0].n,5);
 const limits=(await adminPool.query('SELECT * FROM account_recovery_limits WHERE address_key=ANY($1::text[])',[[a.email,unknown].map(email=>privateIdentifier('folio:account-recovery:address:v1',email))])).rows;
 assert.equal(limits.length,2);assert.ok(!JSON.stringify(limits).includes(a.email));assert.equal(limits.find(row=>row.grants===5)?.grants,5);
});

test('expired-limit cleanup between conflict detection and row locking retries once without losing or duplicating a grant',async()=>{
 const a=await fixture('cleanup-race'),key=privateIdentifier('folio:account-recovery:address:v1',a.email);
 await adminPool.query(`INSERT INTO account_recovery_limits(address_key,window_started_at,grants,cooldown_until,expires_at)
  VALUES($1,clock_timestamp()-interval '2 hours',5,clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour')`,[key]);
 const connect=adminPool.connect.bind(adminPool),cleaner=await connect();let deleted=0,insertions=0;
 (adminPool as any).connect=async()=>{
  const client=await connect(),query=client.query.bind(client);
  return new Proxy(client,{get(target,property){
   if(property==='query')return async(text:any,...args:any[])=>{
    const result=await (query as any)(text,...args);
    if(typeof text==='string'&&text.startsWith('INSERT INTO account_recovery_limits')){
     insertions++;
     if(insertions===1){
      assert.equal(result.rowCount,0,'The old expired row must cause the first insert conflict');
      // Execute the real cleanup predicate on this owned key, on a separate
      // connection exactly after DO NOTHING and before SELECT FOR UPDATE.
      const removed=await cleaner.query(`DELETE FROM account_recovery_limits WHERE address_key IN (
       SELECT address_key FROM account_recovery_limits WHERE address_key=$1 AND expires_at<=clock_timestamp()
       ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING address_key`,[key]);
      deleted=removed.rowCount??0;assert.equal(deleted,1);
     }
    }
    return result;
   };
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
 };
 try{assert.deepEqual(await requestPasswordReset(a.email),recoveryAccepted);}
 finally{(adminPool as any).connect=connect;cleaner.release();}
 assert.equal(deleted,1);assert.equal(insertions,2);
 const limit=(await adminPool.query('SELECT grants,expires_at>clock_timestamp() AS active FROM account_recovery_limits WHERE address_key=$1',[key])).rows[0];
 assert.deepEqual(limit,{grants:1,active:true});
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_requests WHERE address_key=$1',[key])).rows[0].n,1);
 assert.deepEqual(await requestPasswordReset(a.email),recoveryAccepted);
 assert.equal((await adminPool.query('SELECT grants FROM account_recovery_limits WHERE address_key=$1',[key])).rows[0].grants,1);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_requests WHERE address_key=$1',[key])).rows[0].n,1);
});

test('public requests never look up accounts and the bounded request queue stores equal encrypted envelopes',async()=>{
 const a=await fixture('queued'),unknown=`owned-queued-missing-${randomUUID()}@example.test`;
 const connect=adminPool.connect.bind(adminPool);
 (adminPool as any).connect=async()=>{
  const c=await connect(),query=c.query.bind(c);
  const wrapped=new Proxy(c,{get(target,key){
   if(key==='query')return (text:any,...args:any[])=>{if(typeof text==='string'&&/\busers\b/i.test(text))throw new Error('Public reset request must not resolve account existence');return (query as any)(text,...args);};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});return wrapped;
 };
 try{for(const email of [a.email,unknown]){addresses.add(email);assert.deepEqual(await requestPasswordReset(email),recoveryAccepted);}}
 finally{(adminPool as any).connect=connect;}
 const rows=(await adminPool.query('SELECT * FROM account_recovery_requests WHERE address_key=ANY($1::text[])',[[a.email,unknown].map(email=>privateIdentifier('folio:account-recovery:address:v1',email))])).rows;
 assert.equal(rows.length,2);for(const row of rows){assert.ok(row.payload_ciphertext);assert.equal(JSON.stringify(row).includes('@'),false);assert.equal(Object.hasOwn(row,'user_id'),false);}
 while(await processOneAccountRecoveryRequest()){}
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rows[0].n,1);
});

test('the global encrypted request cap returns the same actionable unavailable response without consuming address grants',async()=>{
 const a=await fixture('global-cap'),key=privateIdentifier('folio:account-recovery:address:v1',a.email);
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_requests')).rows[0].n,0,'Only this suite owns pending local recovery requests');
 await adminPool.query(`INSERT INTO account_recovery_requests(address_key,payload_ciphertext,expires_at)
  SELECT $1,$2,clock_timestamp()+interval '30 minutes' FROM generate_series(1,5000)`,[key,encryptSecret(JSON.stringify({email:a.email}))]);
 for(const email of [a.email,`owned-cap-unknown-${randomUUID()}@example.test`]){addresses.add(email);const response=await request(email);assert.equal(response.statusCode,503);assert.equal(response.json().error,'password_recovery_unavailable');assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_limits WHERE address_key=$1',[privateIdentifier('folio:account-recovery:address:v1',email)])).rowCount,0);}
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_recovery_requests')).rows[0].n,5000);
 assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rowCount,0);
});

test('pending requests cannot create a new recovery token after a password change, and queued expiry is never extended',async()=>{
 const a=await fixture('pending-change'),session=await makeSession(a);await requestPasswordReset(a.email);
 await changeAccountPassword(a.id,session,a.password,'Changed before queued resolution');
 assert.equal(await processOneAccountRecoveryRequest(),true);assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rowCount,0);
 const b=await fixture('queued-expiry');await requestPasswordReset(b.email);
 const key=privateIdentifier('folio:account-recovery:address:v1',b.email);
 await adminPool.query("UPDATE account_recovery_requests SET created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()+interval '20 minutes' WHERE address_key=$1",[key]);
 const expiry=(await adminPool.query('SELECT expires_at FROM account_recovery_requests WHERE address_key=$1',[key])).rows[0].expires_at;
 await processOneAccountRecoveryRequest();
 assert.deepEqual((await adminPool.query('SELECT expires_at FROM account_recovery_tokens WHERE user_id=$1',[b.id])).rows[0].expires_at,expiry);
});

test('disabled recovery is uniformly unavailable and invalid/origin/cross-site input creates no tokens',async()=>{
 const a=await fixture('disabled');setAccountEmailSenderForTests(null);
 for(const email of [a.email,`owned-missing-${randomUUID()}@example.test`]){const response=await request(email);assert.equal(response.statusCode,503);assert.equal(response.json().error,'password_recovery_unavailable');}
 setAccountEmailSenderForTests(collect);
 assert.equal((await request('invalid')).statusCode,400);
 assert.equal((await request(a.email,address(),{origin:'https://unrelated.example'})).statusCode,403);
 assert.equal((await request(a.email,address(),{'sec-fetch-site':'cross-site'})).statusCode,403);
 assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rowCount,0);
 assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_limits WHERE address_key=$1',[privateIdentifier('folio:account-recovery:address:v1',a.email)])).rowCount,0);
});

test('reset links use trusted fragment origins with only hashes/encrypted payloads, and later issuance preserves earlier links',async()=>{
 const a=await fixture('tokens'),first=await issue(a);await cooldown(a);const second=await issue(a);
 assert.notEqual(first.token,second.token);assert.equal(first.link.origin,new URL(config.origin).origin);assert.equal(first.link.pathname,'/reset-password');assert.equal(first.link.search,'');
 const rows=(await adminPool.query('SELECT *,extract(epoch FROM(expires_at-created_at)) seconds FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rows;
 assert.equal(rows.length,2);for(const row of rows){assert.match(row.token_hash,/^[a-f0-9]{64}$/);assert.equal(row.credential_digest,hashToken(a.hash));assert.equal(row.purpose,'password_reset');assert.ok(Number(row.seconds)>1799&&Number(row.seconds)<=1800);}
 assert.equal(rows.some(row=>row.token_hash===hashToken(first.token)),true);
 assert.equal(JSON.stringify(rows).includes(first.token),false);assert.equal(first.row.payload_ciphertext.includes(first.token),false);assert.equal(first.row.payload_ciphertext.includes(a.email),false);
 assert.equal((await complete(first.token)).statusCode,200);assert.equal((await complete(second.token)).statusCode,400);
});

test('completion is atomic, signs out browser sessions, preserves API keys and workspace state, and never signs in',async()=>{
 const a=await fixture('complete'),other=await fixture('isolated'),session=await makeSession(a),otherSession=await makeSession(other),key=`fl_${newToken()}`;
 await makeSession(a);await adminPool.query("INSERT INTO api_keys(workspace_id,user_id,name,prefix,token_hash,scopes) VALUES($1,$2,'Owned recovery key','fl_owned',$3,'[\"documents:read\"]')",[a.workspaceId,a.id,hashToken(key)]);
 const snapshot=await ownedSnapshot(a),issued=await issue(a);const response=await complete(issued.token,'  New MiXeD Café Password  ');
 assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json(),{ok:true});assert.equal(response.headers['set-cookie'],undefined);
 assert.equal((await app.inject({url:'/api/auth/me',headers:{cookie:`folio_session=${session}`}})).statusCode,401);
 assert.equal((await app.inject({url:'/api/auth/me',headers:{cookie:`folio_session=${otherSession}`}})).statusCode,200);
 assert.equal((await app.inject({url:'/api/documents',headers:{authorization:`Bearer ${key}`}})).statusCode,200);
 assert.deepEqual(await ownedSnapshot(a),snapshot);
 const hash=(await adminPool.query('SELECT password_hash FROM users WHERE id=$1',[a.id])).rows[0].password_hash;
 assert.equal(await verifyPassword(a.password,hash),false);assert.equal(await verifyPassword('  New MiXeD Café Password  ',hash),true);assert.equal(await verifyPassword('New MiXeD Café Password',hash),false);
 assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE user_id=$1',[a.id])).rowCount,0);
 assert.equal((await outbox(issued.row.id)).payload_ciphertext,null);
 const audit=(await adminPool.query("SELECT * FROM account_security_events WHERE user_id=$1 AND action='password_reset_completed'",[a.id])).rows[0];assert.equal(audit.sessions_revoked,2);assert.equal(audit.tokens_invalidated,1);assert.equal(JSON.stringify(audit).includes(a.email),false);
 assert.equal((await adminPool.query("SELECT count(*)::int n FROM account_email_outbox WHERE user_id=$1 AND kind='password_changed' AND state='pending'",[a.id])).rows[0].n,1);
});

test('wrong, expired, used and credential-bound stale tokens share one safe error; password creation policy stays specific',async()=>{
 const a=await fixture('invalid'),issued=await issue(a);
 for(const password of ['short','x'.repeat(129)]){const response=await complete(issued.token,password);assert.equal(response.statusCode,400);assert.match(response.json().message,/between 10 and 128/);}
 const wrong=await complete(newToken());assert.equal(wrong.statusCode,400);assert.equal(wrong.json().message,invalidResetMessage);
 await expire(a);assert.deepEqual((await complete(issued.token)).json(),wrong.json());
 await cooldown(a);const stale=await issue(a);await adminPool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await hashPassword('Independent password changed'),a.id]);assert.deepEqual((await complete(stale.token)).json(),wrong.json());
});

test('concurrent completions of different tokens for one account have exactly one winner and notification',async()=>{
 const a=await fixture('concurrent'),first=await issue(a);await cooldown(a);const second=await issue(a);
 const results=await Promise.all([complete(first.token,'First valid password'),complete(second.token,'Second valid password')]);
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,400]);assert.equal((await adminPool.query("SELECT count(*)::int n FROM account_security_events WHERE user_id=$1 AND action='password_reset_completed'",[a.id])).rows[0].n,1);
 assert.equal((await adminPool.query("SELECT count(*)::int n FROM account_email_outbox WHERE user_id=$1 AND kind='password_changed'",[a.id])).rows[0].n,1);
});

test('a security-audit failure rolls back password, sessions, token invalidation and notification together',async()=>{
 const a=await fixture('rollback'),issued=await issue(a),session=await makeSession(a),name=`owned_recovery_${randomUUID().replaceAll('-','')}`;
 await adminPool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.user_id='${a.id}'::uuid AND NEW.action='password_reset_completed' THEN RAISE EXCEPTION 'Owned audit rollback'; END IF; RETURN NEW; END$$`);
 await adminPool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON account_security_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{
  await assert.rejects(completePasswordReset(issued.token,'New rollback password'),/Owned audit rollback/);
  assert.equal((await adminPool.query('SELECT password_hash FROM users WHERE id=$1',[a.id])).rows[0].password_hash,a.hash);
  assert.equal((await adminPool.query('SELECT 1 FROM sessions WHERE token_hash=$1',[hashToken(session)])).rowCount,1);
  assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE token_hash=$1',[hashToken(issued.token)])).rowCount,1);
  assert.equal((await outbox(issued.row.id)).state,'pending');assert.equal((await adminPool.query("SELECT 1 FROM account_email_outbox WHERE user_id=$1 AND kind='password_changed'",[a.id])).rowCount,0);
 }finally{await adminPool.query(`DROP TRIGGER ${name} ON account_security_events`);await adminPool.query(`DROP FUNCTION ${name}()`);}
});

test('session creation fences a password verified before reset, and reset revokes a session created first',async()=>{
 const a=await fixture('login-race'),issued=await issue(a),cookies:string[]=[];
 const reply={setCookie:(_name:string,value:string)=>{cookies.push(value);}} as unknown as FastifyReply;
 await createSession(reply,a.id,a.workspaceId,a.hash);assert.equal(cookies.length,1);
 await completePasswordReset(issued.token,'Reset racing login password');
 assert.equal((await adminPool.query('SELECT 1 FROM sessions WHERE token_hash=$1',[hashToken(cookies[0])])).rowCount,0);
 await assert.rejects(createSession(reply,a.id,a.workspaceId,a.hash),(e:any)=>e.statusCode===401&&e.message==='Email or password is incorrect');assert.equal(cookies.length,1);
});

test('authenticated password changes retain only the current session and cancel recovery; stale work cannot overwrite a reset',async()=>{
 const a=await fixture('change'),issued=await issue(a),session=await makeSession(a),second=await makeSession(a);
 await changeAccountPassword(a.id,session,a.password,'Authenticated replacement password');
 assert.equal((await adminPool.query('SELECT 1 FROM sessions WHERE token_hash=$1',[hashToken(session)])).rowCount,1);assert.equal((await adminPool.query('SELECT 1 FROM sessions WHERE token_hash=$1',[hashToken(second)])).rowCount,0);
 assert.equal((await complete(issued.token)).statusCode,400);assert.equal((await outbox(issued.row.id)).payload_ciphertext,null);
 const b=await fixture('stale-change'),active=await makeSession(b),c=await lockUser(b);
 const pending=changeAccountPassword(b.id,active,b.password,'Must not replace the reset');
 try{await waitForCredentialLock();await c.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await hashPassword('Won reset password'),b.id]);await c.query('DELETE FROM sessions WHERE user_id=$1',[b.id]);await c.query('COMMIT');}
 finally{c.release();}
 await assert.rejects(pending,(e:any)=>e.statusCode===401);
 assert.equal(await verifyPassword('Won reset password',(await adminPool.query('SELECT password_hash FROM users WHERE id=$1',[b.id])).rows[0].password_hash),true);
});

test('expiry is checked against the database clock after a blocked credential lock',async()=>{
 const a=await fixture('expiry-lock'),issued=await issue(a),c=await lockUser(a),pending=completePasswordReset(issued.token,'Too late for this token');
 try{await waitForCredentialLock();await c.query("UPDATE account_recovery_tokens SET created_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp() WHERE user_id=$1",[a.id]);await c.query('COMMIT');}finally{c.release();}
 await assert.rejects(pending,(e:any)=>e.statusCode===400&&e.message===invalidResetMessage);
 assert.equal((await adminPool.query('SELECT password_hash FROM users WHERE id=$1',[a.id])).rows[0].password_hash,a.hash);
});

test('leased delivery survives uncertain acknowledgement with one stable idempotency key and scrubs accepted payloads',async()=>{
 const a=await fixture('retry'),issued=await issue(a),calls:AccountEmailMessage[]=[];
 setAccountEmailSenderForTests({async send(message){calls.push(message);if(calls.length===1)throw new Error('PRIVATE provider response/token diagnostic');return {providerId:randomUUID()};}});
 assert.equal(await processOneAccountEmail(),true);let row=await outbox(issued.row.id);assert.equal(row.state,'pending');assert.equal(row.failure_code,'temporary_failure');assert.equal(row.attempts,1);assert.ok(row.payload_ciphertext);assert.equal(JSON.stringify(row).includes('PRIVATE'),false);
 assert.equal(await processOneAccountEmail(),false);await adminPool.query("UPDATE account_email_outbox SET available_at=clock_timestamp() WHERE id=$1",[row.id]);
 assert.equal(await processOneAccountEmail(),true);row=await outbox(row.id);assert.equal(row.state,'accepted');assert.equal(row.payload_ciphertext,null);assert.equal(row.attempts,2);assert.equal(calls[0].idempotencyKey,calls[1].idempotencyKey);assert.match(calls[0].text,new RegExp(issued.token));
 assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE token_hash=$1',[hashToken(issued.token)])).rowCount,1);
});

test('expired worker leases are reclaimable and a late worker cannot overwrite a newer result',async()=>{
 const a=await fixture('lease'),issued=await issue(a);let release!:(value:{providerId:string})=>void,started!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;});let calls=0;
 setAccountEmailSenderForTests({async send(){calls++;if(calls===1){started();return new Promise(resolve=>{release=resolve;});}return {providerId:randomUUID()};}});
 const late=processOneAccountEmail();await began;
 assert.equal(await processOneAccountEmail(),false);
 await adminPool.query("UPDATE account_email_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[issued.row.id]);
 assert.equal(await processOneAccountEmail(),true);const accepted=await outbox(issued.row.id);assert.equal(accepted.state,'accepted');assert.equal(accepted.attempts,2);
 release({providerId:randomUUID()});await late;assert.deepEqual(await outbox(issued.row.id),accepted);
});

test('credential changes cancel in-flight delivery without allowing a late acknowledgement to reactivate the link',async()=>{
 const a=await fixture('inflight'),issued=await issue(a);let release!:(value:{providerId:string})=>void,started!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;});setAccountEmailSenderForTests({async send(){started();return new Promise(resolve=>{release=resolve;});}});
 const pending=processOneAccountEmail();await began;await completePasswordReset(issued.token,'Reset while delivery is in flight');
 assert.equal((await outbox(issued.row.id)).state,'cancelled');release({providerId:randomUUID()});await pending;assert.equal((await outbox(issued.row.id)).state,'cancelled');assert.equal((await complete(issued.token)).statusCode,400);
});

test('terminal failures, attempt exhaustion and expiry clear token secrets; temporary unavailability preserves valid completion',async()=>{
 const a=await fixture('terminal'),issued=await issue(a);setAccountEmailSenderForTests({async send(){throw new AccountEmailError('permanent_failure',false);}});
 await processOneAccountEmail();assert.equal((await outbox(issued.row.id)).state,'failed');assert.equal((await outbox(issued.row.id)).payload_ciphertext,null);assert.equal((await complete(issued.token)).statusCode,400);
 setAccountEmailSenderForTests(collect);const b=await fixture('attempts'),attempted=await issue(b);await adminPool.query("UPDATE account_email_outbox SET attempts=5,state='sending',lease_owner=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[attempted.row.id,randomUUID()]);
 await processOneAccountEmail();assert.equal((await outbox(attempted.row.id)).failure_code,'attempt_limit');assert.equal(delivered.length,0);
 const c=await fixture('expired'),expired=await issue(c);await expire(c);setAccountEmailSenderForTests(null);await cleanupAccountRecovery();assert.equal((await outbox(expired.row.id)).payload_ciphertext,null);assert.equal((await adminPool.query('SELECT 1 FROM account_recovery_tokens WHERE user_id=$1',[c.id])).rowCount,0);
 setAccountEmailSenderForTests(collect);const d=await fixture('disabled-completion'),valid=await issue(d);setAccountEmailSenderForTests(null);assert.equal((await complete(valid.token)).statusCode,200);
});

test('a worker budget abort is awaited, safely retryable, and cannot leak transport diagnostics',async()=>{
 const a=await fixture('budget'),issued=await issue(a),controller=new AbortController();let started!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;});setAccountEmailSenderForTests({async send(){started();return new Promise(()=>{});}});
 const pending=processOneAccountEmail({signal:controller.signal});await began;controller.abort();assert.equal(await pending,true);
 const row=await outbox(issued.row.id);assert.equal(row.state,'pending');assert.equal(row.failure_code,'cancelled');assert.ok(row.payload_ciphertext);
});

test('IP protection applies to recovery routes and recovery tables remain backend-only after migration grants',async()=>{
 const a=await fixture('ip'),remote=address();for(let i=0;i<30;i++)assert.equal((await request(a.email,remote)).statusCode,202);
 const blocked=await complete(newToken(),'Valid new password',remote);assert.equal(blocked.statusCode,429);assert.ok(Number(blocked.headers['retry-after'])>0);
 for(const table of ['account_recovery_requests','account_recovery_tokens','account_email_outbox','account_recovery_limits','account_security_events']){
  await assert.rejects(appPool.query(`SELECT * FROM ${table}`),/permission denied/);
  const row=(await adminPool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",[table])).rows[0];assert.equal(row.relrowsecurity,true);assert.equal(row.relforcerowsecurity,true);
 }
 const sql=buildMigrationSql(await readMigrations(),{schema:'owned_recovery_schema',adminRole:'owned_recovery_admin',appRole:'owned_recovery_app'});
 assert.ok(sql.indexOf('folio_recovery_permissions')>sql.indexOf('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES'));
 assert.match(sql,/REVOKE ALL ON %I\.%I FROM PUBLIC,%I/);
});
