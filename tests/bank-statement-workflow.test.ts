import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Evidence} from '../shared/types.js';
import Fastify from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase,withWorkspace} from '../server/core/db.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {registerOperationalHealth} from '../server/core/operations.js';
import {bankStatementInstructions,bankStatementSchema,bankStatementWorkflow,legacyBankStatementSchema,legacyBankStatementInstructions} from '../shared/bank-statement-preset.js';
import {assertBankFixtureDatabase,bankRawFixture,cleanupBankFixtures,createBankFixture,setBankFixtureProvider} from './bank-statement-fixtures.js';

let app:Awaited<ReturnType<typeof buildApp>>,networkCalls=0;
const originalFetch=globalThis.fetch;
before(async()=>{await assertBankFixtureDatabase();globalThis.fetch=async()=>{networkCalls++;throw new Error('External network forbidden in bank fixtures');};app=await buildApp();});
afterEach(()=>{setExtractionProvider(undefined);assert.equal(networkCalls,0);});
after(async()=>{setExtractionProvider(undefined);globalThis.fetch=originalFetch;await app?.close();await cleanupBankFixtures();await closeDatabase();});
const save=(f:Awaited<ReturnType<typeof createBankFixture>>,run:any,values=run.bankValues)=>f.request('POST',`/api/runs/${run.id}/corrections`,{values,expectedRevision:run.effectiveRevision});

async function partialEvidenceFixture(f:Awaited<ReturnType<typeof createBankFixture>>,retainProviderIssue:boolean){
 const source=await f.queue(),raw=bankRawFixture(),evidence:Record<string,Evidence[]>={};
 for(const [field,value] of Object.entries(raw.accounts[0]))if(typeof value==='string')evidence[`accounts[0].${field}`]=[{page:1,text:value,source:'matched-text'}];
 for(const [index,row] of raw.accounts[0].transactions.entries())for(const [field,value] of Object.entries(row))if(value!==null)evidence[`accounts[0].transactions[${index}].${field}`]=[{page:1,text:value,source:'matched-text'}];
 const field='accounts[0].transactions[0].description';evidence[field]=[{page:1,text:'Office supplies',source:'matched-text'}];
 const issues=retainProviderIssue?[{field,code:'evidence_incomplete',message:'Retained synthetic provider warning'}]:[];
 setExtractionProvider({configured:()=>true,async extract(){return {rawValues:structuredClone(raw) as unknown as Record<string,unknown>,normalizedValues:{},evidence:structuredClone(evidence),issues:structuredClone(issues),engine:'controlled-evidence-fixture',model:'synthetic-provider'};}});
 try{assert.equal(await processOneCoreJob(source.jobId),true);const run=(await f.detail(source.document.id)).runs[0];assert.ok(run);return {...source,run,raw,evidence,issues};}finally{setExtractionProvider(undefined);}
}

