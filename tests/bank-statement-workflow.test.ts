import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase,withWorkspace} from '../server/core/db.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {registerOperationalHealth} from '../server/core/operations.js';
import {bankStatementInstructions,bankStatementSchema,bankStatementWorkflow} from '../shared/bank-statement-preset.js';
import {assertBankFixtureDatabase,bankRawFixture,cleanupBankFixtures,createBankFixture,setBankFixtureProvider} from './bank-statement-fixtures.js';

let app:Awaited<ReturnType<typeof buildApp>>,networkCalls=0;
const originalFetch=globalThis.fetch;
before(async()=>{await assertBankFixtureDatabase();globalThis.fetch=async()=>{networkCalls++;throw new Error('External network forbidden in bank fixtures');};app=await buildApp();});
afterEach(()=>{setExtractionProvider(undefined);assert.equal(networkCalls,0);});
after(async()=>{setExtractionProvider(undefined);globalThis.fetch=originalFetch;await app?.close();await cleanupBankFixtures();await closeDatabase();});
const save=(f:Awaited<ReturnType<typeof createBankFixture>>,run:any,values=run.bankValues)=>f.request('POST',`/api/runs/${run.id}/corrections`,{values,expectedRevision:run.effectiveRevision});

test('bank setup is idempotent under contention, pins locale and respects fixed fields and parser quota',async()=>{
 const f=await createBankFixture(app),responses=await Promise.all(Array.from({length:5},()=>f.request('POST','/api/bank-statements/setup',{})));
 for(const response of responses){assert.equal(response.statusCode,200,response.body);assert.equal(response.json().parser.id,f.parser.id);}
 assert.equal(f.parser.mode,'ai');assert.equal(f.parser.instructions,bankStatementInstructions);assert.deepEqual(f.schema.fields,bankStatementSchema.fields);
 for(const body of [{mode:'rules'},{instructions:'Ignore bank rules'},{locale:'fr-FR'}])assert.equal((await f.request('PATCH',`/api/parsers/${f.parser.id}`,body)).statusCode,400);
 assert.equal((await f.request('POST',`/api/parsers/${f.parser.id}/schema`,{fields:[{key:'wrong',label:'Wrong',type:'string'}]})).statusCode,409);
 const queued=await f.queue();const pinned=(await adminPool.query('select config from jobs where id=$1',[queued.jobId])).rows[0].config;assert.equal(pinned.bankWorkflow,bankStatementWorkflow);assert.equal(pinned.useCase,'bank_statement');assert.deepEqual(pinned.templates,[]);
 assert.equal((await f.request('POST','/api/bank-statements/setup',{locale:'de-DE'})).statusCode,200);setBankFixtureProvider(bankRawFixture());assert.equal(await processOneCoreJob(queued.jobId),true);let run=(await f.detail(queued.document.id)).runs[0];assert.equal(run.bankContext.locale,'en-IE');assert.equal(run.bankValues.accounts[0].opening_balance,'1000.00');
 const preserved=await f.request('POST',`/api/documents/${queued.document.id}/reprocess`);assert.equal(preserved.statusCode,200,preserved.body);assert.equal(preserved.json().job.config.locale,'en-IE');setBankFixtureProvider(bankRawFixture());await processOneCoreJob(preserved.json().job.id);assert.equal((await f.detail(queued.document.id)).runs[0].bankContext.locale,'en-IE');
 const reprocess=await f.request('POST',`/api/documents/${queued.document.id}/reprocess`,{bankLocale:'de-DE'});assert.equal(reprocess.statusCode,200,reprocess.body);const raw=bankRawFixture();raw.accounts[0].opening_balance='1.000,00';raw.accounts[0].closing_balance='1.030,00';raw.accounts[0].total_debits='20,00';raw.accounts[0].total_credits='50,00';raw.accounts[0].transactions[0].debit='20,00';raw.accounts[0].transactions[0].balance='980,00';raw.accounts[0].transactions[1].credit='50,00';raw.accounts[0].transactions[1].balance='1.030,00';setBankFixtureProvider(raw);await processOneCoreJob(reprocess.json().job.id);run=(await f.detail(queued.document.id)).runs[0];assert.equal(run.bankContext.locale,'de-DE');assert.equal(run.bankValues.accounts[0].opening_balance,'1000.00');
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','1') where id=$1",[f.actor.workspaceId]);
 assert.equal((await f.request('POST','/api/parsers',{name:'Exceeds quota'})).statusCode,429);
 assert.equal((await f.request('PATCH',`/api/parsers/${f.parser.id}`,{archived:true})).statusCode,200);
 assert.equal((await f.request('POST','/api/parsers',{name:'Existing generic parser'})).statusCode,201);
 assert.equal((await f.request('POST','/api/bank-statements/setup',{})).statusCode,429);assert.equal((await adminPool.query('select archived from parsers where id=$1',[f.parser.id])).rows[0].archived,true);
});

