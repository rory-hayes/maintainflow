import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {requireActor,editors,admins} from './auth.js';
import {withWorkspace,camel,badRequest,notFound,audit} from './db.js';
import {parserSchema} from './schema.js';
import {presets} from '../../shared/presets.js';
import {parserSetupStatus,queueInitialSetup,releaseInitialJobs} from './parser-setup.js';
import {schemaSuggestionsConfigured} from './schema-suggestions.js';
import {aiConfigured} from './worker.js';
import {allowedFormatsInput} from './intake-policy.js';
const idFrom=(p:unknown)=>z.object({id:z.string().uuid()}).parse(p).id;
const locale=z.string().max(35).refine(v=>{try{new Intl.NumberFormat(v);return true;}catch{return false;}},'Invalid locale');
const timezone=z.string().max(80).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Invalid timezone');
const parserInput=z.object({setupMode:z.enum(['preset','sample']).default('preset'),name:z.string().trim().min(1).max(100),useCase:z.enum(['invoice','purchase_order','receipt','leads','custom']).default('custom'),mode:z.enum(['rules','ai']).default('rules'),instructions:z.string().max(8000).default(''),locale:locale.default('en-IE'),timezone:timezone.default('Europe/Dublin'),schema:parserSchema.optional(),allowedFormats:allowedFormatsInput.optional()});
// Creation defaults must never reset settings omitted from a partial update.
const parserPatch=z.object({name:parserInput.shape.name.optional(),mode:z.enum(['rules','ai']).optional(),instructions:z.string().max(8000).optional(),locale:locale.optional(),timezone:timezone.optional(),archived:z.boolean().optional(),allowedFormats:allowedFormatsInput.optional()});
// Call only after taking the workspace advisory lock shared by create/archive/restore.
async function requireParserCapacity(c:PoolClient,workspaceId:string){
 const {rows:[usage]}=await c.query('select count(*)::integer count from parsers where workspace_id=$1 and archived=false',[workspaceId]);
 const {rows:[workspace]}=await c.query('select plan from workspaces where id=$1',[workspaceId]);
 if(usage.count>=workspace.plan.maxParsers)badRequest('The workspace parser limit has been reached',429);
}
export async function registerParsers(app:FastifyInstance){
app.get('/api/presets',async()=>({presets:Object.entries(presets).map(([id,p])=>({id,...p})),providers:{setup:{configured:aiConfigured()&&schemaSuggestionsConfigured(),message:aiConfigured()&&schemaSuggestionsConfigured()?'AI-assisted setup is available.':'AI-assisted setup needs both field discovery and extraction providers.'},ai:{configured:aiConfigured(),message:aiConfigured()?'Provider configured; verify with your documents.':'AI provider is not configured. Text-anchor parsing is available.'}}}));
app.get('/api/parsers',async req=>{const a=await requireActor(req,{scope:'parsers:read'});return withWorkspace(a.workspaceId,async c=>({parsers:(await c.query('select p.*,(select count(*)::int from documents d where d.parser_id=p.id) document_count,(select count(*)::int from documents d where d.parser_id=p.id and d.status=$2) review_count from parsers p where p.workspace_id=$1 order by p.archived,p.created_at desc',[a.workspaceId,'needs_review'])).rows.map(camel)}));});
app.post('/api/parsers',async(req,reply)=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});const body=parserInput.parse(req.body);if(body.setupMode==='sample'){if(body.mode!=='ai'||body.useCase!=='custom'||body.schema)badRequest('Sample setup requires AI mode, a custom parser, and no preset schema override.');if(a.authType==='api'&&!a.scopes?.includes('documents:read'))badRequest('API key requires documents:read scope',403);if(!aiConfigured()||!schemaSuggestionsConfigured())badRequest('AI-assisted setup is unavailable. Configure field discovery and extraction first.',503);}const schema=body.schema||{fields:presets[body.useCase].fields};const result=await withWorkspace(a.workspaceId,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);await requireParserCapacity(c,a.workspaceId);const {rows:[p]}=await c.query('insert into parsers(workspace_id,name,use_case,mode,instructions,locale,timezone,allowed_formats,field_setup_state) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[a.workspaceId,body.name,body.useCase,body.mode,body.instructions,body.locale,body.timezone,body.allowedFormats??null,body.setupMode==='sample'?'awaiting_sample':'ready']);const {rows:[s]}=await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) values($1,$2,1,$3,$4) returning *',[a.workspaceId,p.id,JSON.stringify(schema),a.userId]);await c.query('update parsers set active_schema_id=$2 where id=$1',[p.id,s.id]);await audit(c,a.workspaceId,a.userId,'parser.created',p.id);return {parser:camel({...p,active_schema_id:s.id}),schema:{id:s.id,version:s.version,...s.schema}};});reply.code(201);return result;});
app.get('/api/parsers/:id',async req=>{const a=await requireActor(req,{scope:'parsers:read'});const id=idFrom(req.params);return withWorkspace(a.workspaceId,async c=>{const p=(await c.query('select * from parsers where id=$1 and workspace_id=$2',[id,a.workspaceId])).rows[0];if(!p)notFound('Parser not found');const schemas=(await c.query('select * from schema_versions where parser_id=$1 order by version desc',[id])).rows.map(s=>({id:s.id,version:s.version,createdAt:s.created_at,...s.schema}));const templates=(await c.query('select * from templates where parser_id=$1 order by created_at',[id])).rows.map(camel);return {parser:camel(p),schema:schemas.find(s=>s.id===p.active_schema_id),schemas,templates};});});
app.get('/api/parsers/:id/setup',async req=>{
 const a=await requireActor(req,{scope:'parsers:read'}),id=idFrom(req.params);
 if(a.authType==='api'&&!a.scopes?.includes('documents:read'))badRequest('API key requires documents:read scope',403);
 return withWorkspace(a.workspaceId,async c=>{const {rows:[parser]}=await c.query('select * from parsers where id=$1 and workspace_id=$2',[id,a.workspaceId]);if(!parser)notFound();return {setup:await parserSetupStatus(c,parser,aiConfigured()&&schemaSuggestionsConfigured())};});
});
app.post('/api/parsers/:id/setup/retry',async(req,reply)=>{
 const a=await requireActor(req,{roles:editors,scope:'parsers:write'}),id=idFrom(req.params),b=z.object({documentId:z.uuid(),requestId:z.uuid()}).strict().parse(req.body);
 if(a.authType==='api'&&!a.scopes?.includes('documents:read'))badRequest('API key requires documents:read scope',403);
 const result=await withWorkspace(a.workspaceId,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);
  const {rows:[parser]}=await c.query('select * from parsers where id=$1 and workspace_id=$2 for update',[id,a.workspaceId]);if(!parser)notFound();
  const {rows:[document]}=await c.query('select * from documents where id=$1 and parser_id=$2',[b.documentId,id]);if(!document)notFound('Document not found in this parser');
  const prior=(await c.query('select id from schema_suggestions where workspace_id=$1 and request_id=$2',[a.workspaceId,b.requestId])).rowCount;
  if(!prior&&(!aiConfigured()||!schemaSuggestionsConfigured()))badRequest('AI-assisted setup is unavailable. Configure field discovery and extraction first.',503);
  await queueInitialSetup(c,a,parser,document,b.requestId);
  const current=(await c.query('select * from parsers where id=$1',[id])).rows[0];return {setup:await parserSetupStatus(c,current,aiConfigured()&&schemaSuggestionsConfigured())};
 });return reply.code(202).send(result);
});
app.patch('/api/parsers/:id',async req=>{
 const a=await requireActor(req,{roles:editors,scope:'parsers:write'}),id=idFrom(req.params),b=parserPatch.parse(req.body);
 return withWorkspace(a.workspaceId,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);
  const p=(await c.query('select * from parsers where id=$1 and workspace_id=$2 for update',[id,a.workspaceId])).rows[0];
  if(!p)notFound();
  if(p.archived&&b.archived===false)await requireParserCapacity(c,a.workspaceId);
  const {rows:[updated]}=await c.query('update parsers set name=$2,mode=$3,instructions=$4,locale=$5,timezone=$6,archived=$7,allowed_formats=$8 where id=$1 returning *',[id,b.name??p.name,b.mode??p.mode,b.instructions??p.instructions,b.locale??p.locale,b.timezone??p.timezone,b.archived??p.archived,b.allowedFormats===undefined?p.allowed_formats:b.allowedFormats]);
  await audit(c,a.workspaceId,a.userId,'parser.updated',id,b.allowedFormats===undefined?{}:{allowedFormats:updated.allowed_formats});
  return {parser:camel(updated)};
 });
});
const schemaSave=parserSchema.safeExtend({baseSchemaId:z.string().uuid().optional(),suggestionId:z.string().uuid().optional()});
app.post('/api/parsers/:id/schema',async req=>{
 const a=await requireActor(req,{roles:editors,scope:'parsers:write'}),id=idFrom(req.params),body=schemaSave.parse(req.body);
 const schema=parserSchema.parse({fields:body.fields});
 return withWorkspace(a.workspaceId,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);
  const {rows:[parser]}=await c.query('select * from parsers where id=$1 and workspace_id=$2 for update',[id,a.workspaceId]);
  if(!parser)notFound();
  if(body.baseSchemaId&&parser.active_schema_id!==body.baseSchemaId)badRequest('The parser fields changed since you started editing. Reload the saved fields and review your changes before saving.',409);
  if(body.suggestionId){
   if(!body.baseSchemaId)badRequest('The original schema version is required when saving suggested fields.');
   if(parser.archived)badRequest('Restore this parser before saving suggested fields.',409);
   if(a.authType==='api'&&!a.scopes?.includes('documents:read'))badRequest('API key requires documents:read scope',403);
   const {rows:[suggestion]}=await c.query('select * from schema_suggestions where id=$1 and parser_id=$2 for update',[body.suggestionId,id]);
   if(!suggestion)notFound('Field suggestion not found');
   if(suggestion.state!=='ready'||suggestion.applied_schema_id||suggestion.base_schema_id!==body.baseSchemaId)badRequest('This suggestion cannot be applied. Reload the fields or request a new suggestion.',409);
  }
  const {rows:[version]}=await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) select $1,$2,coalesce(max(version),0)+1,$3,$4 from schema_versions where parser_id=$2 returning *',[a.workspaceId,id,JSON.stringify(schema),a.userId]);
  await c.query("update parsers set active_schema_id=$2,field_setup_state='ready',field_setup_suggestion_id=case when field_setup_state='ready' then field_setup_suggestion_id else null end,field_setup_error=null where id=$1",[id,version.id]);
  if(parser.field_setup_state!=='ready'){const documents=await releaseInitialJobs(c,parser,version.id);await audit(c,a.workspaceId,a.userId,'parser.setup_overridden',id,{schemaId:version.id,documents});}
  if(body.suggestionId)await c.query('update schema_suggestions set applied_schema_id=$2,updated_at=now() where id=$1',[body.suggestionId,version.id]);
  await audit(c,a.workspaceId,a.userId,'schema.version_created',id,{version:version.version,...(body.suggestionId?{suggestionId:body.suggestionId}:{})});
  return {schema:{id:version.id,version:version.version,...version.schema}};
 });
});
const templateBody=z.object({name:z.string().trim().min(1).max(100),matchText:z.string().max(1000).default(''),enabled:z.boolean().default(true),rules:z.array(z.object({field:z.string().max(150),anchor:z.string().min(1).max(200)})).max(100)});
app.post('/api/parsers/:id/templates',async req=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});const id=idFrom(req.params),b=templateBody.parse(req.body);return withWorkspace(a.workspaceId,async c=>{if(!(await c.query('select id from parsers where id=$1 and workspace_id=$2',[id,a.workspaceId])).rowCount)notFound();const {rows:[t]}=await c.query('insert into templates(workspace_id,parser_id,name,match_text,rules,enabled) values($1,$2,$3,$4,$5,$6) returning *',[a.workspaceId,id,b.name,b.matchText,JSON.stringify(b.rules),b.enabled]);await audit(c,a.workspaceId,a.userId,'template.created',t.id);return {template:camel(t)};});});
app.patch('/api/templates/:id',async req=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});const id=idFrom(req.params),b=templateBody.parse(req.body);return withWorkspace(a.workspaceId,async c=>{const {rows:[t]}=await c.query('update templates set name=$2,match_text=$3,rules=$4,enabled=$5 where id=$1 returning *',[id,b.name,b.matchText,JSON.stringify(b.rules),b.enabled]);if(!t)notFound();return {template:camel(t)};});});
app.delete('/api/templates/:id',async req=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});return withWorkspace(a.workspaceId,async c=>{if(!(await c.query('delete from templates where id=$1 returning id',[idFrom(req.params)])).rowCount)notFound();return {ok:true};});});
}
