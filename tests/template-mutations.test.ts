import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,closeDatabase,databaseSchema,withWorkspace} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob} from '../server/core/worker.js';
import {setStorageForTests} from '../server/core/storage.js';
import {canonicalTemplateDefinition} from '../shared/template-definitions.js';
import type {ParserSchema} from '../shared/types.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;schemaId:string};
const accounts:Account[]=[];let app:FastifyInstance,verified=false,calls=0;
const originalFetch=globalThis.fetch;
const request=(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,...headers}});
async function account(){
 const result=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned template revision',workspaceName:'Owned template revision',email:`region-mutations-${randomUUID()}@example.test`,password:'Owned region mutation password'}});
 assert.equal(result.statusCode,201,result.body);const a={...result.json(),cookie:result.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(a);return a;
}
async function fixture(a?:Account):Promise<Fixture>{
 const owner=a??await account();const r=await request(owner,'POST','/api/parsers',{name:'Owned native templates',useCase:'custom',mode:'rules',schema:{fields:[{key:'reference',label:'Reference',type:'string',required:true}]}});
 assert.equal(r.statusCode,201,r.body);return {account:owner,parserId:r.json().parser.id,schemaId:r.json().schema.id};
}
function definition(){return {kind:'native-pdf-region-v1',name:'Owned native region',matchText:'',enabled:true,rules:[{field:'reference',anchor:'Reference',page:1,reference:{width:400,height:600,rotation:0},offset:{x:0.3,y:0,width:0.2,height:0.04}}]};}
const text=()=>({name:'Owned text template',matchText:'',enabled:true,rules:[{field:'reference',anchor:'Reference'}]});
const create=(f:Fixture,body:unknown)=>request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,body);
const change=(f:Fixture,overrides:Record<string,unknown>={})=>({...definition(),requestId:randomUUID(),baseSchemaId:f.schemaId,...overrides});
const recovery=(f:Fixture,id:string)=>`/api/parsers/${f.parserId}/template-mutations/requests/${id}`;
async function saved(f:Fixture){const r=await request(f.account,'GET',`/api/parsers/${f.parserId}`);assert.equal(r.statusCode,200,r.body);return r.json().templates;}
async function operational(f:Fixture){return (await adminPool.query(`select (select count(*)::int from documents where workspace_id=$1) documents,(select count(*)::int from jobs where workspace_id=$1) jobs,(select count(*)::int from usage_ledger where workspace_id=$1) usage,(select count(*)::int from schema_suggestions where workspace_id=$1) suggestions,(select count(*)::int from split_suggestions where workspace_id=$1) split_suggestions`,[f.account.workspace.id])).rows[0];}
async function key(a:Account,scopes:string[]){const r=await request(a,'POST','/api/workspace/api-keys',{name:'Owned template permission',scopes});assert.equal(r.statusCode,200,r.body);return {cookie:'',authorization:`Bearer ${r.json().token}`};}
before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role]of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}}
 verified=true;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected provider call in owned template tests');};app=await buildApp();
});
after(async()=>{try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}assert.equal(calls,0);}finally{globalThis.fetch=originalFetch;await closeDatabase();}});

test('legacy text requests retain explicit compatibility while every write advances a real revision',async()=>{
 const f=await fixture(),before=await operational(f),created=await create(f,text());assert.equal(created.statusCode,200,created.body);
 const t=created.json().template;assert.equal(t.kind,'text-v1');assert.equal(t.revision,1);assert.equal(created.json().mutation,undefined);
 const edited=await request(f.account,'PATCH',`/api/templates/${t.id}`,{...text(),name:'Owned changed text'});assert.equal(edited.statusCode,200,edited.body);assert.equal(edited.json().template.revision,2);
 await adminPool.query('update templates set rules=$2 where id=$1',[t.id,JSON.stringify([{field:'removed',anchor:'Removed'}])]);
 const disabled=await request(f.account,'PATCH',`/api/templates/${t.id}`,{...text(),enabled:false,rules:[{field:'removed',anchor:'Removed'}]});assert.equal(disabled.statusCode,200,disabled.body);assert.equal(disabled.json().template.revision,3);
 assert.equal((await request(f.account,'DELETE',`/api/templates/${t.id}`)).statusCode,200);assert.equal((await saved(f)).length,0);assert.deepEqual(await operational(f),before);
});

