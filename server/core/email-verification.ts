import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {adminPool,transaction,badRequest} from './db.js';
import {hashToken,newToken,verifyPassword} from './auth.js';
import {invalidateRecovery} from './account-recovery.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../integrations/secrets.js';
import {accountEmailStatus,trustedAccountOrigin} from '../integrations/account-email.js';
import {requireWorkBudget,type WorkBudget} from './work-budget.js';

export const verificationAccepted=Object.freeze({accepted:true,message:'If this email belongs to an account awaiting verification, a verification link will be sent shortly.'});
export const invalidVerificationMessage='We could not verify your email. Check your password, or request a new verification link.';
export class EmailVerificationUnavailableError extends Error {
 constructor(){super('Email verification is temporarily unavailable. Try again later.');this.name='EmailVerificationUnavailableError';}
}
export function emailVerificationRequired(environment:NodeJS.ProcessEnv=process.env){
 const setting=environment.FOLIO_REQUIRE_EMAIL_VERIFICATION;
 if(setting!==undefined&&setting!=='true'&&setting!=='false')throw new Error('FOLIO_REQUIRE_EMAIL_VERIFICATION must be true or false.');
 return setting===undefined?environment.NODE_ENV==='production':setting==='true';
}
// Reject malformed policy at startup, as well as on subsequent status reads.
emailVerificationRequired();
export function emailVerificationStatus(){return {available:accountEmailStatus().available,requiredForSignup:emailVerificationRequired()};}
const invalidVerification=():never=>badRequest(invalidVerificationMessage,400);
const addressKey=(email:string)=>privateIdentifier('folio:email-verification:address:v1',email);
const emailDigest=(email:string)=>privateIdentifier('folio:email-verification:email:v1',email);
type VerificationUser={id:string;email:string;password_hash:string};

async function grantAddress(c:PoolClient,email:string){
 const key=addressKey(email);
 // Expired-limit cleanup may remove a DO NOTHING conflict before its row lock.
 // The admission advisory lock serializes issuers; one fresh insert is sufficient.
 for(let attempt=0;attempt<2;attempt++){
  const inserted=await c.query(`INSERT INTO email_verification_limits(address_key,window_started_at,grants,cooldown_until,expires_at)
   VALUES($1,clock_timestamp(),1,clock_timestamp()+interval '60 seconds',clock_timestamp()+interval '1 hour') ON CONFLICT DO NOTHING RETURNING address_key`,[key]);
  if(inserted.rowCount)return true;
  const {rows:[limit]}=await c.query('SELECT * FROM email_verification_limits WHERE address_key=$1 FOR UPDATE',[key]);
  if(!limit)continue;
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(limit.expires_at<=clock.at){
   await c.query(`UPDATE email_verification_limits SET window_started_at=$2,grants=1,cooldown_until=$2::timestamptz+interval '60 seconds',expires_at=$2::timestamptz+interval '1 hour' WHERE address_key=$1`,[key,clock.at]);return true;
  }
  if(limit.cooldown_until>clock.at||limit.grants>=5)return false;
  await c.query("UPDATE email_verification_limits SET grants=grants+1,cooldown_until=$2::timestamptz+interval '60 seconds' WHERE address_key=$1",[key,clock.at]);return true;
 }
 throw new EmailVerificationUnavailableError();
}

export async function requestEmailVerification(email:string){
 if(!emailVerificationStatus().available||!trustedAccountOrigin())throw new EmailVerificationUnavailableError();
 await transaction(adminPool,async c=>{
  // Public admission never queries account existence. Global capacity failure is
  // identical for every address and does not consume an address grant.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('folio:email-verification:request-cap',0))");
  await c.query('DELETE FROM email_verification_requests WHERE id IN (SELECT id FROM email_verification_requests WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)');
  const {rows:[count]}=await c.query('SELECT count(*)::int n FROM email_verification_requests');
  if(count.n>=5000)throw new EmailVerificationUnavailableError();
  if(!await grantAddress(c,email))return;
  await c.query(`INSERT INTO email_verification_requests(address_key,payload_ciphertext,expires_at) VALUES($1,$2,clock_timestamp()+interval '24 hours')`,[addressKey(email),encryptSecret(JSON.stringify({email}))]);
 });
 return verificationAccepted;
}

