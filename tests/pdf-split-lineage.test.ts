import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,withWorkspace,transaction,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {purgePdfSplit,deleteStoredFiles,deleteStoredFile} from '../server/core/retention.js';
import {readPdfSplitReceipt} from '../server/core/pdf-split-records.js';
import {reconcileInterruptedIntake} from '../server/core/object-reconciliation.js';
import {enforceRetention,setExtractionProvider} from '../server/core/worker.js';
import {setSchemaSuggestionProvider} from '../server/core/schema-suggestions.js';
import {pdfSplitValidationReasons} from '../shared/pdf-split.js';
import {sourceValidationReasons} from '../server/core/source-validation.js';

type Tenant={workspace:string;owner:string;viewer:string;parser:string;schema:string;token:string;viewerToken:string;writeToken:string};
type Batch={id:string;requestId:string;sourceKey:string;source:Buffer;children:Array<{id:string;job:string;key:string;bytes:Buffer}>};
const tenants:Tenant[]=[],objects=new Map<string,Buffer>(),removals:string[]=[];
let app:FastifyInstance,localVerified=false,externalCalls=0,providerCalls=0;
const originalFetch=globalThis.fetch;
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const remote:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned fixture missing'),{statusCode:404});return Buffer.from(bytes);},async remove(key){removals.push(key);objects.delete(key);}};
const filesystem:PrivateStorage={kind:'filesystem',async write(key,bytes){await fs.mkdir(path.dirname(path.join(config.storageDir,key)),{recursive:true,mode:0o700});await fs.writeFile(path.join(config.storageDir,key),bytes,{mode:0o600});},async read(key){return fs.readFile(path.join(config.storageDir,key));},async remove(key){removals.push(key);await fs.rm(path.join(config.storageDir,key),{force:true});}};
let storage=remote;
function useStorage(value:PrivateStorage){storage=value;setStorageForTests(value);}
async function tenant():Promise<Tenant>{
 const t={workspace:randomUUID(),owner:randomUUID(),viewer:randomUUID(),parser:randomUUID(),schema:randomUUID(),token:randomUUID(),viewerToken:randomUUID(),writeToken:`fl_${randomUUID()}`};tenants.push(t);
 await transaction(adminPool,async c=>{
  for(const id of [t.owner,t.viewer])await c.query("insert into users(id,email,name,password_hash) values($1,$2,'Owned lineage fixture','unusable-fixture-hash')",[id,`lineage-${id}@example.test`]);
  await c.query("insert into workspaces(id,name,slug,settings) values($1::uuid,'Owned PDF lineage fixture',$1::text,'{\"retentionDays\":1}')",[t.workspace]);
  await c.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer')",[t.workspace,t.owner,t.viewer]);
  for(const [id,token] of [[t.owner,t.token],[t.viewer,t.viewerToken]])await c.query("insert into sessions(token_hash,user_id,workspace_id,expires_at) values($1,$2,$3,now()+interval '1 hour')",[hashToken(token),id,t.workspace]);
  await c.query("insert into api_keys(workspace_id,user_id,name,prefix,token_hash,scopes) values($1,$2,'Owned write-only key','fl_owned',$3,'[\"documents:write\"]')",[t.workspace,t.owner,hashToken(t.writeToken)]);
  await c.query("insert into parsers(id,workspace_id,name,use_case,mode) values($1,$2,'Owned split parser','custom','rules')",[t.parser,t.workspace]);
  await c.query("insert into schema_versions(id,workspace_id,parser_id,version,schema) values($1,$2,$3,1,'{\"fields\":[{\"key\":\"reference\",\"label\":\"Reference\",\"type\":\"string\"}]}')",[t.schema,t.workspace,t.parser]);
  await c.query('update parsers set active_schema_id=$2 where id=$1',[t.parser,t.schema]);
 });return t;
}
// Direct database fixtures exercise lineage/cleanup only, not decoder or intake acceptance.
async function batch(t:Tenant,count=2):Promise<Batch>{
 const id=randomUUID(),requestId=randomUUID(),source=Buffer.from('%PDF-1.7\nOWNED FULL SOURCE including omitted page 2\n%%EOF');
 const b={id,requestId,sourceKey:`${t.workspace}/${id}`,source,children:Array.from({length:count},()=>{const id=randomUUID();return {id,job:randomUUID(),key:`${t.workspace}/${id}`,bytes:Buffer.from('%PDF-1.7\nOWNED IDENTICAL CHILD\n%%EOF')};})};
 const spec={mode:'ranges',ranges:b.children.map((_,i)=>({start:i*2+1,end:i*2+1}))};
 await withWorkspace(t.workspace,async c=>{
  await c.query("insert into pdf_splits(id,workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,source_byte_size,source_page_count,selected_pages,child_count,source_storage_key,source_name,created_by) values($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$10,$10,$11,'Owned original.pdf',$12)",[id,t.workspace,t.parser,requestId,digest(source),JSON.stringify(spec),digest(JSON.stringify(spec)),source.length,count*2-1,count,b.sourceKey,t.owner]);
  for(const [index,child] of b.children.entries()){
   const name=`Owned child ${index+1}.pdf`;
   await c.query('insert into pdf_split_children(split_id,workspace_id,parser_id,child_index,document_id,job_id,start_page,end_page,sha256,byte_size,document_name) values($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)',[id,t.workspace,t.parser,index+1,child.id,child.job,index*2+1,digest(child.bytes),child.bytes.length,name]);
   await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,source_text,pdf_split_id,pdf_split_index) values($1,$2,$3,$4,'application/pdf',$5,$6,$7,'processed',1,'[{\"page\":1,\"text\":\"OWNED CHILD VALUE\"}]',$8,$9)",[child.id,t.workspace,t.parser,name,child.bytes.length,digest(child.bytes),child.key,id,index+1]);
   await c.query("insert into jobs(id,workspace_id,document_id,schema_version_id,config,state) values($1,$2,$3,$4,'{}','completed')",[child.job,t.workspace,child.id,t.schema]);
   await c.query("insert into usage_ledger(workspace_id,document_id,event,pages,idempotency_key) values($1,$2,'upload',1,$3)",[t.workspace,child.id,`owned-lineage:${child.id}`]);
  }
 });
 await storage.write(b.sourceKey,source);for(const child of b.children)await storage.write(child.key,child.bytes);return b;
}
function request(t:Tenant,method:'GET'|'DELETE',url:string,headers:Record<string,string>={}){return app.inject({method,url,headers:{cookie:`folio_session=${t.token}`,origin:config.origin,...headers}});}
async function receipt(t:Tenant,b:Batch){return withWorkspace(t.workspace,c=>readPdfSplitReceipt(c,t.workspace,b.id,true));}
async function usage(t:Tenant){return (await adminPool.query('select count(*)::int entries,sum(pages)::int pages from usage_ledger where workspace_id=$1',[t.workspace])).rows[0];}
async function sourceRow(b:Batch){return (await adminPool.query('select * from pdf_splits where id=$1',[b.id])).rows[0];}

