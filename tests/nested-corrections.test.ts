import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type {FastifyInstance} from 'fastify';
import type {ParserSchema} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,transaction,closeDatabase,withWorkspace} from '../server/core/db.js';
import {hashToken,newToken} from '../server/core/auth.js';
import {config} from '../server/core/config.js';

type Account={userId:string;workspaceId:string;cookie:string};
const accounts:Account[]=[];let app:FastifyInstance,verified=false,networkCalls=0;
const originalFetch=globalThis.fetch;
const ordinarySchema:ParserSchema={fields:[{key:'group',label:'Group',type:'object',fields:[{key:'rows',label:'Rows',type:'array',fields:[{key:'detail',label:'Detail',type:'object',fields:[{key:'amount',label:'Amount',type:'number',required:true},{key:'enabled',label:'Enabled',type:'boolean'}]}]}]}]};
const ordinaryValues={group:{rows:[{detail:{amount:0,enabled:false}},{detail:{amount:2.5,enabled:true}}]}};
async function account():Promise<Account>{
 const value=await transaction(adminPool,async c=>{
  const user=(await c.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id',[`owned-nested-${randomUUID()}@example.test`,'Owned nested contract','unused owned fixture'])).rows[0];
  const workspace=(await c.query('INSERT INTO workspaces(name,slug) VALUES($1,$2) RETURNING id',['Owned nested review',randomUUID()])).rows[0];
  await c.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspace.id,user.id]);const token=newToken();
  await c.query("INSERT INTO sessions(token_hash,user_id,workspace_id,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[hashToken(token),user.id,workspace.id]);
  return {userId:user.id,workspaceId:workspace.id,cookie:`folio_session=${token}`};
 });accounts.push(value);return value;
}
async function fixture(owner:Account,schema:ParserSchema=ordinarySchema,values:Record<string,unknown>=ordinaryValues){
 return transaction(adminPool,async c=>{
  const parserId=randomUUID(),schemaId=randomUUID(),documentId=randomUUID(),runId=randomUUID();
  await c.query("INSERT INTO parsers(id,workspace_id,name,use_case,mode) VALUES($1,$2,'Owned nested parser','custom','rules')",[parserId,owner.workspaceId]);
  await c.query('INSERT INTO schema_versions(id,workspace_id,parser_id,version,schema,created_by) VALUES($1,$2,$3,1,$4,$5)',[schemaId,owner.workspaceId,parserId,JSON.stringify(schema),owner.userId]);
  await c.query('UPDATE parsers SET active_schema_id=$2 WHERE id=$1',[parserId,schemaId]);
  await c.query("INSERT INTO documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count) VALUES($1,$2,$3,'owned-nested.txt','text/plain',1,$4,$5,'needs_review',1)",[documentId,owner.workspaceId,parserId,'a'.repeat(64),`${owner.workspaceId}/${documentId}`]);
  await c.query("INSERT INTO extraction_runs(id,workspace_id,document_id,schema_version_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues) VALUES($1,$2,$3,$4,'owned fixture','owned fixture','owned fixture',$5,$6,$6,'{}','[]')",[runId,owner.workspaceId,documentId,schemaId,'a'.repeat(64),JSON.stringify(values)]);
  await c.query('UPDATE documents SET latest_run_id=$2 WHERE id=$1',[documentId,runId]);return {parserId,schemaId,documentId,runId,revision:`run:${runId}`,values};
 });
}
function request(owner:Account,method:'GET'|'POST',url:string,payload?:unknown,headers:Record<string,string>={}){return app.inject({method,url,payload:payload as any,headers:{cookie:owner.cookie,origin:config.origin,...headers}});}
async function state(documentId:string){
 return {document:(await adminPool.query('SELECT status,latest_run_id,approved_run_id,updated_at FROM documents WHERE id=$1',[documentId])).rows[0],corrections:(await adminPool.query('SELECT c.* FROM corrections c JOIN extraction_runs r ON r.id=c.run_id WHERE r.document_id=$1 ORDER BY c.id',[documentId])).rows,approvals:(await adminPool.query('SELECT a.* FROM approvals a JOIN extraction_runs r ON r.id=a.run_id WHERE r.document_id=$1 ORDER BY a.id',[documentId])).rows};
}
before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const urlMode=Boolean(pool.options.connectionString);
  if(urlMode){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');const url=new URL(pool.options.connectionString!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("SELECT current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,urlMode?5432:55432);if(!urlMode)assert.equal(row.address,null);
 }
 verified=true;globalThis.fetch=async()=>{networkCalls++;throw new Error('External calls forbidden in owned nested correction tests');};app=await buildApp();
});
afterEach(async()=>{if(verified){for(const owner of accounts)await adminPool.query('DELETE FROM workspaces WHERE id=$1',[owner.workspaceId]);for(const owner of accounts)await adminPool.query('DELETE FROM users WHERE id=$1',[owner.userId]);accounts.length=0;}assert.equal(networkCalls,0);});
after(async()=>{globalThis.fetch=originalFetch;await app?.close();await closeDatabase();});

