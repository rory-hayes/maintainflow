import {randomUUID,createHash} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Actor,SchemaField} from '../../shared/types.js';
import {schemaSuggestionLimits,type SchemaSuggestion,type SchemaSuggestionProvider,type SchemaSuggestionResult} from '../../shared/schema-suggestions.js';
import {adminPool,transaction,withWorkspace,audit,badRequest,notFound} from './db.js';
import {requireActor,editors} from './auth.js';
import {readStoredObject} from './storage.js';
import {parserSchema} from './schema.js';
import {requireSuggestionCapacity,finishInitialSetup,failInitialSetup} from './parser-setup.js';
import {SchemaSuggestionProviderError} from './schema-suggestion-errors.js';

let provider:SchemaSuggestionProvider|undefined;
export function setSchemaSuggestionProvider(value:SchemaSuggestionProvider|undefined){provider=value;}
export function schemaSuggestionsConfigured(){return provider?.configured()===true;}
const input=z.object({documentId:z.string().uuid(),baseSchemaId:z.string().uuid(),requestId:z.string().uuid()}).strict();
const params=z.object({id:z.string().uuid(),suggestionId:z.string().uuid().optional()});
const columns='s.*,d.name document_name';
const joined='schema_suggestions s join documents d on d.id=s.document_id and d.workspace_id=s.workspace_id';
function publicSuggestion(row:any):SchemaSuggestion{return {
 id:row.id,parserId:row.parser_id,documentId:row.document_id,documentName:row.document_name,
 baseSchemaId:row.base_schema_id,state:row.state,attempts:row.attempts,maxAttempts:row.max_attempts,
 createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),
 schema:row.proposed_schema,error:row.error,model:row.model,promptVersion:row.prompt_version,
 tokenUsage:row.token_usage,costUsd:Number(row.cost_usd),appliedSchemaId:row.applied_schema_id,
};}
async function actorFor(request:FastifyRequest,write=false){
 const actor=await requireActor(request,{scope:write?'parsers:write':'parsers:read',...(write?{roles:editors}:{})});
 if(actor.authType==='api'&&!actor.scopes?.includes('documents:read'))badRequest('API key requires documents:read scope',403);
 return actor;
}
async function parserExists(c:PoolClient,actor:Actor,id:string,lock=false){
 const {rows:[parser]}=await c.query(`select * from parsers where id=$1 and workspace_id=$2${lock?' for update':''}`,[id,actor.workspaceId]);
 if(!parser)notFound('Parser not found');return parser;
}
export async function registerSchemaSuggestions(app:FastifyInstance){
 app.get('/api/parsers/:id/schema-suggestions',async request=>{
  const actor=await actorFor(request),{id}=params.parse(request.params);
  return withWorkspace(actor.workspaceId,async c=>{
   await parserExists(c,actor,id);
   const {rows}=await c.query(`select ${columns} from ${joined} where s.parser_id=$1 order by s.created_at desc,s.id desc limit 10`,[id]);
   return {suggestions:rows.map(publicSuggestion),available:schemaSuggestionsConfigured(),limits:{perDay:schemaSuggestionLimits.perDay,pendingPerWorkspace:schemaSuggestionLimits.pendingPerWorkspace}};
  });
 });
 app.get('/api/parsers/:id/schema-suggestions/:suggestionId',async request=>{
  const actor=await actorFor(request),{id,suggestionId}=params.parse(request.params);
  return withWorkspace(actor.workspaceId,async c=>{
   const {rows:[row]}=await c.query(`select ${columns} from ${joined} where s.id=$1 and s.parser_id=$2`,[suggestionId,id]);
   if(!row)notFound('Field suggestion not found');return {suggestion:publicSuggestion(row)};
  });
 });
 app.post('/api/parsers/:id/schema-suggestions',async(request,reply)=>{
  const actor=await actorFor(request,true),{id}=params.parse(request.params),body=input.parse(request.body);
  const suggestion=await withWorkspace(actor.workspaceId,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
   const parser=await parserExists(c,actor,id,true);
   const {rows:[prior]}=await c.query(`select ${columns} from ${joined} where s.workspace_id=$1 and s.request_id=$2`,[actor.workspaceId,body.requestId]);
   if(prior){
    if(prior.parser_id!==id||prior.document_id!==body.documentId||prior.base_schema_id!==body.baseSchemaId)badRequest('This request was already used for another field suggestion.',409);
    return publicSuggestion(prior);
   }
   if(parser.archived)badRequest('Restore this parser before suggesting fields.',409);
   if(parser.active_schema_id!==body.baseSchemaId)badRequest('The parser fields changed. Reload them before requesting suggestions.',409);
   const {rows:[doc]}=await c.query('select * from documents where id=$1 and parser_id=$2 and workspace_id=$3',[body.documentId,id,actor.workspaceId]);
   if(!doc)notFound('Document not found in this parser');
   if(!schemaSuggestionsConfigured())badRequest('AI field suggestions are unavailable. Ask your workspace administrator to check the AI connection.',503);
   if(parser.field_setup_state!=='ready')badRequest('AI-assisted setup already manages this parser. Finish setup or save your own fields first.',409);
   await requireSuggestionCapacity(c,actor.workspaceId);
   const {rows:[row]}=await c.query('insert into schema_suggestions(workspace_id,parser_id,document_id,base_schema_id,requested_by,request_id,document_sha256,config) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[actor.workspaceId,id,doc.id,body.baseSchemaId,actor.userId,body.requestId,doc.sha256,JSON.stringify({locale:parser.locale})]);
   await audit(c,actor.workspaceId,actor.userId,'schema.suggestion_requested',row.id,{parserId:id,documentId:doc.id,baseSchemaId:body.baseSchemaId});
   return publicSuggestion({...row,document_name:doc.name});
  });
  return reply.code(202).send({suggestion});
 });
}

