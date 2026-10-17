import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {registerCore} from '../server/core/index.js';
import {adminPool,transaction,closeDatabase} from '../server/core/db.js';
import {hashToken} from '../server/core/auth.js';
import {config} from '../server/core/config.js';
import {privateStorage,setStorageForTests} from '../server/core/storage.js';
import {deleteStoredFile,processOneFileDeletion} from '../server/core/retention.js';
import {enforceRetention} from '../server/core/worker.js';
import {reconcileInterruptedIntake} from '../server/core/object-reconciliation.js';
import {assertRetentionRehearsalDatabase} from './retention-rehearsal-fixtures.js';

// Controlled operator-request rehearsal. It exercises supported product actions,
// not a broad user/workspace DELETE or an adopted account-erasure policy.
const workspace=randomUUID(),foreign=randomUUID(),owner=randomUUID(),member=randomUUID();
const tokens={owner:randomUUID(),member:randomUUID(),foreign:randomUUID()};
const apiKey=randomUUID(),apiToken=`fl_${randomUUID()}`,parser=randomUUID(),schema=randomUUID();
const document=randomUUID(),aged=randomUUID(),active=randomUUID(),otherDocument=randomUUID();
const source=Buffer.from('OWNED SYNTHETIC REQUEST. Reference: 00017');
const documentBytes=(id:string)=>Buffer.concat([source,Buffer.from(`\n${id}`)]);
const failures=new Set<string>();
const originalFetch=globalThis.fetch;
let networkCalls=0,app:FastifyInstance,owned=false;
const key=(w:string,id:string)=>`${w}/${id}`;
async function request(method:any,url:string,as:keyof typeof tokens='owner',payload?:unknown,selected=workspace){
 return app.inject({method,url,payload:payload as any,headers:{cookie:`folio_session=${tokens[as]}`,'x-workspace-id':selected,origin:config.origin}});
}
async function exists(w:string,id:string){return (await adminPool.query('select id from documents where workspace_id=$1 and id=$2',[w,id])).rowCount===1;}
async function control(){
 return {
  document:(await adminPool.query('select * from documents where id=$1',[otherDocument])).rows,
  activeDocument:(await adminPool.query('select * from documents where id=$1',[active])).rows,
  history:(await adminPool.query('select * from jobs where document_id=any($1::uuid[]) order by id',[[active,otherDocument]])).rows,
  user:(await adminPool.query('select * from users where id=$1',[member])).rows,
  membership:(await adminPool.query('select * from memberships where workspace_id=$1',[foreign])).rows,
  session:(await adminPool.query('select * from sessions where token_hash=$1',[hashToken(tokens.foreign)])).rows,
  usage:(await adminPool.query('select * from usage_ledger where workspace_id=any($1::uuid[]) order by id',[[workspace,foreign]])).rows,
  bytes:await fs.readFile(path.join(config.storageDir,key(foreign,otherDocument)),'utf8'),
  activeBytes:await fs.readFile(path.join(config.storageDir,key(workspace,active)),'utf8'),
 };
}
before(async()=>{
 await assertRetentionRehearsalDatabase();
 assert.equal((await adminPool.query('select count(*)::int n from file_deletions')).rows[0].n,0,'The isolated rehearsal needs an empty deletion queue.');
 globalThis.fetch=async()=>{networkCalls++;throw new Error('No provider requests in the owned closure rehearsal.');};
 const filesystem=privateStorage();assert.equal(filesystem.kind,'filesystem');
 setStorageForTests({...filesystem,async remove(storageKey){if(failures.has(storageKey))throw new Error('PRIVATE controlled provider diagnostic');await filesystem.remove(storageKey);}});
 app=Fastify({logger:false});await app.register(cookie);await app.register(multipart);
 app.setErrorHandler((error:any,_request,reply)=>reply.code(error.statusCode||500).send({error:error.message}));
 await registerCore(app);await app.ready();
 await transaction(adminPool,async c=>{
  for(const id of [owner,member])await c.query("insert into users(id,email,name,password_hash) values($1,$2,'Owned request fixture','unusable-fixture-hash')",[id,`request-${id}@example.test`]);
  for(const id of [workspace,foreign])await c.query("insert into workspaces(id,name,slug,settings) values($1,'Owned closure rehearsal',$2,'{\"retentionDays\":1}')",[id,id]);
  await c.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'owner'),($1,$3,'viewer'),($4,$3,'owner')",[workspace,owner,member,foreign]);
  for(const [token,u,w] of [[tokens.owner,owner,workspace],[tokens.member,member,workspace],[tokens.foreign,member,foreign]])await c.query("insert into sessions(token_hash,user_id,workspace_id,expires_at) values($1,$2,$3,now()+interval '1 hour')",[hashToken(token),u,w]);
  await c.query("insert into api_keys(id,workspace_id,user_id,name,prefix,token_hash,scopes) values($1,$2,$3,'Owned member credential','fl_owned',$4,'[\"documents:read\"]')",[apiKey,workspace,member,hashToken(apiToken)]);
  for(const w of [workspace,foreign]){
   const p=w===workspace?parser:randomUUID(),s=w===workspace?schema:randomUUID();
   await c.query("insert into parsers(id,workspace_id,name,use_case) values($1,$2,'Owned request parser','custom')",[p,w]);
   await c.query('insert into schema_versions(id,workspace_id,parser_id,version,schema) values($1,$2,$3,1,$4)',[s,w,p,JSON.stringify({fields:[{key:'reference',label:'Reference',type:'string'}]})]);
   await c.query('update parsers set active_schema_id=$2 where id=$1',[p,s]);
   for(const id of w===workspace?[document,aged,active]:[otherDocument]){
    const bytes=documentBytes(id);
    await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,created_at) values($1,$2,$3,'owned.txt','text/plain',$4,$5,$6,$7,1,now()-($8::int*interval '1 day'))",[id,w,p,bytes.length,createHash('sha256').update(bytes).digest('hex'),key(w,id),id===active?'queued':'needs_review',[aged,active,otherDocument].includes(id)?3:0]);
    await c.query("insert into jobs(workspace_id,document_id,schema_version_id,config,state,available_at) values($1,$2,$3,'{}',$4,now()+interval '1 hour')",[w,id,s,id===active?'queued':'completed']);
    await c.query("insert into usage_ledger(workspace_id,document_id,event,pages,idempotency_key) values($1,$2,'intake',1,$3)",[w,id,id]);
   }
  }
 });
 owned=true;
 for(const [w,ids] of [[workspace,[document,aged,active]],[foreign,[otherDocument]]] as const){
  await fs.mkdir(path.join(config.storageDir,w),{recursive:true,mode:0o700});
  for(const id of ids)await fs.writeFile(path.join(config.storageDir,key(w,id)),documentBytes(id),{mode:0o600});
 }
});
after(async()=>{
 try{
  await app?.close();setStorageForTests(undefined);globalThis.fetch=originalFetch;
  if(owned){
   await adminPool.query('delete from workspaces where id=any($1::uuid[])',[[workspace,foreign]]);
   await adminPool.query('delete from users where id=any($1::uuid[])',[[owner,member]]);
   for(const w of [workspace,foreign])await fs.rm(path.join(config.storageDir,w),{recursive:true,force:true});
  }
  assert.equal(networkCalls,0);
 }finally{await closeDatabase();}
});