test('extra nested object and row keys are rejected before any correction, approval or document state changes',async()=>{
 const owner=await account(),f=await fixture(owner),approved=await request(owner,'POST',`/api/runs/${f.runId}/approve`,{expectedRevision:f.revision});assert.equal(approved.statusCode,200,approved.body);
 const before=await state(f.documentId),auditBefore=(await adminPool.query('SELECT id FROM audit_events WHERE workspace_id=$1 ORDER BY id',[owner.workspaceId])).rows;
 for(const kind of ['root','object','row','depth4','prototype'] as const){
  const values:any=structuredClone(ordinaryValues);
  if(kind==='root')values.extra='unexpected';if(kind==='object')values.group.extra='unexpected';if(kind==='row')values.group.rows[0].extra='unexpected';if(kind==='depth4')values.group.rows[0].detail.extra='unexpected';if(kind==='prototype')Object.defineProperty(values.group.rows[0].detail,'__proto__',{value:{polluted:true},enumerable:true});
  const response=await request(owner,'POST',`/api/runs/${f.runId}/corrections`,{values,expectedRevision:f.revision});assert.equal(response.statusCode,400,response.body);assert.equal(response.json().message,kind==='prototype'?"Body is not valid JSON but content-type is set to 'application/json'":'Corrections contain a field outside this schema');assert.deepEqual(await state(f.documentId),before);
 }
 assert.deepEqual((await adminPool.query('SELECT id FROM audit_events WHERE workspace_id=$1 ORDER BY id',[owner.workspaceId])).rows,auditBefore);assert.equal(Object.hasOwn(Object.prototype,'polluted'),false);
});

test('invalid nested drafts remain savable, but missing values, wrong types and legacy hidden fields cannot approve',async()=>{
 const owner=await account(),f=await fixture(owner),values={group:{rows:[{detail:{amount:'unfinished-',enabled:false}},{detail:{amount:null,enabled:null}}]}};
 const saved=await request(owner,'POST',`/api/runs/${f.runId}/corrections`,{values,expectedRevision:f.revision});assert.equal(saved.statusCode,200,saved.body);assert.ok(saved.json().issues.some((i:any)=>i.code==='number'));assert.ok(saved.json().issues.some((i:any)=>i.code==='required'));
 const invalid=await request(owner,'POST',`/api/runs/${f.runId}/approve`,{expectedRevision:saved.json().run.effectiveRevision});assert.equal(invalid.statusCode,422);assert.equal((await state(f.documentId)).approvals.length,0);
 const legacy=structuredClone(ordinaryValues) as any;legacy.group.rows[0].detail.hidden='Legacy unreviewed attribute';
 const correction=(await adminPool.query('INSERT INTO corrections(workspace_id,run_id,user_id,values) VALUES($1,$2,$3,$4) RETURNING id',[owner.workspaceId,f.runId,owner.userId,JSON.stringify(legacy)])).rows[0];
 const before=await state(f.documentId);const rejected=await request(owner,'POST',`/api/runs/${f.runId}/approve`,{expectedRevision:`correction:${correction.id}`});assert.equal(rejected.statusCode,422,rejected.body);assert.match(rejected.json().message,/outside this schema/);assert.deepEqual(await state(f.documentId),before);
});

test('concurrent nested corrections reject a stale writer and stale approval without losing the accepted draft',async()=>{
 const owner=await account(),f=await fixture(owner),one=structuredClone(ordinaryValues),two=structuredClone(ordinaryValues);one.group.rows.reverse();two.group.rows[0].detail.amount=42;
 const responses=await Promise.all([one,two].map(values=>request(owner,'POST',`/api/runs/${f.runId}/corrections`,{values,expectedRevision:f.revision})));assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409]);
 const successful=responses.find(r=>r.statusCode===200)!.json();assert.equal((await state(f.documentId)).corrections.length,1);assert.deepEqual((await state(f.documentId)).corrections[0].values,successful.run.effectiveValues);
 assert.equal((await request(owner,'POST',`/api/runs/${f.runId}/approve`,{expectedRevision:f.revision})).statusCode,409);assert.equal((await state(f.documentId)).approvals.length,0);
});

test('foreign workspace, viewer and insufficient API scope cannot mutate nested results',async()=>{
 const owner=await account(),other=await account(),f=await fixture(owner),before=await state(f.documentId),payload={values:ordinaryValues,expectedRevision:f.revision};
 assert.equal((await request(other,'POST',`/api/runs/${f.runId}/corrections`,payload)).statusCode,404);assert.equal(await withWorkspace(other.workspaceId,async c=>(await c.query('SELECT 1 FROM corrections WHERE run_id=$1',[f.runId])).rowCount),0);
 await adminPool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[owner.workspaceId,other.userId]);assert.equal((await request(other,'POST',`/api/runs/${f.runId}/corrections`,payload,{'x-workspace-id':owner.workspaceId})).statusCode,403);
 const key=`fl_${newToken()}`;await adminPool.query("INSERT INTO api_keys(workspace_id,user_id,name,prefix,token_hash,scopes) VALUES($1,$2,'Owned nested key','fl_owned',$3,'[\"results:read\"]')",[owner.workspaceId,owner.userId,hashToken(key)]);
 assert.equal((await app.inject({method:'POST',url:`/api/runs/${f.runId}/corrections`,headers:{authorization:`Bearer ${key}`},payload})).statusCode,403);assert.deepEqual(await state(f.documentId),before);
});