/** Also validate injected provider results before a durable draft can be saved. */
function validatedResult(result:SchemaSuggestionResult):SchemaSuggestionResult{
 const parsed=parserSchema.safeParse(result?.schema);let count=0;
 const safeFields=(fields:SchemaField[]):boolean=>fields.every(field=>{
  count++;return field.required!==true&&field.default===undefined&&field.enum===undefined&&(!field.fields||safeFields(field.fields));
 });
 if(!parsed.success||!safeFields(parsed.data.fields)||count>schemaSuggestionLimits.maxFields||
  typeof result.model!=='string'||!result.model||result.model.length>200||typeof result.promptVersion!=='string'||!result.promptVersion||result.promptVersion.length>200||
  !Number.isFinite(result.costUsd)||result.costUsd<0||result.costUsd>=1_000_000||
  !result.tokenUsage||typeof result.tokenUsage!=='object'||Array.isArray(result.tokenUsage)||Buffer.byteLength(JSON.stringify(result.tokenUsage))>16_000)
  throw new SchemaSuggestionProviderError('AI returned an invalid field suggestion. Try a clearer sample or define the fields manually.');
 return {...result,schema:parsed.data};
}
async function suggestWithDeadline(work:(signal:AbortSignal)=>Promise<SchemaSuggestionResult|undefined>,options:{signal?:AbortSignal;providerTimeoutMs?:number}){
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 let interrupt!:(error:Error)=>void;
 const interrupted=new Promise<never>((_,reject)=>{interrupt=reject;});
 const abort=()=>{interrupt(new SchemaSuggestionProviderError('Field suggestion interrupted. A retry is scheduled.',false));controller.abort();};
 options.signal?.addEventListener('abort',abort,{once:true});
 if(options.signal?.aborted)abort();else timer=setTimeout(()=>{
  interrupt(new SchemaSuggestionProviderError('Field suggestion timed out. A retry is scheduled.',false));controller.abort();
 },options.providerTimeoutMs??90_000);
 try{return await Promise.race([controller.signal.aborted?interrupted:work(controller.signal),interrupted]);}
 finally{if(timer)clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}

async function lockSuggestionParser(c:PoolClient,workspaceId:string,parserId:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[workspaceId]);
 return (await c.query('select * from parsers where id=$1 for update',[parserId])).rows[0];
}
async function failCurrentSetup(c:PoolClient,parser:any,row:any){
 if(row.auto_setup&&row.state==='failed'&&parser?.field_setup_state==='suggesting'&&parser.field_setup_suggestion_id===row.id)await failInitialSetup(c,parser,row.error||'Field discovery failed. Retry setup or define the fields yourself.');
}
async function recoverExpiredSuggestions(onlyId?:string){
 const candidates=(await adminPool.query("select id,workspace_id,parser_id from schema_suggestions where state='processing' and lease_until<now() and ($1::uuid is null or id=$1) order by lease_until,id limit 20",[onlyId??null])).rows;
 for(const candidate of candidates)await transaction(adminPool,async c=>{
  const parser=await lockSuggestionParser(c,candidate.workspace_id,candidate.parser_id);
  const {rows:[row]}=await c.query("update schema_suggestions set state=case when attempts>=max_attempts then 'failed' else 'queued' end,lease_owner=null,lease_until=null,error='Field suggestion was interrupted. Try again if it does not recover.',updated_at=now() where id=$1 and state='processing' and lease_until<now() returning *",[candidate.id]);
  if(row?.state==='failed'){await audit(c,row.workspace_id,null,'schema.suggestion_failed',row.id,{parserId:row.parser_id,reason:'lease_expired'});await failCurrentSetup(c,parser,row);}
 });
}

