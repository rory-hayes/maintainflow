import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {adminPool,transaction} from './db.js';
import {hashToken} from './auth.js';
import {processOneAccountRecoveryRequest} from './account-recovery.js';
import {decryptSecret} from '../integrations/secrets.js';
import {AccountEmailError,accountEmailStatus,sendAccountEmail,type AccountEmailErrorCode} from '../integrations/account-email.js';
import {requireWorkBudget,type WorkBudget} from './work-budget.js';

const payloadSchema=z.object({to:z.string().email().max(254),subject:z.enum(['Reset your Folio password','Your Folio password was changed']),text:z.string().min(1).refine(value=>Buffer.byteLength(value)<=4096)}).strict();
const providerCodes=new Set<AccountEmailErrorCode>(['unavailable','invalid_message','temporary_failure','permanent_failure','timeout','cancelled','invalid_response']);
type MailRow={id:string;user_id:string;token_id:string|null;kind:'password_reset'|'password_changed';payload_ciphertext:string|null;state:string;attempts:number;expires_at:Date;lease_owner:string|null;lease_until:Date|null;available_at:Date};
type Claim={row:MailRow;lease:string;remainingMs:number};

async function terminal(c:PoolClient,row:MailRow,state:'failed'|'cancelled',code:string){
 await c.query(`UPDATE account_email_outbox SET state=$2,payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,failure_code=$3,finished_at=clock_timestamp() WHERE id=$1`,[row.id,state,code]);
 if(row.token_id)await c.query('DELETE FROM account_recovery_tokens WHERE id=$1 AND user_id=$2',[row.token_id,row.user_id]);
}

