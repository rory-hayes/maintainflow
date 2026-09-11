import '@fastify/cookie';
import {randomBytes,createHash,scrypt as scryptCallback,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import type {FastifyRequest,FastifyReply} from 'fastify';
import type {Actor,Role} from '../../shared/types.js';
import {adminPool,badRequest} from './db.js';
import {config} from './config.js';
const scrypt=promisify(scryptCallback);
export const hashToken=(value:string)=>createHash('sha256').update(value).digest('hex');
export const newToken=()=>randomBytes(32).toString('base64url');
export async function hashPassword(password:string){const salt=randomBytes(16).toString('hex');const hash=await scrypt(password,salt,64) as Buffer;return `${salt}:${hash.toString('hex')}`;}
export async function verifyPassword(password:string,encoded:string){const [salt,hash]=encoded.split(':');if(!salt||!hash)return false;const expected=Buffer.from(hash,'hex');const value=await scrypt(password,salt,64) as Buffer;return expected.length===value.length&&timingSafeEqual(expected,value);}
export async function createSession(reply:FastifyReply,userId:string,workspaceId:string){const token=newToken();await adminPool.query("insert into sessions(token_hash,user_id,workspace_id,expires_at) values($1,$2,$3,now()+interval '14 days')",[hashToken(token),userId,workspaceId]);reply.setCookie('folio_session',token,{path:'/',httpOnly:true,sameSite:'lax',secure:config.production,maxAge:14*86400});}
export async function requireActor(request:FastifyRequest,options:{roles?:Role[];scope?:string}={}):Promise<Actor>{
 const header=request.headers.authorization;let actor:Actor;
 if(header?.startsWith('Bearer ')){
  const token=header.slice(7);if(!token.startsWith('fl_'))badRequest('Invalid API key',401);
  const {rows}=await adminPool.query('select k.*,m.role from api_keys k join memberships m on m.workspace_id=k.workspace_id and m.user_id=k.user_id where k.token_hash=$1 and k.revoked_at is null',[hashToken(token)]);const key=rows[0];if(!key)badRequest('Invalid or revoked API key',401);
  if(options.scope&&!key.scopes.includes(options.scope))badRequest(`API key requires ${options.scope} scope`,403);
  actor={userId:key.user_id,workspaceId:key.workspace_id,role:key.role,authType:'api',scopes:key.scopes};
  await adminPool.query('update api_keys set last_used_at=now() where id=$1',[key.id]);
 }else{
  const token=request.cookies?.folio_session;if(!token)badRequest('Sign in to continue',401);
  const {rows}=await adminPool.query('select * from sessions where token_hash=$1 and expires_at>now()',[hashToken(token)]);const session=rows[0];if(!session)badRequest('Your session has expired. Sign in again.',401);
  const workspaceHeader=request.headers['x-workspace-id'];const workspaceId=typeof workspaceHeader==='string'?workspaceHeader:session.workspace_id;
  if(!/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(workspaceId))badRequest('Invalid workspace',400);
  const {rows:members}=await adminPool.query('select role from memberships where user_id=$1 and workspace_id=$2',[session.user_id,workspaceId]);if(!members[0])badRequest('Workspace access denied',403);
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){
   const origin=request.headers.origin;if(origin&&origin!==config.origin)badRequest('Request origin is not allowed',403);
   const fetchSite=request.headers['sec-fetch-site'];if(fetchSite==='cross-site')badRequest('Cross-site requests are not allowed',403);
  }
  actor={userId:session.user_id,workspaceId,role:members[0].role,authType:'session'};
 }
 if(options.roles&&!options.roles.includes(actor.role))badRequest('Your workspace role does not allow this action',403);
 return actor;
}
export const editors:Role[]=['owner','admin','editor'];
export const admins:Role[]=['owner','admin'];
export function requireSession(actor:Actor){if(actor.authType!=='session')badRequest('This action requires a browser session',403);}