test('bank worker retains evidence warnings and current approval binds them while drafts, exclusions and old exports preserve audit history',async()=>{
 const f=await createBankFixture(app),source=await partialEvidenceFixture(f,true),initial=source.run;
 const identity=initial.bankValues.accounts[0].transactions[0].id;
 const stored=async()=> (await adminPool.query('select raw_values,evidence,issues,bank_statement_context from extraction_runs where id=$1',[initial.id])).rows[0];
 const before=await stored();assert.ok(before.issues.some((issue:any)=>issue.message==='Retained synthetic provider warning'));assert.deepEqual(before.raw_values,source.raw);assert.deepEqual(before.evidence,source.evidence);
 const warning=initial.bankIssues.find((issue:any)=>issue.code==='evidence_incomplete');assert.equal(warning.transactionId,identity);assert.equal(warning.field,'description');assert.doesNotMatch(warning.message,/synthetic provider/);
 const oldToken=createHash('sha256').update(JSON.stringify({version:1,runId:initial.id,revision:initial.effectiveRevision,values:initial.bankValues,issues:initial.bankIssues.filter((issue:any)=>issue.code!=='evidence_incomplete'),relatedRevisions:[]})).digest('hex');
 assert.notEqual(initial.bankReviewToken,oldToken);
 assert.equal((await f.request('POST',`/api/runs/${initial.id}/approve`,{expectedRevision:initial.effectiveRevision,bankReviewToken:oldToken,acknowledgeBankWarnings:true})).statusCode,409);
 assert.equal((await f.request('POST',`/api/runs/${initial.id}/approve`,{expectedRevision:initial.effectiveRevision,bankReviewToken:initial.bankReviewToken})).statusCode,422);
 const approvalResponse=await f.approve(initial);assert.equal(approvalResponse.statusCode,200,approvalResponse.body);const approval=approvalResponse.json().approval;
 assert.ok(approval.bankReview.issues.some((issue:any)=>issue.code==='evidence_incomplete'&&issue.transactionId===identity));
 const exported=await f.request('POST','/api/exports',{format:'csv',workflow:'bank_statement',documentIds:[source.document.id],revisions:[{documentId:source.document.id,approvalId:approval.id}]});assert.equal(exported.statusCode,200,exported.body);
 const download=await f.request('GET',exported.json().downloadUrl);assert.equal(download.statusCode,200,download.body);
 const values=structuredClone(initial.bankValues);values.accounts[0].transactions[0].description='Office supplies';values.accounts[0].transactions.reverse();
 const corrected=await save(f,initial,values);assert.equal(corrected.statusCode,200,corrected.body);let run=corrected.json().run;
 assert.equal(run.bankIssues.find((issue:any)=>issue.code==='evidence_incomplete').transactionId,identity);assert.deepEqual(run.bankContext,initial.bankContext);
 const excluded=structuredClone(run.bankValues);const row=excluded.accounts[0].transactions.find((item:any)=>item.id===identity);row.excluded=true;row.exclusion_reason='Synthetic excluded item, retained in audit';
 const saved=await save(f,run,excluded);assert.equal(saved.statusCode,200,saved.body);run=saved.json().run;assert.ok(!run.bankIssues.some((issue:any)=>issue.code==='evidence_incomplete'));
 assert.deepEqual(await stored(),before);assert.deepEqual((await adminPool.query('select values,bank_review from approvals where id=$1',[approval.id])).rows[0],{values:approval.values,bank_review:approval.bankReview});
 const historical=await f.request('GET',exported.json().downloadUrl);assert.equal(historical.statusCode,200,historical.body);assert.ok(historical.rawPayload.equals(download.rawPayload));
});

test('legacy bank runs derive current partial-quote warnings without rewriting run or older approval snapshots',async()=>{
 const f=await createBankFixture(app),source=await partialEvidenceFixture(f,false),run=source.run;
 const before=(await adminPool.query('select raw_values,evidence,issues,bank_statement_context from extraction_runs where id=$1',[run.id])).rows[0];assert.ok(!before.issues.some((issue:any)=>issue.code==='evidence_incomplete'));
 // Explicit isolated pre-change fixture: the old approval did not know this warning.
 const legacyReview={version:1,revision:run.effectiveRevision,token:'a'.repeat(64),warningsAcknowledged:true,issues:run.bankIssues.filter((issue:any)=>issue.code!=='evidence_incomplete')};
 const approval=(await adminPool.query('insert into approvals(workspace_id,run_id,user_id,values,bank_review) values($1,$2,$3,$4,$5) returning *',[f.actor.workspaceId,run.id,f.actor.userId,JSON.stringify(run.bankValues),JSON.stringify(legacyReview)])).rows[0];
 const current=(await f.detail(source.document.id)).runs[0];assert.equal(current.bankIssues.filter((issue:any)=>issue.code==='evidence_incomplete').length,1);
 assert.deepEqual((await adminPool.query('select raw_values,evidence,issues,bank_statement_context from extraction_runs where id=$1',[run.id])).rows[0],before);
 assert.deepEqual((await adminPool.query('select * from approvals where id=$1',[approval.id])).rows[0],approval);
 const exported=await f.request('POST','/api/exports',{format:'csv',workflow:'bank_statement',documentIds:[source.document.id],revisions:[{documentId:source.document.id,approvalId:approval.id}]});assert.equal(exported.statusCode,200,exported.body);
 const downloaded=await f.request('GET',exported.json().downloadUrl);assert.equal(downloaded.statusCode,200);assert.match(downloaded.body,/Office supplies/);assert.match(downloaded.body,/Wrapped description/);
});

