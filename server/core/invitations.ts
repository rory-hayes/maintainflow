import type {PoolClient} from 'pg';
import type {Actor,Role} from '../../shared/types.js';
import {adminPool,transaction,badRequest,notFound,audit,camel} from './db.js';
import {hashToken,newToken} from './auth.js';
import {accountEmailStatus,trustedAccountOrigin} from '../integrations/account-email.js';
import {encryptSecret,privateIdentifier} from '../integrations/secrets.js';

export const invalidInvitationMessage='This invitation is invalid, expired or already used';
export const invitationEmailSubject='Join your MaintainFlow workspace';
export const invitationAddressKey=(email:string)=>privateIdentifier('folio:invitation-email:address:v1',email);
export type InvitationRow={id:string;workspace_id:string;email:string;role:'admin'|'editor'|'viewer';token_hash:string;expires_at:Date;accepted_at:Date|null;created_at:Date;issuer_id:string|null;delivery:'manual'|'email'};
export function invitationEmailStatus(){return {available:accountEmailStatus().available};}
function unavailable():never{badRequest('Invitation email is temporarily unavailable. Copy an invitation link or try again later.',503);}
const roleAllowed=(issuerRole:Role|undefined,invitedRole:string)=>issuerRole==='owner'||issuerRole==='admin'&&invitedRole!=='admin';

/** Every invitation mutation starts with its workspace, then issuer membership, then invitation. */
async function lockIssuer(c:PoolClient,actor:Actor,role?:string){
 const workspace=(await c.query('SELECT id,name FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[actor.workspaceId])).rows[0];
 if(!workspace)notFound();
 const membership=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[actor.workspaceId,actor.userId])).rows[0];
 if(!membership||!['owner','admin'].includes(membership.role))badRequest('Your workspace role does not allow this action',403);
 if(role==='admin'&&membership.role!=='owner')badRequest('Only the workspace owner can appoint an admin',403);
 return {workspace,role:membership.role as Role};
}

export async function cancelInvitationMail(c:PoolClient,invitationId:string,code:'revoked'|'accepted'|'superseded'|'expired'|'issuer_unauthorized'){
 await c.query(`UPDATE invitation_email_outbox SET state='cancelled',payload_ciphertext=NULL,lease_owner=NULL,lease_until=NULL,failure_code=$2,finished_at=clock_timestamp()
  WHERE invitation_id=$1 AND state IN ('pending','sending')`,[invitationId,code]);
}

async function grantRecipient(c:PoolClient,email:string){
 const key=invitationAddressKey(email);
 for(let attempt=0;attempt<2;attempt++){
  const inserted=await c.query(`INSERT INTO invitation_email_limits(address_key,window_started_at,grants,cooldown_until,expires_at)
   VALUES($1,clock_timestamp(),1,clock_timestamp()+interval '60 seconds',clock_timestamp()+interval '1 hour') ON CONFLICT DO NOTHING RETURNING address_key`,[key]);
  if(inserted.rowCount)return;
  const {rows:[limit]}=await c.query('SELECT * FROM invitation_email_limits WHERE address_key=$1 FOR UPDATE',[key]);
  if(!limit)continue;
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(limit.expires_at<=clock.at){
   await c.query(`UPDATE invitation_email_limits SET window_started_at=$2,grants=1,cooldown_until=$2::timestamptz+interval '60 seconds',expires_at=$2::timestamptz+interval '1 hour' WHERE address_key=$1`,[key,clock.at]);return;
  }
  if(limit.cooldown_until>clock.at||limit.grants>=5)badRequest('Please wait before sending another invitation to this email address.',429);
  await c.query("UPDATE invitation_email_limits SET grants=grants+1,cooldown_until=$2::timestamptz+interval '60 seconds' WHERE address_key=$1",[key,clock.at]);return;
 }
 unavailable();
}

async function reserveMail(c:PoolClient,email:string){
 if(!invitationEmailStatus().available)unavailable();
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('folio:invitation-email:capacity',0))");
 const {rows:[count]}=await c.query("SELECT count(*)::int n FROM invitation_email_outbox WHERE state IN ('pending','sending')");
 if(count.n>=5000)unavailable();
 await grantRecipient(c,email);
}

async function enqueue(c:PoolClient,invite:InvitationRow,token:string,workspaceName:string,origin:string){
 const name=workspaceName.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,' ').replace(/\s+/g,' ').trim().slice(0,100);
 const text=`You have been invited to join ${name} on MaintainFlow as ${invite.role}.\n\nSign in or create an account with this email address, then review your invitation:\n${origin}/invite#token=${token}\n\nThis invitation expires on ${invite.expires_at.toUTCString()}. If you were not expecting it, you can ignore this email.`;
 await c.query(`INSERT INTO invitation_email_outbox(invitation_id,workspace_id,token_hash,payload_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5)`,
  [invite.id,invite.workspace_id,invite.token_hash,encryptSecret(JSON.stringify({to:invite.email,subject:invitationEmailSubject,text})),invite.expires_at]);
}