export async function processOneSchemaSuggestion(onlyId?:string,options:{signal?:AbortSignal;providerTimeoutMs?:number}={}){
 if(options.providerTimeoutMs!==undefined&&(!Number.isFinite(options.providerTimeoutMs)||options.providerTimeoutMs<=0||options.providerTimeoutMs>90_000))throw new Error('Suggestion deadline must be positive and at most 90 seconds');
 if(options.signal?.aborted)return false;
 await recoverExpiredSuggestions(onlyId);
 if(options.signal?.aborted)return false;
 const owner=randomUUID();
 const job=await transaction(adminPool,async c=>{
  const {rows:[selected]}=await c.query(`select s.* from schema_suggestions s join workspaces w on w.id=s.workspace_id
   where s.state='queued' and s.available_at<=now() and s.attempts<s.max_attempts
   and ($1::uuid is not null or not exists(select 1 from jobs earlier where earlier.workspace_id=s.workspace_id and earlier.state='queued' and not earlier.waiting_for_schema and earlier.available_at<=now() and earlier.created_at<s.created_at)) and ($1::uuid is null or s.id=$1)
   and ((select count(*) from jobs j where j.workspace_id=s.workspace_id and j.state='processing')+
        (select count(*) from schema_suggestions running where running.workspace_id=s.workspace_id and running.state='processing'))<coalesce((w.plan->>'maxConcurrent')::int,2)
   order by s.created_at,s.id for update of s,w skip locked limit 1`,[onlyId??null]);
  if(!selected)return null;
  if(!await hasWorkspaceExtractionCapacity(c,selected.workspace_id))return null;
  await c.query("update schema_suggestions set state='processing',attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '120 seconds',error=null,updated_at=now() where id=$1",[selected.id,owner]);
  return {...selected,attempts:selected.attempts+1};
 });
 if(!job)return false;
 try{
  // The lease covers the entire attempt, including slow private storage. A read
  // that ignores cancellation must never start a late provider call after timeout.
  const result=await suggestWithDeadline(async signal=>{
   const data=await withWorkspace(job.workspace_id,async c=>{
    const {rows:[doc]}=await c.query('select d.*,p.archived from documents d join parsers p on p.id=d.parser_id where d.id=$1 and d.parser_id=$2',[job.document_id,job.parser_id]);
    return doc;
   });
   if(!data)return undefined;
   signal.throwIfAborted();
   if(data.archived)throw new SchemaSuggestionProviderError('The parser was archived. Restore it before requesting new suggestions.');
   if(data.sha256!==job.document_sha256)throw new SchemaSuggestionProviderError('The sample document changed. Request a new field suggestion.');
   const active=provider;
   if(!active?.configured())throw new SchemaSuggestionProviderError('AI field suggestions are unavailable. Check the AI connection before trying again.');
   const bytes=await readStoredObject(data.storage_key);
   signal.throwIfAborted();
   if(createHash('sha256').update(bytes).digest('hex')!==job.document_sha256)throw new SchemaSuggestionProviderError('The sample document could not be verified. Upload it again before suggesting fields.');
   const value=await active.suggest({bytes,mimeType:data.mime_type,pages:data.source_text,locale:job.config.locale,signal});
   signal.throwIfAborted();return validatedResult(value);
  },options);
  if(!result)return true;
  await withWorkspace(job.workspace_id,async c=>{
   await lockSuggestionParser(c,job.workspace_id,job.parser_id);
   const changed=await c.query("update schema_suggestions set state='ready',completed_at=now(),lease_owner=null,lease_until=null,proposed_schema=$3,model=$4,prompt_version=$5,token_usage=$6,cost_usd=$7,error=null,updated_at=now() where id=$1 and lease_owner=$2 and state='processing' returning *",[job.id,owner,JSON.stringify(result.schema),result.model,result.promptVersion,JSON.stringify(result.tokenUsage),result.costUsd]);
   if(changed.rowCount){await audit(c,job.workspace_id,null,'schema.suggestion_ready',job.id,{parserId:job.parser_id,documentId:job.document_id});await finishInitialSetup(c,changed.rows[0]);}
  });
 }catch(error){
  const trusted=error instanceof SchemaSuggestionProviderError;
  const permanent=trusted&&error.permanent||job.attempts>=job.max_attempts;
  const safeMessage=trusted?error.message.slice(0,500):'Field suggestions could not be completed. Try again shortly.';
  const message=permanent?safeMessage.replace('A retry is scheduled.','Request a new suggestion to try again.'):safeMessage;
  await withWorkspace(job.workspace_id,async c=>{
   const parser=await lockSuggestionParser(c,job.workspace_id,job.parser_id);
   const changed=await c.query("update schema_suggestions set state=$3,lease_owner=null,lease_until=null,error=$4,available_at=now()+($5*interval '1 second'),updated_at=now() where id=$1 and lease_owner=$2 and state='processing' returning *",[job.id,owner,permanent?'failed':'queued',message,Math.min(60,2**job.attempts)]);
   if(changed.rowCount&&permanent){await audit(c,job.workspace_id,null,'schema.suggestion_failed',job.id,{parserId:job.parser_id,reason:trusted?'provider_failed':'processing_failed'});await failCurrentSetup(c,parser,changed.rows[0]);}
  });
 }
 return true;
}

/** Recheck in a fresh statement after locking the workspace row during a claim. */
export async function hasWorkspaceExtractionCapacity(c:PoolClient,workspaceId:string){
 const {rows:[row]}=await c.query(`select ((select count(*) from jobs where workspace_id=$1 and state='processing')+
  (select count(*) from schema_suggestions where workspace_id=$1 and state='processing'))<coalesce((plan->>'maxConcurrent')::int,2) allowed
  from workspaces where id=$1`,[workspaceId]);
 return row?.allowed===true;
}