test('bank setup is idempotent under contention, pins locale and respects fixed fields and parser quota',async()=>{
 const f=await createBankFixture(app),responses=await Promise.all(Array.from({length:5},()=>f.request('POST','/api/bank-statements/setup',{})));
 for(const response of responses){assert.equal(response.statusCode,200,response.body);assert.equal(response.json().parser.id,f.parser.id);}
 assert.equal(f.parser.mode,'ai');assert.equal(f.parser.instructions,bankStatementInstructions);assert.deepEqual(f.schema.fields,bankStatementSchema.fields);
 for(const body of [{mode:'rules'},{instructions:'Ignore bank rules'},{locale:'fr-FR'}])assert.equal((await f.request('PATCH',`/api/parsers/${f.parser.id}`,body)).statusCode,400);
 assert.equal((await f.request('POST',`/api/parsers/${f.parser.id}/schema`,{fields:[{key:'wrong',label:'Wrong',type:'string'}]})).statusCode,409);
 const queued=await f.queue();const pinned=(await adminPool.query('select config from jobs where id=$1',[queued.jobId])).rows[0].config;assert.equal(pinned.bankWorkflow,bankStatementWorkflow);assert.equal(pinned.useCase,'bank_statement');assert.deepEqual(pinned.templates,[]);
 assert.equal((await f.request('POST','/api/bank-statements/setup',{locale:'de-DE'})).statusCode,200);setBankFixtureProvider(bankRawFixture());assert.equal(await processOneCoreJob(queued.jobId),true);let run=(await f.detail(queued.document.id)).runs[0];assert.equal(run.bankContext.locale,'en-IE');assert.equal(run.bankValues.accounts[0].opening_balance,'1000.00');
 const preserved=await f.request('POST',`/api/documents/${queued.document.id}/reprocess`);assert.equal(preserved.statusCode,200,preserved.body);assert.equal(preserved.json().job.config.locale,'en-IE');setBankFixtureProvider(bankRawFixture());await processOneCoreJob(preserved.json().job.id);assert.equal((await f.detail(queued.document.id)).runs[0].bankContext.locale,'en-IE');
 const reprocess=await f.request('POST',`/api/documents/${queued.document.id}/reprocess`,{bankLocale:'de-DE'});assert.equal(reprocess.statusCode,200,reprocess.body);const raw=bankRawFixture();raw.accounts[0].number_format='A decimal comma and full stop for thousands are used.';raw.accounts[0].opening_balance='1.000,00';raw.accounts[0].closing_balance='1.030,00';raw.accounts[0].total_debits='20,00';raw.accounts[0].total_credits='50,00';raw.accounts[0].transactions[0].debit='20,00';raw.accounts[0].transactions[0].balance='980,00';raw.accounts[0].transactions[1].credit='50,00';raw.accounts[0].transactions[1].balance='1.030,00';setBankFixtureProvider(raw);await processOneCoreJob(reprocess.json().job.id);run=(await f.detail(queued.document.id)).runs[0];assert.equal(run.bankContext.locale,'de-DE');assert.equal(run.bankValues.accounts[0].opening_balance,'1000.00');
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


function legacyRawFixture(){const raw=bankRawFixture();for(const account of raw.accounts){delete account.date_format;delete account.number_format;delete account.transaction_layout;delete account.movement_convention;}return raw;}
async function useLegacySchema(f:Awaited<ReturnType<typeof createBankFixture>>){
 const schema=(await adminPool.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) values($1,$2,2,$3,$4) returning *',[f.actor.workspaceId,f.parser.id,JSON.stringify(legacyBankStatementSchema),f.actor.userId])).rows[0];
 await adminPool.query('update parsers set active_schema_id=$2,instructions=$3 where id=$1',[f.parser.id,schema.id,legacyBankStatementInstructions]);return schema;
}

test('preset adoption creates an immutable version once; legacy queued jobs retain their exact schema and context',async()=>{
 const f=await createBankFixture(app),legacy=await useLegacySchema(f),oldQueue=await f.queue('old-pinned-preset');
 const oldJob=(await adminPool.query('select schema_version_id,config from jobs where id=$1',[oldQueue.jobId])).rows[0];assert.equal(oldJob.schema_version_id,legacy.id);
 const setup=await f.request('POST','/api/bank-statements/setup',{});assert.equal(setup.statusCode,200,setup.body);const adopted=setup.json().schema;assert.equal(adopted.version,3);assert.deepEqual(adopted.fields,bankStatementSchema.fields);assert.notEqual(adopted.id,legacy.id);
 const repeated=await f.request('POST','/api/bank-statements/setup',{});assert.equal(repeated.json().schema.id,adopted.id);assert.equal((await adminPool.query('select count(*)::int n from schema_versions where parser_id=$1',[f.parser.id])).rows[0].n,3);
 assert.deepEqual((await adminPool.query('select schema from schema_versions where id=$1',[legacy.id])).rows[0].schema,legacyBankStatementSchema);assert.deepEqual((await adminPool.query('select schema_version_id,config from jobs where id=$1',[oldQueue.jobId])).rows[0],oldJob);
 setBankFixtureProvider(legacyRawFixture(),legacyBankStatementSchema);assert.equal(await processOneCoreJob(oldQueue.jobId),true);const old=(await f.detail(oldQueue.document.id)).runs[0];assert.equal(old.schemaVersionId,legacy.id);assert.equal(old.bankContext.version,1);assert.ok(Object.values(old.bankContext.accounts).every((a:any)=>a.formats===undefined));assert.deepEqual(old.rawValues,legacyRawFixture());
 const modern=await f.upload();assert.equal(modern.run.schemaVersionId,adopted.id);assert.equal(modern.run.bankContext.version,1);assert.ok(Object.values(modern.run.bankContext.accounts).every((a:any)=>a.formats.dateOrder==='ymd'&&a.formats.numberStatus==='supported'));
 const historical=(await f.detail(oldQueue.document.id)).runs[0];assert.deepEqual(historical.bankContext,old.bankContext);assert.deepEqual(historical.rawValues,old.rawValues);
});

test('default legacy reprocessing pins server history; current preset is an explicit strictly validated choice',async()=>{
 const f=await createBankFixture(app),legacy=await useLegacySchema(f),source=await f.queue('historical-reprocess');setBankFixtureProvider(legacyRawFixture(),legacyBankStatementSchema);await processOneCoreJob(source.jobId);
 const initial=(await f.detail(source.document.id)).runs[0],approved=await f.approve(initial);assert.equal(approved.statusCode,200,approved.body);const approvalBefore=(await adminPool.query('select * from approvals where id=$1',[approved.json().approval.id])).rows[0];const snapshot=(await adminPool.query('select config from jobs where id=$1',[source.jobId])).rows[0].config;
 const setup=await f.request('POST','/api/bank-statements/setup',{});assert.equal(setup.statusCode,200,setup.body);const adopted=setup.json().schema;
 await adminPool.query("update parsers set instructions='Changed current parser settings',locale='en-US' where id=$1",[f.parser.id]);
 for(const body of [{bankUseCurrentPreset:'true'},{bankUseCurrentPreset:1},{bankUseCurrentPreset:true,config:snapshot},{schemaVersionId:adopted.id}])assert.equal((await f.request('POST',`/api/documents/${source.document.id}/reprocess`,body)).statusCode,400);
 const replay=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(replay.statusCode,200,replay.body);const replayJob=(await adminPool.query('select schema_version_id,config from jobs where id=$1',[replay.json().job.id])).rows[0];assert.equal(replayJob.schema_version_id,legacy.id);assert.deepEqual(replayJob.config,snapshot);setBankFixtureProvider(legacyRawFixture(),legacyBankStatementSchema);await processOneCoreJob(replay.json().job.id);
 assert.ok(Object.values((await f.detail(source.document.id)).runs[0].bankContext.accounts).every((a:any)=>a.formats===undefined));
 const explicit=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankUseCurrentPreset:true});assert.equal(explicit.statusCode,200,explicit.body);const chosen=(await adminPool.query('select schema_version_id,config from jobs where id=$1',[explicit.json().job.id])).rows[0];assert.equal(chosen.schema_version_id,adopted.id);assert.equal(chosen.config.instructions,'Changed current parser settings');setBankFixtureProvider(bankRawFixture());await processOneCoreJob(explicit.json().job.id);assert.ok(Object.values((await f.detail(source.document.id)).runs[0].bankContext.accounts).every((a:any)=>a.formats.version===1));
 assert.deepEqual((await adminPool.query('select * from approvals where id=$1',[approved.json().approval.id])).rows[0],approvalBefore);assert.deepEqual((await f.detail(source.document.id)).runs.find((r:any)=>r.id===initial.id).bankContext,initial.bankContext);
 // A deleted original job cannot justify substituting an unrelated snapshot.
 await adminPool.query('delete from jobs where id=$1',[source.jobId]);await adminPool.query('update documents set latest_run_id=$2 where id=$1',[source.document.id,initial.id]);const orphanCounts=(await adminPool.query('select (select count(*)::int from jobs where document_id=$1) jobs,(select count(*)::int from usage_ledger where document_id=$1) usage',[source.document.id])).rows[0];const orphanReplay=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(orphanReplay.statusCode,409,orphanReplay.body);assert.deepEqual((await adminPool.query('select (select count(*)::int from jobs where document_id=$1) jobs,(select count(*)::int from usage_ledger where document_id=$1) usage',[source.document.id])).rows[0],orphanCounts);const orphanCurrent=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankUseCurrentPreset:true});assert.equal(orphanCurrent.statusCode,200,orphanCurrent.body);assert.equal((await adminPool.query('select schema_version_id from jobs where id=$1',[orphanCurrent.json().job.id])).rows[0].schema_version_id,adopted.id);assert.deepEqual((await adminPool.query('select * from approvals where id=$1',[approved.json().approval.id])).rows[0],approvalBefore);
});