before(async()=>{
  assert.equal(databaseSchema, 'public', 'PDF split lineage fixtures require the disposable public application schema');
  const pools = [[adminPool, 'folio_admin'], [appPool, 'folio_app']] as const;
  const urlMode = Boolean(adminPool.options.connectionString || appPool.options.connectionString);
  if (urlMode) {
    assert.equal(process.env.NODE_ENV, 'test', 'URL databases are permitted only for controlled CI tests');
    assert.ok(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true', 'URL databases require the disposable CI environment');
    assert.ok(process.env.DATABASE_ADMIN_URL && process.env.DATABASE_URL, 'CI must supply both database URLs');
    for (const [pool, role] of pools) {
      assert.equal(typeof pool.options.connectionString, 'string', 'CI must use explicit URLs for both database roles');
      const url = new URL(pool.options.connectionString!);
      assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'PDF split lineage CI databases must be loopback only');
      assert.equal(url.port || '5432', '5432'); assert.equal(url.pathname, '/folio'); assert.equal(decodeURIComponent(url.username), role);
      assert.equal(url.search, '', 'CI database URLs cannot override host, role or connection settings'); assert.equal(url.hash, '');
    }
  } else {
    for (const [pool, role] of pools) {
      const options = pool.options;
      assert.equal(typeof options.host, 'string');
      assert.equal(path.resolve(options.host!), path.resolve(config.root, '.local/socket'), 'PDF split lineage fixtures require this checkout\'s isolated local Unix socket');
      assert.equal(options.port, 55432); assert.equal(options.database, 'folio'); assert.equal(options.user, role);
    }
  }
  // Check both actual sessions before any fixture mutations; never echo URL credentials.
  for (const [pool, role] of pools) {
    const { rows: [connected] } = await pool.query("select current_database() name,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address");
    assert.equal(connected.name, 'folio'); assert.equal(connected.schema, 'public'); assert.equal(connected.role, role); assert.equal(connected.port, urlMode ? 5432 : 55432);
    // GitHub publishes its disposable Docker service on localhost. PostgreSQL
    // sees the container interface; the client URLs above enforce loopback.
    if (urlMode) assert.ok(connected.address, 'CI must use the verified TCP endpoint'); else assert.equal(connected.address, null);
  }
 localVerified=true;useStorage(remote);
 globalThis.fetch=async()=>{externalCalls++;throw new Error('No external requests in lineage fixtures');};
 setExtractionProvider({configured:()=>false,extract:async()=>{providerCalls++;throw new Error('No extraction in lineage fixtures');}});
 setSchemaSuggestionProvider({configured:()=>false,suggest:async()=>{providerCalls++;throw new Error('No suggestions in lineage fixtures');}});
 app=await buildApp();
});
afterEach(()=>{useStorage(remote);assert.equal(externalCalls,0);assert.equal(providerCalls,0);});
after(async()=>{
 setStorageForTests(undefined);setExtractionProvider(undefined);setSchemaSuggestionProvider(undefined);globalThis.fetch=originalFetch;
 try{await app?.close();if(localVerified){for(const t of tenants){await adminPool.query('delete from workspaces where id=$1',[t.workspace]);await adminPool.query('delete from users where id=any($1::uuid[])',[[t.owner,t.viewer]]);await fs.rm(path.join(config.storageDir,t.workspace),{recursive:true,force:true});}}objects.clear();}finally{await closeDatabase();}
});