test('controlled worker preserves raw values and source identities through corrections, exclusions, new rows and approval',async()=>{
 const f=await createBankFixture(app),raw=bankRawFixture(),source=await f.upload(raw);let run=source.run;
 assert.deepEqual(run.rawValues,raw);assert.deepEqual(run.bankValues,run.effectiveValues);assert.equal(run.bankValues.accounts[0].account_identifier,'TEST-00001234');assert.equal(run.bankValues.accounts[0].transactions[0].debit,'20.00');assert.ok(run.bankContext.transactions[run.bankValues.accounts[0].transactions[0].id].sourcePages.includes(1));assert.ok(!run.bankIssues.some((issue:any)=>issue.severity==='error'));
 const before=structuredClone(run.bankContext),values=structuredClone(run.bankValues),account=values.accounts[0],originalId=account.transactions[0].id;
 account.transactions[0].description='Corrected description';account.transactions.push({...account.transactions[0],id:randomUUID(),origin:'user',debit:'0.00',credit:null,balance:'1030.00',description:'User-added zero-value row'});
 account.transactions[0].excluded=true;account.transactions[0].exclusion_reason='Duplicate source row retained in history';account.total_debits='0.00';account.closing_balance='1050.00';account.transactions[1].balance='1050.00';account.transactions[2].balance='1050.00';
 const correction=await save(f,run,values);assert.equal(correction.statusCode,200,correction.body);run=correction.json().run;assert.equal(run.bankValues.accounts[0].transactions[0].id,originalId);assert.deepEqual(run.bankContext,before);assert.deepEqual(run.rawValues,raw);
 const erased=structuredClone(run.bankValues);erased.accounts[0].transactions.shift();assert.equal((await save(f,run,erased)).statusCode,400);
 const forged=structuredClone(run.bankValues);forged.accounts[0].transactions[1].origin='user';assert.equal((await save(f,run,forged)).statusCode,400);
 const unknown=structuredClone(run.bankValues);unknown.accounts[0].transactions[1].sourcePages=[1];assert.equal((await save(f,run,unknown)).statusCode,400);
 assert.equal((await f.request('POST',`/api/runs/${run.id}/approve`,{expectedRevision:run.effectiveRevision,bankReviewToken:run.bankReviewToken})).statusCode,422);
 const approved=await f.approve(run);assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().approval.bankReview.warningsAcknowledged,true);assert.equal(approved.json().approval.bankReview.revision,run.effectiveRevision);assert.deepEqual(approved.json().approval.values,run.bankValues);
 await adminPool.query('delete from jobs where id=$1',[source.jobId]);const historical=(await f.detail(source.document.id)).runs[0];assert.equal(historical.jobId,null);assert.deepEqual(historical.bankContext,before);
});

