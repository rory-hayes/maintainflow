import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {adminPool,transaction,badRequest,camel} from './db.js';
import {hashPassword,verifyPassword,createSession,requireActor,hashToken,requireSession} from './auth.js';
import {config,defaultPlan} from './config.js';
import {acceptsPreviewInvite} from './preview.js';
import {registerAccountRecoveryRoutes} from './account-recovery-routes.js';
import {changeAccountPassword} from './account-recovery.js';
import {authenticationRateLimit} from './rate-limit.js';
const credentials=z.object({email:z.string().email().max(254).transform(v=>v.trim().toLowerCase()),password:z.string().min(10).max(128)});
// Password creation rules must not reject an existing credential at sign-in.
const loginCredentials=z.object({email:z.string().max(254).trim().email().toLowerCase(),password:z.string().min(1).max(128)});
const incorrectCredentials='Email or password is incorrect';
function authOrigin(origin:string|undefined){if(origin&&origin!==config.origin)badRequest('Request origin is not allowed',403);}
export async function sessionResponse(userId:string,workspaceId:string){const user=(await adminPool.query('select id,email,name,created_at from users where id=$1',[userId])).rows[0];const workspaces=(await adminPool.query('select w.*,m.role from memberships m join workspaces w on w.id=m.workspace_id where m.user_id=$1 order by w.created_at',[userId])).rows.map(camel);return {user:camel(user),workspace:workspaces.find(w=>w.id===workspaceId),workspaces};}
export async function registerAuth(app:FastifyInstance){
app.post('/api/auth/register',{config:{rateLimit:authenticationRateLimit}},async(req,reply)=>{authOrigin(req.headers.origin);const body=credentials.extend({name:z.string().trim().min(1).max(100),workspaceName:z.string().trim().min(1).max(100),inviteCode:z.string().max(256).optional()}).parse(req.body);if(!acceptsPreviewInvite(body.inviteCode))badRequest('An invite code is required for this test preview.',403);const passwordHash=await hashPassword(body.password);const ids=await transaction(adminPool,async c=>{if((await c.query('select 1 from users where email=$1',[body.email])).rowCount)badRequest('This email is already registered',409);const {rows:[u]}=await c.query('insert into users(email,name,password_hash) values($1,$2,$3) returning id',[body.email,body.name,passwordHash]);const {rows:[w]}=await c.query('insert into workspaces(name,slug,plan) values($1,$2,$3) returning id',[body.workspaceName,`${body.workspaceName.toLowerCase().replace(/[^a-z0-9]+/g,'-')}-${randomUUID().slice(0,8)}`,JSON.stringify(defaultPlan)]);await c.query('insert into memberships(workspace_id,user_id,role) values($1,$2,$3)',[w.id,u.id,'owner']);return {userId:u.id,workspaceId:w.id};});await createSession(reply,ids.userId,ids.workspaceId,passwordHash);reply.code(201);return sessionResponse(ids.userId,ids.workspaceId);});
app.post('/api/auth/login',{config:{rateLimit:authenticationRateLimit}},async(req,reply)=>{
 authOrigin(req.headers.origin);
 const parsed=loginCredentials.safeParse(req.body);
 if(!parsed.success)badRequest(incorrectCredentials,401);
 const body=parsed.data;
 const user=(await adminPool.query('select * from users where email=$1',[body.email])).rows[0];
 const encoded=user?.password_hash||'da53db997e44c565658e207d0b21eaa77:'+ '0'.repeat(128);
 if(!await verifyPassword(body.password,encoded)||!user)badRequest(incorrectCredentials,401);
 const member=(await adminPool.query('select workspace_id from memberships where user_id=$1 order by created_at limit 1',[user.id])).rows[0];
 if(!member)badRequest(incorrectCredentials,401);
 await createSession(reply,user.id,member.workspace_id,user.password_hash);
 return sessionResponse(user.id,member.workspace_id);
});
app.get('/api/auth/me',async req=>{const actor=await requireActor(req);requireSession(actor);return sessionResponse(actor.userId,actor.workspaceId);});
app.post('/api/auth/logout',async(req,reply)=>{const actor=await requireActor(req);requireSession(actor);await adminPool.query('delete from sessions where token_hash=$1',[hashToken(req.cookies.folio_session!)]);reply.clearCookie('folio_session',{path:'/'});return {ok:true};});
app.get('/api/workspaces',async req=>{const a=await requireActor(req);requireSession(a);return {workspaces:(await sessionResponse(a.userId,a.workspaceId)).workspaces};});
app.post('/api/workspaces',async req=>{const a=await requireActor(req);requireSession(a);const body=z.object({name:z.string().trim().min(1).max(100)}).parse(req.body);const w=await transaction(adminPool,async c=>{const {rows:[w]}=await c.query('insert into workspaces(name,slug,plan) values($1,$2,$3) returning *',[body.name,randomUUID(),JSON.stringify(defaultPlan)]);await c.query('insert into memberships(workspace_id,user_id,role) values($1,$2,$3)',[w.id,a.userId,'owner']);return w;});return {workspace:{...camel(w),role:'owner'}};});
app.post('/api/workspaces/:id/select',async req=>{const a=await requireActor(req);requireSession(a);const id=z.object({id:z.string().uuid()}).parse(req.params).id;if(!(await adminPool.query('select 1 from memberships where workspace_id=$1 and user_id=$2',[id,a.userId])).rowCount)badRequest('Workspace access denied',403);await adminPool.query('update sessions set workspace_id=$1 where token_hash=$2',[id,hashToken(req.cookies.folio_session!)]);return sessionResponse(a.userId,id);});
app.post('/api/auth/password',{config:{rateLimit:authenticationRateLimit}},async req=>{const a=await requireActor(req);requireSession(a);const body=z.object({currentPassword:z.string().max(128),newPassword:z.string().min(10).max(128)}).parse(req.body);return changeAccountPassword(a.userId,req.cookies.folio_session!,body.currentPassword,body.newPassword);});
await registerAccountRecoveryRoutes(app);
}
