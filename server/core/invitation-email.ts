import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {adminPool,transaction} from './db.js';
import {hashToken} from './auth.js';
import {cancelInvitationMail,invitationEmailSubject,type InvitationRow} from './invitations.js';
import {decryptSecret} from '../integrations/secrets.js';
import {AccountEmailError,accountEmailStatus,sendAccountEmail,type AccountEmailErrorCode} from '../integrations/account-email.js';
import {requireWorkBudget,type WorkBudget} from './work-budget.js';

const payloadSchema=z.object({to:z.string().email().max(254),subject:z.literal(invitationEmailSubject),text:z.string().min(1).refine(value=>Buffer.byteLength(value)<=4096)}).strict();
const providerCodes=new Set<AccountEmailErrorCode>(['unavailable','invalid_message','temporary_failure','permanent_failure','timeout','cancelled','invalid_response']);
type MailRow={id:string;invitation_id:string;workspace_id:string;token_hash:string;payload_ciphertext:string|null;state:string;attempts:number;expires_at:Date;lease_owner:string|null;lease_until:Date|null;available_at:Date};
type Claim={row:MailRow;invite:InvitationRow;lease:string;remainingMs:number};

async function terminal(c:PoolClient,id:string,state:'failed'|'cancelled',code:string){
 await c.query(`UPDATE invitation_email_outbox SET state=$2,payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,failure_code=$3,finished_at=clock_timestamp() WHERE id=$1`,[id,state,code]);
}