test('large legacy text definitions execute, disable, recover and copy intact without inheriting native snapshot limits',async()=>{
 const f=await fixture();
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','2') where id=$1",[f.account.workspace.id]);
 const nested:ParserSchema={fields:Array.from({length:4},(_,group)=>({key:'group'+group+'a'.repeat(55),label:'Group '+group,type:'object',fields:Array.from({length:25},(_,index)=>({key:'f'+index+'a'.repeat(55),label:'Field '+index,type:'string',required:true}))}))};
 const schemaResponse=await request(f.account,'POST',`/api/parsers/${f.parserId}/schema`,nested);assert.equal(schemaResponse.statusCode,200,schemaResponse.body);f.schemaId=schemaResponse.json().schema.id;
 const rules=nested.fields.flatMap((group,g)=>group.fields!.map((field,index)=>({field:group.key+'.'+field.key,anchor:String(g*25+index).padStart(3,'0')+'漢'.repeat(197)})));
 const legacy={name:'Preserved large legacy',matchText:'',enabled:true,rules};
 assert.ok(Buffer.byteLength(canonicalTemplateDefinition({...legacy,kind:'text-v1'}))>73_728);
 // A pre-region row has no native kind or revision in the original INSERT.
 const row=(await adminPool.query('insert into templates(workspace_id,parser_id,name,match_text,rules,enabled) values($1,$2,$3,$4,$5,true) returning *',[f.account.workspace.id,f.parserId,legacy.name,'',JSON.stringify(rules)])).rows[0];
 const objects=new Map<string,Buffer>();
 setStorageForTests({kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},async remove(key){objects.delete(key);}});
 try{
  const source=await addDocument({userId:f.account.user.id,workspaceId:f.account.workspace.id,role:'owner',authType:'session'},f.parserId,Buffer.from(rules.map(rule=>rule.anchor+': value').join('\n')),'owned-legacy.txt');assert.ok(source.jobId);
  const usage=(await adminPool.query('select * from usage_ledger where workspace_id=$1 order by id',[f.account.workspace.id])).rows;
  assert.equal(await processOneCoreJob(source.jobId!),true);
  const job=(await adminPool.query('select state,error from jobs where id=$1',[source.jobId])).rows[0];assert.equal(job.state,'completed',job.error);
  const run=(await adminPool.query('select * from extraction_runs where job_id=$1',[source.jobId])).rows[0];assert.equal(run.engine,'text-template');assert.equal(run.selection.outcome,'template');
  assert.deepEqual(run.template_snapshot.template,{...legacy,kind:'text-v1',id:row.id,revision:1});assert.ok(Buffer.byteLength(JSON.stringify(run.template_snapshot))>73_728);
  assert.deepEqual((await adminPool.query('select * from usage_ledger where workspace_id=$1 order by id',[f.account.workspace.id])).rows,usage);
  const disabled={...legacy,enabled:false,requestId:randomUUID(),baseSchemaId:f.schemaId,baseRevision:1};
  const response=await request(f.account,'PATCH',`/api/templates/${row.id}`,disabled);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().template.revision,2);
  const recovered=await request(f.account,'GET',recovery(f,disabled.requestId));assert.equal(recovered.statusCode,200,recovered.body);assert.deepEqual(recovered.json().template,response.json().template);
  const replay=await request(f.account,'PATCH',`/api/templates/${row.id}`,disabled);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().mutation.replayed,true);
  // Prior disabled bodies permit control characters in arbitrary removed paths.
  const escaped={kind:'text-v1' as const,name:'Preserved disabled control characters',matchText:'',enabled:false,rules:Array.from({length:100},()=>({field:'\u0001'.repeat(259),anchor:'\u0001'.repeat(200)})),requestId:randomUUID(),baseSchemaId:f.schemaId};
  assert.ok(Buffer.byteLength(canonicalTemplateDefinition(escaped))>262_144);
  const escapedResponse=await create(f,escaped);assert.equal(escapedResponse.statusCode,200,escapedResponse.body);assert.deepEqual(escapedResponse.json().template.rules,escaped.rules);
  const escapedRecovery=await request(f.account,'GET',recovery(f,escaped.requestId));assert.equal(escapedRecovery.statusCode,200,escapedRecovery.body);assert.deepEqual(escapedRecovery.json().template,escapedResponse.json().template);
  const copied=await request(f.account,'POST',`/api/parsers/${f.parserId}/copy`,{name:'Preserved legacy copy'});assert.equal(copied.statusCode,201,copied.body);
  for(const definition of [response.json().template,escapedResponse.json().template]){const copy=copied.json().templates.find((template:any)=>template.name===definition.name);assert.ok(copy);assert.equal(copy.kind,'text-v1');assert.equal(copy.enabled,false);assert.equal(copy.revision,1);assert.deepEqual(copy.rules,definition.rules);}
  // A text allowance cannot enlarge a native receipt or run snapshot.
  await assert.rejects(adminPool.query("update template_mutations set accepted_template=jsonb_set(accepted_template,'{kind}','\"native-pdf-region-v1\"') where request_id=$1",[disabled.requestId]),(error:any)=>error.code==='23514'&&error.constraint==='template_mutations_accepted_template_check');
  await assert.rejects(adminPool.query("update extraction_runs set template_snapshot=jsonb_set(template_snapshot,'{template,kind}','\"native-pdf-region-v1\"') where id=$1",[run.id]),(error:any)=>error.code==='23514'&&error.constraint==='extraction_runs_template_snapshot_check');
 }finally{setStorageForTests(undefined);objects.clear();}
});