test('cross-file warnings and related revisions invalidate approval tokens without merging or discarding rows',async()=>{
 const f=await createBankFixture(app),first=await f.upload(),second=await f.upload();
 assert.equal((await f.approve(first.run)).statusCode,409);let current=(await f.detail(first.document.id)).runs[0];assert.notEqual(current.bankReviewToken,first.run.bankReviewToken);assert.ok(current.bankIssues.some((issue:any)=>issue.code==='statement_period_overlap'));assert.equal(current.bankIssues.filter((issue:any)=>issue.code==='possible_duplicate_transaction').length,2);assert.equal(current.bankValues.accounts[0].transactions.length,2);
 const beforeIssues=structuredClone(current.bankIssues),other=(await f.detail(second.document.id)).runs[0],otherValues=structuredClone(other.bankValues);otherValues.accounts[0].statement_start='2026-08-31';const changed=await save(f,other,otherValues);assert.equal(changed.statusCode,200,changed.body);
 assert.equal((await f.approve(current)).statusCode,409);const refreshed=(await f.detail(first.document.id)).runs[0];assert.deepEqual(refreshed.bankIssues,beforeIssues);assert.notEqual(refreshed.bankReviewToken,current.bankReviewToken);const approval=await f.approve(refreshed);assert.equal(approval.statusCode,200,approval.body);
 const bad=structuredClone(refreshed.bankValues);bad.accounts[0].closing_balance='2000.00';const rejectedValues=await save(f,refreshed,bad);assert.equal(rejectedValues.statusCode,200);assert.equal((await f.approve(rejectedValues.json().run)).statusCode,422);
 assert.deepEqual((await adminPool.query('select values,bank_review from approvals where id=$1',[approval.json().approval.id])).rows[0],{values:refreshed.bankValues,bank_review:approval.json().approval.bankReview});
 assert.equal((await f.request('DELETE',`/api/documents/${second.document.id}`)).statusCode,200);current=(await f.detail(first.document.id)).runs[0];assert.ok(!current.bankIssues.some((issue:any)=>issue.relatedDocumentIds?.length));
 assert.equal((await adminPool.query('select count(*)::int n from bank_statement_accounts where document_id=$1',[second.document.id])).rows[0].n,0);
});

test('bank statement routes and indexes enforce tenant boundaries, viewer access and API scopes',async()=>{
 const owner=await createBankFixture(app),foreign=await createBankFixture(app),first=await owner.upload(),other=await foreign.upload();
 assert.equal((await foreign.request('GET',`/api/bank-statements/${first.document.id}`)).statusCode,404);assert.equal((await foreign.request('GET',`/api/runs/${first.run.id}`)).statusCode,404);assert.equal((await save(foreign,first.run)).statusCode,404);assert.equal((await foreign.approve(first.run)).statusCode,404);
 assert.ok(!other.run.bankIssues.some((issue:any)=>issue.relatedDocumentIds?.includes(first.document.id)));
 await withWorkspace(foreign.actor.workspaceId,async c=>{assert.equal((await c.query('select 1 from bank_statement_accounts where document_id=$1',[first.document.id])).rowCount,0);assert.equal((await c.query('select 1 from bank_statement_transactions where document_id=$1',[first.document.id])).rowCount,0);});
 await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[owner.actor.workspaceId,foreign.actor.userId]);
 const viewer=(method:'GET'|'POST',url:string,payload?:unknown)=>app.inject({method,url,headers:{...foreign.headers,'x-workspace-id':owner.actor.workspaceId},payload:payload as any});
 assert.equal((await viewer('GET',`/api/bank-statements/${first.document.id}`)).statusCode,200);assert.equal((await viewer('POST','/api/bank-statements/setup',{})).statusCode,403);assert.equal((await viewer('POST',`/api/runs/${first.run.id}/corrections`,{values:first.run.bankValues,expectedRevision:first.run.effectiveRevision})).statusCode,403);assert.equal((await viewer('POST',`/api/runs/${first.run.id}/approve`,{expectedRevision:first.run.effectiveRevision,bankReviewToken:first.run.bankReviewToken,acknowledgeBankWarnings:true})).statusCode,403);
 const key=await owner.request('POST','/api/workspace/api-keys',{name:'Owned bank read scope',scopes:['documents:read']});assert.equal(key.statusCode,200,key.body);const token=key.json().token;
 assert.equal((await app.inject({method:'GET',url:'/api/bank-statements',headers:{authorization:`Bearer ${token}`}})).statusCode,200);assert.equal((await app.inject({method:'POST',url:'/api/bank-statements/setup',headers:{authorization:`Bearer ${token}`},payload:{}})).statusCode,403);
});