/** Bounded secret cleanup also runs when sending is unavailable. User locks precede token/mail locks. */
export async function cleanupAccountRecovery(budget:WorkBudget={}){
 requireWorkBudget(budget);
 const users=(await adminPool.query(`SELECT user_id FROM (
  SELECT user_id,expires_at AS due FROM account_recovery_tokens WHERE expires_at<=clock_timestamp()
  UNION ALL SELECT user_id,expires_at AS due FROM account_email_outbox WHERE expires_at<=clock_timestamp() AND state IN ('pending','sending')
 ) expired GROUP BY user_id ORDER BY min(due) LIMIT 20`)).rows;
 for(const candidate of users){
  requireWorkBudget(budget);
  await transaction(adminPool,async c=>{
   if(!(await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.user_id])).rowCount)return;
   const expired=(await c.query('SELECT id FROM account_recovery_tokens WHERE user_id=$1 AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE',[candidate.user_id])).rows.map(row=>row.id);
   if(expired.length){
    await c.query(`UPDATE account_email_outbox SET state='cancelled',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,failure_code='expired',finished_at=clock_timestamp()
     WHERE user_id=$1 AND token_id=ANY($2::uuid[]) AND state IN ('pending','sending')`,[candidate.user_id,expired]);
    await c.query('DELETE FROM account_recovery_tokens WHERE user_id=$1 AND id=ANY($2::uuid[])',[candidate.user_id,expired]);
   }
   const rows=(await c.query(`SELECT * FROM account_email_outbox WHERE user_id=$1 AND expires_at<=clock_timestamp() AND state IN ('pending','sending') ORDER BY expires_at LIMIT 100 FOR UPDATE`,[candidate.user_id])).rows as MailRow[];
   for(const row of rows)await terminal(c,row,'cancelled','expired');
  });
 }
 requireWorkBudget(budget);
 await adminPool.query(`DELETE FROM account_recovery_requests WHERE id IN (SELECT id FROM account_recovery_requests WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
 await adminPool.query(`DELETE FROM account_recovery_limits WHERE address_key IN (SELECT address_key FROM account_recovery_limits WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
 await adminPool.query(`DELETE FROM account_email_outbox WHERE id IN (SELECT id FROM account_email_outbox WHERE finished_at<clock_timestamp()-interval '7 days' ORDER BY finished_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
 await adminPool.query(`DELETE FROM account_security_events WHERE id IN (SELECT id FROM account_security_events WHERE created_at<clock_timestamp()-interval '90 days' ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
}

async function claim(budget:WorkBudget):Promise<Claim|undefined>{
 const candidates=(await adminPool.query(`SELECT id,user_id FROM account_email_outbox WHERE
  (state='pending' AND available_at<=clock_timestamp()) OR (state='sending' AND lease_until<=clock_timestamp())
  ORDER BY created_at,id LIMIT 20`)).rows;
 for(const candidate of candidates){
  requireWorkBudget(budget,1000);
  const result=await transaction(adminPool,async c=>{
   // Skip contention without holding an outbox row while waiting for its user.
   const {rows:[user]}=await c.query('SELECT id,password_hash FROM users WHERE id=$1 FOR UPDATE SKIP LOCKED',[candidate.user_id]);
   if(!user)return;
   const {rows:[row]}=await c.query('SELECT * FROM account_email_outbox WHERE id=$1 AND user_id=$2 FOR UPDATE',[candidate.id,user.id]) as {rows:MailRow[]};
   const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
   if(!row||!(row.state==='pending'&&row.available_at<=clock.at||row.state==='sending'&&row.lease_until!<=clock.at))return;
   if(row.expires_at<=clock.at){await terminal(c,row,'cancelled','expired');return;}
   if(row.attempts>=5){await terminal(c,row,'failed','attempt_limit');return;}
   if(row.kind==='password_reset'){
    const {rows:[token]}=await c.query("SELECT credential_digest,expires_at FROM account_recovery_tokens WHERE id=$1 AND user_id=$2 AND purpose='password_reset'",[row.token_id,user.id]);
    if(!token||token.expires_at<=clock.at||token.credential_digest!==hashToken(user.password_hash)){await terminal(c,row,'cancelled','invalid_token');return;}
   }
   const lease=randomUUID();
   await c.query(`UPDATE account_email_outbox SET state='sending',attempts=attempts+1,lease_owner=$2,lease_until=clock_timestamp()+interval '45 seconds',failure_code=NULL WHERE id=$1`,[row.id,lease]);
   return {row:{...row,attempts:row.attempts+1},lease,remainingMs:row.expires_at.getTime()-clock.at.getTime()};
  });
  if(result)return result;
 }
}

async function finish(claimed:Claim,error?:unknown){
 await transaction(adminPool,async c=>{
  if(!(await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[claimed.row.user_id])).rowCount)return;
  const {rows:[row]}=await c.query('SELECT * FROM account_email_outbox WHERE id=$1 AND user_id=$2 FOR UPDATE',[claimed.row.id,claimed.row.user_id]) as {rows:MailRow[]};
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(!row||row.state!=='sending'||row.lease_owner!==claimed.lease||!row.lease_until||row.lease_until<=clock.at)return;
  if(row.expires_at<=clock.at){await terminal(c,row,'cancelled','expired');return;}
  if(!error){
   await c.query(`UPDATE account_email_outbox SET state='accepted',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,finished_at=clock_timestamp(),failure_code=NULL WHERE id=$1`,[row.id]);return;
  }
  // Only our transport's finite error class may determine terminal status.
  const typed=error instanceof AccountEmailError&&providerCodes.has(error.code)?error:undefined;
  const code=typed?.code??'temporary_failure',retryable=typed?.retryable??true;
  if(!retryable||row.attempts>=5){await terminal(c,row,'failed',code);return;}
  const seconds=[30,120,300,600][Math.min(row.attempts-1,3)];
  await c.query(`UPDATE account_email_outbox SET state='pending',lease_owner=NULL,lease_until=NULL,failure_code=$2,
   available_at=least(expires_at,clock_timestamp()+$3::integer*interval '1 second') WHERE id=$1`,[row.id,code,seconds]);
 });
}

/** One awaited durable unit. Delivery acceptance never asserts inbox delivery. */
export async function processOneAccountEmail(budget:WorkBudget={}):Promise<boolean>{
 await cleanupAccountRecovery(budget);
 if(!accountEmailStatus().available)return false;
 requireWorkBudget(budget,1000);
 const resolved=await processOneAccountRecoveryRequest();
 requireWorkBudget(budget,1000);
 const claimed=await claim(budget);if(!claimed)return resolved;
 const controller=new AbortController();
 const remaining=Math.min(20_000,claimed.remainingMs,budget.deadlineAt===undefined?Infinity:budget.deadlineAt-Date.now());
 let timer:ReturnType<typeof setTimeout>|undefined,error:unknown;
 const abort=()=>controller.abort();
 let rejectAbort!:(error:AccountEmailError)=>void;
 const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
 const onAbort=()=>rejectAbort(new AccountEmailError(budget.signal?.aborted?'cancelled':'timeout',true));
 controller.signal.addEventListener('abort',onAbort,{once:true});
 budget.signal?.addEventListener('abort',abort,{once:true});
 try{
  if(budget.signal?.aborted||remaining<=0)throw new AccountEmailError('cancelled',true);
  let payload:unknown;
  try{payload=JSON.parse(decryptSecret(claimed.row.payload_ciphertext!));}catch{throw new AccountEmailError('invalid_message',false);}
  const parsed=payloadSchema.safeParse(payload);
  if(!parsed.success)throw new AccountEmailError('invalid_message',false);
  if((claimed.row.kind==='password_reset')!==(parsed.data.subject==='Reset your Folio password'))throw new AccountEmailError('invalid_message',false);
  timer=setTimeout(()=>controller.abort(),remaining);
  await Promise.race([sendAccountEmail({...parsed.data,idempotencyKey:`folio-account-email/${claimed.row.id}`},{signal:controller.signal,deadlineAt:Date.now()+remaining}),aborted]);
 }catch(failure){error=failure;}
 finally{if(timer)clearTimeout(timer);budget.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);}
 await finish(claimed,error);
 return true;
}