test('authenticated owner request purges only its document; denied requests and pending physical removal remain explicit',async()=>{
 const before=await control();
 assert.equal((await app.inject({method:'DELETE',url:`/api/documents/${document}`})).statusCode,401);
 assert.equal((await request('DELETE',`/api/documents/${document}`,'member')).statusCode,403);
 assert.equal((await request('DELETE',`/api/documents/${otherDocument}`)).statusCode,404);
 assert.equal(await exists(workspace,document),true);
 failures.add(key(workspace,document));
 const result=await request('DELETE',`/api/documents/${document}`);assert.equal(result.statusCode,200,result.body);
 assert.deepEqual(result.json(),{ok:true,storageDeletion:'pending'});assert.equal(await exists(workspace,document),false);
 await fs.access(path.join(config.storageDir,key(workspace,document)));
 const pending=(await request('GET','/api/workspace/storage-deletions')).json().deletions;
 assert.equal(pending.length,1);assert.equal(pending[0].status,'pending');assert.equal(pending[0].attempts,1);
 assert.ok(!JSON.stringify(pending).includes('PRIVATE'));assert.equal((await request('GET','/api/workspace/storage-deletions','member')).statusCode,403);
 // Usage survives with a null document link; the rest of the control is exact.
 const after=await control();const beforeUsage=before.usage.map(row=>({...row,document_id:row.document_id===document?null:row.document_id}));
 assert.deepEqual(after,{...before,usage:beforeUsage});
});

