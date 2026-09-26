import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,closeDatabase,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {extractRules} from '../server/core/extraction.js';
import type {Actor,ParserSchema} from '../shared/types.js';

let app:FastifyInstance,networkCalls=0;
const originalFetch=globalThis.fetch;
const accounts:Actor[]=[];
const schema:ParserSchema={fields:[{key:'occurred_at',label:'Occurred at',type:'timestamp',required:true},{key:'date',label:'Date',type:'date',required:true},{key:'identifier',label:'Identifier',type:'string',required:true}]};
before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  if(pool.options.connectionString){const url=new URL(pool.options.connectionString);assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/folio');assert.equal(url.port||'5432','5432');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
 }
 const identity=(await adminPool.query('select current_database() db,current_schema() schema,inet_server_addr()::text address')).rows[0];assert.equal(identity.db,'folio');assert.equal(identity.schema,'public');if(!adminPool.options.connectionString)assert.equal(identity.address,null);
 globalThis.fetch=async()=>{networkCalls++;throw new Error('External network forbidden in timestamp fixtures');};app=await buildApp();
});
afterEach(()=>{setExtractionProvider(undefined);assert.equal(networkCalls,0);});
after(async()=>{
 setExtractionProvider(undefined);globalThis.fetch=originalFetch;await app?.close();
 for(const actor of accounts){await adminPool.query('delete from workspaces where id=$1',[actor.workspaceId]);await fs.rm(path.join(config.storageDir,actor.workspaceId),{recursive:true,force:true});await adminPool.query('delete from users where id=$1',[actor.userId]);}
 await closeDatabase();
});
async function fixture(mode:'rules'|'ai'='rules'){
 const registration=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned timestamp fixture',email:`timestamp-${randomUUID()}@example.test`,password:'Owned timestamp fixture password',workspaceName:'Owned timestamp workspace'}});
 assert.equal(registration.statusCode,201,registration.body);const account=registration.json();
 const actor:Actor={userId:account.user.id,workspaceId:account.workspace.id,role:'owner',authType:'session'};accounts.push(actor);
 const headers={origin:config.origin,cookie:registration.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')};
 const request=(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown)=>app.inject({method,url,headers,payload:payload as any});
 const creation=await request('POST','/api/parsers',{name:'Owned timestamp parser',mode,locale:'en-IE',timezone:'Europe/Dublin',schema});assert.equal(creation.statusCode,201,creation.body);
 const parser=creation.json().parser;
 const upload=async(value:string)=>{
  const content=`Occurred at: ${value}\nDate: 17/09/2026\nIdentifier: 000127`;
  const source=await addDocument(actor,parser.id,Buffer.from(content),`owned-timestamp-${randomUUID()}.txt`);assert.ok(source.jobId);return {...source,jobId:source.jobId!};
 };
 const detail=async(id:string)=>{const response=await request('GET',`/api/documents/${id}`);assert.equal(response.statusCode,200,response.body);return response.json();};
 return {actor,request,parser,upload,detail};
}

test('queued and historical runs keep locale/timezone after parser changes, job deletion, corrections and exports',async()=>{
 const f=await fixture(),source=await f.upload('09/10/2026 14:30');
 const queued=(await adminPool.query('select config from jobs where id=$1',[source.jobId])).rows[0].config;assert.equal(queued.normalizationPolicy,'timestamp-v1');assert.equal(queued.timezone,'Europe/Dublin');
 assert.equal((await f.request('PATCH',`/api/parsers/${f.parser.id}`,{locale:'en-US',timezone:'America/Los_Angeles'})).statusCode,200);
 assert.equal(await processOneCoreJob(source.jobId),true);const run=(await f.detail(source.document.id)).runs[0];assert.ok(run);
 assert.deepEqual(run.normalizationContext,{version:'timestamp-v1',locale:'en-IE',timezone:'Europe/Dublin',tzdbVersion:process.versions.tz??null});
 assert.deepEqual(run.normalizedValues,{occurred_at:'2026-10-09T13:30:00Z',date:'2026-09-17',identifier:'000127'});assert.equal(run.rawValues.occurred_at,'09/10/2026 14:30');assert.deepEqual(run.timestampIssues,[]);
 await adminPool.query('delete from jobs where id=$1',[source.jobId]);assert.equal((await f.detail(source.document.id)).runs[0].jobId,null);
 const localCorrection=await f.request('POST',`/api/runs/${run.id}/corrections`,{values:{...run.effectiveValues,occurred_at:'10/09/2026 14:30'},expectedRevision:run.effectiveRevision});assert.equal(localCorrection.statusCode,200,localCorrection.body);
 const corrected=localCorrection.json().run;assert.equal(corrected.effectiveValues.occurred_at,'2026-09-10T13:30:00Z');assert.equal(corrected.normalizationContext.timezone,'Europe/Dublin');
 const approved=await f.request('POST',`/api/runs/${run.id}/approve`,{expectedRevision:corrected.effectiveRevision});assert.equal(approved.statusCode,200,approved.body);const approvalId=approved.json().approval.id;
 const reprocess=await f.request('POST',`/api/documents/${source.document.id}/reprocess`);assert.equal(reprocess.statusCode,200,reprocess.body);assert.equal(await processOneCoreJob(reprocess.json().job.id),true);
 const newest=(await f.detail(source.document.id)).runs[0];assert.notEqual(newest.id,run.id);assert.equal(newest.normalizationContext.timezone,'America/Los_Angeles');assert.equal(newest.normalizedValues.occurred_at,'2026-09-10T21:30:00Z');
 for(const format of ['json','csv','xlsx']){
  const exported=await f.request('POST','/api/exports',{documentIds:[source.document.id],revisions:[{documentId:source.document.id,approvalId}],format});assert.equal(exported.statusCode,200,exported.body);
  const bytes=await f.request('GET',exported.json().downloadUrl);assert.equal(bytes.statusCode,200,bytes.body);
  if(format==='xlsx'){const book=new ExcelJS.Workbook();await book.xlsx.load(bytes.rawPayload as any);assert.ok(JSON.stringify(book.worksheets[0].getSheetValues()).includes('2026-09-10T13:30:00Z'));assert.ok(JSON.stringify(book.worksheets[0].getSheetValues()).includes('000127'));}
  else{assert.ok(bytes.body.includes('2026-09-10T13:30:00Z'));assert.ok(bytes.body.includes('000127'));assert.ok(!bytes.body.includes('2026-09-10T21:30:00Z'));}
 }
 const original=(await f.request('GET',`/api/runs/${run.id}`)).json().run;assert.equal(original.rawValues.occurred_at,'09/10/2026 14:30');assert.equal(original.normalizedValues.occurred_at,'2026-10-09T13:30:00Z');
});

test('ambiguous and nonexistent timestamp corrections remain saved for review and cannot approve',async()=>{
 const f=await fixture(),source=await f.upload('2026-10-25 01:30');await processOneCoreJob(source.jobId);let run=(await f.detail(source.document.id)).runs[0];
 assert.equal(run.issues[0].code,'timestamp_ambiguous');assert.equal(run.timestampIssues[0].code,'timestamp_ambiguous');assert.equal((await f.request('POST',`/api/runs/${run.id}/approve`)).statusCode,422);
 const gap=await f.request('POST',`/api/runs/${run.id}/corrections`,{values:{...run.effectiveValues,occurred_at:'2026-03-29 01:30'}});assert.equal(gap.statusCode,200,gap.body);run=gap.json().run;assert.equal(gap.json().issues[0].code,'timestamp_nonexistent');assert.equal(run.timestampIssues[0].code,'timestamp_nonexistent');assert.equal(run.effectiveValues.occurred_at,'2026-03-29 01:30');assert.equal((await f.request('POST',`/api/runs/${run.id}/approve`)).statusCode,422);
 const fixed=await f.request('POST',`/api/runs/${run.id}/corrections`,{values:{...run.effectiveValues,occurred_at:'2026-10-25T01:30+01:00'}});assert.equal(fixed.statusCode,200,fixed.body);assert.equal(fixed.json().run.effectiveValues.occurred_at,'2026-10-25T00:30:00Z');assert.deepEqual(fixed.json().run.timestampIssues,[]);assert.equal((await f.request('POST',`/api/runs/${run.id}/approve`)).statusCode,200);
});

test('legacy absent run context never borrows a current parser timezone',async()=>{
 const f=await fixture(),source=await f.upload('2026-07-15 14:30');await processOneCoreJob(source.jobId);let run=(await f.detail(source.document.id)).runs[0];
 await adminPool.query('update extraction_runs set normalization_context=null where id=$1',[run.id]);
 const correction=await f.request('POST',`/api/runs/${run.id}/corrections`,{values:{...run.effectiveValues,occurred_at:'2026-07-15 14:30'}});assert.equal(correction.statusCode,200,correction.body);run=correction.json().run;assert.equal(run.normalizationContext,null);assert.equal(run.effectiveValues.occurred_at,'2026-07-15 14:30');assert.equal(correction.json().issues[0].code,'timestamp_timezone_missing');
 assert.equal((await f.request('POST',`/api/runs/${run.id}/approve`)).statusCode,422);
 const explicit=await f.request('POST',`/api/runs/${run.id}/corrections`,{values:{...run.effectiveValues,occurred_at:'2026-07-15T14:30+01:00'}});assert.equal(explicit.json().run.effectiveValues.occurred_at,'2026-07-15T13:30:00Z');
});

test('normalization snapshot constraint rejects null versions and malformed or incomplete contexts',async()=>{
 const f=await fixture(),source=await f.upload('2026-07-15 14:30');await processOneCoreJob(source.jobId);const run=(await f.detail(source.document.id)).runs[0],valid=run.normalizationContext;
 for(const value of [{...valid,version:null},{...valid,version:'future'},{...valid,locale:null},{...valid,timezone:4},{...valid,tzdbVersion:[]},{...valid,extra:true},{version:'timestamp-v1',locale:'en-IE'}])await assert.rejects(adminPool.query('update extraction_runs set normalization_context=$2 where id=$1',[run.id,JSON.stringify(value)]),(error:any)=>error.code==='23514');
 assert.deepEqual((await f.detail(source.document.id)).runs[0].normalizationContext,valid);
});

test('worker forwards pinned timezone to the controlled provider and rejects future normalization policies',async()=>{
 const f=await fixture('ai'),source=await f.upload('2026-07-15 14:30');let calls=0;
 setExtractionProvider({configured:()=>true,async extract(input){calls++;assert.equal(input.timezone,'Europe/Dublin');return extractRules(input.pages,input.schema,input.locale,[],input.timezone);}});
 await f.request('PATCH',`/api/parsers/${f.parser.id}`,{timezone:'UTC'});await processOneCoreJob(source.jobId);assert.equal(calls,1);assert.equal((await f.detail(source.document.id)).runs[0].normalizedValues.occurred_at,'2026-07-15T13:30:00Z');
 const unsupported=await f.upload('2026-07-16 14:30');await adminPool.query("update jobs set config=jsonb_set(config,'{normalizationPolicy}','\"unknown-policy\"') where id=$1",[unsupported.jobId]);await processOneCoreJob(unsupported.jobId);const failed=await f.detail(unsupported.document.id);assert.equal(failed.runs.length,0);assert.equal(failed.document.status,'failed');assert.match(failed.document.error,/unsupported normalization version/);assert.equal(calls,1);
});
