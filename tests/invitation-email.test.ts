import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,closeDatabase,transaction} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken,newToken,hashPassword} from '../server/core/auth.js';
import {createInvitation,resendInvitation,deleteInvitation,inspectInvitation,acceptInvitation,listInvitations,invitationAddressKey,invalidInvitationMessage} from '../server/core/invitations.js';
import {processOneInvitationEmail,cleanupInvitationEmail} from '../server/core/invitation-email.js';
import {processOneWorkspaceEmail} from '../server/core/workspace-email.js';
import {enqueueEmailVerification} from '../server/core/email-verification.js';
import {decryptSecret,encryptSecret} from '../server/integrations/secrets.js';
import {AccountEmailError,setAccountEmailSenderForTests,type AccountEmailMessage} from '../server/integrations/account-email.js';

type Account=Actor&{email:string;cookie:string};
const accounts:Account[]=[],addresses=new Set<string>(),sent:AccountEmailMessage[]=[];
let app:FastifyInstance,verified=false,networkCalls=0;
const originalFetch=globalThis.fetch,originalOrigin=process.env.APP_ORIGIN;
const sender={async send(message:AccountEmailMessage){assert.ok(addresses.has(message.to));sent.push(message);return {providerId:randomUUID()};}};
function address(){const value=`owned-invite-${randomUUID()}@example.test`;addresses.add(value);return value;}
async function fixture():Promise<Account>{
 const email=address(),token=newToken();
 const actor=await transaction(adminPool,async c=>{
  const user=(await c.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id',[email,'Owned invitation test',await hashPassword('Owned invitation test password')])).rows[0];
  const workspace=(await c.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id',['Owned invitation workspace',randomUUID()])).rows[0];
  await c.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace.id,user.id]);
  await c.query("INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[hashToken(token),user.id,workspace.id]);
  return {userId:user.id,workspaceId:workspace.id,role:'owner' as const,authType:'session' as const,email,cookie:`folio_session=${token}`};
 });accounts.push(actor);return actor;
}
const request=(a:Account,method:'GET'|'POST'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method,url,payload:payload as any,headers:{cookie:a.cookie,origin:config.origin,...headers}});
async function issue(a:Account,email=address(),delivery:'email'|'manual'='email',role:'admin'|'editor'|'viewer'='viewer'){return createInvitation(a,{email,role,delivery});}
async function mail(id:string){return (await adminPool.query('SELECT * FROM invitation_email_outbox WHERE invitation_id=$1 ORDER BY created_at DESC,id DESC',[id])).rows[0];}
function tokenFrom(row:any){const text=JSON.parse(decryptSecret(row.payload_ciphertext)).text;return new URLSearchParams(new URL(text.match(/https?:\/\/[^\s]+/)![0]).hash.slice(1)).get('token')!;}
async function cooldown(email:string){await adminPool.query("UPDATE invitation_email_limits SET cooldown_until=clock_timestamp()-interval '1 second' WHERE address_key=$1",[invitationAddressKey(email)]);}
async function clearOwned(){
 for(const a of accounts)await adminPool.query('DELETE FROM workspaces WHERE id=$1',[a.workspaceId]);
 for(const a of accounts)await adminPool.query('DELETE FROM users WHERE id=$1',[a.userId]);
 await adminPool.query('DELETE FROM invitation_email_limits WHERE address_key=ANY($1::text[])',[[...addresses].map(invitationAddressKey)]);
 accounts.length=0;sent.length=0;
}
before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const urlMode=Boolean(pool.options.connectionString);
  if(urlMode){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');const url=new URL(pool.options.connectionString!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("SELECT current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,urlMode?5432:55432);if(!urlMode)assert.equal(row.address,null);
 }
 for(const table of ['account_registration_requests','account_recovery_requests','email_verification_requests'])assert.equal((await adminPool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,0);
 for(const table of ['account_email_outbox','invitation_email_outbox'])assert.equal((await adminPool.query(`SELECT count(*)::int n FROM ${table} WHERE state IN ('pending','sending')`)).rows[0].n,0);
 verified=true;globalThis.fetch=async()=>{networkCalls++;throw new Error('External network forbidden in owned invitation tests');};setAccountEmailSenderForTests(sender);app=await buildApp();
});
afterEach(async()=>{setAccountEmailSenderForTests(sender);process.env.APP_ORIGIN=originalOrigin;if(verified)await clearOwned();assert.equal(networkCalls,0);});
after(async()=>{if(verified)await clearOwned();setAccountEmailSenderForTests(undefined);globalThis.fetch=originalFetch;await app?.close();await closeDatabase();});

