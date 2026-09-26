import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {PoolClient} from 'pg';
import type {Actor} from '../shared/types.js';
import {monthlyAiSuggestionLimit} from '../shared/ai-suggestion-allowances.js';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase,withWorkspace} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {requireSuggestionCapacity,auditSuggestionRequest} from '../server/core/parser-setup.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {processOneSchemaSuggestion,setSchemaSuggestionProvider} from '../server/core/schema-suggestions.js';
import {SchemaSuggestionProviderError} from '../server/core/schema-suggestion-errors.js';
import {setSplitSuggestionProvider} from '../server/core/split-suggestions.js';
import {setExtractionProvider} from '../server/core/worker.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;baseSchemaId:string;documentId:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>();
const schema={fields:[{key:'reference',label:'Reference',type:'string' as const}]};
let app:FastifyInstance,verified=false;
const originalFetch=globalThis.fetch;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},async remove(key){objects.delete(key);},async signUpload(key){return `https://owned.example.test/upload/${key}`;}};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const request=(a:Account,method:'GET'|'POST'|'DELETE',url:string,payload?:unknown)=>app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id}});
const fields=(f:Fixture)=>`/api/parsers/${f.parserId}/schema-suggestions`;
const splits=(f:Fixture)=>`/api/parsers/${f.parserId}/split-suggestions`;
const fieldBody=(f:Fixture)=>({requestId:randomUUID(),documentId:f.documentId,baseSchemaId:f.baseSchemaId});
const splitBody=()=>({requestId:randomUUID(),filename:'owned-reservation.pdf',size:20,sourceSha256:'a'.repeat(64),mimeType:'application/pdf'});
const configured=()=>setSchemaSuggestionProvider({configured:()=>true,suggest:async()=>({schema,model:'controlled',promptVersion:'controlled',tokenUsage:{},costUsd:0})});
async function plan(a:Account,id:unknown){await adminPool.query("update workspaces set plan=(plan-'id')||$2::jsonb where id=$1",[a.workspace.id,JSON.stringify(id===undefined?{}:{id})]);}
async function fixture():Promise<Fixture>{
 const signed=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned suggestion allowance',workspaceName:'Owned suggestion allowance',email:`allowance-${randomUUID()}@example.test`,password:'Owned allowance fixture password'}});assert.equal(signed.statusCode,201,signed.body);
 const account={...signed.json(),cookie:signed.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','20') where id=$1",[account.workspace.id]);
 const created=await request(account,'POST','/api/parsers',{name:'Owned allowance parser',useCase:'custom',mode:'rules',schema});assert.equal(created.statusCode,201,created.body);
 const parserId=created.json().parser.id,source=await addDocument(actor(account),parserId,Buffer.from('Reference: OWNED-ALLOWANCE'),'owned.txt');
 return {account,parserId,baseSchemaId:created.json().schema.id,documentId:source.document.id};
}
async function seed(a:Account,count:number,at?:Date){for(let i=0;i<count;i++)await adminPool.query('insert into audit_events(workspace_id,user_id,action,entity_id,metadata,created_at) values($1,$2,$3,$4,$5,coalesce($6,clock_timestamp()))',[a.workspace.id,a.user.id,i%2?'split.suggestion_requested':'schema.suggestion_requested',randomUUID(),'{}',at??null]);}
async function count(a:Account){return (await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action in('schema.suggestion_requested','split.suggestion_requested')",[a.workspace.id])).rows[0].n;}
async function capacity(a:Account,zone='UTC'){return withWorkspace(a.workspace.id,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[a.workspace.id]);await c.query("select set_config('TimeZone',$1,true)",[zone]);await requireSuggestionCapacity(c,a.workspace.id);});}

before(async()=>{
 const host=adminPool.options.connectionString?new URL(adminPool.options.connectionString).hostname:adminPool.options.host;
 assert.ok(typeof host==='string'&&(host.startsWith('/')||['localhost','127.0.0.1','::1','[::1]'].includes(host)),'Allowance fixtures require an isolated local database');
 verified=true;globalThis.fetch=async()=>{throw new Error('No outbound calls are permitted by allowance fixtures');};setStorageForTests(storage);configured();setSplitSuggestionProvider({configured:()=>true,suggest:async()=>{throw new Error('Reservation must not call a provider');}});app=await buildApp();
});
after(async()=>{setSchemaSuggestionProvider(undefined);setSplitSuggestionProvider(undefined);setExtractionProvider(undefined);setStorageForTests(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}}finally{objects.clear();await closeDatabase();}});

