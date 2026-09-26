import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,transaction,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {processOneAccountRegistration,requiredSignupAccepted} from '../server/core/account-registration.js';
import {validateSignupPolicy,ownSignupTermsRecord} from '../server/core/signup-terms.js';
import {setAccountEmailSenderForTests} from '../server/integrations/account-email.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../server/integrations/secrets.js';
import {assertBankFixtureDatabase} from './bank-statement-fixtures.js';
import type {SignupPolicyInput} from '../shared/signup-terms.js';

const synthetic:SignupPolicyInput={version:'synthetic-signup-v1',language:'en-IE',title:'Synthetic account terms',text:'SYNTHETIC FIXTURE ONLY.\nThese are not customer terms.',url:'https://example.test/synthetic-signup-v1',agreementText:'I accept the synthetic test terms.'};
let current:SignupPolicyInput|null=synthetic,app:Awaited<ReturnType<typeof buildApp>>,ready=false,requests=0,sends=0;
const emails=new Set<string>(),originalFetch=globalThis.fetch,originalRequired=process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION;
const key=(email:string)=>privateIdentifier('folio:account-registration:address:v1',email);
function fields(label='fixture'){const email=`signup-terms-${label}-${randomUUID()}@example.test`;emails.add(email);return {email,password:'Synthetic signup password',name:'Owned signup terms fixture',workspaceName:'Owned '+label};}
function acceptance(policy=synthetic){const checked=validateSignupPolicy(policy);return {accepted:true,version:checked.version,sha256:checked.sha256};}
const register=(value:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:value});
const cookie=(reply:any)=>reply.cookies.map((value:any)=>`${value.name}=${value.value}`).join('; ');
const read=(session:string,url='/api/auth/signup-terms/record',extra={})=>app.inject({method:'GET',url,headers:{cookie:session,...extra}});
const user=(email:string)=>adminPool.query('SELECT * FROM users WHERE email=$1',[email]).then(result=>result.rows[0]);
async function queued(email:string){return (await adminPool.query('SELECT * FROM account_registration_requests WHERE address_key=$1 ORDER BY created_at,id',[key(email)])).rows;}
async function cleanup(){const addresses=[...emails];await adminPool.query('DELETE FROM account_registration_requests WHERE address_key=ANY($1::text[])',[addresses.map(key)]);await adminPool.query('DELETE FROM account_registration_limits WHERE address_key=ANY($1::text[])',[addresses.map(key)]);await adminPool.query('DELETE FROM workspaces WHERE id IN (SELECT workspace_id FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email=ANY($1::text[])))',[addresses]);await adminPool.query('DELETE FROM users WHERE email=ANY($1::text[])',[addresses]);}
function forbidAdmissionUserReads(){
 const original=adminPool.connect.bind(adminPool);
 (adminPool as any).connect=(callback?:any)=>{
  const pending=original().then(client=>{const query=client.query.bind(client);return new Proxy(client,{get(target,property){
   if(property==='query')return (text:any,...args:any[])=>{assert.doesNotMatch(typeof text==='string'?text:text.text,/\busers\b/i);return (query as any)(text,...args);};
   const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});});
  if(callback){void pending.then(client=>callback(null,client,client.release),error=>callback(error));return;}return pending;
 };
 return()=>{(adminPool as any).connect=original;};
}
before(async()=>{await assertBankFixtureDatabase();assert.equal((await adminPool.query('SELECT count(*)::int n FROM account_registration_requests')).rows[0].n,0);ready=true;process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='false';globalThis.fetch=async()=>{requests++;throw Error('No provider requests in signup terms fixtures');};setAccountEmailSenderForTests({async send(){sends++;return {providerId:'synthetic-unused'};}});app=await buildApp({signupPolicy:()=>current});});
afterEach(async()=>{assert.equal(requests,0);assert.equal(sends,0);if(ready)await cleanup();current=synthetic;process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='false';});
after(async()=>{await app?.close();if(ready)await cleanup();setAccountEmailSenderForTests(undefined);globalThis.fetch=originalFetch;if(originalRequired===undefined)delete process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION;else process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION=originalRequired;await closeDatabase();});

test('public status is exact/no-store and stale or withdrawn acceptance cannot provision or enqueue',async()=>{
 const status=await app.inject('/api/auth/signup-terms');assert.equal(status.statusCode,200);assert.deepEqual(status.json(),{enabled:true,policy:validateSignupPolicy(synthetic)});assert.match(String(status.headers['cache-control']),/(?:^|,\s*)no-store(?:,|$)/);assert.equal(status.headers['referrer-policy'],'no-referrer');
 const f=fields('stale');for(const termsAcceptance of [undefined,{...acceptance(),accepted:false},{...acceptance(),version:'stale'}]){const response=await register({...f,...(termsAcceptance?{termsAcceptance}:{})});assert.equal(response.statusCode,termsAcceptance?.version==='stale'?409:400);assert.equal(response.headers['set-cookie'],undefined);}
 current={...synthetic,text:synthetic.text+'\nChanged without version bump'};assert.equal((await register({...f,termsAcceptance:acceptance()})).statusCode,409);
 current=null;assert.equal((await register({...f,termsAcceptance:acceptance()})).statusCode,409);assert.deepEqual((await app.inject('/api/auth/signup-terms')).json(),{enabled:false,policy:null});
 current=undefined as any;assert.equal((await register(f)).statusCode,503);assert.equal((await app.inject('/api/auth/signup-terms')).statusCode,503);
 assert.equal(await user(f.email),undefined);assert.deepEqual(await queued(f.email),[]);
});

test('immediate signup atomically records exact policy and self-service download; legacy disabled signup remains empty',async()=>{
 const f=fields('accepted'),response=await register({...f,termsAcceptance:acceptance()});assert.equal(response.statusCode,201,response.body);const session=cookie(response),id=response.json().user.id;
 const retrieved=await read(session);assert.equal(retrieved.statusCode,200);const record=retrieved.json().record;assert.deepEqual(record.policy,validateSignupPolicy(synthetic));assert.ok(Date.parse(record.acceptedAt)<=Date.parse(record.recordedAt));assert.equal(Object.hasOwn(record,'userId'),false);
 const download=await read(session,'/api/auth/signup-terms/record/download');assert.equal(download.statusCode,200);assert.match(String(download.headers['content-type']),/^text\/plain/);assert.equal(download.headers['content-disposition'],'attachment; filename="signup-terms.txt"');assert.match(String(download.headers['cache-control']),/(?:^|,\s*)no-store(?:,|$)/);assert.ok(download.body.includes(synthetic.text));
 await assert.rejects(adminPool.query("UPDATE signup_terms_acceptances SET accepted_at=accepted_at+interval '1 second' WHERE user_id=$1",[id]),/immutable/);
 current=null;const legacy=await register(fields('legacy'));assert.equal(legacy.statusCode,201);assert.deepEqual((await read(cookie(legacy))).json(),{record:null});assert.equal((await read(cookie(legacy),'/api/auth/signup-terms/record/download')).statusCode,404);
 assert.deepEqual((await read(session)).json().record,record);
 await adminPool.query('DELETE FROM users WHERE id=$1',[id]);assert.equal((await adminPool.query('SELECT 1 FROM signup_terms_acceptances WHERE user_id=$1',[id])).rowCount,0);await adminPool.query('DELETE FROM workspaces WHERE id=$1',[response.json().workspace.id]);
});

test('record access follows session user across workspace roles; APIs, outsiders and app writes are denied',async()=>{
 const a=await register({...fields('owner'),termsAcceptance:acceptance()}),b=await register({...fields('other'),termsAcceptance:acceptance()});assert.equal(a.statusCode,201);assert.equal(b.statusCode,201);const first=a.json(),second=b.json(),session=cookie(a);
 await adminPool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[second.workspace.id,first.user.id]);
 const expected=(await read(session)).json();for(const role of ['viewer','editor','admin']){await adminPool.query('UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[second.workspace.id,first.user.id,role]);assert.deepEqual((await read(session,'/api/auth/signup-terms/record',{'x-workspace-id':second.workspace.id})).json(),expected);}
 assert.equal((await app.inject('/api/auth/signup-terms/record')).statusCode,401);
 const apiKey='fl_'+randomUUID();await adminPool.query("INSERT INTO api_keys(workspace_id,user_id,name,prefix,token_hash,scopes) VALUES($1,$2,'Owned fixture','fl_owned',$3,'[]')",[first.workspace.id,first.user.id,hashToken(apiKey)]);assert.equal((await app.inject({method:'GET',url:'/api/auth/signup-terms/record',headers:{authorization:'Bearer '+apiKey}})).statusCode,403);
 assert.equal((await appPool.query('SELECT count(*)::int n FROM signup_terms_acceptances')).rows[0].n,0);
 await transaction(appPool,async c=>{await c.query("SELECT set_config('app.user_id',$1,true),set_config('app.workspace_id',$2,true)",[first.user.id,second.workspace.id]);assert.deepEqual((await c.query('SELECT user_id FROM signup_terms_acceptances')).rows,[{user_id:first.user.id}]);assert.equal((await c.query('SELECT 1 FROM signup_terms_acceptances WHERE user_id=$1',[second.user.id])).rowCount,0);});
 assert.equal((await appPool.query('SELECT count(*)::int n FROM signup_terms_acceptances')).rows[0].n,0);
 for(const query of ['INSERT INTO signup_terms_acceptances(user_id,policy,accepted_at) VALUES($1,$2,now())','UPDATE signup_terms_acceptances SET policy=$2 WHERE user_id=$1','DELETE FROM signup_terms_acceptances WHERE user_id=$1 AND $2::jsonb IS NOT NULL'])await assert.rejects(appPool.query(query,[first.user.id,JSON.stringify(validateSignupPolicy(synthetic))]),(error:any)=>error.code==='42501');
 const privileges=(await adminPool.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='signup_terms_acceptances'::regclass")).rows[0];assert.deepEqual(privileges,{relrowsecurity:true,relforcerowsecurity:true});
});

test('encrypted required signup retains original acceptance through policy rotation and never backfills an existing account',async()=>{
 current=null;const existingFields=fields('known'),existing=await register(existingFields);assert.equal(existing.statusCode,201);const existingBefore=await user(existingFields.email);
 current=synthetic;process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='true';const fresh=fields('queued'),restore=forbidAdmissionUserReads();
 try{for(const f of [existingFields,fresh]){const response=await register({...f,termsAcceptance:acceptance()});assert.equal(response.statusCode,202,response.body);assert.deepEqual(response.json(),requiredSignupAccepted);assert.equal(response.headers['set-cookie'],undefined);}}finally{restore();}
 const [request]=await queued(fresh.email),payload=JSON.parse(decryptSecret(request.payload_ciphertext));assert.deepEqual(payload.signupTerms.policy,validateSignupPolicy(synthetic));for(const value of [synthetic.text,fresh.email,fresh.password,payload.passwordHash])assert.equal(JSON.stringify(request).includes(value),false);
 current={...synthetic,version:'synthetic-v2',text:'ROTATED SYNTHETIC TERMS'};
 assert.equal(await processOneAccountRegistration(),true);current=null;assert.equal(await processOneAccountRegistration(),true);
 const created=await user(fresh.email),record=await ownSignupTermsRecord(created.id);assert.ok(record);assert.deepEqual(record.policy,payload.signupTerms.policy);assert.equal(record.acceptedAt,payload.signupTerms.acceptedAt);assert.equal(created.email_verification_required,true);
 assert.deepEqual(await user(existingFields.email),existingBefore);assert.equal(await ownSignupTermsRecord(existingBefore.id),null);
 // A repeated request for the newly-created address cannot rewrite its evidence.
 current={...synthetic,version:'synthetic-v2'};await adminPool.query("UPDATE account_registration_limits SET cooldown_until=clock_timestamp()-interval '1 second' WHERE address_key=$1",[key(fresh.email)]);assert.equal((await register({...fresh,termsAcceptance:acceptance(current)})).statusCode,202);await processOneAccountRegistration();assert.deepEqual(await ownSignupTermsRecord(created.id),record);
});

test('legacy encrypted envelopes remain valid while malformed present evidence is discarded without downgrade',async()=>{
 process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='true';current=null;const legacy=fields('legacy-queue');assert.equal((await register(legacy)).statusCode,202);const [original]=await queued(legacy.email),oldPayload=JSON.parse(decryptSecret(original.payload_ciphertext));assert.deepEqual(Object.keys(oldPayload).sort(),['email','name','passwordHash','workspaceName']);await processOneAccountRegistration();assert.equal(await ownSignupTermsRecord((await user(legacy.email)).id),null);
 for(const kind of ['bad-hash','null','extra'] as const){current=synthetic;const f=fields(kind);assert.equal((await register({...f,termsAcceptance:acceptance()})).statusCode,202);const [row]=await queued(f.email),payload=JSON.parse(decryptSecret(row.payload_ciphertext));if(kind==='null')payload.signupTerms=null;else if(kind==='extra')payload.signupTerms.untrusted='extra';else payload.signupTerms.policy.text+=' changed';await adminPool.query('UPDATE account_registration_requests SET payload_ciphertext=$2 WHERE id=$1',[row.id,encryptSecret(JSON.stringify(payload))]);await processOneAccountRegistration();assert.equal(await user(f.email),undefined);assert.deepEqual(await queued(f.email),[]);}
});

test('a provisioning failure rolls back user, workspace and evidence while preserving the encrypted original request',async()=>{
 process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='true';const f=fields('rollback');assert.equal((await register({...f,termsAcceptance:acceptance()})).statusCode,202);const [request]=await queued(f.email),name='signup_rollback_'+randomUUID().replaceAll('-','');
 await adminPool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND email='${f.email}') THEN RAISE EXCEPTION 'Synthetic signup rollback'; END IF; RETURN NEW; END$$`);await adminPool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON account_security_events FOR EACH ROW EXECUTE FUNCTION ${name}()`);
 try{await assert.rejects(processOneAccountRegistration(),/Synthetic signup rollback/);assert.equal(await user(f.email),undefined);assert.deepEqual(await queued(f.email),[request]);assert.equal((await adminPool.query('SELECT 1 FROM workspaces WHERE name=$1',[f.workspaceName])).rowCount,0);}finally{await adminPool.query(`DROP TRIGGER ${name} ON account_security_events`);await adminPool.query(`DROP FUNCTION ${name}()`);}
 await processOneAccountRegistration();assert.ok(await ownSignupTermsRecord((await user(f.email)).id));
});

test('larger bounded policy envelopes are supported without widening the existing total queue storage budget',async()=>{
 process.env.FOLIO_REQUIRE_EMAIL_VERIFICATION='true';current={...synthetic,text:'SYNTHETIC '+ 'é'.repeat(6000)};const large=fields('large');assert.equal((await register({...large,termsAcceptance:acceptance(current)})).statusCode,202);const [request]=await queued(large.email),bytes=Buffer.byteLength(request.payload_ciphertext);assert.ok(bytes>8192&&bytes<=32768);await processOneAccountRegistration();assert.equal((await ownSignupTermsRecord((await user(large.email)).id))!.policy.text,current.text);
 const fill=fields('cap-fill'),known=large,fresh=fields('overbudget');await adminPool.query("INSERT INTO account_registration_requests(address_key,payload_ciphertext,expires_at) SELECT $1,repeat('x',32768),clock_timestamp()+interval '1 hour' FROM generate_series(1,1250)",[key(fill.email)]);
 const before=(await adminPool.query('SELECT count(*)::int n,sum(octet_length(payload_ciphertext))::bigint bytes FROM account_registration_requests')).rows[0];assert.equal(before.n,1250);assert.equal(Number(before.bytes),5000*8192);
 const limitsBefore=(await adminPool.query('SELECT * FROM account_registration_limits WHERE address_key=ANY($1::text[]) ORDER BY address_key',[[key(known.email),key(fresh.email)]])).rows;
 const restore=forbidAdmissionUserReads();try{for(const f of [known,fresh]){const response=await register({...f,termsAcceptance:acceptance(current)});assert.equal(response.statusCode,503,response.body);assert.equal(response.json().error,'registration_unavailable');}}finally{restore();}
 assert.deepEqual((await adminPool.query('SELECT * FROM account_registration_limits WHERE address_key=ANY($1::text[]) ORDER BY address_key',[[key(known.email),key(fresh.email)]])).rows,limitsBefore);assert.deepEqual((await adminPool.query('SELECT count(*)::int n,sum(octet_length(payload_ciphertext))::bigint bytes FROM account_registration_requests')).rows[0],before);assert.equal(await user(fresh.email),undefined);
 await assert.rejects(adminPool.query("INSERT INTO account_registration_requests(address_key,payload_ciphertext,expires_at) VALUES($1,repeat('x',32769),clock_timestamp()+interval '1 hour')",[key(fill.email)]),(error:any)=>error.code==='23514');
});