function publicInvitation(invite:InvitationRow,emailStatus:string|null,retryAt:Date|null){
 return camel({id:invite.id,email:invite.email,role:invite.role,expires_at:invite.expires_at,accepted_at:invite.accepted_at,created_at:invite.created_at,delivery:invite.delivery,email_status:emailStatus,retry_at:retryAt});
}
async function view(c:PoolClient,invite:InvitationRow){
 const {rows:[mail]}=await c.query('SELECT state FROM invitation_email_outbox WHERE invitation_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[invite.id]);
 const {rows:[limit]}=await c.query(`SELECT CASE WHEN grants>=5 THEN expires_at ELSE cooldown_until END retry_at FROM invitation_email_limits
  WHERE address_key=$1 AND expires_at>clock_timestamp() AND (grants>=5 OR cooldown_until>clock_timestamp())`,[invitationAddressKey(invite.email)]);
 return publicInvitation(invite,mail?.state??null,limit?.retry_at??null);
}

export async function listInvitations(actor:Actor){
 return transaction(adminPool,async c=>{
  const role=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2',[actor.workspaceId,actor.userId])).rows[0]?.role;
  if(!['owner','admin'].includes(role))return [];
  const invitations=(await c.query(`SELECT i.*,mail.state email_status FROM invitations i LEFT JOIN LATERAL
   (SELECT state FROM invitation_email_outbox WHERE invitation_id=i.id ORDER BY created_at DESC,id DESC LIMIT 1) mail ON true
   WHERE i.workspace_id=$1 ORDER BY (i.accepted_at IS NULL AND i.expires_at>clock_timestamp()) DESC,i.created_at DESC LIMIT 200`,[actor.workspaceId])).rows;
  const keys=invitations.map(invite=>invitationAddressKey(invite.email));
  const limits=(await c.query(`SELECT address_key,CASE WHEN grants>=5 THEN expires_at ELSE cooldown_until END retry_at FROM invitation_email_limits
   WHERE address_key=ANY($1::text[]) AND expires_at>clock_timestamp() AND (grants>=5 OR cooldown_until>clock_timestamp())`,[keys])).rows;
  const retryByKey=new Map(limits.map(limit=>[limit.address_key,limit.retry_at]));
  return invitations.map((invite,index)=>publicInvitation(invite,invite.email_status??null,retryByKey.get(keys[index])??null));
 });
}

export async function createInvitation(actor:Actor,fields:{email:string;role:'admin'|'editor'|'viewer';delivery:'manual'|'email'}){
 const origin=trustedAccountOrigin();if(!origin)badRequest('Invitation links are temporarily unavailable. Please try again later.',503);
 if(fields.delivery==='email'&&!invitationEmailStatus().available)unavailable();
 return transaction(adminPool,async c=>{
  const {workspace}=await lockIssuer(c,actor,fields.role);
  const {rows:[count]}=await c.query('SELECT count(*)::int n FROM invitations WHERE workspace_id=$1 AND accepted_at IS NULL AND expires_at>clock_timestamp()',[actor.workspaceId]);
  if(count.n>=100)badRequest('This workspace has reached its limit of 100 pending invitations. Revoke an invitation before adding another.',429);
  if(fields.delivery==='email')await reserveMail(c,fields.email);
  const token=newToken();
  const {rows:[invite]}=await c.query(`INSERT INTO invitations(workspace_id,email,role,token_hash,expires_at,issuer_id,delivery)
   VALUES($1,$2,$3,$4,clock_timestamp()+interval '7 days',$5,$6) RETURNING *`,[actor.workspaceId,fields.email,fields.role,hashToken(token),actor.userId,fields.delivery]);
  if(fields.delivery==='email')await enqueue(c,invite,token,workspace.name,origin);
  await audit(c,actor.workspaceId,actor.userId,'member.invited',invite.id,{role:fields.role,delivery:fields.delivery});
  const invitation=await view(c,invite);
  return fields.delivery==='email'?{invitation,delivery:'email' as const,message:'Invitation email queued.'}:
   {invitation,delivery:'manual' as const,token,inviteUrl:`${origin}/invite#token=${token}`,message:'Copy this invitation link. It will not be displayed again.'};
 });
}

export async function resendInvitation(actor:Actor,id:string){
 const origin=trustedAccountOrigin();if(!origin||!invitationEmailStatus().available)unavailable();
 return transaction(adminPool,async c=>{
  const {workspace,role}=await lockIssuer(c,actor);
  const {rows:[invite]}=await c.query('SELECT * FROM invitations WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[id,actor.workspaceId]);
  if(!invite)notFound();
  if(!roleAllowed(role,invite.role))badRequest('Only the workspace owner can appoint an admin',403);
  if(invite.accepted_at)badRequest('This invitation has already been accepted.');
  const {rows:[count]}=await c.query('SELECT count(*)::int n FROM invitations WHERE workspace_id=$1 AND id<>$2 AND accepted_at IS NULL AND expires_at>clock_timestamp()',[actor.workspaceId,id]);
  if(count.n>=100)badRequest('This workspace has reached its limit of 100 pending invitations. Revoke an invitation before adding another.',429);
  await reserveMail(c,invite.email);
  await cancelInvitationMail(c,id,'superseded');
  const token=newToken();
  const {rows:[updated]}=await c.query(`UPDATE invitations SET token_hash=$3,expires_at=clock_timestamp()+interval '7 days',delivery='email',issuer_id=$4 WHERE id=$1 AND workspace_id=$2 RETURNING *`,[id,actor.workspaceId,hashToken(token),actor.userId]);
  await enqueue(c,updated,token,workspace.name,origin);
  await audit(c,actor.workspaceId,actor.userId,'member.invitation_resent',id,{role:invite.role});
  return {invitation:await view(c,updated),delivery:'email' as const,message:'Invitation email queued.'};
 });
}

export async function deleteInvitation(actor:Actor,id:string){
 return transaction(adminPool,async c=>{
  await lockIssuer(c,actor);
  const {rows:[invite]}=await c.query('SELECT * FROM invitations WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[id,actor.workspaceId]);
  if(!invite)notFound();
  await cancelInvitationMail(c,id,'revoked');
  await c.query('DELETE FROM invitations WHERE id=$1 AND workspace_id=$2',[id,actor.workspaceId]);
  await audit(c,actor.workspaceId,actor.userId,invite.accepted_at?'member.invitation_deleted':'member.invitation_revoked',id,{role:invite.role});
  return {ok:true};
 });
}

/** The initial lookup locates locks only. Validity is decided after all waits using the DB clock. */
async function withValidInvitation<T>(actor:Actor,token:string,fn:(c:PoolClient,invite:InvitationRow,workspace:any,existing:any)=>Promise<T>){
 const tokenHash=hashToken(token);
 return transaction(adminPool,async c=>{
  const candidate=(await c.query('SELECT id,workspace_id,issuer_id FROM invitations WHERE token_hash=$1',[tokenHash])).rows[0];
  if(!candidate)badRequest(invalidInvitationMessage);
  const workspace=(await c.query('SELECT id,name FROM workspaces WHERE id=$1 FOR NO KEY UPDATE',[candidate.workspace_id])).rows[0];
  if(!workspace)badRequest(invalidInvitationMessage);
  const issuer=candidate.issuer_id?(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[candidate.workspace_id,candidate.issuer_id])).rows[0]:undefined;
  const {rows:[invite]}=await c.query('SELECT * FROM invitations WHERE id=$1 AND token_hash=$2 FOR UPDATE',[candidate.id,tokenHash]);
  if(!invite||invite.issuer_id!==candidate.issuer_id||invite.issuer_id&&!roleAllowed(issuer?.role,invite.role))badRequest(invalidInvitationMessage);
  const {rows:[user]}=await c.query('SELECT email FROM users WHERE id=$1 FOR UPDATE',[actor.userId]);
  const existing=(await c.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[invite.workspace_id,actor.userId])).rows[0];
  const {rows:[clock]}=await c.query('SELECT clock_timestamp() AS at');
  if(invite.accepted_at||invite.expires_at<=clock.at)badRequest(invalidInvitationMessage);
  if(!user||user.email!==invite.email)badRequest('Sign in with the email address this invitation was sent to',403);
  return fn(c,invite,workspace,existing);
 });
}

export async function inspectInvitation(actor:Actor,token:string){
 return withValidInvitation(actor,token,async(_c,invite,workspace,existing)=>({workspaceId:workspace.id,workspaceName:workspace.name,role:existing?.role??invite.role,expiresAt:invite.expires_at,alreadyMember:Boolean(existing)}));
}
export async function acceptInvitation(actor:Actor,token:string){
 return withValidInvitation(actor,token,async(c,invite,_workspace,existing)=>{
  if(!existing)await c.query('INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,$3)',[invite.workspace_id,actor.userId,invite.role]);
  // A membership FK/trigger can itself wait; do not grant an expired invitation.
  const updated=await c.query('UPDATE invitations SET accepted_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp() AND accepted_at IS NULL RETURNING id',[invite.id]);
  if(!updated.rowCount)badRequest(invalidInvitationMessage);
  await cancelInvitationMail(c,invite.id,'accepted');
  const role=existing?.role??invite.role;
  await audit(c,invite.workspace_id,actor.userId,'member.invitation_accepted',invite.id,{memberId:actor.userId,role,membershipCreated:!existing});
  return {workspaceId:invite.workspace_id,role};
 });
}