test('manual default stays available during mail outage, uses trusted fragment link and creates no recipient account',async()=>{
 const a=await fixture(),email=address(),before=(await adminPool.query('SELECT count(*)::int n FROM users')).rows[0].n;setAccountEmailSenderForTests(null);
 const response=await request(a,'POST','/api/workspace/members',{email,role:'viewer'});assert.equal(response.statusCode,200,response.body);
 const result=response.json();assert.equal(result.delivery,'manual');assert.equal(result.invitation.emailStatus,null);assert.equal(result.invitation.delivery,'manual');assert.equal(result.inviteUrl,`${config.origin}/invite#token=${result.token}`);assert.equal(new URL(result.inviteUrl).search,'');
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM users')).rows[0].n,before);assert.equal((await adminPool.query('SELECT 1 FROM invitation_email_outbox WHERE invitation_id=$1',[result.invitation.id])).rowCount,0);
 const failed=await request(a,'POST','/api/workspace/members',{email:address(),role:'viewer',delivery:'email'});assert.equal(failed.statusCode,503);assert.equal((await listInvitations(a)).length,1);
 process.env.APP_ORIGIN='https://trusted.example.test/path';assert.equal((await request(a,'POST','/api/workspace/members',{email:address(),role:'viewer'})).statusCode,503);assert.equal((await listInvitations(a)).length,1);
});

test('email admission is encrypted and atomic, returns no token, and reports provider acceptance without claiming inbox delivery',async()=>{
 const a=await fixture(),email=address(),result=await issue(a,email);assert.equal(result.delivery,'email');assert.equal(result.message,'Invitation email queued.');assert.equal('token' in result,false);assert.equal('inviteUrl' in result,false);assert.equal(result.invitation.emailStatus,'pending');assert.ok(result.invitation.retryAt);
 const row=await mail(result.invitation.id),token=tokenFrom(row);assert.equal(row.token_hash,hashToken(token));assert.equal(JSON.stringify(row).includes(email),false);assert.equal(JSON.stringify(row).includes(token),false);assert.equal((await adminPool.query('SELECT 1 FROM users WHERE email=$1',[email])).rowCount,0);
 assert.equal(await processOneInvitationEmail(),true);assert.equal(sent.length,1);assert.equal(sent[0].subject,'Join your MaintainFlow workspace');assert.equal(sent[0].idempotencyKey,`folio-account-email/${row.id}`);
 assert.equal((await mail(result.invitation.id)).state,'accepted');assert.equal((await mail(result.invitation.id)).payload_ciphertext,null);assert.equal((await listInvitations(a))[0].emailStatus,'accepted');
 const listing=await request(a,'GET','/api/workspace/members');assert.equal(listing.json().invitationEmail.available,true);assert.equal(listing.body.includes(token),false);
});

test('browser session, tenant, current role and cross-origin checks protect create, resend, inspect and accept',async()=>{
 const a=await fixture(),b=await fixture(),member=await fixture();await adminPool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[a.workspaceId,member.userId]);
 const admin={...member,workspaceId:a.workspaceId,role:'admin' as const};
 await assert.rejects(issue(admin,address(),'email','admin'),{statusCode:403});const created=await issue(admin,b.email);
 await adminPool.query("UPDATE memberships SET role='viewer' WHERE workspace_id=$1 AND user_id=$2",[a.workspaceId,member.userId]);
 await assert.rejects(issue(admin),{statusCode:403});await assert.rejects(resendInvitation(admin,created.invitation.id),{statusCode:403});
 assert.equal((await request(b,'POST',`/api/workspace/invitations/${created.invitation.id}/resend`,{})).statusCode,404);
 const key=newToken();await adminPool.query("INSERT INTO api_keys(workspace_id,user_id,name,prefix,token_hash,scopes) VALUES($1,$2,'Owned invitation API','fl_test',$3,'[]')",[a.workspaceId,a.userId,hashToken(`fl_${key}`)]);
 assert.equal((await app.inject({method:'POST',url:'/api/workspace/members',headers:{authorization:`Bearer fl_${key}`},payload:{email:address(),role:'viewer'}})).statusCode,403);
 for(const headers of [{origin:'https://unrelated.example.test'},{'sec-fetch-site':'cross-site'}] as Record<string,string>[])assert.equal((await request(a,'POST','/api/workspace/members',{email:address(),role:'viewer'},headers)).statusCode,403);
 const token=tokenFrom(await mail(created.invitation.id));assert.equal((await app.inject({method:'POST',url:'/api/workspace/invitations/inspect',payload:{token}})).statusCode,401);
 // A lost issuer role invalidates the link and the queued email, even if the recipient has a session.
 await assert.rejects(inspectInvitation(b,token),{statusCode:400,message:invalidInvitationMessage});assert.equal(await processOneInvitationEmail(),false);assert.equal((await mail(created.invitation.id)).state,'cancelled');assert.equal(sent.length,0);
});