test('native definitions require request/schema identity and cannot be silently converted by legacy bodies',async()=>{
 const f=await fixture(),before=await operational(f);
 for(const body of [definition(),{...definition(),requestId:randomUUID()},change(f,{baseSchemaId:randomUUID()}),change(f,{rules:[{...definition().rules[0],field:'missing'}]}),change(f,{rules:[definition().rules[0],definition().rules[0]]})])assert.ok([400,409].includes((await create(f,body)).statusCode));
 assert.equal((await saved(f)).length,0);
 const created=await create(f,change(f));assert.equal(created.statusCode,200,created.body);const t=created.json().template;
 for(const body of [text(),{...text(),requestId:randomUUID(),baseSchemaId:f.schemaId,baseRevision:t.revision}])assert.ok([400,409].includes((await request(f.account,'PATCH',`/api/templates/${t.id}`,body)).statusCode));
 assert.equal((await request(f.account,'DELETE',`/api/templates/${t.id}`)).statusCode,400);
 assert.equal((await saved(f))[0].kind,'native-pdf-region-v1');assert.deepEqual(await operational(f),before);
});

test('matching create retries ignore JSON object key order and later schema changes but reject changed payloads',async()=>{
 const f=await fixture(),body=change(f),r=await create(f,body);assert.equal(r.statusCode,200,r.body);const first=r.json();
 const reorder=JSON.parse(JSON.stringify(body));reorder.rules[0].offset={height:0.04,width:0.2,y:0,x:0.3};reorder.rules[0].reference={rotation:0,height:600,width:400};reorder.requestId=body.requestId.toUpperCase();reorder.baseSchemaId=f.schemaId.toUpperCase();
 const replay=await create(f,reorder);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().mutation.replayed,true);assert.deepEqual(replay.json().template,first.template);
 const schema=await request(f.account,'POST',`/api/parsers/${f.parserId}/schema`,{fields:[{key:'other',label:'Other',type:'string'}]});assert.equal(schema.statusCode,200,schema.body);
 assert.equal((await create(f,body)).statusCode,200);assert.equal((await create(f,{...body,name:'Changed payload'})).statusCode,409);
 assert.equal((await saved(f)).length,1);assert.equal((await adminPool.query("select id from audit_events where workspace_id=$1 and action='template.created'",[f.account.workspace.id])).rowCount,1);
});