test('receipt and detail expose ordered original ranges without storage keys, hashes or extracted values',async()=>{
 const t=await tenant(),b=await batch(t),result=await receipt(t,b);
 assert.equal(result.replayed,true);assert.equal(result.split.sourceAvailable,true);assert.deepEqual(result.documents.map(d=>[d.id,d.index,d.originalPageStart,d.pageCount,d.available]),b.children.map((c,i)=>[c.id,i+1,i*2+1,1,true]));
 assert.deepEqual(Object.keys(result.split).sort(),['childCount','createdAt','id','parserId','requestId','selectedPages','sourceAvailable','sourceName','sourcePageCount']);
 assert.ok(!JSON.stringify(result).includes(t.workspace));assert.ok(!JSON.stringify(result).includes(digest(b.source)));assert.ok(!JSON.stringify(result).includes('OWNED CHILD VALUE'));
 const detail=await request(t,'GET',`/api/documents/${b.children[1].id}`);assert.equal(detail.statusCode,200,detail.body);
 assert.deepEqual(detail.json().split,{id:b.id,index:2,childCount:2,originalPageStart:3,originalPageEnd:3,sourcePageCount:3,sourceName:'Owned original.pdf',sourceAvailable:true,retainedDocuments:2});
 assert.deepEqual(detail.json().document.sourceText,[{page:1,text:'OWNED CHILD VALUE'}]);
 const original=await request(t,'GET',`/api/documents/${b.children[1].id}/original`),bundle=await request(t,'GET',`/api/documents/${b.children[1].id}/bundle-original`);
 assert.equal(original.statusCode,200);assert.equal(bundle.statusCode,200);assert.deepEqual(original.rawPayload,b.children[1].bytes);assert.deepEqual(bundle.rawPayload,b.source);
 assert.match(String(bundle.headers['cache-control']),/private, no-store/);assert.equal(bundle.headers['x-content-type-options'],'nosniff');assert.match(String(bundle.headers['content-security-policy']),/sandbox/);
});