/** Queue locks follow the same workspace / issuer / invitation order as API mutations. */
async function lockInvitation(c:PoolClient,candidate:{workspace_id:string;invitation_id:string},skip:boolean){
 const suffix=skip?' SKIP LOCKED':'';
 if(!(await c.query(`SELECT id FROM workspaces WHERE id=$1 FOR NO KEY UPDATE${suffix}`,[candidate.workspace_id])).rowCount)return;
 const current=(await c.query('SELECT issuer_id FROM invitations WHERE id=$1 AND workspace_id=$2',[candidate.invitation_id,candidate.workspace_id])).rows[0];
 if(!current)return;
 const issuer=current.issuer_id?(await c.query(`SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE${suffix}`,[candidate.workspace_id,current.issuer_id])).rows[0]:undefined;
 // Distinguish a contended membership from a revoked membership before cancelling.
 if(current.issuer_id&&!issuer&&skip&&(await c.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2',[candidate.workspace_id,current.issuer_id])).rowCount)return;
 const {rows:[invite]}=await c.query('SELECT * FROM invitations WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[candidate.invitation_id,candidate.workspace_id]);
 if(!invite)return;
 const authorized=Boolean(invite.issuer_id&&invite.issuer_id===current.issuer_id&&(issuer?.role==='owner'||issuer?.role==='admin'&&invite.role!=='admin'));
 return {invite:invite as InvitationRow,authorized};
}

export async function cleanupInvitationEmail(budget:WorkBudget={}){
 requireWorkBudget(budget);
 const candidates=(await adminPool.query(`SELECT DISTINCT invitation_id,workspace_id FROM invitation_email_outbox WHERE state IN ('pending','sending') AND expires_at<=clock_timestamp() LIMIT 20`)).rows;
 for(const candidate of candidates){
  requireWorkBudget(budget);
  await transaction(adminPool,async c=>{
   const locked=await lockInvitation(c,candidate,true);if(!locked)return;
   await c.query(`UPDATE invitation_email_outbox SET state='cancelled',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,failure_code='expired',finished_at=clock_timestamp()
    WHERE invitation_id=$1 AND expires_at<=clock_timestamp() AND state IN ('pending','sending')`,[candidate.invitation_id]);
  });
 }
 requireWorkBudget(budget);
 await adminPool.query(`DELETE FROM invitation_email_limits WHERE address_key IN (SELECT address_key FROM invitation_email_limits WHERE expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
 // Keep the latest status while its invitation still exists. Older attempts have a finite retention.
 await adminPool.query(`DELETE FROM invitation_email_outbox WHERE id IN (SELECT old.id FROM invitation_email_outbox old
  WHERE old.finished_at<clock_timestamp()-interval '7 days' AND EXISTS(SELECT 1 FROM invitation_email_outbox newer WHERE newer.invitation_id=old.invitation_id AND newer.created_at>old.created_at)
  ORDER BY old.finished_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
}

async function claim(budget:WorkBudget):Promise<Claim|undefined>{
 const candidates=(await adminPool.query(`SELECT id,invitation_id,workspace_id FROM invitation_email_outbox WHERE
  (state='pending' AND available_at<=clock_timestamp()) OR (state='sending' AND lease_until<=clock_timestamp()) ORDER BY created_at,id LIMIT 20`)).rows;
 for(const candidate of candidates){
  requireWorkBudget(budget,1000);
  const result=await transaction(adminPool,async c=>{
   const locked=await lockInvitation(c,candidate,true);if(!locked)return;
   const {invite,authorized}=locked;
   const {rows:[row]}=await c.query('SELECT * FROM invitation_email_outbox WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[candidate.id,candidate.workspace_id]) as {rows:MailRow[]};
   const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
   if(!row||!(row.state==='pending'&&row.available_at<=clock.at||row.state==='sending'&&row.lease_until!<=clock.at))return;
   if(!authorized){await cancelInvitationMail(c,invite.id,'issuer_unauthorized');return;}
   if(invite.accepted_at||invite.token_hash!==row.token_hash){await terminal(c,row.id,'cancelled','invalid_token');return;}
   if(invite.expires_at<=clock.at||row.expires_at<=clock.at){await terminal(c,row.id,'cancelled','expired');return;}
   if(row.attempts>=5){await terminal(c,row.id,'failed','attempt_limit');return;}
   const lease=randomUUID();
   await c.query(`UPDATE invitation_email_outbox SET state='sending',attempts=attempts+1,lease_owner=$2,lease_until=clock_timestamp()+interval '45 seconds',failure_code=NULL WHERE id=$1`,[row.id,lease]);
   return {row:{...row,attempts:row.attempts+1},invite,lease,remainingMs:Math.min(row.expires_at.getTime(),invite.expires_at.getTime())-clock.at.getTime()};
  });
  if(result)return result;
 }
}

async function finish(claimed:Claim,error?:unknown){
 await transaction(adminPool,async c=>{
  const locked=await lockInvitation(c,claimed.row,false);if(!locked)return;
  const {invite,authorized}=locked;
  const {rows:[row]}=await c.query('SELECT * FROM invitation_email_outbox WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[claimed.row.id,claimed.row.workspace_id]) as {rows:MailRow[]};
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(!row||row.state!=='sending'||row.lease_owner!==claimed.lease||!row.lease_until||row.lease_until<=clock.at)return;
  if(!authorized){await cancelInvitationMail(c,invite.id,'issuer_unauthorized');return;}
  if(invite.accepted_at||invite.token_hash!==row.token_hash){await terminal(c,row.id,'cancelled','invalid_token');return;}
  if(invite.expires_at<=clock.at||row.expires_at<=clock.at){await terminal(c,row.id,'cancelled','expired');return;}
  if(!error){await c.query(`UPDATE invitation_email_outbox SET state='accepted',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,finished_at=clock_timestamp(),failure_code=NULL WHERE id=$1`,[row.id]);return;}
  const typed=error instanceof AccountEmailError&&providerCodes.has(error.code)?error:undefined;
  const code=typed?.code??'temporary_failure',retryable=typed?.retryable??true;
  if(!retryable||row.attempts>=5){await terminal(c,row.id,'failed',code);return;}
  const seconds=[30,120,300,600][Math.min(row.attempts-1,3)];
  await c.query(`UPDATE invitation_email_outbox SET state='pending',lease_owner=NULL,lease_until=NULL,failure_code=$2,
   available_at=least(expires_at,clock_timestamp()+$3::integer*interval '1 second') WHERE id=$1`,[row.id,code,seconds]);
 });
}

/** Provider acceptance is durable progress, never a claim that the message reached an inbox. */
export async function processOneInvitationEmail(budget:WorkBudget={}):Promise<boolean>{
 await cleanupInvitationEmail(budget);
 if(!accountEmailStatus().available)return false;
 requireWorkBudget(budget,1000);
 const claimed=await claim(budget);if(!claimed)return false;
 const controller=new AbortController();
 const remaining=Math.min(20_000,claimed.remainingMs,budget.deadlineAt===undefined?Infinity:budget.deadlineAt-Date.now());
 let timer:ReturnType<typeof setTimeout>|undefined,error:unknown;
 const abort=()=>controller.abort();
 let rejectAbort!:(error:AccountEmailError)=>void;
 const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject;});
 const onAbort=()=>rejectAbort(new AccountEmailError(budget.signal?.aborted?'cancelled':'timeout',true));
 controller.signal.addEventListener('abort',onAbort,{once:true});budget.signal?.addEventListener('abort',abort,{once:true});
 try{
  if(budget.signal?.aborted||remaining<=0)throw new AccountEmailError('cancelled',true);
  let payload:unknown;try{payload=JSON.parse(decryptSecret(claimed.row.payload_ciphertext!));}catch{throw new AccountEmailError('invalid_message',false);}
  const parsed=payloadSchema.safeParse(payload);
  if(!parsed.success||parsed.data.to!==claimed.invite.email)throw new AccountEmailError('invalid_message',false);
  const links=parsed.data.text.match(/https?:\/\/[^\s]+/g)??[];
  const hasToken=links.some(link=>{try{const url=new URL(link),token=new URLSearchParams(url.hash.slice(1)).get('token');return url.pathname==='/invite'&&Boolean(token)&&hashToken(token!)===claimed.row.token_hash;}catch{return false;}});
  if(!hasToken)throw new AccountEmailError('invalid_message',false);
  timer=setTimeout(()=>controller.abort(),remaining);
  await Promise.race([sendAccountEmail({...parsed.data,idempotencyKey:`folio-account-email/${claimed.row.id}`},{signal:controller.signal,deadlineAt:Date.now()+remaining}),aborted]);
 }catch(failure){error=failure;}
 finally{if(timer)clearTimeout(timer);budget.signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',onAbort);}
 await finish(claimed,error);return true;
}