test('unexpected bank schemas are preserved during setup and refused by the fixed workflow worker',async()=>{
 const f=await createBankFixture(app),unexpected=structuredClone(legacyBankStatementSchema);unexpected.fields[0].instructions+=' Unreviewed custom schema.';
 const custom=(await adminPool.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) values($1,$2,2,$3,$4) returning *',[f.actor.workspaceId,f.parser.id,JSON.stringify(unexpected),f.actor.userId])).rows[0];await adminPool.query('update parsers set active_schema_id=$2 where id=$1',[f.parser.id,custom.id]);
 const setup=await f.request('POST','/api/bank-statements/setup',{});assert.equal(setup.statusCode,200,setup.body);assert.equal(setup.json().schema.id,custom.id);assert.deepEqual(setup.json().schema.fields,unexpected.fields);assert.equal((await adminPool.query('select count(*)::int n from schema_versions where parser_id=$1',[f.parser.id])).rows[0].n,2);
 let called=false;setExtractionProvider({configured:()=>true,async extract(){called=true;throw new Error('Unexpected schema must fail before extraction');}});const queued=await f.queue('unsupported-preserved');await processOneCoreJob(queued.jobId);assert.equal(called,false);const detail=await f.detail(queued.document.id);assert.equal(detail.document.status,'failed');assert.match(detail.document.error,/incompatible extraction settings/);assert.equal(detail.runs.length,0);
});