test('revision CAS and durable accepted snapshots survive later updates, deletion and lost response recovery',async()=>{
 const f=await fixture(),body=change(f),created=(await create(f,body)).json(),id=created.template.id;
 const firstUpdate=change(f,{baseRevision:1,name:'Revision two'}),update=await request(f.account,'PATCH',`/api/templates/${id}`,firstUpdate);assert.equal(update.statusCode,200,update.body);assert.equal(update.json().template.revision,2);
 assert.equal((await request(f.account,'PATCH',`/api/templates/${id}`,change(f,{baseRevision:1,name:'Stale editor'}))).statusCode,409);
 const second=await request(f.account,'PATCH',`/api/templates/${id}`,change(f,{baseRevision:2,name:'Revision three'}));assert.equal(second.statusCode,200,second.body);
 const replay=await request(f.account,'PATCH',`/api/templates/${id}`,firstUpdate);assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().template.name,'Revision two');assert.equal(replay.json().mutation.acceptedRevision,2);assert.equal(replay.json().mutation.currentRevision,3);
 const remove={requestId:randomUUID(),baseRevision:3};const removed=await request(f.account,'DELETE',`/api/templates/${id}`,remove);assert.equal(removed.statusCode,200,removed.body);assert.equal(removed.json().mutation.acceptedRevision,4);assert.equal(removed.json().mutation.deleted,true);assert.equal(removed.json().template,null);
 assert.equal((await request(f.account,'DELETE',`/api/templates/${id}`,remove)).statusCode,200);
 const recovered=await request(f.account,'GET',recovery(f,body.requestId));assert.equal(recovered.statusCode,200,recovered.body);assert.deepEqual(recovered.json().template,created.template);assert.equal(recovered.json().mutation.currentRevision,null);assert.equal(recovered.json().mutation.deleted,true);
 assert.equal((await create(f,body)).statusCode,200);assert.equal((await saved(f)).length,0);
});

test('explicit close fences an unknown late save while an accepted mutation wins close and replays unchanged',async()=>{
 const f=await fixture(),body=change(f),url=recovery(f,body.requestId);
 assert.equal((await request(f.account,'GET',url)).statusCode,404);
 const close=await request(f.account,'POST',url+'/close',{});assert.equal(close.statusCode,200,close.body);assert.deepEqual(close.json(),{template:null,mutation:{requestId:body.requestId,state:'closed',operation:null,templateId:null,acceptedRevision:null,currentRevision:null,deleted:false,replayed:true}});
 assert.equal((await create(f,body)).statusCode,410);assert.equal((await request(f.account,'POST',url+'/close',{})).statusCode,200);assert.equal((await saved(f)).length,0);
 const acceptedBody=change(f),accepted=await create(f,acceptedBody);assert.equal(accepted.statusCode,200,accepted.body);
 const recovered=await request(f.account,'POST',recovery(f,acceptedBody.requestId)+'/close',{});assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().mutation.state,'accepted');assert.deepEqual(recovered.json().template,accepted.json().template);
 assert.equal((await saved(f)).length,1);
});

async function blockedOnWorkspace(workspaceId:string,count:number){
 const end=Date.now()+3000;
 while(Date.now()<end){
  const row=(await adminPool.query("select count(*)::int n from pg_locks where locktype='advisory' and not granted and objid=(hashtextextended($1,0)&4294967295)::oid and classid=((hashtextextended($1,0)>>32)&4294967295)::oid",[workspaceId])).rows[0];
  if(row.n>=count)return;
  await new Promise<void>(resolve=>setTimeout(resolve,10));
 }
 throw new Error('Owned template request did not reach its workspace lock');
}
test('actual concurrent close/save order is fenced and a credential expiring behind the workspace lock cannot commit',async()=>{
 for(const first of ['close','save']){
  const f=await fixture(),body=change(f),client=await adminPool.connect();
  try{
   await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[f.account.workspace.id]);
   const close=()=>request(f.account,'POST',recovery(f,body.requestId)+'/close',{}),save=()=>create(f,body);
   const one=first==='close'?close():save();await blockedOnWorkspace(f.account.workspace.id,1);
   const two=first==='close'?save():close();await blockedOnWorkspace(f.account.workspace.id,2);await client.query('commit');
   const [a,b]=await Promise.all([one,two]);assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,first==='close'?410:200,b.body);
   assert.equal((await saved(f)).length,first==='close'?0:1);assert.equal((await request(f.account,'GET',recovery(f,body.requestId))).json().mutation.state,first==='close'?'closed':'accepted');
  }finally{await client.query('rollback');client.release();}
 }
 const f=await fixture(),client=await adminPool.connect(),body=change(f);
 try{
  await adminPool.query("update sessions set expires_at=clock_timestamp()+interval '1 second' where user_id=$1",[f.account.user.id]);
  await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[f.account.workspace.id]);
  const pending=create(f,body);await blockedOnWorkspace(f.account.workspace.id,1);await new Promise<void>(resolve=>setTimeout(resolve,1100));await client.query('commit');
  const response=await pending;assert.equal(response.statusCode,401,response.body);
  assert.equal((await adminPool.query('select id from templates where parser_id=$1',[f.parserId])).rowCount,0);assert.equal((await adminPool.query('select id from template_mutations where parser_id=$1',[f.parserId])).rowCount,0);
 }finally{await client.query('rollback');client.release();}
});