test('child deletion preserves sibling source, tombstones identity, and final child queues and removes the shared original once',async()=>{
 const t=await tenant(),b=await batch(t),beforeUsage=await usage(t);
 assert.equal((await request(t,'DELETE',`/api/documents/${b.children[0].id}`)).statusCode,200);
 assert.equal(objects.has(b.children[0].key),false);assert.equal(objects.has(b.sourceKey),true);
 let replay=await receipt(t,b);assert.equal(replay.documents[0].available,false);assert.equal(replay.documents[0].name,null);assert.equal(replay.documents[0].id,b.children[0].id);assert.equal(replay.documents[0].jobId,b.children[0].job);assert.equal(replay.documents[1].available,true);
 assert.equal((await request(t,'GET',`/api/documents/${b.children[0].id}/bundle-original`)).statusCode,404);
 assert.equal((await request(t,'GET',`/api/documents/${b.children[1].id}/bundle-original`)).statusCode,200);
 assert.equal((await request(t,'DELETE',`/api/documents/${b.children[1].id}`)).json().storageDeletion,'complete');
 replay=await receipt(t,b);assert.equal(replay.split.sourceAvailable,false);assert.equal(replay.split.sourceName,null);assert.ok(replay.documents.every(d=>!d.available&&d.name===null));
 assert.equal(objects.has(b.sourceKey),false);assert.equal(removals.filter(key=>key===b.sourceKey).length,1);assert.deepEqual(await usage(t),beforeUsage);
 const row=await sourceRow(b);assert.equal(row.source_storage_key,null);assert.ok(row.source_released_at);assert.equal(row.source_sha256,digest(b.source));
});

test('concurrent last-child deletes serialize source release and preserve the exact replay manifest',async()=>{
 const t=await tenant(),b=await batch(t);
 const results=await Promise.all(b.children.map(child=>request(t,'DELETE',`/api/documents/${child.id}`)));
 assert.ok(results.every(r=>r.statusCode===200),results.map(r=>r.body).join('\n'));
 assert.equal(removals.filter(key=>key===b.sourceKey).length,1);assert.equal((await receipt(t,b)).documents.length,2);
 assert.equal((await adminPool.query('select id from file_deletions where workspace_id=$1',[t.workspace])).rowCount,0);
});

test('whole-group purge rolls back on transaction failure then removes every child while retaining the replay receipt',async()=>{
 const t=await tenant(),b=await batch(t),beforeUsage=await usage(t);
 await assert.rejects(withWorkspace(t.workspace,async c=>{assert.equal((await purgePdfSplit(c,t.workspace,b.id))?.removedDocuments,2);throw new Error('Controlled audit failure');}),/Controlled audit failure/);
 assert.ok((await receipt(t,b)).documents.every(d=>d.available));assert.equal((await adminPool.query('select id from file_deletions where workspace_id=$1',[t.workspace])).rowCount,0);assert.ok(objects.has(b.sourceKey));
 const response=await request(t,'DELETE',`/api/pdf-splits/${b.id}`);assert.equal(response.statusCode,200,response.body);assert.equal(response.json().removedDocuments,2);assert.equal(response.json().storageDeletion,'pending');
 const replayedDelete=await request(t,'DELETE',`/api/pdf-splits/${b.id}`);assert.equal(replayedDelete.json().removedDocuments,0);assert.equal(replayedDelete.json().storageDeletion,'pending');
 assert.equal(await deleteStoredFiles(t.workspace,[b.sourceKey,...b.children.map(child=>child.key)]),'complete');
 assert.equal((await request(t,'DELETE',`/api/pdf-splits/${b.id}`)).json().storageDeletion,'complete');assert.equal(objects.has(b.sourceKey),false);
 assert.equal((await adminPool.query("select id from audit_events where workspace_id=$1 and action='document.split_deleted'",[t.workspace])).rowCount,1);
 assert.ok((await receipt(t,b)).documents.every(d=>!d.available));assert.deepEqual(await usage(t),beforeUsage);
});

test('retention keeps the full source for active child work and releases it after the final suggestion terminates',async()=>{
 const t=await tenant(),b=await batch(t),child=b.children[0];
 await adminPool.query("update documents set created_at=now()-interval '3 days' where workspace_id=$1",[t.workspace]);
 await adminPool.query("update jobs set state='queued' where id=$1",[child.job]);
 assert.deepEqual(await enforceRetention(t.workspace),{removed:1});assert.ok(objects.has(b.sourceKey));
 const suggestion=randomUUID();
 await adminPool.query("insert into schema_suggestions(id,workspace_id,parser_id,document_id,base_schema_id,request_id,document_sha256,config) values($1,$2,$3,$4,$5,$6,$7,'{}')",[suggestion,t.workspace,t.parser,child.id,t.schema,randomUUID(),digest(child.bytes)]);
 await adminPool.query("update jobs set state='completed' where id=$1",[child.job]);
 assert.deepEqual(await enforceRetention(t.workspace),{removed:0});assert.ok(objects.has(b.sourceKey));
 await adminPool.query("update schema_suggestions set state='failed',error='Controlled terminal fixture' where id=$1",[suggestion]);
 assert.deepEqual(await enforceRetention(t.workspace),{removed:1});assert.equal(objects.has(b.sourceKey),false);assert.ok((await receipt(t,b)).documents.every(d=>!d.available));
});

