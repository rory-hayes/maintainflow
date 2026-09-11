import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {requireActor,editors,admins} from './auth.js';
import {withWorkspace,camel,badRequest,notFound,audit} from './db.js';
import {parserSchema} from './schema.js';
import {presets} from '../../shared/presets.js';
import {aiConfigured} from './worker.js';
const idFrom=(p:unknown)=>z.object({id:z.string().uuid()}).parse(p).id;
const locale=z.string().max(35).refine(v=>{try{new Intl.NumberFormat(v);return true;}catch{return false;}},'Invalid locale');
const timezone=z.string().max(80).refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Invalid timezone');
const parserInput=z.object({name:z.string().trim().min(1).max(100),useCase:z.enum(['invoice','purchase_order','receipt','leads','custom']).default('custom'),mode:z.enum(['rules','ai']).default('rules'),instructions:z.string().max(8000).default(''),locale:locale.default('en-IE'),timezone:timezone.default('Europe/Dublin'),schema:parserSchema.optional()});
// Creation defaults must never reset settings omitted from a partial update.
const parserPatch=z.object({name:parserInput.shape.name.optional(),mode:z.enum(['rules','ai']).optional(),instructions:z.string().max(8000).optional(),locale:locale.optional(),timezone:timezone.optional(),archived:z.boolean().optional()});
// Call only after taking the workspace advisory lock shared by create/archive/restore.
async function requireParserCapacity(c:PoolClient,workspaceId:string){
 const {rows:[usage]}=await c.query('select count(*)::integer count from parsers where workspace_id=$1 and archived=false',[workspaceId]);
 const {rows:[workspace]}=await c.query('select plan from workspaces where id=$1',[workspaceId]);
 if(usage.count>=workspace.plan.maxParsers)badRequest('The workspace parser limit has been reached',429);
}
export async function registerParsers(app:FastifyInstance){
app.get('/api/presets',async()=>({presets:Object.entries(presets).map(([id,p])=>({id,...p})),providers:{ai:{configured:aiConfigured(),message:aiConfigured()?'Provider configured; verify with your documents.':'AI provider is not configured. Text-anchor parsing is available.'}}}));
app.get('/api/parsers',async req=>{const a=await requireActor(req,{scope:'parsers:read'});return withWorkspace(a.workspaceId,async c=>({parsers:(await c.query('select p.*,(select count(*)::int from documents d where d.parser_id=p.id) document_count,(select count(*)::int from documents d where d.parser_id=p.id and d.status=$2) review_count from parsers p where p.workspace_id=$1 order by p.archived,p.created_at desc',[a.workspaceId,'needs_review'])).rows.map(camel)}));});
app.post('/api/parsers',async(req,reply)=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});const body=parserInput.parse(req.body);const schema=body.schema||{fields:presets[body.useCase].fields};const result=await withWorkspace(a.workspaceId,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);await requireParserCapacity(c,a.workspaceId);const {rows:[p]}=await c.query('insert into parsers(workspace_id,name,use_case,mode,instructions,locale,timezone) values($1,$2,$3,$4,$5,$6,$7) returning *',[a.workspaceId,body.name,body.useCase,body.mode,body.instructions,body.locale,body.timezone]);const {rows:[s]}=await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) values($1,$2,1,$3,$4) returning *',[a.workspaceId,p.id,JSON.stringify(schema),a.userId]);await c.query('update parsers set active_schema_id=$2 where id=$1',[p.id,s.id]);await audit(c,a.workspaceId,a.userId,'parser.created',p.id);return {parser:camel({...p,active_schema_id:s.id}),schema:{id:s.id,version:s.version,...s.schema}};});reply.code(201);return result;});
app.get('/api/parsers/:id',async req=>{const a=await requireActor(req,{scope:'parsers:read'});const id=idFrom(req.params);return withWorkspace(a.workspaceId,async c=>{const p=(await c.query('select * from parsers where id=$1 and workspace_id=$2',[id,a.workspaceId])).rows[0];if(!p)notFound('Parser not found');const schemas=(await c.query('select * from schema_versions where parser_id=$1 order by version desc',[id])).rows.map(s=>({id:s.id,version:s.version,createdAt:s.created_at,...s.schema}));const templates=(await c.query('select * from templates where parser_id=$1 order by created_at',[id])).rows.map(camel);return {parser:camel(p),schema:schemas.find(s=>s.id===p.active_schema_id),schemas,templates};});});
app.patch('/api/parsers/:id',async req=>{
 const a=await requireActor(req,{roles:editors,scope:'parsers:write'}),id=idFrom(req.params),b=parserPatch.parse(req.body);
 return withWorkspace(a.workspaceId,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspaceId]);
  const p=(await c.query('select * from parsers where id=$1 and workspace_id=$2 for update',[id,a.workspaceId])).rows[0];
  if(!p)notFound();
  if(p.archived&&b.archived===false)await requireParserCapacity(c,a.workspaceId);
  const {rows:[updated]}=await c.query('update parsers set name=$2,mode=$3,instructions=$4,locale=$5,timezone=$6,archived=$7 where id=$1 returning *',[id,b.name??p.name,b.mode??p.mode,b.instructions??p.instructions,b.locale??p.locale,b.timezone??p.timezone,b.archived??p.archived]);
  await audit(c,a.workspaceId,a.userId,'parser.updated',id);
  return {parser:camel(updated)};
 });
});
app.post('/api/parsers/:id/schema',async req=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});const id=idFrom(req.params);const schema=parserSchema.parse(req.body);return withWorkspace(a.workspaceId,async c=>{if(!(await c.query('select id from parsers where id=$1 and workspace_id=$2 for update',[id,a.workspaceId])).rows[0])notFound();const {rows:[s]}=await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) select $1,$2,coalesce(max(version),0)+1,$3,$4 from schema_versions where parser_id=$2 returning *',[a.workspaceId,id,JSON.stringify(schema),a.userId]);await c.query('update parsers set active_schema_id=$2 where id=$1',[id,s.id]);await audit(c,a.workspaceId,a.userId,'schema.version_created',id,{version:s.version});return {schema:{id:s.id,version:s.version,...s.schema}};});});
const templateBody=z.object({name:z.string().trim().min(1).max(100),matchText:z.string().max(1000).default(''),enabled:z.boolean().default(true),rules:z.array(z.object({field:z.string().max(150),anchor:z.string().min(1).max(200)})).max(100)});
app.post('/api/parsers/:id/templates',async req=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});const id=idFrom(req.params),b=templateBody.parse(req.body);return withWorkspace(a.workspaceId,async c=>{if(!(await c.query('select id from parsers where id=$1 and workspace_id=$2',[id,a.workspaceId])).rowCount)notFound();const {rows:[t]}=await c.query('insert into templates(workspace_id,parser_id,name,match_text,rules,enabled) values($1,$2,$3,$4,$5,$6) returning *',[a.workspaceId,id,b.name,b.matchText,JSON.stringify(b.rules),b.enabled]);await audit(c,a.workspaceId,a.userId,'template.created',t.id);return {template:camel(t)};});});
app.patch('/api/templates/:id',async req=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});const id=idFrom(req.params),b=templateBody.parse(req.body);return withWorkspace(a.workspaceId,async c=>{const {rows:[t]}=await c.query('update templates set name=$2,match_text=$3,rules=$4,enabled=$5 where id=$1 returning *',[id,b.name,b.matchText,JSON.stringify(b.rules),b.enabled]);if(!t)notFound();return {template:camel(t)};});});
app.delete('/api/templates/:id',async req=>{const a=await requireActor(req,{roles:editors,scope:'parsers:write'});return withWorkspace(a.workspaceId,async c=>{if(!(await c.query('delete from templates where id=$1 returning id',[idFrom(req.params)])).rowCount)notFound();return {ok:true};});});
}