test('mutation receipts enforce requester, tenant, role, scopes, origin and current credential state',async()=>{
 const f=await fixture(),other=await account(),foreign=await fixture(),body=change(f),created=await create(f,body);assert.equal(created.statusCode,200,created.body);
 await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'editor')",[f.account.workspace.id,other.user.id]);
 const headers={'x-workspace-id':f.account.workspace.id};assert.equal((await request(other,'GET',recovery(f,body.requestId),undefined,headers)).statusCode,404);assert.equal((await request(other,'POST',recovery(f,body.requestId)+'/close',{},headers)).statusCode,404);
 assert.equal((await request(foreign.account,'GET',recovery(f,body.requestId))).statusCode,404);
 assert.equal((await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,change(f),{origin:'https://unrelated.example'})).statusCode,403);
 const readOnly=await key(f.account,['parsers:read']),writer=await key(f.account,['parsers:write']);
 assert.equal((await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,change(f),readOnly)).statusCode,403);
 const allowed=await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,change(f),writer);assert.equal(allowed.statusCode,200,allowed.body);
 await adminPool.query('update api_keys set revoked_at=now() where user_id=$1 and workspace_id=$2',[f.account.user.id,f.account.workspace.id]);assert.equal((await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,change(f),writer)).statusCode,401);
 await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,other.user.id]);assert.equal((await request(other,'POST',`/api/parsers/${f.parserId}/templates`,change(f),headers)).statusCode,403);
 assert.equal((await withWorkspace(foreign.account.workspace.id,c=>c.query('select id from template_mutations where workspace_id=$1',[f.account.workspace.id]))).rowCount,0);
});

test('receipt failure rolls back the template and audit together; native parser state and bounded definitions remain enforced',async()=>{
 const f=await fixture(),constraint=`owned_template_${randomUUID().replaceAll('-','')}`;
 await adminPool.query(`alter table template_mutations add constraint ${constraint} check(workspace_id <> '${f.account.workspace.id}'::uuid)`);
 try{const response=await create(f,change(f));assert.equal(response.statusCode,500);assert.equal((await saved(f)).length,0);assert.equal((await adminPool.query("select id from audit_events where workspace_id=$1 and action='template.created'",[f.account.workspace.id])).rowCount,0);}
 finally{await adminPool.query(`alter table template_mutations drop constraint ${constraint}`);}
 await adminPool.query("update parsers set allowed_formats=ARRAY['txt']::text[] where id=$1",[f.parserId]);assert.equal((await create(f,change(f))).statusCode,415);
 await adminPool.query('update parsers set allowed_formats=null,archived=true where id=$1',[f.parserId]);assert.equal((await create(f,change(f))).statusCode,409);
 await adminPool.query('update parsers set archived=false where id=$1',[f.parserId]);assert.equal((await create(f,change(f,{rules:[{...definition().rules[0],offset:{x:Infinity,y:0,width:1,height:1}}]}))).statusCode,400);
 assert.equal((await saved(f)).length,0);
});
