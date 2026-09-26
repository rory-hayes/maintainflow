import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {adminPool,transaction} from './db.js';
import {defaultPlan} from './config.js';
import {hashPassword} from './auth.js';
import {enqueueEmailVerification} from './email-verification.js';
import {accountEmailStatus,trustedAccountOrigin} from '../integrations/account-email.js';
import {decryptSecret,encryptSecret,privateIdentifier} from '../integrations/secrets.js';
import {requireWorkBudget,type WorkBudget} from './work-budget.js';
import {signupTermsSnapshotSchema,type SignupTermsSnapshot} from '../../shared/signup-terms.js';
import {checkedSignupTermsSnapshot,saveSignupTermsAcceptance} from './signup-terms.js';

export const requiredSignupAccepted=Object.freeze({accepted:true,message:'If this address can be registered, a verification email will be sent shortly.'});
export class RegistrationUnavailableError extends Error {
 constructor(){super('Account registration is temporarily unavailable. Please try again later.');this.name='RegistrationUnavailableError';}
}
type RegistrationFields={email:string;password:string;name:string;workspaceName:string};
const addressKey=(email:string)=>privateIdentifier('folio:account-registration:address:v1',email);
const envelopeSchema=z.object({
 email:z.string().email().max(254).refine(value=>value===value.trim().toLowerCase()),
 name:z.string().min(1).max(100),workspaceName:z.string().min(1).max(100),
 passwordHash:z.string().regex(/^[0-9a-f]{32}:[0-9a-f]{128}$/),
 signupTerms:signupTermsSnapshotSchema.optional(),
}).strict();
const available=()=>accountEmailStatus().available&&Boolean(trustedAccountOrigin());

async function grantAddress(c:PoolClient,key:string){
 // Cleanup may remove an expired conflicting row between DO NOTHING and the
 // locking read. The global admission lock lets one bounded retry renew it.
 for(let attempt=0;attempt<2;attempt++){
  const inserted=await c.query(`INSERT INTO account_registration_limits(address_key,window_started_at,grants,cooldown_until,expires_at)
   VALUES($1,clock_timestamp(),1,clock_timestamp()+interval '60 seconds',clock_timestamp()+interval '1 hour') ON CONFLICT DO NOTHING RETURNING address_key`,[key]);
  if(inserted.rowCount)return true;
  const {rows:[limit]}=await c.query('SELECT * FROM account_registration_limits WHERE address_key=$1 FOR UPDATE',[key]);
  if(!limit)continue;
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(limit.expires_at<=clock.at){
   await c.query(`UPDATE account_registration_limits SET window_started_at=$2,grants=1,cooldown_until=$2::timestamptz+interval '60 seconds',expires_at=$2::timestamptz+interval '1 hour' WHERE address_key=$1`,[key,clock.at]);return true;
  }
  if(limit.cooldown_until>clock.at||limit.grants>=5)return false;
  await c.query("UPDATE account_registration_limits SET grants=grants+1,cooldown_until=$2::timestamptz+interval '60 seconds' WHERE address_key=$1",[key,clock.at]);return true;
 }
 throw new RegistrationUnavailableError();
}