test('explicit current reprocessing directly adopts only the document parser legacy preset without prior setup',async()=>{
 const f=await createBankFixture(app),legacy=await useLegacySchema(f),source=await f.queue('direct-current-selection');setBankFixtureProvider(legacyRawFixture(),legacyBankStatementSchema);await processOneCoreJob(source.jobId);
 const choice=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankUseCurrentPreset:true});assert.equal(choice.statusCode,200,choice.body);const selected=(await adminPool.query('select j.schema_version_id,s.version,s.schema,p.active_schema_id from jobs j join schema_versions s on s.id=j.schema_version_id join parsers p on p.id=s.parser_id where j.id=$1',[choice.json().job.id])).rows[0];assert.equal(selected.version,3);assert.equal(selected.schema_version_id,selected.active_schema_id);assert.notEqual(selected.schema_version_id,legacy.id);assert.deepEqual(selected.schema,bankStatementSchema);assert.equal((await adminPool.query('select config from jobs where id=$1',[choice.json().job.id])).rows[0].config.instructions,bankStatementInstructions);assert.equal((await adminPool.query('select config from jobs where id=$1',[source.jobId])).rows[0].config.instructions,legacyBankStatementInstructions);setBankFixtureProvider(bankRawFixture());await processOneCoreJob(choice.json().job.id);assert.ok(Object.values((await f.detail(source.document.id)).runs[0].bankContext.accounts).every((a:any)=>a.formats.version===1));
 const custom=structuredClone(bankStatementSchema);custom.fields[0].label='Custom retained label';const customVersion=(await adminPool.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) values($1,$2,4,$3,$4) returning id',[f.actor.workspaceId,f.parser.id,JSON.stringify(custom),f.actor.userId])).rows[0];await adminPool.query('update parsers set active_schema_id=$2 where id=$1',[f.parser.id,customVersion.id]);const before=(await adminPool.query('select count(*)::int n from jobs where document_id=$1',[source.document.id])).rows[0].n;const refusal=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankUseCurrentPreset:true});assert.equal(refusal.statusCode,409,refusal.body);assert.equal((await adminPool.query('select count(*)::int n from jobs where document_id=$1',[source.document.id])).rows[0].n,before);assert.equal((await adminPool.query('select active_schema_id from parsers where id=$1',[f.parser.id])).rows[0].active_schema_id,customVersion.id);
});


