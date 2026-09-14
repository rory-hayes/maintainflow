import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {adminPool,transaction,badRequest} from './db.js';
import {hashPassword,hashToken,newToken,verifyPassword} from './auth.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../integrations/secrets.js';
import {accountEmailStatus,trustedAccountOrigin} from '../integrations/account-email.js';

export const recoveryAccepted = Object.freeze({accepted:true,message:'If an account uses this email, a password reset link will be sent shortly.'});
export const invalidResetMessage = 'This password reset link is invalid or has expired. Request a new link.';
export class AccountRecoveryUnavailableError extends Error {
 constructor(){super('Password recovery is temporarily unavailable. Try again later.');this.name='AccountRecoveryUnavailableError';}
}
const invalidReset=():never=>badRequest(invalidResetMessage,400);

async function grantAddress(c:PoolClient,email:string){
 const key=privateIdentifier('folio:account-recovery:address:v1',email);
 // DO NOTHING does not lock its conflicting tuple. Expired-row cleanup may
 // remove it before SELECT FOR UPDATE; one retry inserts a fresh window.
 // The caller's global request lock serializes issuers, and cleanup cannot
 // remove the newly inserted, unexpired row.
 for(let attempt=0;attempt<2;attempt++){
  const inserted=await c.query(`INSERT INTO account_recovery_limits(address_key,window_started_at,grants,cooldown_until,expires_at)
   VALUES($1,clock_timestamp(),1,clock_timestamp()+interval '60 seconds',clock_timestamp()+interval '1 hour') ON CONFLICT DO NOTHING RETURNING address_key`,[key]);
  if(inserted.rowCount)return true;
  const {rows:[limit]}=await c.query('SELECT * FROM account_recovery_limits WHERE address_key=$1 FOR UPDATE',[key]);
  if(!limit)continue;
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(new Date(limit.expires_at)<=clock.at){
   await c.query(`UPDATE account_recovery_limits SET window_started_at=$2,grants=1,cooldown_until=$2::timestamptz+interval '60 seconds',expires_at=$2::timestamptz+interval '1 hour' WHERE address_key=$1`,[key,clock.at]);return true;
  }
  if(new Date(limit.cooldown_until)>clock.at||limit.grants>=5)return false;
  await c.query("UPDATE account_recovery_limits SET grants=grants+1,cooldown_until=$2::timestamptz+interval '60 seconds' WHERE address_key=$1",[key,clock.at]);return true;
 }
 throw new AccountRecoveryUnavailableError();
}

/** The user row must already be locked. No provider call takes place here. */
export async function enqueuePasswordChanged(c:PoolClient,user:{id:string;email:string}){
 const id=randomUUID();
 const payload=encryptSecret(JSON.stringify({to:user.email,subject:'Your Folio password was changed',text:'Your Folio password was changed. Browser sessions were signed out, except the current session when you changed it in Settings. API keys are separate credentials and remain separately revocable in Settings. If you did not make this change, use Forgot password on the Folio sign-in page.'}));
 await c.query(`INSERT INTO account_email_outbox(id,user_id,kind,payload_ciphertext,expires_at) VALUES($1,$2,'password_changed',$3,clock_timestamp()+interval '24 hours')`,[id,user.id,payload]);
}

/** Revocation and ciphertext removal happen atomically with the credential change. */
async function invalidateRecovery(c:PoolClient,userId:string){
 await c.query(`UPDATE account_email_outbox SET state='cancelled',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,
  failure_code='invalid_token',finished_at=clock_timestamp() WHERE user_id=$1 AND kind='password_reset' AND state IN ('pending','sending')`,[userId]);
 return (await c.query('DELETE FROM account_recovery_tokens WHERE user_id=$1',[userId])).rowCount??0;
}