test('inspect exposes details only to the intended authenticated address and acceptance preserves an existing role',async()=>{
 const a=await fixture(),b=await fixture(),wrong=await fixture(),result=await issue(a,b.email,'manual','admin');const token=result.token!;
 const rejected=await request(wrong,'POST','/api/workspace/invitations/inspect',{token});assert.equal(rejected.statusCode,403);assert.equal(rejected.body.includes(a.workspaceId),false);
 const info=await inspectInvitation(b,token);assert.deepEqual(info,{workspaceId:a.workspaceId,workspaceName:'Owned invitation workspace',role:'admin',expiresAt:new Date(result.invitation.expiresAt),alreadyMember:false});
 await adminPool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[a.workspaceId,b.userId]);assert.equal((await inspectInvitation(b,token)).role,'viewer');assert.equal((await inspectInvitation(b,token)).alreadyMember,true);
 assert.deepEqual(await acceptInvitation(b,token),{workspaceId:a.workspaceId,role:'viewer'});await assert.rejects(acceptInvitation(b,token),{statusCode:400});await assert.rejects(inspectInvitation(b,token),{statusCode:400});
 await deleteInvitation(a,result.invitation.id);assert.equal((await adminPool.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2',[a.workspaceId,b.userId])).rows[0].role,'viewer');
 const events=(await adminPool.query("SELECT action,metadata FROM audit_events WHERE workspace_id=$1 AND entity_id=$2 ORDER BY created_at",[a.workspaceId,result.invitation.id])).rows;assert.ok(events.some(e=>e.action==='member.invitation_deleted'));assert.equal(events.some(e=>e.action==='member.invitation_revoked'),false);assert.equal(JSON.stringify(events).includes(token),false);assert.equal(JSON.stringify(events).includes(b.email),false);
});

test('resend converts manual invitations, enforces recipient limits and invalidates each earlier token atomically',async()=>{
 const a=await fixture(),b=await fixture(),created=await issue(a,b.email,'manual');const old=created.token!;
 let result=await resendInvitation(a,created.invitation.id);assert.equal(result.delivery,'email');assert.equal('token' in result,false);assert.equal(result.invitation.emailStatus,'pending');await assert.rejects(inspectInvitation(b,old),{statusCode:400});
 const firstMail=await mail(created.invitation.id),first=tokenFrom(firstMail);await assert.rejects(resendInvitation(a,created.invitation.id),{statusCode:429});assert.equal((await mail(created.invitation.id)).id,firstMail.id);
 await cooldown(b.email);result=await resendInvitation(a,created.invitation.id);await assert.rejects(inspectInvitation(b,first),{statusCode:400});assert.equal((await adminPool.query('SELECT state,payload_ciphertext FROM invitation_email_outbox WHERE id=$1',[firstMail.id])).rows[0].state,'cancelled');assert.equal((await adminPool.query('SELECT payload_ciphertext FROM invitation_email_outbox WHERE id=$1',[firstMail.id])).rows[0].payload_ciphertext,null);
 for(let n=0;n<3;n++){await cooldown(b.email);await resendInvitation(a,created.invitation.id);}await cooldown(b.email);await assert.rejects(resendInvitation(a,created.invitation.id),{statusCode:429});assert.equal((await adminPool.query('SELECT grants FROM invitation_email_limits WHERE address_key=$1',[invitationAddressKey(b.email)])).rows[0].grants,5);
 await acceptInvitation(b,tokenFrom(await mail(created.invitation.id)));assert.equal((await mail(created.invitation.id)).state,'cancelled');await assert.rejects(resendInvitation(a,created.invitation.id),{statusCode:400});
});

test('recipient grants, invitation and mail all roll back on an audit failure',async()=>{
 const a=await fixture(),email=address(),connect=adminPool.connect.bind(adminPool);let rejected=0;
 (adminPool as any).connect=async()=>{const c=await connect(),query=c.query.bind(c);return new Proxy(c,{get(target,p){if(p==='query')return (sql:any,...args:any[])=>{if(typeof sql==='string'&&sql.startsWith('insert into audit_events')){rejected++;throw new Error('Owned invitation audit failure');}return (query as any)(sql,...args);};const value=Reflect.get(target,p,target);return typeof value==='function'?value.bind(target):value;}});};
 try{await assert.rejects(issue(a,email),/Owned invitation audit failure/);}finally{(adminPool as any).connect=connect;}
 assert.equal(rejected,1);assert.equal((await listInvitations(a)).length,0);assert.equal((await adminPool.query('SELECT 1 FROM invitation_email_limits WHERE address_key=$1',[invitationAddressKey(email)])).rowCount,0);assert.equal((await adminPool.query('SELECT 1 FROM invitation_email_outbox WHERE workspace_id=$1',[a.workspaceId])).rowCount,0);
});

test('pending cap counts active invitations, global mail cap is serialized and failed admission has no recipient grant',async()=>{
 const a=await fixture();await adminPool.query("INSERT INTO invitations(workspace_id,email,role,token_hash,expires_at,issuer_id) SELECT $1,'owned-cap-'||n||'@example.test','viewer',encode(digest(random()::text||n::text,'sha256'),'hex'),clock_timestamp()+interval '7 days',$2 FROM generate_series(1,100) n",[a.workspaceId,a.userId]);
 await assert.rejects(issue(a,address(),'manual'),{statusCode:429});await adminPool.query('UPDATE invitations SET expires_at=clock_timestamp() WHERE workspace_id=$1',[a.workspaceId]);const created=await issue(a,address(),'manual');
 const envelope=encryptSecret(JSON.stringify({to:address(),subject:'Join your MaintainFlow workspace',text:'Owned cap fixture'}));await adminPool.query("INSERT INTO invitation_email_outbox(invitation_id,workspace_id,token_hash,payload_ciphertext,expires_at) SELECT $1,$2,$3,$4,clock_timestamp()+interval '7 days' FROM generate_series(1,5000)",[created.invitation.id,a.workspaceId,hashToken(created.token!),envelope]);
 const email=address();await assert.rejects(issue(a,email),{statusCode:503});assert.equal((await adminPool.query('SELECT 1 FROM invitation_email_limits WHERE address_key=$1',[invitationAddressKey(email)])).rowCount,0);assert.equal((await adminPool.query('SELECT count(*)::int n FROM invitation_email_outbox WHERE workspace_id=$1',[a.workspaceId])).rows[0].n,5000);
});

test('database constraints bind invitation mail to its tenant and keep all queue/limit data backend-only',async()=>{
 const a=await fixture(),b=await fixture(),created=await issue(a),row=await mail(created.invitation.id);
 await assert.rejects(adminPool.query('UPDATE invitation_email_outbox SET workspace_id=$2 WHERE id=$1',[row.id,b.workspaceId]),/foreign key constraint/);
 await assert.rejects(adminPool.query("UPDATE invitation_email_outbox SET state='accepted' WHERE id=$1",[row.id]),/check constraint/);
 await assert.rejects(adminPool.query('UPDATE invitation_email_outbox SET attempts=6 WHERE id=$1',[row.id]),/check constraint/);
 for(const table of ['invitation_email_outbox','invitation_email_limits']){
  await assert.rejects(appPool.query(`SELECT * FROM ${table}`),/permission denied/);
  const rule=(await adminPool.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',[table])).rows[0];assert.deepEqual(rule,{relrowsecurity:true,relforcerowsecurity:true});
 }
});

test('expiry is rechecked after an actual workspace lock wait and rollback prevents membership creation',async()=>{
 const a=await fixture(),b=await fixture(),created=await issue(a,b.email,'manual'),c=await adminPool.connect();
 await c.query('BEGIN');await c.query('SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[a.workspaceId]);
 const result=acceptInvitation(b,created.token!).then(()=>null,error=>error);
 try{await delay(80);await c.query('UPDATE invitations SET expires_at=clock_timestamp() WHERE id=$1',[created.invitation.id]);await c.query('COMMIT');}finally{await c.query('ROLLBACK');c.release();}
 const error=await result;assert.equal(error?.statusCode,400);assert.equal(error?.message,invalidInvitationMessage);assert.equal((await adminPool.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2',[a.workspaceId,b.userId])).rowCount,0);
});

test('retries retain a stable idempotency key, scrub terminal payloads, and sanitize unknown errors',async()=>{
 const a=await fixture(),created=await issue(a),row=await mail(created.invitation.id);let calls=0;const keys:string[]=[];
 setAccountEmailSenderForTests({async send(message){keys.push(message.idempotencyKey);calls++;if(calls===1)throw new Error('PRIVATE failure recipient and token');return {providerId:randomUUID()};}});
 assert.equal(await processOneInvitationEmail(),true);let current=await mail(created.invitation.id);assert.equal(current.state,'pending');assert.equal(current.failure_code,'temporary_failure');assert.equal(current.attempts,1);assert.equal(JSON.stringify(current).includes('PRIVATE'),false);assert.equal(await processOneInvitationEmail(),false);
 await adminPool.query('UPDATE invitation_email_outbox SET available_at=clock_timestamp() WHERE id=$1',[row.id]);assert.equal(await processOneInvitationEmail(),true);assert.equal((await mail(created.invitation.id)).state,'accepted');assert.equal((await mail(created.invitation.id)).payload_ciphertext,null);assert.equal(keys[0],keys[1]);
 const failed=await issue(a);setAccountEmailSenderForTests({async send(){throw new AccountEmailError('permanent_failure',false);}});await processOneInvitationEmail();assert.equal((await mail(failed.invitation.id)).state,'failed');assert.equal((await mail(failed.invitation.id)).payload_ciphertext,null);
 const exhausted=await issue(a);await adminPool.query('UPDATE invitation_email_outbox SET attempts=5 WHERE invitation_id=$1',[exhausted.invitation.id]);assert.equal(await processOneInvitationEmail(),false);assert.equal((await mail(exhausted.invitation.id)).failure_code,'attempt_limit');
});

test('legacy encrypted invitation mail keeps its original message and retry identity',async()=>{
 const a=await fixture(),created=await issue(a),row=await mail(created.invitation.id),calls:AccountEmailMessage[]=[];
 const payload=JSON.parse(decryptSecret(row.payload_ciphertext));assert.equal(payload.subject,'Join your MaintainFlow workspace');assert.match(payload.text,/on MaintainFlow as/);
 payload.subject='Join your Folio workspace';payload.text=payload.text.replace('on MaintainFlow as','on Folio as');
 const ciphertext=encryptSecret(JSON.stringify(payload));await adminPool.query('UPDATE invitation_email_outbox SET payload_ciphertext=$2 WHERE id=$1',[row.id,ciphertext]);
 setAccountEmailSenderForTests({async send(message){calls.push(message);if(calls.length===1)throw new AccountEmailError('temporary_failure',true);return {providerId:randomUUID()};}});
 assert.equal(await processOneInvitationEmail(),true);assert.equal((await mail(created.invitation.id)).state,'pending');assert.equal((await mail(created.invitation.id)).payload_ciphertext,ciphertext);
 await adminPool.query('UPDATE invitation_email_outbox SET available_at=clock_timestamp() WHERE id=$1',[row.id]);assert.equal(await processOneInvitationEmail(),true);
 const expected={...payload,idempotencyKey:`folio-account-email/${row.id}`};assert.deepEqual(calls,[expected,expected]);
 const accepted=await mail(created.invitation.id);assert.equal(accepted.state,'accepted');assert.equal(accepted.attempts,2);assert.equal(accepted.payload_ciphertext,null);
});

test('lease recovery keeps idempotency and late old acknowledgements cannot overwrite a later accepted attempt',async()=>{
 const a=await fixture(),created=await issue(a),row=await mail(created.invitation.id);let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let calls=0;const keys:string[]=[];
 setAccountEmailSenderForTests({async send(message){keys.push(message.idempotencyKey);if(++calls===1){entered();await gate;throw new AccountEmailError('permanent_failure',false);}return {providerId:randomUUID()};}});
 const first=processOneInvitationEmail();await began;assert.equal(await processOneInvitationEmail(),false);await adminPool.query("UPDATE invitation_email_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[row.id]);assert.equal(await processOneInvitationEmail(),true);release();assert.equal(await first,true);assert.equal((await mail(created.invitation.id)).state,'accepted');assert.equal((await mail(created.invitation.id)).attempts,2);assert.equal(keys[0],keys[1]);
});

test('revocation, acceptance and resend during a provider request fence late acknowledgements and stale links',async()=>{
 const a=await fixture(),b=await fixture();
 for(const action of ['revoke','accept','resend'] as const){
  await cooldown(b.email);const created=await issue(a,b.email),old=await mail(created.invitation.id),token=tokenFrom(old);let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  setAccountEmailSenderForTests({async send(){entered();await gate;return {providerId:randomUUID()};}});const pending=processOneInvitationEmail();await began;
  if(action==='revoke')await deleteInvitation(a,created.invitation.id);
  if(action==='accept')await acceptInvitation(b,token);
  if(action==='resend'){await cooldown(b.email);await resendInvitation(a,created.invitation.id);}
  release();assert.equal(await pending,true);const previous=(await adminPool.query('SELECT state,payload_ciphertext FROM invitation_email_outbox WHERE id=$1',[old.id])).rows[0];if(action==='revoke')assert.equal(previous,undefined);else assert.deepEqual(previous,{state:'cancelled',payload_ciphertext:null});
  await assert.rejects(inspectInvitation(b,token),{statusCode:400});
  if(action==='resend')await deleteInvitation(a,created.invitation.id);
 }
});

test('cancelled work respects abort and expiry cleanup runs with sending disabled',async()=>{
 const a=await fixture(),created=await issue(a);let entered!:()=>void;const began=new Promise<void>(r=>entered=r);setAccountEmailSenderForTests({async send(){entered();return new Promise(()=>{});}});
 const controller=new AbortController(),pending=processOneInvitationEmail({signal:controller.signal});await began;controller.abort();assert.equal(await pending,true);assert.equal((await mail(created.invitation.id)).state,'pending');assert.equal((await mail(created.invitation.id)).failure_code,'cancelled');
 await adminPool.query('UPDATE invitation_email_outbox SET expires_at=clock_timestamp() WHERE invitation_id=$1',[created.invitation.id]);setAccountEmailSenderForTests(null);await cleanupInvitationEmail();assert.equal((await mail(created.invitation.id)).state,'cancelled');assert.equal((await mail(created.invitation.id)).payload_ciphertext,null);await assert.rejects(processOneInvitationEmail({signal:AbortSignal.abort()}),/Worker time budget reached/);
});

test('account and invitation mail alternate under load and one broken lane cannot starve the other',async()=>{
 const a=await fixture(),b=await fixture();await issue(a,b.email);await transaction(adminPool,async c=>{const user=(await c.query('SELECT id,email,password_hash,email_verified_at FROM users WHERE id=$1 FOR UPDATE',[a.userId])).rows[0];await enqueueEmailVerification(c,user,new Date(Date.now()+86400000));});
 assert.equal(await processOneWorkspaceEmail(),true);assert.equal(await processOneWorkspaceEmail(),true);assert.deepEqual(new Set(sent.map(m=>m.subject)),new Set(['Join your MaintainFlow workspace','Verify your MaintainFlow email']));
 await cooldown(b.email);await issue(a,b.email);const query=adminPool.query.bind(adminPool);let failures=0;
 (adminPool as any).query=(sql:any,...args:any[])=>{if(typeof sql==='string'&&sql.includes('FROM account_email_outbox')){failures++;throw new Error('PRIVATE account lane failure');}return (query as any)(sql,...args);};
 try{assert.equal(await processOneWorkspaceEmail(),true);await assert.rejects(processOneWorkspaceEmail(),{message:'Workspace email processing failed.'});}finally{(adminPool as any).query=query;}
 assert.ok(failures>0);assert.equal(sent.filter(m=>m.subject==='Join your MaintainFlow workspace').length,2);
});

test('legacy manual issuer-null invitations remain valid and active invitations stay visible amid accepted history',async()=>{
 const a=await fixture(),b=await fixture(),created=await issue(a,b.email,'manual');await adminPool.query('UPDATE invitations SET issuer_id=NULL WHERE id=$1',[created.invitation.id]);assert.equal((await inspectInvitation(b,created.token!)).workspaceId,a.workspaceId);
 await adminPool.query("INSERT INTO invitations(workspace_id,email,role,token_hash,expires_at,accepted_at) SELECT $1,'owned-history-'||n||'@example.test','viewer',encode(digest(random()::text||n::text,'sha256'),'hex'),clock_timestamp()+interval '7 days',clock_timestamp() FROM generate_series(1,205) n",[a.workspaceId]);
 assert.ok((await listInvitations(a)).some(i=>i.id===created.invitation.id));await acceptInvitation(b,created.token!);
});