/** Caller holds the user lock (or inserted the user in this same transaction). */
export async function enqueueEmailVerification(c:PoolClient,user:VerificationUser,expiresAt:Date):Promise<void>{
 const origin=trustedAccountOrigin();if(!origin)throw new EmailVerificationUnavailableError();
 const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
 if(!Number.isFinite(expiresAt.getTime())||expiresAt<=clock.at)return;
 const token=newToken(),tokenId=randomUUID(),outboxId=randomUUID();
 const link=new URL('/verify-email/confirm',origin);link.hash=`token=${token}`;
 const payload=encryptSecret(JSON.stringify({to:user.email,subject:'Verify your MaintainFlow email',text:`Confirm your email address for MaintainFlow by opening this link and entering your current MaintainFlow password within 24 hours of your request:\n\n${link.href}\n\nIf you did not register or request verification, ignore this email. Opening the link alone will not verify the account.`}));
 await c.query(`INSERT INTO email_verification_tokens(id,user_id,token_hash,credential_digest,email_digest,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[tokenId,user.id,hashToken(token),hashToken(user.password_hash),emailDigest(user.email),clock.at,expiresAt]);
 await c.query(`INSERT INTO account_email_outbox(id,user_id,verification_token_id,kind,payload_ciphertext,expires_at) VALUES($1,$2,$3,'email_verification',$4,$5)`,[outboxId,user.id,tokenId,payload,expiresAt]);
 await c.query("INSERT INTO account_security_events(user_id,action) VALUES($1,'email_verification_requested')",[user.id]);
}

export async function processOneEmailVerificationRequest(){
 if(!emailVerificationStatus().available||!trustedAccountOrigin())return false;
 return transaction(adminPool,async c=>{
  const {rows:[request]}=await c.query('SELECT * FROM email_verification_requests ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED');
  if(!request)return false;
  const discard=()=>c.query('DELETE FROM email_verification_requests WHERE id=$1',[request.id]);
  let payload:unknown;
  try{payload=JSON.parse(decryptSecret(request.payload_ciphertext));}catch{await discard();return true;}
  const parsed=z.object({email:z.string().max(254).email()}).strict().safeParse(payload);
  if(!parsed.success||addressKey(parsed.data.email)!==request.address_key){await discard();return true;}
  const {rows:[user]}=await c.query('SELECT id,email,password_hash,password_changed_at,email_verified_at FROM users WHERE email=$1 FOR UPDATE',[parsed.data.email]);
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(!user||user.email_verified_at||request.expires_at<=clock.at||user.password_changed_at&&request.created_at<=user.password_changed_at){await discard();return true;}
  await enqueueEmailVerification(c,user,request.expires_at);
  await discard();return true;
 });
}

/** Caller holds the user lock; validity remains independent of sending config. */
export async function isEmailVerificationMailValid(c:PoolClient,user:VerificationUser&{email_verified_at:Date|null},tokenId:string|null){
 if(!tokenId||user.email_verified_at)return false;
 const {rows:[token]}=await c.query("SELECT credential_digest,email_digest FROM email_verification_tokens WHERE id=$1 AND user_id=$2 AND purpose='email_verification' AND expires_at>clock_timestamp()",[tokenId,user.id]);
 return Boolean(token&&token.credential_digest===hashToken(user.password_hash)&&token.email_digest===emailDigest(user.email));
}

/** Caller holds the user lock. Ciphertexts and token validity change atomically. */
export async function invalidateEmailVerification(c:PoolClient,userId:string):Promise<number>{
 await c.query(`UPDATE account_email_outbox SET state='cancelled',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,failure_code='invalid_token',finished_at=clock_timestamp() WHERE user_id=$1 AND kind='email_verification' AND state IN ('pending','sending')`,[userId]);
 return (await c.query('DELETE FROM email_verification_tokens WHERE user_id=$1',[userId])).rowCount??0;
}

export async function completeEmailVerification(token:string,password:string){
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||typeof password!=='string'||password.length<1||password.length>128)invalidVerification();
 const tokenHash=hashToken(token);
 // Password verification is expensive: do it outside the user lock, then fence
 // it against the exact hash again after locking. No cookie account is trusted.
 const {rows:[candidate]}=await adminPool.query("SELECT u.id,u.password_hash FROM email_verification_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=$1 AND t.purpose='email_verification'",[tokenHash]);
 const encoded=candidate?.password_hash||'da53db997e44c565658e207d0b21eaa77:'+ '0'.repeat(128);
 if(!await verifyPassword(password,encoded)||!candidate)invalidVerification();
 await transaction(adminPool,async c=>{
  const {rows:[user]}=await c.query('SELECT id,email,password_hash,email_verified_at FROM users WHERE id=$1 FOR UPDATE',[candidate.id]);
  if(!user||user.email_verified_at||user.password_hash!==candidate.password_hash)invalidVerification();
  const {rows:[record]}=await c.query("SELECT * FROM email_verification_tokens WHERE token_hash=$1 AND user_id=$2 AND purpose='email_verification' FOR UPDATE",[tokenHash,user.id]);
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(!record||record.expires_at<=clock.at||record.credential_digest!==hashToken(user.password_hash)||record.email_digest!==emailDigest(user.email))invalidVerification();
  await c.query('UPDATE users SET email_verified_at=$2 WHERE id=$1',[user.id,clock.at]);
  const sessions=(await c.query('DELETE FROM sessions WHERE user_id=$1',[user.id])).rowCount??0;
  const tokens=await invalidateEmailVerification(c,user.id)+await invalidateRecovery(c,user.id);
  await c.query("INSERT INTO account_security_events(user_id,action,sessions_revoked,tokens_invalidated) VALUES($1,'email_verified',$2,$3)",[user.id,sessions,tokens]);
 });
 return {ok:true};
}

export async function cleanupEmailVerification(budget:WorkBudget={}){
 requireWorkBudget(budget);
 const users=(await adminPool.query('SELECT DISTINCT user_id FROM email_verification_tokens WHERE expires_at<=clock_timestamp() LIMIT 20')).rows;
 for(const candidate of users){
  requireWorkBudget(budget);
  await transaction(adminPool,async c=>{
   if(!(await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.user_id])).rowCount)return;
   const expired=(await c.query('SELECT id FROM email_verification_tokens WHERE user_id=$1 AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE',[candidate.user_id])).rows.map(row=>row.id);
   if(!expired.length)return;
   await c.query(`UPDATE account_email_outbox SET state='cancelled',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,failure_code='expired',finished_at=clock_timestamp() WHERE user_id=$1 AND verification_token_id=ANY($2::uuid[]) AND state IN ('pending','sending')`,[candidate.user_id,expired]);
   await c.query('DELETE FROM email_verification_tokens WHERE user_id=$1 AND id=ANY($2::uuid[])',[candidate.user_id,expired]);
  });
 }
 requireWorkBudget(budget);
 await adminPool.query('DELETE FROM email_verification_requests WHERE id IN (SELECT id FROM email_verification_requests WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)');
 requireWorkBudget(budget);
 await adminPool.query('DELETE FROM email_verification_limits WHERE address_key IN (SELECT address_key FROM email_verification_limits WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)');
}