/** Called only after normal signup field/invite validation. Never resolves an account. */
export async function requestVerifiedRegistration(fields:RegistrationFields,signupTerms?:SignupTermsSnapshot){
 if(!available())throw new RegistrationUnavailableError();
 const passwordHash=await hashPassword(fields.password);
 const payload=envelopeSchema.parse({email:fields.email,name:fields.name,workspaceName:fields.workspaceName,passwordHash,...(signupTerms!==undefined?{signupTerms:checkedSignupTermsSnapshot(signupTerms)}:{})});
 const ciphertext=encryptSecret(JSON.stringify(payload)),key=addressKey(payload.email);
 const ciphertextBytes=Buffer.byteLength(ciphertext);
 if(ciphertextBytes>(signupTerms===undefined?8192:32768))throw new RegistrationUnavailableError();
 await transaction(adminPool,async c=>{
  if(!available())throw new RegistrationUnavailableError();
  // Capacity and suppression depend only on global queue/address state. In
  // particular, neither known addresses nor a full queue trigger a user read.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('folio:account-registration:request-cap',0))");
  await c.query(`DELETE FROM account_registration_requests WHERE id IN (SELECT id FROM account_registration_requests WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
  const {rows:[count]}=await c.query('SELECT count(*)::int n,coalesce(sum(octet_length(payload_ciphertext)),0)::bigint bytes FROM account_registration_requests');
  if(count.n>=5000||Number(count.bytes)+ciphertextBytes>5000*8192)throw new RegistrationUnavailableError();
  if(!await grantAddress(c,key))return;
  await c.query(`INSERT INTO account_registration_requests(address_key,payload_ciphertext,expires_at)
   VALUES($1,$2,clock_timestamp()+interval '24 hours')`,[key,ciphertext]);
 });
 return requiredSignupAccepted;
}

/** Only this asynchronous transaction resolves uniqueness and provisions an account. */
export async function processOneAccountRegistration(){
 if(!available())return false;
 return transaction(adminPool,async c=>{
  const {rows:[request]}=await c.query('SELECT * FROM account_registration_requests ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED');
  if(!request)return false;
  const discard=()=>c.query('DELETE FROM account_registration_requests WHERE id=$1',[request.id]);
  const {rows:[before]}=await c.query('SELECT clock_timestamp() AS at');
  if(request.expires_at<=before.at){await discard();return true;}
  let decoded:unknown;
  try{decoded=JSON.parse(decryptSecret(request.payload_ciphertext));}catch{await discard();return true;}
  const parsed=envelopeSchema.safeParse(decoded);
  if(!parsed.success||addressKey(parsed.data.email)!==request.address_key){await discard();return true;}
  const payload=parsed.data;
  try{if(payload.signupTerms!==undefined)checkedSignupTermsSnapshot(payload.signupTerms);}catch{await discard();return true;}
  await c.query('SAVEPOINT registration_provisioning');
  // The unique email constraint arbitrates simultaneous workers and immediate
  // signup. A conflict must never update the existing account or its profile.
  const {rows:[user]}=await c.query(`INSERT INTO users(email,name,password_hash,email_verification_required)
   VALUES($1,$2,$3,true) ON CONFLICT(email) DO NOTHING RETURNING id,email,password_hash`,[payload.email,payload.name,payload.passwordHash]);
  if(!user){await discard();return true;}
  // Uniqueness waits can cross the original deadline. Roll back only this
  // request's provisioning; the request lock remains held for safe disposal.
  const {rows:[after]}=await c.query('SELECT clock_timestamp() AS at');
  if(request.expires_at<=after.at){await c.query('ROLLBACK TO SAVEPOINT registration_provisioning');await discard();return true;}
  const slug=`${payload.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${randomUUID()}`;
  const {rows:[workspace]}=await c.query('INSERT INTO workspaces(name,slug,plan) VALUES($1,$2,$3) RETURNING id',[payload.workspaceName,slug,JSON.stringify(defaultPlan)]);
  await c.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace.id,user.id]);
  await saveSignupTermsAcceptance(c,user.id,payload.signupTerms);
  await enqueueEmailVerification(c,user,request.expires_at);
  // Enqueue deliberately does nothing for an expired deadline. Provisioning
  // must not survive that outcome or a deadline crossed during its DB writes.
  const {rows:[finished]}=await c.query('SELECT clock_timestamp() AS at');
  if(request.expires_at<=finished.at)await c.query('ROLLBACK TO SAVEPOINT registration_provisioning');
  await discard();return true;
 });
}

/** Bounded ciphertext/limit cleanup also works while delivery is disabled. */
export async function cleanupAccountRegistrations(budget:WorkBudget={}){
 requireWorkBudget(budget);
 await adminPool.query(`DELETE FROM account_registration_requests WHERE id IN (SELECT id FROM account_registration_requests WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
 requireWorkBudget(budget);
 await adminPool.query(`DELETE FROM account_registration_limits WHERE address_key IN (SELECT address_key FROM account_registration_limits WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
}