test('only known catalogue IDs grant monthly allowances; absent, legacy and crafted values fall back to Explore',()=>{
 assert.equal(monthlyAiSuggestionLimit('explore'),3);assert.equal(monthlyAiSuggestionLimit('standard'),5);assert.equal(monthlyAiSuggestionLimit('team'),20);
 for(const id of [undefined,null,'enterprise','Team','constructor','__proto__',20,{id:'team'}])assert.equal(monthlyAiSuggestionLimit(id),3);
});

test('API limits follow the current stored plan and remain workspace-scoped',async()=>{
 const f=await fixture(),other=await fixture();
 for(const [id,expected] of [['explore',3],['standard',5],['team',20],['legacy-unlimited',3],[undefined,3]] as const){
  await plan(f.account,id);
  for(const url of [fields(f),splits(f)]){const r=await request(f.account,'GET',url);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().limits.perMonth,expected);assert.equal(r.json().limits.perDay,10);assert.equal(r.json().limits.pendingPerWorkspace,3);}
  const setup=await request(f.account,'GET',`/api/parsers/${f.parserId}/setup`);assert.equal(setup.json().setup.limits.perMonth,expected);
 }
 await plan(f.account,'team');assert.equal((await request(other.account,'GET',fields(other))).json().limits.perMonth,3);assert.equal((await request(other.account,'GET',fields(f))).statusCode,404);
});

test('concurrent field and split admissions share the last Explore slot; exact replays spend no extra request',async()=>{
 const f=await fixture();await seed(f.account,2);const field=fieldBody(f),split=splitBody();
 const replies=await Promise.all([request(f.account,'POST',fields(f),field),request(f.account,'POST',splits(f),split)]);
 assert.deepEqual(replies.map(r=>r.statusCode).sort(),[202,429]);assert.match(replies.find(r=>r.statusCode===429)!.body,/calendar month \(UTC\)/);assert.equal(await count(f.account),3);
 const winner=replies[0].statusCode===202?0:1,replay=await request(f.account,'POST',winner===0?fields(f):splits(f),winner===0?field:split);
 assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().suggestion.id,replies[winner].json().suggestion.id);assert.equal(await count(f.account),3);
 const total=(await adminPool.query('select (select count(*)::int from schema_suggestions where workspace_id=$1)+(select count(*)::int from split_suggestions where workspace_id=$1) n',[f.account.workspace.id])).rows[0].n;assert.equal(total,1);
});

test('Standard admits its fifth request, deletion does not refund it, and a current Team upgrade permits further work',async()=>{
 const f=await fixture();await plan(f.account,'standard');await seed(f.account,4);
 const accepted=await request(f.account,'POST',fields(f),fieldBody(f));assert.equal(accepted.statusCode,202,accepted.body);
 const removed=await request(f.account,'DELETE',`/api/documents/${f.documentId}`);assert.equal(removed.statusCode,200,removed.body);assert.equal((await adminPool.query('select id from schema_suggestions where workspace_id=$1',[f.account.workspace.id])).rowCount,0);
 const source=await addDocument(actor(f.account),f.parserId,Buffer.from('Reference: OWNED-AFTER-DELETION'),'new.txt');f.documentId=source.document.id;
 const denied=await request(f.account,'POST',fields(f),fieldBody(f));assert.equal(denied.statusCode,429,denied.body);assert.match(denied.body,/used its 5 AI suggestions/);assert.equal(await count(f.account),5);
 await plan(f.account,'team');assert.equal((await request(f.account,'POST',fields(f),fieldBody(f))).statusCode,202);assert.equal(await count(f.account),6);
});