test('failed removal retains its cleanup handle; only an authorised retry can recover terminal failure',async()=>{
 const before=await control();
 const storageKey=key(workspace,document);
 await adminPool.query('update file_deletions set attempts=9 where workspace_id=$1 and storage_key=$2',[workspace,storageKey]);
 assert.equal(await deleteStoredFile(workspace,storageKey),'failed');
 const row=(await adminPool.query('select * from file_deletions where workspace_id=$1 and storage_key=$2',[workspace,storageKey])).rows[0];
 assert.equal(row.attempts,10);assert.equal(row.status,'failed');await fs.access(path.join(config.storageDir,storageKey));
 assert.equal(await processOneFileDeletion(),false,'Terminal failure is quarantined from unattended retries.');
 assert.equal((await request('POST',`/api/workspace/storage-deletions/${row.id}/retry`,'member')).statusCode,403);
 assert.equal((await request('POST',`/api/workspace/storage-deletions/${row.id}/retry`,'foreign',undefined,foreign)).statusCode,404);
 assert.equal((await adminPool.query('select attempts from file_deletions where id=$1',[row.id])).rows[0].attempts,10);
 failures.delete(storageKey);
 assert.equal((await request('POST',`/api/workspace/storage-deletions/${row.id}/retry`)).statusCode,200);
 assert.equal(await processOneFileDeletion(),true);
 assert.equal((await adminPool.query('select id from file_deletions where id=$1',[row.id])).rowCount,0);
 await assert.rejects(fs.access(path.join(config.storageDir,storageKey)),(error:any)=>error.code==='ENOENT');
 assert.equal(await deleteStoredFile(workspace,storageKey),'complete','Repeated removal is idempotent.');
 assert.deepEqual(await control(),before,'Recovery must preserve protected originals, durable history and Usage.');
});

test('age expiry and orphan reconciliation preserve active, fresh, leased and foreign originals',async()=>{
 const foreignBefore=await control();
 assert.deepEqual(await enforceRetention(workspace),{removed:1});
 assert.equal(await exists(workspace,aged),false);assert.equal(await exists(workspace,active),true);
 const stale=randomUUID(),fresh=randomUUID(),leased=randomUUID();
 for(const id of [stale,fresh,leased])await fs.writeFile(path.join(config.storageDir,key(workspace,id)),Buffer.from('Owned orphan fixture'),{mode:0o600});
 for(const id of [stale,leased])await fs.utimes(path.join(config.storageDir,key(workspace,id)),new Date(Date.now()-3*3600_000),new Date(Date.now()-3*3600_000));
 await adminPool.query("insert into intake_files(id,workspace_id,storage_key,lease_expires_at) values($1,$2,$3,now()+interval '1 hour')",[leased,workspace,key(workspace,leased)]);
 const leaseBefore=(await adminPool.query('select * from intake_files where id=$1',[leased])).rows;
 const result=await reconcileInterruptedIntake(workspace,{limit:100});assert.equal(result.queued,1);assert.equal(result.removed,1);
 await assert.rejects(fs.access(path.join(config.storageDir,key(workspace,stale))),(error:any)=>error.code==='ENOENT');
 for(const id of [fresh,leased,active])await fs.access(path.join(config.storageDir,key(workspace,id)));
 assert.deepEqual((await adminPool.query('select * from intake_files where id=$1',[leased])).rows,leaseBefore);
 const after=await control();assert.deepEqual(after,{...foreignBefore,usage:foreignBefore.usage.map(row=>({...row,document_id:row.document_id===aged?null:row.document_id}))});
});

test('closure access removal rejects the old session and API key but preserves the separate account and workspace',async()=>{
 const before=await control();
 assert.equal((await request('DELETE',`/api/workspace/members/${owner}`)).statusCode,403,'The owner cannot be silently removed by this control.');
 assert.equal((await request('DELETE',`/api/workspace/members/${member}`)).statusCode,200);
 assert.equal((await request('GET','/api/workspace/settings','member')).statusCode,401);
 assert.equal((await app.inject({method:'GET',url:'/api/workspace/usage',headers:{authorization:`Bearer ${apiToken}`}})).statusCode,401);
 assert.equal((await request('GET','/api/workspace/settings','foreign',undefined,foreign)).statusCode,200);
 assert.deepEqual(await control(),before,'Account and foreign session/data must remain unchanged.');
 assert.equal((await adminPool.query('select * from api_keys where id=$1 and revoked_at is not null',[apiKey])).rowCount,1);
 assert.equal((await adminPool.query('select * from audit_events where workspace_id=$1 and action=\'member.removed\' and entity_id=$2',[workspace,member])).rowCount,1);
 assert.equal((await adminPool.query('select * from users where id=$1',[owner])).rowCount,1);
 // This is the required incomplete response category, never "account erased".
 assert.equal(await exists(workspace,active),true);
});
