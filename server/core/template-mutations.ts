import {createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {templateLimits,templateReasonLabels} from '../../shared/template-selection.js';
import {canonicalTemplateDefinition} from '../../shared/template-definitions.js';
import {requireActor,editors,hashToken} from './auth.js';
import {adminPool,transaction,badRequest,notFound,camel,audit} from './db.js';
import {templateDefinitionInput} from './template-input.js';
import {validateTemplateDefinition} from './template-region-selection.js';
import {ParserFormatNotAllowedError} from './intake-policy.js';

export const templateUuid=z.string().uuid().transform(value=>value.toLowerCase());
const revision=z.number().int().min(1).max(2147483647);
const envelope=z.object({kind:z.unknown().optional(),name:z.unknown().optional(),matchText:z.unknown().optional(),enabled:z.unknown().optional(),rules:z.unknown().optional(),requestId:templateUuid.optional(),baseSchemaId:templateUuid.optional(),baseRevision:revision.optional()}).strict();
const deletion=z.object({requestId:templateUuid.optional(),baseRevision:revision.optional()}).strict();
type Definition=z.infer<typeof templateDefinitionInput>;
type Operation='create'|'update'|'delete';
export type TemplateAuthorization={actor:Actor;tokenHash:string};
const conflict=()=>badRequest('This template request already belongs to a different change. Recover its original result or start a new change.',409);
const schemaConflict=()=>badRequest('The parser fields changed. Reload the saved fields and review your draft before saving.',409);
const revisionConflict=()=>badRequest('This template changed since you started editing. Reload the saved template and review your draft before saving.',409);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

export async function templateAuthorization(request:FastifyRequest,scopes:string[],write:boolean):Promise<TemplateAuthorization>{
 const actor=await requireActor(request,{...(write?{roles:editors}:{}),scope:scopes[0]});
 if(actor.authType==='api'&&scopes.some(scope=>!actor.scopes?.includes(scope)))badRequest('API key does not allow this template action',403);
 const token=actor.authType==='api'?request.headers.authorization?.slice(7):request.cookies?.folio_session;
 if(!token)badRequest('Sign in to continue',401);
 return {actor,tokenHash:hashToken(token)};
}

/** Explicit scopes avoid imposing document-write permission on a template save.
 * No source I/O runs inside this short current-credential fence. */
export async function withTemplateAuthorization<T>(auth:TemplateAuthorization,scopes:string[],write:boolean,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
 const a=auth.actor;
 try{return await transaction(adminPool,async c=>{
  await c.query("select set_config('app.workspace_id',$1,true),set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)",[a.workspaceId]);
  if(!(await c.query('select id from users where id=$1 for key share nowait',[a.userId])).rowCount)badRequest('Your access has expired. Sign in again.',401);
  const membership=(await c.query('select role from memberships where workspace_id=$1 and user_id=$2 for share nowait',[a.workspaceId,a.userId])).rows[0];
  if(!membership||write&&!editors.includes(membership.role))badRequest('Your workspace role does not allow this action',403);
  const credential=a.authType==='api'
   ?(await c.query('select id from api_keys where token_hash=$1 and user_id=$2 and workspace_id=$3 for share nowait',[auth.tokenHash,a.userId,a.workspaceId])).rows[0]
   :(await c.query('select id from sessions where token_hash=$1 and user_id=$2 for share nowait',[auth.tokenHash,a.userId])).rows[0];
  if(!credential)badRequest('Your access has expired or been revoked. Sign in again.',401);
  const valid=async()=>{
   const found=a.authType==='api'
    ?await c.query(`select k.scopes from api_keys k join users u on u.id=k.user_id where k.id=$1 and k.revoked_at is null and (k.expires_at is null or k.expires_at>clock_timestamp()) and (not u.email_verification_required or u.email_verified_at is not null)`,[credential.id])
    :await c.query(`select s.id from sessions s join users u on u.id=s.user_id where s.id=$1 and s.expires_at>clock_timestamp() and (not u.email_verification_required or u.email_verified_at is not null)`,[credential.id]);
   if(!found.rowCount)badRequest('Your access has expired or been revoked. Sign in again.',401);
   if(a.authType==='api'&&scopes.some(scope=>!found.rows[0].scopes.includes(scope)))badRequest('API key does not allow this template action',403);
  };
  await valid();const result=await fn(c);await valid();return result;
 });}catch(error){if((error as {code?:string}).code==='55P03')badRequest('Workspace access is changing. Retry the same request shortly.',503);throw error;}
}

/** The caller holds the workspace advisory lock before the parser lock. */
export async function lockTemplateParser(c:PoolClient,workspaceId:string,parserId:string){
 const parser=(await c.query(`select p.*,s.schema from parsers p join schema_versions s on s.id=p.active_schema_id and s.parser_id=p.id and s.workspace_id=p.workspace_id where p.id=$1 and p.workspace_id=$2 for update of p`,[parserId,workspaceId])).rows[0];
 if(!parser)notFound('Parser not found');return parser;
}
export function requireNativeTemplateParser(parser:any,baseSchemaId?:string){
 if(parser.archived)badRequest('Restore this parser before editing native PDF regions.',409);
 if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before editing native PDF regions.',409);
 if(baseSchemaId&&parser.active_schema_id!==baseSchemaId)schemaConflict();
 if(parser.allowed_formats!==null&&!parser.allowed_formats.includes('pdf'))throw new ParserFormatNotAllowedError(parser.id,'pdf');
}

function publicTemplate(row:any){
 return {id:row.id,parserId:row.parser_id,kind:row.kind,revision:row.revision,name:row.name,matchText:row.match_text,enabled:row.enabled,rules:row.rules,createdAt:new Date(row.created_at).toISOString()};
}
async function publicMutation(c:PoolClient,row:any,replayed:boolean){
 const current=row.template_id?(await c.query('select revision from templates where id=$1 and parser_id=$2 and workspace_id=$3',[row.template_id,row.parser_id,row.workspace_id])).rows[0]:null;
 return {template:row.accepted_template,mutation:{requestId:row.request_id,state:row.state,operation:row.operation,templateId:row.template_id,acceptedRevision:row.accepted_revision,currentRevision:current?.revision??null,deleted:row.state==='accepted'&&!current,replayed}};
}
function parsedMutation(operation:Operation,payload:unknown){
 if(operation==='delete')return {...deletion.parse(payload??{}),baseSchemaId:undefined,definition:undefined};
 const {requestId,baseSchemaId,baseRevision,...definition}=envelope.parse(payload);
 return {requestId,baseSchemaId,baseRevision,definition:templateDefinitionInput.parse(definition)};
}

export async function mutateTemplate(auth:TemplateAuthorization,operation:Operation,id:string,payload:unknown){
 const input=parsedMutation(operation,payload),a=auth.actor;
 return withTemplateAuthorization(auth,['parsers:write'],true,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);
  const prior=input.requestId?(await c.query('select * from template_mutations where workspace_id=$1 and request_id=$2',[a.workspaceId,input.requestId])).rows[0]:null;
  if(prior&&prior.requested_by!==a.userId)notFound('Template change not found');
  const existing=operation==='create'?null:(await c.query('select * from templates where id=$1 and workspace_id=$2',[id,a.workspaceId])).rows[0];
  const parserId=operation==='create'?id:existing?.parser_id??prior?.parser_id;
  if(!parserId)notFound('Template not found');
  if(prior&&(prior.parser_id!==parserId||prior.operation!==null&&(prior.operation!==operation||prior.template_id!==id&&operation!=='create')))conflict();
  const parser=await lockTemplateParser(c,a.workspaceId,parserId);
  const requestHash=digest(JSON.stringify({operation,parserId,templateId:operation==='create'?null:id,baseSchemaId:input.baseSchemaId??null,baseRevision:input.baseRevision??null,definition:input.definition?canonicalTemplateDefinition(input.definition):null}));
  if(prior){
   if(prior.state==='closed')badRequest('This template change was closed without saving. Start a new change to save a definition.',410);
   if(prior.request_hash!==requestHash)conflict();
   return publicMutation(c,prior,true);
  }
  if(operation!=='create'&&!existing)notFound('Template not found');
  const native=input.definition?.kind==='native-pdf-region-v1'||existing?.kind==='native-pdf-region-v1';
  if(native&&!input.requestId)badRequest('A request ID is required for a native PDF template change.');
  if(operation==='create'&&input.baseRevision!==undefined)badRequest('A new template cannot have a previous revision.');
  if(input.requestId&&operation!=='delete'&&!input.baseSchemaId)badRequest('The current parser schema ID is required for this template change.');
  if((input.requestId||native)&&operation!=='create'&&input.baseRevision===undefined)badRequest('The saved template revision is required for this change.');
  if(input.baseSchemaId&&parser.active_schema_id!==input.baseSchemaId)schemaConflict();
  if(existing&&input.baseRevision!==undefined&&existing.revision!==input.baseRevision)revisionConflict();
  if(existing&&input.definition&&input.definition.kind!==existing.kind)badRequest('A template cannot change its extraction kind. Create a separate template instead.',409);
  if(existing&&existing.revision===2147483647)badRequest('This template reached its revision limit. Create a separate template.',409);
  if(input.definition){
   if(native&&input.definition.enabled)requireNativeTemplateParser(parser,input.baseSchemaId);
   if(input.definition.enabled){const validation=validateTemplateDefinition(parser.schema,input.definition);if(!validation.valid)badRequest(validation.reasons.map(reason=>templateReasonLabels[reason]??'The template definition is invalid.').join(' '));}
  }
  let saved:any=null,templateId=id,acceptedRevision=existing?existing.revision+1:1;
  if(operation==='create'){
   if((await c.query('select count(*)::int count from templates where parser_id=$1 and workspace_id=$2',[parserId,a.workspaceId])).rows[0].count>=templateLimits.templates)badRequest(`This parser already has ${templateLimits.templates} templates. Delete a template before adding another.`,429);
   const b=input.definition!;
   saved=(await c.query('insert into templates(workspace_id,parser_id,kind,name,match_text,rules,enabled) values($1,$2,$3,$4,$5,$6,$7) returning *',[a.workspaceId,parserId,b.kind,b.name,b.matchText,JSON.stringify(b.rules),b.enabled])).rows[0];templateId=saved.id;
  }else if(operation==='update'){
   const b=input.definition!;
   saved=(await c.query('update templates set kind=$2,name=$3,match_text=$4,rules=$5,enabled=$6,revision=revision+1 where id=$1 and workspace_id=$7 and parser_id=$8 and revision=$9 returning *',[id,b.kind,b.name,b.matchText,JSON.stringify(b.rules),b.enabled,a.workspaceId,parserId,existing.revision])).rows[0];
   if(!saved)revisionConflict();
  }else if(!(await c.query('delete from templates where id=$1 and workspace_id=$2 and parser_id=$3 and revision=$4 returning id',[id,a.workspaceId,parserId,existing.revision])).rowCount)revisionConflict();
  const acceptedTemplate=saved?publicTemplate(saved):null;
  let receipt:any;
  if(input.requestId)receipt=(await c.query('insert into template_mutations(workspace_id,parser_id,requested_by,request_id,state,operation,template_id,request_hash,base_schema_id,base_revision,accepted_revision,accepted_template) values($1,$2,$3,$4,\'accepted\',$5,$6,$7,$8,$9,$10,$11) returning *',[a.workspaceId,parserId,a.userId,input.requestId,operation,templateId,requestHash,input.baseSchemaId??null,input.baseRevision??null,acceptedRevision,acceptedTemplate?JSON.stringify(acceptedTemplate):null])).rows[0];
  await audit(c,a.workspaceId,a.userId,`template.${operation==='create'?'created':operation==='update'?'updated':'deleted'}`,templateId,{revision:acceptedRevision,...(input.requestId?{requestId:input.requestId}:{})});
  return receipt?publicMutation(c,receipt,false):operation==='delete'?{ok:true}:{template:camel(saved)};
 });
}