test('month boundaries are UTC even in another database timezone; unrelated actions and workspaces do not count',async()=>{
 const f=await fixture(),other=await fixture();const now=(await adminPool.query('select clock_timestamp() instant')).rows[0].instant as Date;
 const start=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1)),next=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+1,1));
 await seed(f.account,3,new Date(start.getTime()-1));await seed(f.account,2,start);
 // A future event at the next boundary is outside this month. Daily guard sees
 // at most six events even when the test happens in the first 24 hours.
 await seed(f.account,1,next);await seed(other.account,3,start);
 await adminPool.query("insert into audit_events(workspace_id,user_id,action,metadata) values($1,$2,'schema.suggestion_completed','{}')",[f.account.workspace.id,f.account.user.id]);
 await capacity(f.account,'Pacific/Honolulu');await seed(f.account,1,start);
 await assert.rejects(capacity(f.account,'Pacific/Honolulu'),(e:any)=>e.statusCode===429&&/calendar month/.test(e.message));
 await assert.rejects(capacity(other.account),(e:any)=>e.statusCode===429);const empty=await fixture();await capacity(empty.account);
});

test('unknown stored plans use the free cap even when their page allowance claims unlimited access',async()=>{
 const f=await fixture();await plan(f.account,'unlimited');await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','999999') where id=$1",[f.account.workspace.id]);await seed(f.account,3);
 const r=await request(f.account,'POST',fields(f),fieldBody(f));assert.equal(r.statusCode,429,r.body);assert.match(r.body,/used its 3 AI suggestions/);
});

test('automatic provider retries retain one admitted request and do not consume another monthly slot',async()=>{
 const f=await fixture();let calls=0;setSchemaSuggestionProvider({configured:()=>true,suggest:async()=>{calls++;if(calls<3)throw new SchemaSuggestionProviderError('Owned temporary fixture failure',false);return {schema,model:'controlled',promptVersion:'controlled',tokenUsage:{},costUsd:0};}});
 try{const r=await request(f.account,'POST',fields(f),fieldBody(f));assert.equal(r.statusCode,202,r.body);const id=r.json().suggestion.id;
  for(let i=0;i<3;i++){await adminPool.query('update schema_suggestions set available_at=now() where id=$1',[id]);assert.equal(await processOneSchemaSuggestion(id),true);}
  assert.equal(calls,3);assert.equal((await adminPool.query('select state from schema_suggestions where id=$1',[id])).rows[0].state,'ready');assert.equal(await count(f.account),1);
  const replies=await Promise.all([request(f.account,'POST',fields(f),fieldBody(f)),request(f.account,'POST',fields(f),fieldBody(f))]);assert.deepEqual(replies.map(r=>r.statusCode),[202,202]);assert.equal((await request(f.account,'POST',fields(f),fieldBody(f))).statusCode,429);
 }finally{configured();}
});

test('monthly exhaustion rolls back the first sample upload and leaves manual setup available',async()=>{
 const f=await fixture();await seed(f.account,3);setExtractionProvider({configured:()=>true,extract:async()=>{throw new Error('No extraction expected');}});
 try{const created=await request(f.account,'POST','/api/parsers',{name:'Owned setup at monthly cap',setupMode:'sample',useCase:'custom',mode:'ai'});assert.equal(created.statusCode,201,created.body);const id=created.json().parser.id;
  await assert.rejects(addDocument(actor(f.account),id,Buffer.from('Reference: OWNED-FIRST-SAMPLE'),'sample.txt'),(e:any)=>e.statusCode===429&&/calendar month/.test(e.message));
  for(const table of ['documents','schema_suggestions'])assert.equal((await adminPool.query(`select id from ${table} where parser_id=$1`,[id])).rowCount,0);
  assert.equal((await adminPool.query('select count(*)::int n from usage_ledger where workspace_id=$1',[f.account.workspace.id])).rows[0].n,1);
  const setup=await request(f.account,'GET',`/api/parsers/${id}/setup`);assert.equal(setup.json().setup.state,'awaiting_sample');assert.equal(setup.json().setup.limits.perMonth,3);
 }finally{setExtractionProvider(undefined);}
});