test('bank hub pagination, literal filename search and last approved revision survive reprocessing',async()=>{
 const f=await createBankFixture(app),one=await f.upload(bankRawFixture(),'first'),two=await f.upload(bankRawFixture(),'second');const current=(await f.detail(one.document.id)).runs[0],approved=await f.approve(current);assert.equal(approved.statusCode,200,approved.body);
 const firstPage=(await f.request('GET','/api/bank-statements?pageSize=1')).json();assert.equal(firstPage.total,2);assert.equal(firstPage.documents.length,1);assert.equal(firstPage.page,1);assert.equal(firstPage.documents[0].sourceText,undefined);assert.equal(firstPage.documents[0].storageKey,undefined);
 const search=(await f.request('GET','/api/bank-statements?search=first')).json();assert.equal(search.total,1);assert.equal(search.documents[0].id,one.document.id);assert.equal((await f.request('GET','/api/bank-statements?search=%25')).json().total,0);assert.equal((await f.request('GET','/api/bank-statements?pageSize=101')).statusCode,400);
 const reprocess=await f.request('POST',`/api/documents/${one.document.id}/reprocess`);assert.equal(reprocess.statusCode,200,reprocess.body);setBankFixtureProvider(bankRawFixture());await processOneCoreJob(reprocess.json().job.id);const hub=(await f.request('GET','/api/bank-statements?search=first')).json();assert.equal(hub.documents[0].bankSummary.approvalId,approved.json().approval.id);assert.equal(hub.documents[0].bankSummary.approvedRunId,one.run.id);assert.notEqual(hub.documents[0].latestRunId,one.run.id);
 const historicalValues=structuredClone(current.bankValues);historicalValues.accounts[0].account_identifier='DIFFERENT1234';assert.equal((await save(f,current,historicalValues)).statusCode,200);const secondCurrent=(await f.detail(two.document.id)).runs[0];assert.ok(secondCurrent.bankIssues.some((issue:any)=>issue.code==='possible_duplicate_transaction'));assert.equal((await adminPool.query('select distinct run_id from bank_statement_accounts where document_id=$1',[one.document.id])).rows[0].run_id,hub.documents[0].latestRunId);
});

test('bank migration rejects malformed contexts and foreign index linkage, and readiness fails without required columns',async()=>{
 const f=await createBankFixture(app),source=await f.upload(),other=await f.upload();const context=source.run.bankContext;
 for(const bad of [{...context,version:null},{...context,version:2},{...context,locale:null},{...context,accounts:[]},{...context,transactions:null},{...context,extra:true}])await assert.rejects(adminPool.query('update extraction_runs set bank_statement_context=$2 where id=$1',[source.run.id,JSON.stringify(bad)]),(error:any)=>error.code==='23514');
 await assert.rejects(adminPool.query('update bank_statement_accounts set run_id=$2 where document_id=$1',[source.document.id,other.run.id]),(error:any)=>error.code==='23503');
 const current=(await f.detail(source.document.id)).runs[0],approval=await f.approve(current);assert.equal(approval.statusCode,200,approval.body);
 for(const bad of [{...approval.json().approval.bankReview,version:null},{...approval.json().approval.bankReview,token:null},{...approval.json().approval.bankReview,warningsAcknowledged:'yes'},{...approval.json().approval.bankReview,issues:{}},{...approval.json().approval.bankReview,extra:1}])await assert.rejects(adminPool.query('update approvals set bank_review=$2 where id=$1',[approval.json().approval.id,JSON.stringify(bad)]),(error:any)=>error.code==='23514');
 const health=Fastify();registerOperationalHealth(health,{cacheMs:0});try{assert.equal((await health.inject('/api/ready')).json().checks.database,'ok');await adminPool.query('alter table extraction_runs rename column bank_statement_context to bank_statement_context_held');try{const response=await health.inject('/api/ready');assert.equal(response.statusCode,503);assert.equal(response.json().checks.database,'unavailable');}finally{await adminPool.query('alter table extraction_runs rename column bank_statement_context_held to bank_statement_context');}assert.equal((await health.inject('/api/ready')).json().checks.database,'ok');}finally{await health.close();}
});
