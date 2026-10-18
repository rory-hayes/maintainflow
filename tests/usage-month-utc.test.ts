/** Real routes and owned fixtures only; requires an isolated copied database or CI. */
import test, {before, after, mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool, appPool, closeDatabase, databaseSchema, withWorkspace} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {setStorageForTests, type PrivateStorage} from '../server/core/storage.js';

type Account = {user: {id: string}; workspace: {id: string}; cookie: string};
const accounts: Account[] = [], objects = new Map<string, Buffer>();
let app: FastifyInstance, isolated = false, networkCalls = 0;
const storage: PrivateStorage = {
  kind: 'filesystem',
  async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
  async read(key) { const bytes = objects.get(key); assert.ok(bytes); return Buffer.from(bytes); },
  async remove(key) { objects.delete(key); },
};
const request = (account: Account, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({method, url, payload: payload as any, headers: {cookie: account.cookie, origin: config.origin, ...headers}});
async function upload(account: Account, parserId: string) {
  const boundary = `owned-${randomUUID()}`;
  const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="utc-month.txt"\r\nContent-Type: text/plain\r\n\r\nSYNTHETIC UTC MONTH FIXTURE ${randomUUID()}\r\n--${boundary}--\r\n`);
  return request(account, 'POST', `/api/parsers/${parserId}/documents`, payload, {'content-type': `multipart/form-data; boundary=${boundary}`});
}
async function usage(account: Account) {
  const response = await request(account, 'GET', '/api/workspace/usage');
  assert.equal(response.statusCode, 200, response.body);
  return response.json().usage;
}

before(async () => {
  assert.equal(databaseSchema, 'public');
  assert.equal(process.env.NODE_ENV, 'test');
  const pools = [[adminPool, 'folio_admin'], [appPool, 'folio_app']] as const;
  const urlMode = Boolean(adminPool.options.connectionString || appPool.options.connectionString);
  if (urlMode) {
    assert.ok(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true');
    for (const [pool, role] of pools) {
      assert.equal(typeof pool.options.connectionString, 'string');
      const url = new URL(pool.options.connectionString!);
      assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
      assert.equal(url.pathname, '/folio'); assert.equal(url.port || '5432', '5432');
      assert.equal(decodeURIComponent(url.username), role); assert.equal(url.search, ''); assert.equal(url.hash, '');
    }
  } else {
    assert.ok(config.root.startsWith('/private/tmp/') || config.root.startsWith('/tmp/'), 'Never use the ordinary checkout database');
    for (const [pool, role] of pools) {
      assert.equal(path.resolve(pool.options.host!), path.resolve(config.root, '.local/socket'));
      assert.equal(pool.options.port, 55432); assert.equal(pool.options.database, 'folio'); assert.equal(pool.options.user, role);
    }
  }
  // Keep exactly one application session alive so its deliberately non-UTC
  // timezone applies to every real route transaction in this isolated file.
  assert.equal(appPool.totalCount, 0);
  appPool.options.max = 1;
  appPool.options.idleTimeoutMillis = 0;
  for (const [pool, role] of pools) {
    const row = (await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];
    assert.equal(row.db, 'folio'); assert.equal(row.schema, 'public'); assert.equal(row.role, role);
    assert.equal(row.port, urlMode ? 5432 : 55432); if (!urlMode) assert.equal(row.address, null);
  }
  isolated = true;
  setStorageForTests(storage);
  const deny = () => { networkCalls++; throw new Error('External requests are forbidden in UTC month fixtures'); };
  mock.method(globalThis, 'fetch', deny); mock.method(http, 'request', deny); mock.method(https, 'request', deny);
  app = Fastify({logger: false});
  await app.register(cookie); await app.register(multipart);
  app.setErrorHandler((error: any, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode || 500).send({message: error.message}));
  await registerCore(app); await app.ready();
});
after(async () => {
  try {
    await app?.close();
    if (isolated) {
      for (const account of accounts) await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
      for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.user.id]);
    }
    assert.equal(networkCalls, 0);
  } finally { mock.restoreAll(); setStorageForTests(undefined); objects.clear(); await closeDatabase(); }
});

test('UTC month boundary governs real upload quotas and usage/cost totals in east and west database sessions', async () => {
  for (const timezone of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
    await appPool.query("select set_config('TimeZone',$1,false)", [timezone]);
    const registration = await app.inject({method: 'POST', url: '/api/auth/register', headers: {origin: config.origin},
      payload: {name: 'Owned UTC month fixture', workspaceName: 'Owned UTC month fixture', email: `utc-month-${randomUUID()}@example.test`, password: 'Owned UTC month fixture password'}});
    assert.equal(registration.statusCode, 201, registration.body);
    const account: Account = {...registration.json(), cookie: registration.cookies.map(c => `${c.name}=${c.value}`).join('; ')};
    accounts.push(account);
    const workspaceId = account.workspace.id;
    const session = await withWorkspace(workspaceId, async c => (await c.query("select now() instant,current_setting('TimeZone') timezone")).rows[0]);
    assert.equal(session.timezone, timezone);
    // Derive expected boundaries from UTC calendar fields, not the SQL being tested.
    const instant = new Date(session.instant), start = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1);
    const stamps = [new Date(start - 1), new Date(start), new Date(start + 1)];
    await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','3') where id=$1", [workspaceId]);
    const created = await request(account, 'POST', '/api/parsers', {name: 'Owned UTC month parser', useCase: 'custom', mode: 'rules',
      schema: {fields: [{key: 'reference', label: 'Reference', type: 'string', required: false}]}});
    assert.equal(created.statusCode, 201, created.body);
    const parserId = created.json().parser.id;
    const first = await upload(account, parserId);
    assert.equal(first.statusCode, 202, first.body);
    const documentId = first.json().document.id;
    const doc = (await adminPool.query('select d.sha256,p.active_schema_id from documents d join parsers p on p.id=d.parser_id where d.id=$1', [documentId])).rows[0];
    await adminPool.query('update usage_ledger set created_at=$2 where document_id=$1', [documentId, stamps[1]]);
    for (const [index, pages] of [[0, 100], [2, 1]]) {
      await adminPool.query("insert into usage_ledger(workspace_id,event,pages,idempotency_key,created_at) values($1,'synthetic-month-boundary',$2,$3,$4)", [workspaceId, pages, randomUUID(), stamps[index]]);
    }
    for (const [index, extractionCost, suggestionCost] of [[0, 7, 9], [1, 0.01, 0.04], [2, 0.02, 0.05]]) {
      await adminPool.query(`insert into extraction_runs(workspace_id,document_id,schema_version_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues,cost_usd,created_at)
        values($1,$2,$3,'synthetic-fixture','synthetic-fixture','synthetic-fixture',$4,'{}','{}','[]','[]',$5,$6)`, [workspaceId, documentId, doc.active_schema_id, doc.sha256, extractionCost, stamps[index]]);
      await adminPool.query(`insert into schema_suggestions(workspace_id,parser_id,document_id,base_schema_id,request_id,document_sha256,config,state,proposed_schema,model,prompt_version,cost_usd,created_at,completed_at)
        values($1,$2,$3,$4,$5,$6,'{}','ready','{"fields":[]}','synthetic-fixture','synthetic-fixture',$7,$8,$8)`, [workspaceId, parserId, documentId, doc.active_schema_id, randomUUID(), doc.sha256, suggestionCost, stamps[index]]);
    }
    const initial = await usage(account);
    assert.equal(initial.pages, 2); assert.equal(initial.events, 2);
    assert.equal(initial.extractionCostUsd, 0.03); assert.equal(initial.schemaSuggestionCostUsd, 0.09);
    assert.equal(initial.schemaSuggestions, 2); assert.equal(initial.costUsd, 0.12);
    const allowed = await upload(account, parserId);
    assert.equal(allowed.statusCode, 202, allowed.body);
    const refused = await upload(account, parserId);
    assert.equal(refused.statusCode, 429, refused.body);
    assert.match(refused.json().message, /Monthly page quota reached/);
    const full = await usage(account);
    assert.equal(full.pages, 3); assert.equal(full.events, 3); assert.equal(full.documents, 2);
    assert.equal(full.costUsd, 0.12); assert.equal(full.schemaSuggestions, 2);
    assert.equal((await withWorkspace(workspaceId, async c => (await c.query("show TimeZone")).rows[0])).TimeZone, timezone);
  }
});

test('Usage estimates failed attempts, deduplicates exact successful fallbacks and exposes unknown/legacy coverage across all AI kinds',async()=>{
 const registration=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned cost coverage',workspaceName:'Owned cost coverage',email:`cost-coverage-${randomUUID()}@example.test`,password:'Owned cost coverage fixture password'}});
 assert.equal(registration.statusCode,201,registration.body);
 const account:Account={...registration.json(),cookie:registration.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};accounts.push(account);
 const workspaceId=account.workspace.id;
 const created=await request(account,'POST','/api/parsers',{name:'Owned cost parser',useCase:'custom',mode:'rules',schema:{fields:[{key:'reference',label:'Reference',type:'string',required:false}]}});
 assert.equal(created.statusCode,201,created.body);const parserId=created.json().parser.id;
 const uploaded=await upload(account,parserId);assert.equal(uploaded.statusCode,202,uploaded.body);
 const documentId=uploaded.json().document.id;
 const doc=(await adminPool.query('select d.sha256,p.active_schema_id,j.id job_id from documents d join parsers p on p.id=d.parser_id join jobs j on j.document_id=d.id where d.id=$1',[documentId])).rows[0];
 const instant=new Date((await adminPool.query('select now() instant')).rows[0].instant);
 const current=new Date(Date.UTC(instant.getUTCFullYear(),instant.getUTCMonth(),1));
 const previous=new Date(current.getTime()-1);
 const extractionAttempt=randomUUID(),schemaAttempt=randomUUID(),splitAttempt=randomUUID(),unknownAttempt=randomUUID(),failedAttempt=randomUUID(),oldAttempt=randomUUID(),knownAttempt=randomUUID();
 const schemaId=randomUUID(),splitId=randomUUID(),oldSchemaId=randomUUID();
 async function attempt(id:string,kind:string,operation:string,state:'unknown'|'reported_priced'|'reported_unpriced',cost:number|null,at=current,workspace=workspaceId){
  const reported=state!=='unknown';
  await adminPool.query(`insert into ai_usage_attempts(id,workspace_id,kind,operation_id,attempt,created_at,outcome,observed_at,model,http_status,response_status,usage_state,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_usd,pricing_basis)
   values($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,[id,workspace,kind,operation,at,reported?'response_received':'interrupted',reported?at:null,reported?'synthetic-model':null,reported?200:null,reported?'failed':null,state,reported?10:null,reported?0:null,reported?1:null,reported?0:null,cost,state==='reported_priced'?'Synthetic standard USD fixture':null]);
 }
 async function run(estimate:number,marker?:string,jobId:string|null=null,known=true,at=current,source={id:documentId,sha256:doc.sha256}){
  await adminPool.query(`insert into extraction_runs(workspace_id,document_id,schema_version_id,job_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues,token_usage,cost_usd,created_at)
   values($1,$2,$3,$4,'openai','synthetic-model','synthetic-fixture',$5,'{}','{}','[]','[]',$6,$7,$8)`,[workspaceId,source.id,doc.active_schema_id,jobId,source.sha256,JSON.stringify({...(known?{estimatedCost:true}:{}),...(marker?{aiUsageAttemptId:marker}:{})}),estimate,at]);
 }
 async function fields(id:string,estimate:number,marker?:string,at=current){
  await adminPool.query(`insert into schema_suggestions(id,workspace_id,parser_id,document_id,base_schema_id,request_id,document_sha256,config,state,proposed_schema,model,prompt_version,token_usage,cost_usd,created_at,completed_at)
   values($1,$2,$3,$4,$5,$6,$7,'{}','ready','{"fields":[]}','synthetic-model','synthetic-fixture',$8,$9,$10,$10)`,[id,workspaceId,parserId,documentId,doc.active_schema_id,randomUUID(),doc.sha256,JSON.stringify({estimatedCost:true,...(marker?{aiUsageAttemptId:marker}:{})}),estimate,at]);
 }
 async function splits(id:string,estimate:number,marker?:string){
  await adminPool.query(`insert into split_suggestions(id,workspace_id,parser_id,requested_by,request_id,auth_type,token_hash,source_name,source_sha256,source_mime_type,expected_bytes,source_reserved_bytes,config,state,page_count,start_pages,model,prompt_version,token_usage,cost_usd,created_at,completed_at)
   values($1,$2,$3,$4,$5,'session',$6,'synthetic-cost.pdf',$7,'application/pdf',1,0,'{}','ready',1,'[1]','synthetic-model','synthetic-fixture',$8,$9,$10,$10)`,[id,workspaceId,parserId,account.user.id,randomUUID(),'0'.repeat(64),doc.sha256,JSON.stringify({estimatedCost:true,...(marker?{aiUsageAttemptId:marker}:{})}),estimate,current]);
 }
 await attempt(extractionAttempt,'extraction',doc.job_id,'unknown',null);await run(0.1,extractionAttempt,doc.job_id);
 await attempt(schemaAttempt,'schema_suggestion',schemaId,'reported_priced',0.2);await fields(schemaId,0.9,schemaAttempt);
 await attempt(splitAttempt,'split_suggestion',splitId,'reported_unpriced',null);await splits(splitId,0.4,splitAttempt);
 await attempt(unknownAttempt,'extraction',randomUUID(),'unknown',null);
 await attempt(failedAttempt,'extraction',randomUUID(),'reported_priced',0.3);
 const knownUpload=await upload(account,parserId);assert.equal(knownUpload.statusCode,202,knownUpload.body);
 const knownDocument=knownUpload.json().document.id;
 const knownSource=(await adminPool.query('select d.id,d.sha256,j.id job_id from documents d join jobs j on j.document_id=d.id where d.id=$1',[knownDocument])).rows[0];
 await attempt(knownAttempt,'extraction',knownSource.job_id,'reported_priced',0.5);await run(0.7,knownAttempt,knownSource.job_id,true,current,knownSource);
 // A current successful result linked to a prior-month attempt belongs to that
 // attempt's month; it must not reappear as a legacy current-month estimate.
 await attempt(oldAttempt,'schema_suggestion',oldSchemaId,'reported_priced',9,previous);await fields(oldSchemaId,0.5,oldAttempt);
 await run(0.05);await fields(randomUUID(),0.06);await splits(randomUUID(),0.07);
 await run(0,undefined,null,false);await run(99,undefined,null,true,previous);
 const otherRegistration=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned other workspace',workspaceName:'Owned other workspace',email:`cost-other-${randomUUID()}@example.test`,password:'Owned other workspace fixture password'}});
 assert.equal(otherRegistration.statusCode,201,otherRegistration.body);
 const other:Account={...otherRegistration.json(),cookie:otherRegistration.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};accounts.push(other);
 const otherAttempt=randomUUID();await attempt(otherAttempt,'extraction',randomUUID(),'reported_priced',100,current,other.workspace.id);
 const pagesBefore=(await adminPool.query('select pages,event from usage_ledger where workspace_id=$1 order by id',[workspaceId])).rows;
 const summary=(await usage(account)).aiCostCoverage;
 assert.equal(summary.period,'utc_month_to_date');assert.equal(summary.completeness,'partial');
 assert.equal(summary.knownEstimatedCostUsd,1.68);assert.equal(summary.recordedAttempts,6);assert.equal(summary.pricedObservationAttempts,3);
 assert.equal(summary.successfulFallbackAttempts,2);assert.equal(summary.unknownObservationAttempts,2);assert.equal(summary.unpricedObservationAttempts,1);assert.equal(summary.unknownCostAttempts,1);
 assert.equal(summary.legacySuccessfulResults,4);assert.equal(summary.legacyEstimatedResults,3);assert.equal(summary.legacyUnknownCostResults,1);assert.equal(summary.legacyEstimatedCostUsd,0.18);
 assert.deepEqual(summary.byKind.map((row:any)=>[row.kind,row.knownEstimatedCostUsd]),[['extraction',0.95],['schema_suggestion',0.26],['split_suggestion',0.47]]);
 assert.deepEqual((await adminPool.query('select pages,event from usage_ledger where workspace_id=$1 order by id',[workspaceId])).rows,pagesBefore);
 // Actual FK deletion removes operation identity from both surviving runs.
 // Keep the priced observation once; an unknown observation cannot use an
 // unbound fallback and must remain unknown rather than become a legacy zero.
 await adminPool.query('delete from jobs where id=any($1::uuid[])',[[doc.job_id,knownSource.job_id]]);
 const orphaned=await usage(account);
 assert.equal(orphaned.aiCostCoverage.knownEstimatedCostUsd,1.58);
 assert.equal(orphaned.aiCostCoverage.recordedAttempts,6);
 assert.equal(orphaned.aiCostCoverage.successfulFallbackAttempts,1);
 assert.equal(orphaned.aiCostCoverage.unknownCostAttempts,2);
 assert.equal(orphaned.aiCostCoverage.legacySuccessfulResults,4);
 const orphanRuns=(await adminPool.query("select job_id from extraction_runs where token_usage->>'aiUsageAttemptId'=any($1::text[])",[[extractionAttempt,knownAttempt]])).rows;
 assert.equal(orphanRuns.length,2);assert.equal(orphanRuns.every(row=>row.job_id===null),true);
 // A marker for another kind or tenant must not suppress a true legacy row.
 await run(0.02,schemaAttempt);await run(0.03,otherAttempt);
 const mismatched=await usage(account);
 assert.equal(mismatched.aiCostCoverage.knownEstimatedCostUsd,1.63);
 assert.equal(mismatched.aiCostCoverage.legacySuccessfulResults,6);
 assert.equal(mismatched.aiCostCoverage.legacyEstimatedCostUsd,0.23);
 assert.equal(mismatched.aiCostCoverage.unknownCostAttempts,2);
 assert.deepEqual((await adminPool.query('select pages,event from usage_ledger where workspace_id=$1 order by id',[workspaceId])).rows,pagesBefore);
 assert.equal(mismatched.pages,2,'Cost observations never consume page credits');
});