test('deep row edits and maximum-length paths round-trip through pinned JSON, CSV and XLSX after a newer approval',async()=>{
 const owner=await account(),a='a'.repeat(64),b='b'.repeat(64),table='t'.repeat(64),object='o'.repeat(64),leaf='v'.repeat(64);
 const schema:ParserSchema={fields:[{key:a,label:'Root',type:'object',fields:[{key:b,label:'Middle',type:'object',fields:[{key:table,label:'Rows',type:'array',fields:[{key:leaf,label:'Description',type:'string'},{key:'zero',label:'Zero',type:'number'},{key:'enabled',label:'Enabled',type:'boolean'}]},{key:object,label:'Object',type:'object',fields:[{key:leaf,label:'Amount',type:'number'}]}]}]}]};
 const original={[a]:{[b]:{[table]:[{[leaf]:'original row',zero:9,enabled:true}],[object]:{[leaf]:10}}}},f=await fixture(owner,schema,original);
 const edited={[a]:{[b]:{[table]:[{[leaf]:'=1+1',zero:0,enabled:false},{[leaf]:'second, "quoted"\nrow',zero:2.5,enabled:true}],[object]:{[leaf]:42}}}};
 const saved=await request(owner,'POST',`/api/runs/${f.runId}/corrections`,{values:edited,expectedRevision:f.revision});assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().issues,[]);
 const approval=await request(owner,'POST',`/api/runs/${f.runId}/approve`,{expectedRevision:saved.json().run.effectiveRevision});assert.equal(approval.statusCode,200,approval.body);const approvalId=approval.json().approval.id;
 const newer:any=structuredClone(edited);newer[a][b][table].reverse();newer[a][b][object][leaf]=999;
 const changed=await request(owner,'POST',`/api/runs/${f.runId}/corrections`,{values:newer,expectedRevision:saved.json().run.effectiveRevision});assert.equal(changed.statusCode,200,changed.body);assert.equal((await request(owner,'POST',`/api/runs/${f.runId}/approve`,{expectedRevision:changed.json().run.effectiveRevision})).statusCode,200);
 const options={columns:[{source:[a,b,object,leaf].join('.'),label:'Amount'},{source:`$item.${leaf}`,label:'Description'},{source:'$item.zero',label:'Zero'},{source:'$item.enabled',label:'Enabled'}],lineItems:[a,b,table].join('.')};
 const mapping=await request(owner,'POST','/api/export-mappings',{parserId:f.parserId,name:'Owned deep mapping',...options});assert.equal(mapping.statusCode,200,mapping.body);assert.deepEqual(mapping.json().columns,options.columns);assert.equal(mapping.json().lineItems,options.lineItems);
 for(const format of ['json','csv','xlsx'] as const){
  const made=await request(owner,'POST','/api/exports',{documentIds:[f.documentId],revisions:[{documentId:f.documentId,approvalId}],format,...options});assert.equal(made.statusCode,200,made.body);const downloaded=await request(owner,'GET',made.json().downloadUrl);assert.equal(downloaded.statusCode,200);
  if(format==='json'){const record=downloaded.json().documents[0];assert.deepEqual(record.values,edited);assert.equal(record.approvalId,approvalId);assert.equal(record.correctionId,saved.json().correction.id);}
  if(format==='csv')assert.equal(downloaded.rawPayload.toString(),'\uFEFF"Amount","Description","Zero","Enabled"\r\n"42","\'=1+1","0","false"\r\n"42","second, ""quoted""\nrow","2.5","true"\r\n');
  if(format==='xlsx'){const book=new ExcelJS.Workbook();await book.xlsx.load(downloaded.rawPayload as any);const sheet=book.getWorksheet(1)!;assert.deepEqual((sheet.getRow(2).values as any[]).slice(1),[42,"'=1+1",0,false]);assert.deepEqual((sheet.getRow(3).values as any[]).slice(1),[42,'second, "quoted"\nrow',2.5,true]);}
  const snapshot=(await adminPool.query('SELECT records FROM export_snapshots WHERE id=$1',[made.json().id])).rows[0];assert.deepEqual(snapshot.records[0].values,edited);assert.equal(snapshot.records[0].approvalId,approvalId);
 }
 const run=(await adminPool.query('SELECT raw_values,normalized_values FROM extraction_runs WHERE id=$1',[f.runId])).rows[0];assert.deepEqual(run.raw_values,original);assert.deepEqual(run.normalized_values,original);
});