test('a request waiting across UTC midnight is charged in the same month checked after the real workspace lock',async()=>{
 const f=await fixture(),instant=(await adminPool.query('select clock_timestamp() instant')).rows[0].instant as Date;
 const boundary=new Date(Date.UTC(instant.getUTCFullYear(),instant.getUTCMonth()+1,1));
 let clock=new Date(boundary.getTime()-1000),clockReads=0;
 const afterMidnight=new Date(boundary.getTime()+1000);
 await seed(f.account,2,boundary);
 // Only this owned client's admission clock is controlled. Real PostgreSQL
 // transactions, advisory-lock blocking, aggregate reads and audit writes run
 // unchanged; the host clock and global audit defaults are never modified.
 const controlledClock=(c:PoolClient):PoolClient=>new Proxy(c,{get(target,key){
  if(key==='query')return (sql:string,values?:unknown[])=>{
   assert.ok(sql.startsWith('with admission_clock as materialized'));
   assert.equal((sql.match(/clock_timestamp\(\)/g)||[]).length,1);clockReads++;
   return target.query(sql.replace('clock_timestamp()','$2::timestamptz'),[...(values??[]),clock]);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const holder=await adminPool.connect();let waiter:Promise<Date>|undefined;
 try{
  await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[f.account.workspace.id]);
  let entered!:(pid:number)=>void;const waitingForLock=new Promise<number>(resolve=>{entered=resolve;});
  waiter=withWorkspace(f.account.workspace.id,async c=>{
   const timing=(await c.query('select pg_backend_pid() pid,now() started')).rows[0];assert.ok(timing.started<boundary);entered(timing.pid);
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[f.account.workspace.id]);
   const admittedAt=await requireSuggestionCapacity(controlledClock(c),f.account.workspace.id);
   await auditSuggestionRequest(c,actor(f.account),'schema.suggestion_requested',randomUUID(),{controlledMonthBoundary:true},admittedAt);
   return admittedAt;
  });void waiter.catch(()=>{});
  const pid=await Promise.race([waitingForLock,waiter.then(()=>{throw new Error('Admission completed before its lock was released');})]);let blocked=false;
  for(let n=0;n<100;n++){
   blocked=Boolean((await holder.query("select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted",[pid])).rowCount);
   if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(blocked,true,'The admission transaction must really wait on its workspace lock');assert.equal(clockReads,0);
  clock=afterMidnight;await holder.query('commit');
  const admittedAt=await waiter;assert.equal(admittedAt.toISOString(),afterMidnight.toISOString());
  const audit=(await adminPool.query("select created_at from audit_events where workspace_id=$1 and metadata->>'controlledMonthBoundary'='true'",[f.account.workspace.id])).rows[0];
  assert.equal(audit.created_at.toISOString(),afterMidnight.toISOString(),'Do not charge the transaction-start month after checking the admission month');
  await assert.rejects(withWorkspace(f.account.workspace.id,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[f.account.workspace.id]);
   await requireSuggestionCapacity(controlledClock(c),f.account.workspace.id);
  }),(e:any)=>e.statusCode===429&&/calendar month/.test(e.message));
  assert.equal(await count(f.account),3);assert.equal(clockReads,2);
 }finally{await holder.query('rollback');holder.release();if(waiter)await waiter.catch(()=>{});}
});