export async function requestPasswordReset(email:string){
 if(!accountEmailStatus().available||!trustedAccountOrigin())throw new AccountRecoveryUnavailableError();
 await transaction(adminPool,async c=>{
  // All valid addresses take the same path. No account existence lookup occurs
  // in this request transaction, even when the bounded queue is full (a uniform service error).
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('folio:account-recovery:request-cap',0))");
  await c.query(`DELETE FROM account_recovery_requests WHERE id IN (SELECT id FROM account_recovery_requests WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
  const {rows:[count]}=await c.query('SELECT count(*)::int n FROM account_recovery_requests');
  if(count.n>=5000)throw new AccountRecoveryUnavailableError();
  if(!await grantAddress(c,email))return;
  await c.query(`INSERT INTO account_recovery_requests(address_key,payload_ciphertext,expires_at)
   VALUES($1,$2,clock_timestamp()+interval '30 minutes')`,[privateIdentifier('folio:account-recovery:address:v1',email),encryptSecret(JSON.stringify({email}))]);
 });
 return recoveryAccepted;
}

/** Account resolution happens asynchronously in one DB transaction, never in the public request. */
export async function processOneAccountRecoveryRequest(){
 const origin=trustedAccountOrigin();if(!origin||!accountEmailStatus().available)return false;
 return transaction(adminPool,async c=>{
  const {rows:[request]}=await c.query('SELECT * FROM account_recovery_requests ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED');
  if(!request)return false;
  const discard=()=>c.query('DELETE FROM account_recovery_requests WHERE id=$1',[request.id]);
  let payload:unknown;
  try{payload=JSON.parse(decryptSecret(request.payload_ciphertext));}catch{await discard();return true;}
  const parsed=z.object({email:z.string().max(254).email()}).strict().safeParse(payload);
  if(!parsed.success||privateIdentifier('folio:account-recovery:address:v1',parsed.data.email)!==request.address_key){await discard();return true;}
  const {rows:[user]}=await c.query('SELECT id,email,password_hash,password_changed_at FROM users WHERE email=$1 FOR UPDATE',[parsed.data.email]);
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(!user||request.expires_at<=clock.at||user.password_changed_at&&request.created_at<=user.password_changed_at){await discard();return true;}
  const token=newToken(),tokenId=randomUUID(),outboxId=randomUUID();
  await c.query(`INSERT INTO account_recovery_tokens(id,user_id,token_hash,credential_digest,expires_at)
   VALUES($1,$2,$3,$4,$5)`,[tokenId,user.id,hashToken(token),hashToken(user.password_hash),request.expires_at]);
  const link=new URL('/reset-password',origin);link.hash=`token=${token}`;
  const encrypted=encryptSecret(JSON.stringify({to:user.email,subject:'Reset your Folio password',text:`A password reset was requested for your Folio account. Open this link within 30 minutes of your request to choose a new password:\n\n${link.href}\n\nIf you did not request this, you can ignore this email. Your password has not changed.`}));
  await c.query(`INSERT INTO account_email_outbox(id,user_id,token_id,kind,payload_ciphertext,expires_at)
   VALUES($1,$2,$3,'password_reset',$4,$5)`,[outboxId,user.id,tokenId,encrypted,request.expires_at]);
  await c.query("INSERT INTO account_security_events(user_id,action) VALUES($1,'password_reset_requested')",[user.id]);
  await discard();return true;
 });
}

export async function completePasswordReset(token:string,newPassword:string){
 if(!/^[A-Za-z0-9_-]{43}$/.test(token))invalidReset();
 const tokenHash=hashToken(token);
 // Resolve the lock owner without locking the token first.
 const {rows:[candidate]}=await adminPool.query("SELECT user_id FROM account_recovery_tokens WHERE token_hash=$1 AND purpose='password_reset'",[tokenHash]);
 if(!candidate)invalidReset();
 const passwordHash=await hashPassword(newPassword);
 await transaction(adminPool,async c=>{
  const {rows:[user]}=await c.query('SELECT id,email,password_hash FROM users WHERE id=$1 FOR UPDATE',[candidate.user_id]);
  if(!user)invalidReset();
  const {rows:[record]}=await c.query("SELECT * FROM account_recovery_tokens WHERE token_hash=$1 AND user_id=$2 AND purpose='password_reset' FOR UPDATE",[tokenHash,user.id]);
  // clock_timestamp is read after both locks, so waiting never extends a token.
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(!record||record.expires_at<=clock.at||record.credential_digest!==hashToken(user.password_hash))invalidReset();
  await c.query('UPDATE users SET password_hash=$1,password_changed_at=clock_timestamp() WHERE id=$2',[passwordHash,user.id]);
  const sessions=(await c.query('DELETE FROM sessions WHERE user_id=$1',[user.id])).rowCount??0;
  const tokens=await invalidateRecovery(c,user.id);
  await enqueuePasswordChanged(c,user);
  await c.query(`INSERT INTO account_security_events(user_id,action,sessions_revoked,tokens_invalidated) VALUES($1,'password_reset_completed',$2,$3)`,[user.id,sessions,tokens]);
 });
 return {ok:true};
}

export async function changeAccountPassword(userId:string,sessionToken:string,currentPassword:string,newPassword:string){
 const {rows:[verified]}=await adminPool.query('SELECT password_hash FROM users WHERE id=$1',[userId]);
 if(!verified||!await verifyPassword(currentPassword,verified.password_hash))badRequest('Current password is incorrect',400);
 const passwordHash=await hashPassword(newPassword),sessionHash=hashToken(sessionToken);
 await transaction(adminPool,async c=>{
  const {rows:[user]}=await c.query('SELECT id,email,password_hash FROM users WHERE id=$1 FOR UPDATE',[userId]);
  const active=(await c.query('SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp()',[userId,sessionHash])).rowCount;
  if(!user||!active)badRequest('Your session has expired. Sign in again.',401);
  if(user.password_hash!==verified.password_hash)badRequest('Current password is incorrect',400);
  await c.query('UPDATE users SET password_hash=$1,password_changed_at=clock_timestamp() WHERE id=$2',[passwordHash,userId]);
  const sessions=(await c.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2',[userId,sessionHash])).rowCount??0;
  const tokens=await invalidateRecovery(c,userId);
  await enqueuePasswordChanged(c,user);
  await c.query(`INSERT INTO account_security_events(user_id,action,sessions_revoked,tokens_invalidated) VALUES($1,'password_changed',$2,$3)`,[userId,sessions,tokens]);
 });
 return {ok:true};
}