test('explicit latest settings require parser-write API scope before schema, job or page usage changes',async()=>{
 const f=await createBankFixture(app),legacy=await useLegacySchema(f),source=await f.queue('scoped-preset-adoption');setBankFixtureProvider(legacyRawFixture(),legacyBankStatementSchema);await processOneCoreJob(source.jobId);
 const key=await f.request('POST','/api/workspace/api-keys',{name:'Synthetic document-only key',scopes:['documents:write']});assert.equal(key.statusCode,200,key.body);const headers={authorization:`Bearer ${key.json().token}`};const counts=async()=>(await adminPool.query('select (select count(*)::int from schema_versions where parser_id=$1) schemas,(select count(*)::int from jobs where document_id=$2) jobs,(select count(*)::int from usage_ledger where document_id=$2) usage',[f.parser.id,source.document.id])).rows[0],before=await counts();
 const denied=await app.inject({method:'POST',url:`/api/documents/${source.document.id}/reprocess`,headers,payload:{bankUseCurrentPreset:true}});assert.equal(denied.statusCode,403,denied.body);assert.deepEqual(await counts(),before);assert.equal((await adminPool.query('select active_schema_id from parsers where id=$1',[f.parser.id])).rows[0].active_schema_id,legacy.id);
 const replay=await app.inject({method:'POST',url:`/api/documents/${source.document.id}/reprocess`,headers,payload:{}});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().job.schemaVersionId,legacy.id);setBankFixtureProvider(legacyRawFixture(),legacyBankStatementSchema);await processOneCoreJob(replay.json().job.id);
 const allowedKey=await f.request('POST','/api/workspace/api-keys',{name:'Synthetic document-and-parser key',scopes:['documents:write','parsers:write']});assert.equal(allowedKey.statusCode,200,allowedKey.body);const allowed=await app.inject({method:'POST',url:`/api/documents/${source.document.id}/reprocess`,headers:{authorization:`Bearer ${allowedKey.json().token}`},payload:{bankUseCurrentPreset:true}});assert.equal(allowed.statusCode,200,allowed.body);assert.notEqual(allowed.json().job.schemaVersionId,legacy.id);assert.deepEqual((await adminPool.query('select schema from schema_versions where id=$1',[allowed.json().job.schemaVersionId])).rows[0].schema,bankStatementSchema);
});


test('a latest run without bank context retains its own config locale over an unrelated newer failed job',async()=>{
 const f=await createBankFixture(app,'en-US'),source=await f.upload();const newer=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{bankLocale:'de-DE'});assert.equal(newer.statusCode,200,newer.body);await adminPool.query("update jobs set state='failed' where id=$1",[newer.json().job.id]);await adminPool.query("update documents set status='failed' where id=$1",[source.document.id]);await adminPool.query('update extraction_runs set bank_statement_context=null where id=$1',[source.run.id]);const repeat=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(repeat.statusCode,200,repeat.body);assert.equal(repeat.json().job.config.locale,'en-US');assert.equal(repeat.json().job.schemaVersionId,source.run.schemaVersionId);
});