test('remote orphan recovery preserves committed source references and queues only expired unreferenced split intents',async()=>{
 const t=await tenant(),b=await batch(t),orphan=randomUUID(),live=randomUUID();
 for(const [id,expiry] of [[b.id,"now()-interval '2 hours'"],[orphan,"now()-interval '2 hours'"],[live,"now()+interval '5 minutes'"]])await adminPool.query(`insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,10,${expiry})`,[id,t.workspace,`${t.workspace}/${id}`,randomUUID()]);
 objects.set(`${t.workspace}/${orphan}`,Buffer.from('Owned abandoned source'));objects.set(`${t.workspace}/${live}`,Buffer.from('Owned active write'));
 const result=await reconcileInterruptedIntake(t.workspace);assert.equal(result.queued,1);assert.equal(result.expiredIntentsRemoved,1);assert.ok(objects.has(b.sourceKey));
 assert.equal((await adminPool.query('select id from intake_files where id=$1',[live])).rowCount,1);
 const entries=(await adminPool.query('select storage_key from file_deletions where workspace_id=$1',[t.workspace])).rows;assert.deepEqual(entries.map(row=>row.storage_key),[`${t.workspace}/${orphan}`]);
 assert.equal(await deleteStoredFiles(t.workspace,entries.map(row=>row.storage_key)),'complete');assert.equal(objects.has(`${t.workspace}/${orphan}`),false);assert.ok(objects.has(b.sourceKey));
});

test('filesystem reconciliation preserves old retained bundles beyond documents and removes only unreferenced abandoned files',async()=>{
 useStorage(filesystem);const t=await tenant(),b=await batch(t),orphan=randomUUID(),key=`${t.workspace}/${orphan}`,old=new Date(Date.now()-2*60*60*1000);
 await storage.write(key,Buffer.from('Owned orphan'));for(const k of [b.sourceKey,...b.children.map(c=>c.key),key])await fs.utimes(path.join(config.storageDir,k),old,old);
 await adminPool.query("insert into intake_files(id,workspace_id,storage_key,split_attempt_id,lease_expires_at) values($1,$2,$3,$4,now()-interval '2 hours')",[b.id,t.workspace,b.sourceKey,randomUUID()]);
 const result=await reconcileInterruptedIntake(t.workspace);assert.equal(result.removed,1);assert.equal(result.expiredIntentsRemoved,1);await fs.access(path.join(config.storageDir,b.sourceKey));await assert.rejects(fs.access(path.join(config.storageDir,key)));
 assert.equal((await adminPool.query('select id from intake_files where id=$1',[b.id])).rowCount,0);
});

test('bundle routes require a live owned child and read scope, keep viewer reads, and do not mint foreign signed URLs',async()=>{
 const t=await tenant(),other=await tenant(),b=await batch(t);let signed=0;
 useStorage({...remote,async signDownload(key){signed++;assert.equal(key,b.sourceKey);return 'https://owned.example.test/controlled-capability';}});
 const url=`/api/documents/${b.children[0].id}/bundle-original-url`;
 assert.equal((await request(other,'GET',url)).statusCode,404);assert.equal((await app.inject({method:'GET',url})).statusCode,401);
 assert.equal((await request(t,'GET',url,{cookie:'',authorization:`Bearer ${t.writeToken}`})).statusCode,403);assert.equal(signed,0);
 const allowed=await request(t,'GET',url,{cookie:`folio_session=${t.viewerToken}`});assert.equal(allowed.statusCode,200,allowed.body);assert.deepEqual(allowed.json(),{url:'https://owned.example.test/controlled-capability',external:true});assert.equal(signed,1);
 assert.equal((await request(t,'DELETE',`/api/pdf-splits/${b.id}`,{cookie:`folio_session=${t.viewerToken}`})).statusCode,403);
 assert.equal((await request(t,'DELETE',`/api/pdf-splits/${b.id}`,{origin:'https://foreign.example.test'})).statusCode,403);
 assert.equal((await request(other,'DELETE',`/api/pdf-splits/${b.id}`)).statusCode,404);
 assert.equal((await withWorkspace(other.workspace,c=>c.query('select id from pdf_splits where id=$1',[b.id]))).rowCount,0);
 assert.equal((await withWorkspace(other.workspace,c=>c.query('select document_id from pdf_split_children where split_id=$1',[b.id]))).rowCount,0);
});