export function registerTemplateMutations(app:FastifyInstance){
 app.post('/api/parsers/:id/templates',async request=>{const auth=await templateAuthorization(request,['parsers:write'],true),{id}=z.object({id:templateUuid}).parse(request.params);return mutateTemplate(auth,'create',id,request.body);});
 app.patch('/api/templates/:id',async request=>{const auth=await templateAuthorization(request,['parsers:write'],true),{id}=z.object({id:templateUuid}).parse(request.params);return mutateTemplate(auth,'update',id,request.body);});
 app.delete('/api/templates/:id',async request=>{const auth=await templateAuthorization(request,['parsers:write'],true),{id}=z.object({id:templateUuid}).parse(request.params);return mutateTemplate(auth,'delete',id,request.body);});
 const params=z.object({id:templateUuid,requestId:templateUuid});
 async function recover(request:FastifyRequest,close:boolean){
  const auth=await templateAuthorization(request,['parsers:write'],true),{id,requestId}=params.parse(request.params),a=auth.actor;
  if(close)z.object({}).strict().parse(request.body??{});
  return withTemplateAuthorization(auth,['parsers:write'],true,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);
   await lockTemplateParser(c,a.workspaceId,id);
   let row=(await c.query('select * from template_mutations where workspace_id=$1 and request_id=$2',[a.workspaceId,requestId])).rows[0];
   if(row&&(row.parser_id!==id||row.requested_by!==a.userId))notFound('Template change not found');
   if(!row&&!close)notFound('Template change not found');
   if(!row)row=(await c.query("insert into template_mutations(workspace_id,parser_id,requested_by,request_id,state) values($1,$2,$3,$4,'closed') returning *",[a.workspaceId,id,a.userId,requestId])).rows[0];
   return publicMutation(c,row,true);
  });
 }
 app.get('/api/parsers/:id/template-mutations/requests/:requestId',request=>recover(request,false));
 app.post('/api/parsers/:id/template-mutations/requests/:requestId/close',request=>recover(request,true));
}