test('database constraints preserve ordinary dedup, split identity, tenant ownership and the finite rejection catalogues',async()=>{
 const t=await tenant(),other=await tenant(),b=await batch(t),foreign=await batch(other);
 const rls=(await adminPool.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where oid in('pdf_splits'::regclass,'pdf_split_children'::regclass)")).rows;
 assert.equal(rls.length,2);assert.ok(rls.every(row=>row.relrowsecurity&&row.relforcerowsecurity));
 await withWorkspace(t.workspace,async c=>{
  async function rejected(sql:string,values:unknown[],code='23514'){
   await c.query('savepoint owned_constraint');
   try{await assert.rejects(c.query(sql,values),(error:any)=>error.code===code);}finally{await c.query('rollback to savepoint owned_constraint');await c.query('release savepoint owned_constraint');}
  }
  await rejected("update pdf_splits set rejection_reason='pdf' where id=$1",[b.id]);
  await rejected('update pdf_splits set source_storage_key=$2 where id=$1',[b.id,`${other.workspace}/${b.id}`]);
  await rejected('update pdf_splits set source_storage_key=null where id=$1',[b.id]);
  await rejected('update pdf_splits set child_count=21 where id=$1',[b.id]);
  await rejected('update pdf_split_children set end_page=31 where split_id=$1',[b.id]);
  await rejected('update pdf_split_children set parser_id=$2 where split_id=$1',[b.id,other.parser],'23503');
  await rejected('update documents set pdf_split_index=null where id=$1',[b.children[0].id]);
  await rejected('update documents set pdf_split_id=$2,pdf_split_index=20 where id=$1',[b.children[0].id,foreign.id],'23503');
  const invalidIntent=randomUUID();await rejected('insert into intake_files(id,workspace_id,storage_key,reserved_bytes) values($1,$2,$3,10485761)',[invalidIntent,t.workspace,`${t.workspace}/${invalidIntent}`]);
  // A live split child and one ordinary upload can share real bytes; ordinary
  // uploads still deduplicate among themselves. The manifest identity is independent.
  const ordinary=randomUUID();
  const insert="insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count) values($1,$2,$3,'Owned ordinary identical.pdf','application/pdf',$4,$5,$6,'processed',1)";
  await c.query(insert,[ordinary,t.workspace,t.parser,b.children[0].bytes.length,digest(b.children[0].bytes),`${t.workspace}/${ordinary}`]);
  const duplicate=randomUUID();await rejected(insert,[duplicate,t.workspace,t.parser,b.children[0].bytes.length,digest(b.children[0].bytes),`${t.workspace}/${duplicate}`],'23505');
  const insertRejection="insert into pdf_splits(id,workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,rejection_code,rejection_reason,source_byte_size) values($1,$2,$3,$4,$5,'{\"mode\":\"every\",\"pagesPerDocument\":1}',$5,'rejected',$6,$7,0)";
  const categories=[['source_validation_failed',sourceValidationReasons],['pdf_split_validation_failed',pdfSplitValidationReasons],['parser_format_not_allowed',{pdf:{message:'does not accept',statusCode:415}}]] as const;
  for(const [code,reasons] of categories)for(const [reason,definition] of Object.entries(reasons)){
   const id=randomUUID();await c.query(insertRejection,[id,t.workspace,t.parser,randomUUID(),'c'.repeat(64),code,reason]);
   await assert.rejects(readPdfSplitReceipt(c,t.workspace,id), (error:any)=>error.code===code&&error.statusCode===definition.statusCode&&(code==='parser_format_not_allowed'?error.message.includes(definition.message):error.message===definition.message));
  }
  await rejected(insertRejection,[randomUUID(),t.workspace,t.parser,randomUUID(),'c'.repeat(64),'pdf_split_validation_failed','untrusted_private_error']);
  await rejected(insertRejection,[randomUUID(),t.workspace,t.parser,randomUUID(),'c'.repeat(64),'source_validation_failed','invalid_ranges']);
  await rejected(insertRejection,[randomUUID(),t.workspace,other.parser,randomUUID(),'c'.repeat(64),'source_validation_failed','empty'],'23503');
 });
});


test('failed remote split cleanup keeps reserved bytes until physical removal, including terminal deletion failures',async()=>{
 const t=await tenant(),attempt=randomUUID(),id=randomUUID(),key=`${t.workspace}/${id}`;
 objects.set(key,Buffer.from('Owned failed split write'));
 await adminPool.query("insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,1024,now()-interval '2 hours')",[id,t.workspace,key,attempt]);
 const reserved=async()=>Number((await adminPool.query('select coalesce(sum(reserved_bytes),0) bytes from intake_files where workspace_id=$1',[t.workspace])).rows[0].bytes);
 assert.equal((await reconcileInterruptedIntake(t.workspace)).queued,1);assert.equal(await reserved(),1024);
 useStorage({...remote,async remove(){throw new Error('Controlled storage deletion failure');}});
 assert.equal(await deleteStoredFile(t.workspace,key),'pending');assert.equal(await reserved(),1024);assert.ok(objects.has(key));
 await adminPool.query("update file_deletions set attempts=9 where workspace_id=$1 and storage_key=$2",[t.workspace,key]);
 assert.equal(await deleteStoredFile(t.workspace,key),'failed');assert.equal(await reserved(),1024);
 const failed=(await adminPool.query('select * from file_deletions where workspace_id=$1 and storage_key=$2',[t.workspace,key])).rows[0];
 assert.equal((await reconcileInterruptedIntake(t.workspace)).queued,0);
 assert.deepEqual((await adminPool.query('select * from file_deletions where id=$1',[failed.id])).rows[0],failed);
 // Queued/failed split reservations do not consume every remote sweep slot.
 const next=randomUUID(),nextKey=`${t.workspace}/${next}`;
 await adminPool.query("insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,512,now()-interval '2 hours')",[next,t.workspace,nextKey,randomUUID()]);
 objects.set(nextKey,Buffer.from('Owned later abandoned write'));
 assert.equal((await reconcileInterruptedIntake(t.workspace,{limit:1})).queued,1);assert.equal(await reserved(),1536);
 useStorage(remote);assert.equal(await deleteStoredFile(t.workspace,key),'complete');assert.equal(objects.has(key),false);assert.equal(await reserved(),512);
 assert.equal(await deleteStoredFile(t.workspace,nextKey),'complete');assert.equal(await reserved(),0);
 assert.equal((await adminPool.query('select id from file_deletions where workspace_id=$1',[t.workspace])).rowCount,0);
});

test('filesystem split reservations survive queued deletion failures and release only after removal or confirmed old absence',async()=>{
 const t=await tenant(),id=randomUUID(),key=`${t.workspace}/${id}`,old=new Date(Date.now()-2*60*60*1000);
 useStorage(filesystem);await storage.write(key,Buffer.from('Owned abandoned split child'));await fs.utimes(path.join(config.storageDir,key),old,old);
 await adminPool.query("insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,2048,now()-interval '2 hours')",[id,t.workspace,key,randomUUID()]);
 useStorage({...filesystem,async remove(){throw new Error('Controlled filesystem deletion failure');}});
 const result=await reconcileInterruptedIntake(t.workspace);assert.equal(result.queued,1);assert.equal(result.removed,0);assert.equal(result.expiredIntentsRemoved,0);
 assert.equal(Number((await adminPool.query('select reserved_bytes from intake_files where id=$1',[id])).rows[0].reserved_bytes),2048);await fs.access(path.join(config.storageDir,key));
 useStorage(filesystem);assert.equal(await deleteStoredFile(t.workspace,key),'complete');assert.equal((await adminPool.query('select id from intake_files where id=$1',[id])).rowCount,0);await assert.rejects(fs.access(path.join(config.storageDir,key)));
 const missing=randomUUID();await adminPool.query("insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,4096,now()-interval '2 hours')",[missing,t.workspace,`${t.workspace}/${missing}`,randomUUID()]);
 assert.equal((await reconcileInterruptedIntake(t.workspace)).expiredIntentsRemoved,1);assert.equal((await adminPool.query('select id from intake_files where id=$1',[missing])).rowCount,0);
});
