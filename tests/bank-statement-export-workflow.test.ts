import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import ExcelJS from 'exceljs';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {bankStatementExportColumns} from '../shared/bank-statement-preset.js';
import type {BankValues,RawBankValues} from '../shared/bank-statements.js';
import {presets} from '../shared/presets.js';
import {createBankSourceFixtures,syntheticBankRaw,syntheticBankEvidence} from '../scripts/bank-statement-fixtures.js';
import {assertBankFixtureDatabase,createBankFixture,cleanupBankFixtures,setBankFixtureProvider} from './bank-statement-fixtures.js';
import type {Evidence} from '../shared/types.js';

type Fixture=Awaited<ReturnType<typeof createBankFixture>>;
type Format='csv'|'xlsx';
let app:Awaited<ReturnType<typeof buildApp>>,verified=false,networkCalls=0;
let sources:Awaited<ReturnType<typeof createBankSourceFixtures>>;
const originalFetch=globalThis.fetch;
const clone=<T>(value:T):T=>structuredClone(value);
const ok=(response:any,status=200)=>{assert.equal(response.statusCode,status,response.body);return response.json();};

before(async()=>{
  // Refuses the usual working checkout database. Root runs this only in its
  // dedicated temporary copied checkout, or the explicit CI database contract.
  await assertBankFixtureDatabase();verified=true;
  globalThis.fetch=async()=>{networkCalls++;throw new Error('External calls are forbidden in synthetic bank export acceptance');};
  app=await buildApp();sources=await createBankSourceFixtures();
});
afterEach(async()=>{setExtractionProvider(undefined);if(verified)await cleanupBankFixtures();assert.equal(networkCalls,0);});
after(async()=>{setExtractionProvider(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified)await cleanupBankFixtures();}finally{await closeDatabase();}});

async function source(f:Fixture,raw:RawBankValues=clone(syntheticBankRaw),kind:'native'|'scanned'='native'){
  // A harmless PDF comment provides distinct source identity for separate
  // owned admissions while preserving the actual two-page decoder fixture.
  const label=randomUUID(),bytes=Buffer.concat([sources[kind],Buffer.from(`\n% Owned bank export fixture ${label}\n`)]);
  const accepted=await addDocument(f.actor,f.parser.id,bytes,`synthetic-${kind}-${label}.pdf`);assert.equal(accepted.duplicate,false);assert.ok(accepted.jobId);
  let calls=0;setExtractionProvider({configured:()=>true,async extract(input){
    calls++;assert.equal(input.mimeType,'application/pdf');assert.equal(input.pages.length,2);assert.ok(input.bytes.equals(bytes));
    const evidence:Record<string,Evidence[]>={};
    for(const entry of syntheticBankEvidence)evidence[entry.field]=[{page:entry.page,text:entry.text,source:kind==='scanned'?'model-visual':'matched-text'}];
    return {rawValues:clone(raw) as unknown as Record<string,unknown>,normalizedValues:{must_not_be_used:true},evidence,issues:[],engine:'controlled-bank-export-fixture',model:'synthetic-provider',promptVersion:'synthetic-bank-export-v1'};
  }});
  try{assert.equal(await processOneCoreJob(accepted.jobId),true);assert.equal(calls,1);const detail=await f.detail(accepted.document.id);assert.equal(detail.document.status,'needs_review',detail.document.error);assert.equal(detail.runs.length,1);assert.ok(detail.runs[0].bankContext);assert.deepEqual(detail.runs[0].rawValues,raw);return {...accepted,jobId:accepted.jobId!,run:detail.runs[0],bytes};}
  finally{setExtractionProvider(undefined);}
}
async function freshRun(f:Fixture,id:string){return ok(await f.request('GET',`/api/runs/${id}`)).run;}
async function approve(f:Fixture,id:string){const run=await freshRun(f,id);assert.equal(run.bankIssues.filter((issue:any)=>issue.severity==='error').length,0,JSON.stringify(run.bankIssues));return ok(await f.approve(run)).approval;}
async function correct(f:Fixture,id:string,values:BankValues){const run=await freshRun(f,id);return ok(await f.request('POST',`/api/runs/${id}/corrections`,{values,expectedRevision:run.effectiveRevision}));}
async function exported(f:Fixture,format:Format,selections:{documentId:string;approvalId:string}[],headers?:Record<string,string>){
  const payload={documentIds:selections.map(s=>s.documentId),revisions:selections,format,workflow:'bank_statement'};
  const response=headers?await app.inject({method:'POST',url:'/api/exports',headers,payload}):await f.request('POST','/api/exports',payload),created=ok(response);
  const download=headers?await app.inject({method:'GET',url:created.downloadUrl,headers}):await f.request('GET',created.downloadUrl);
  assert.equal(download.statusCode,200,download.body);assert.match(download.headers['cache-control']??'',/private.*no-store/);
  return {created,download,table:await readTable(download.rawPayload,format)};
}
async function readTable(bytes:Buffer,format:Format){
  const book=new ExcelJS.Workbook();let sheet:ExcelJS.Worksheet;
  if(format==='csv'){assert.ok(bytes.toString('utf8').startsWith('\uFEFF'));sheet=await book.csv.read(Readable.from([bytes]),{map:value=>value,parserOptions:{ignoreEmpty:false}});}
  else{await book.xlsx.load(bytes as any);assert.equal(book.worksheets.length,1);sheet=book.getWorksheet('Transactions')!;assert.ok(sheet);}
  const headers=bankStatementExportColumns.map((_,index)=>String(sheet.getCell(1,index+1).value));assert.deepEqual(headers,[...bankStatementExportColumns]);
  const rows=Array.from({length:sheet.rowCount-1},(_,index)=>Object.fromEntries(headers.map((header,column)=>[header,sheet.getCell(index+2,column+1).value??''])));
  if(format==='csv')assert.ok(rows.every(row=>Object.values(row).every(value=>typeof value==='string')),'CSV parser must not round long monetary strings into numbers.');
  sheet.eachRow(row=>row.eachCell(cell=>assert.equal(cell.type===ExcelJS.ValueType.Formula,false,'Export text must never become an Excel formula.')));
  return {headers,rows,sheet};
}
const selection=(documentId:string,approvalId:string)=>({documentId,approvalId});

test('actual PDF extraction, corrections and reprocessing preserve exact explicitly selected historical exports',async()=>{
  const f=await createBankFixture(app),item=await source(f),run=item.run;
  assert.equal(item.document.pageCount,2);assert.deepEqual(run.bankContext.transactions[run.bankValues.accounts[0].transactions[1].id].sourcePages,[2]);
  const originalRaw=clone(run.rawValues),originalContext=clone(run.bankContext),first=await approve(f,run.id);
  const initial=await exported(f,'csv',[selection(item.document.id,first.id)]);assert.equal(initial.table.rows.length,2);assert.equal(initial.table.rows[0].Debit,'10.00');assert.equal(initial.table.rows[1].Credit,'20.00');

  const changed:BankValues=clone(first.values),account=changed.accounts[0],originalDebit=account.transactions[0],originalCredit=account.transactions[1],addedId=randomUUID();
  originalDebit.excluded=true;originalDebit.exclusion_reason='Reviewed source line is superseded by the corrected manual row';
  originalCredit.description='\t=HYPERLINK("https://example.test")\nLiteral synthetic text';originalCredit.reference='+cmd';originalCredit.balance='1020.00';
  account.transactions=[originalCredit,originalDebit,{id:addedId,origin:'user',excluded:false,exclusion_reason:null,date:'2026-09-05',description:'Manual correction, "quoted"\nsecond line',reference:'@reference',debit:'10.00',credit:null,balance:'1010.00',currency:'EUR'}];
  const saved=await correct(f,run.id,changed);assert.deepEqual(saved.run.bankContext,originalContext);assert.deepEqual(saved.run.rawValues,originalRaw);const reviewed=await approve(f,run.id);
  assert.deepEqual(reviewed.values.accounts[0].transactions.map((row:any)=>row.id),[originalCredit.id,originalDebit.id,addedId]);
  const newer:BankValues=clone(reviewed.values);newer.accounts[0].transactions[0].description='NEWER REVIEW MUST NOT REPLACE HISTORICAL APPROVAL';await correct(f,run.id,newer);const latestApproval=await approve(f,run.id);assert.notEqual(latestApproval.id,reviewed.id);

  const reprocessed=ok(await f.request('POST',`/api/documents/${item.document.id}/reprocess`));const laterRaw=clone(syntheticBankRaw);laterRaw.accounts[0].transactions[0].description='NEW EXTRACTION MUST NOT REPLACE HISTORICAL APPROVAL';setBankFixtureProvider(laterRaw);
  try{assert.equal(await processOneCoreJob(reprocessed.job.id),true);}finally{setExtractionProvider(undefined);}
  const after=await f.detail(item.document.id);assert.equal(after.document.status,'needs_review');assert.notEqual(after.document.latestRunId,run.id);assert.equal(after.document.approvedRunId,run.id);
  const laterRun=after.runs.find((candidate:any)=>candidate.id===after.document.latestRunId);assert.ok(laterRun?.bankContext);assert.equal(laterRun.rawValues.accounts[0].transactions[0].description,laterRaw.accounts[0].transactions[0].description);

  for(const format of ['csv','xlsx'] as const){
    const originalExport=await exported(f,format,[selection(item.document.id,first.id)]),historical=await exported(f,format,[selection(item.document.id,reviewed.id)]);
    assert.deepEqual(originalExport.table.rows.map(row=>row['Transaction ID']),first.values.accounts[0].transactions.map((row:any)=>row.id));assert.equal(originalExport.table.rows[0].Description,'Coffee supply monthly office stock');
    assert.deepEqual(historical.table.rows.map(row=>row['Transaction ID']),[originalCredit.id,addedId]);assert.deepEqual(historical.table.rows.map(row=>row['Transaction origin']),['extracted','user']);
    assert.equal(historical.table.rows[0].Description,'\'=HYPERLINK("https://example.test")\nLiteral synthetic text');
    assert.equal(historical.table.rows[0].Reference,"'+cmd");assert.equal(historical.table.rows[1].Reference,"'@reference");assert.equal(historical.table.rows[1].Description,'Manual correction, "quoted"\nsecond line');
    assert.deepEqual(historical.table.rows.map(row=>row['Running balance']),format==='csv'?['1020.00','1010.00']:[1020,1010]);assert.deepEqual(historical.table.rows.map(row=>row['Approval ID']),[reviewed.id,reviewed.id]);
    const stored=(await adminPool.query('select records,bytes from export_snapshots where id=$1 and workspace_id=$2',[historical.created.id,f.actor.workspaceId])).rows[0];assert.deepEqual(stored.records[0].values,reviewed.values);assert.equal(stored.records[0].correctionId,saved.correction.id);assert.equal(stored.records[0].runId,run.id);assert.deepEqual(stored.bytes,historical.download.rawPayload);
  }
  assert.deepEqual((await f.request('GET',initial.created.downloadUrl)).rawPayload,initial.download.rawPayload);
  const untouched=(await adminPool.query('select raw_values,bank_statement_context from extraction_runs where id=$1 and workspace_id=$2',[run.id,f.actor.workspaceId])).rows[0];assert.deepEqual(untouched.raw_values,originalRaw);assert.deepEqual(untouched.bank_statement_context,originalContext);
});

test('selected native/scanned batch exports retain account/currency identity and exact large monetary text',async()=>{
  const f=await createBankFixture(app),first=await source(f),firstApproval=await approve(f,first.run.id),raw=clone(syntheticBankRaw);
  raw.accounts[0].account_identifier='BATCH-EUR-00001234';raw.accounts[0].opening_balance='200.00';raw.accounts[0].closing_balance='201.00';raw.accounts[0].total_debits='0.00';raw.accounts[0].total_credits='1.00';raw.accounts[0].transactions=[{date:'2026-09-06',description:'Batch euro credit',reference:'BATCH-EUR',debit:null,credit:'1.00',balance:'201.00',currency:'EUR'}];
  raw.accounts.push({...clone(raw.accounts[0]),account_identifier:'0000987654321',currency:'USD',opening_balance:'9007199254740993.00',closing_balance:'9007199254740993.01',total_credits:'0.01',transactions:[{date:'2026-09-06',description:'Batch exact dollar credit',reference:'BATCH-USD',debit:null,credit:'0.01',balance:'9007199254740993.01',currency:'USD'}]});
  const second=await source(f,raw,'scanned'),secondApproval=await approve(f,second.run.id);
  for(const format of ['csv','xlsx'] as const){const output=await exported(f,format,[selection(second.document.id,secondApproval.id),selection(first.document.id,firstApproval.id)]),rows=output.table.rows;assert.equal(rows.length,4);
    assert.deepEqual(rows.map(row=>row['Document ID']),[second.document.id,second.document.id,first.document.id,first.document.id]);assert.deepEqual(rows.map(row=>row.Currency),['EUR','USD','EUR','EUR']);assert.deepEqual(rows.map(row=>row['Approval ID']),[secondApproval.id,secondApproval.id,firstApproval.id,firstApproval.id]);
    assert.deepEqual(rows.map(row=>row['Account group ID']),[secondApproval.values.accounts[0].id,secondApproval.values.accounts[1].id,firstApproval.values.accounts[0].id,firstApproval.values.accounts[0].id]);assert.equal(rows[1]['Account identifier'],'0000987654321');assert.equal(rows[1]['Running balance'],'9007199254740993.01');assert.equal(rows[1].Credit,format==='csv'?'0.01':0.01);
    assert.deepEqual(rows.map(row=>row['Source statement']),[second.document.name,second.document.name,first.document.name,first.document.name]);assert.equal(new Set(rows.map(row=>row['Transaction ID'])).size,4);
  }
});

test('unapproved, JSON, generic-column and mixed-workflow requests create no bank export snapshots',async()=>{
  const f=await createBankFixture(app),item=await source(f);const before=(await adminPool.query('select count(*)::int count from export_snapshots where workspace_id=$1',[f.actor.workspaceId])).rows[0].count;
  assert.equal((await f.request('POST','/api/exports',{documentIds:[item.document.id],format:'csv',workflow:'bank_statement'})).statusCode,400);
  const approval=await approve(f,item.run.id),base={documentIds:[item.document.id],revisions:[selection(item.document.id,approval.id)]};
  for(const options of [{format:'json'},{format:'csv',columns:[{source:'accounts',label:'Generic accounts'}]},{format:'xlsx',lineItems:'accounts.transactions'},{format:'csv',workflow:'generic'}])assert.equal((await f.request('POST','/api/exports',{...base,...options})).statusCode,400);
  await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','2') where id=$1",[f.actor.workspaceId]);
  const generic=ok(await f.request('POST','/api/parsers',{name:'Owned generic export comparison',useCase:'invoice',mode:'rules'}),201),admitted=await addDocument(f.actor,generic.parser.id,Buffer.from(presets.invoice.sample),'owned-generic-invoice.txt');assert.ok(admitted.jobId);assert.equal(await processOneCoreJob(admitted.jobId),true);const detail=ok(await f.request('GET',`/api/documents/${admitted.document.id}`)),genericRun=detail.runs[0];const genericApproval=ok(await f.request('POST',`/api/runs/${genericRun.id}/approve`,{expectedRevision:genericRun.effectiveRevision})).approval;
  const mixed=await f.request('POST','/api/exports',{documentIds:[item.document.id,admitted.document.id],revisions:[selection(item.document.id,approval.id),selection(admitted.document.id,genericApproval.id)],format:'csv',workflow:'bank_statement'});assert.equal(mixed.statusCode,400,mixed.body);
  assert.equal((await f.request('POST','/api/exports',{documentIds:[admitted.document.id],format:'csv',workflow:'bank_statement'})).statusCode,400);
  assert.equal((await adminPool.query('select count(*)::int count from export_snapshots where workspace_id=$1',[f.actor.workspaceId])).rows[0].count,before);
  assert.equal((await adminPool.query("select id from document_events where document_id=$1 and phase='export'",[item.document.id])).rowCount,0);
});

test('foreign workspaces cannot select or download snapshots; viewers export the same approved read-only result',async()=>{
  const f=await createBankFixture(app),foreign=await createBankFixture(app),item=await source(f),approval=await approve(f,item.run.id),foreignItem=await foreign.upload(),foreignApproval=await approve(foreign,foreignItem.run.id),chosen=selection(item.document.id,approval.id),owned=await exported(f,'csv',[chosen]);
  assert.equal((await foreign.request('GET',owned.created.downloadUrl)).statusCode,404);assert.equal((await foreign.request('POST','/api/exports',{documentIds:[item.document.id],revisions:[chosen],format:'csv'})).statusCode,404);
  assert.equal((await f.request('POST','/api/exports',{documentIds:[item.document.id],revisions:[selection(item.document.id,foreignApproval.id)],format:'csv'})).statusCode,400);
  assert.equal((await f.request('POST','/api/exports',{documentIds:[item.document.id,foreignItem.document.id],format:'csv'})).statusCode,404);
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[f.actor.workspaceId,foreign.actor.userId]);
  const viewerHeaders={...foreign.headers,'x-workspace-id':f.actor.workspaceId},run=await freshRun(f,item.run.id);
  const correction=await app.inject({method:'POST',url:`/api/runs/${run.id}/corrections`,headers:viewerHeaders,payload:{values:run.bankValues,expectedRevision:run.effectiveRevision}});assert.equal(correction.statusCode,403);
  const rejected=await app.inject({method:'POST',url:`/api/runs/${run.id}/approve`,headers:viewerHeaders,payload:{expectedRevision:run.effectiveRevision,bankReviewToken:run.bankReviewToken,acknowledgeBankWarnings:true}});assert.equal(rejected.statusCode,403);
  const view=await exported(f,'csv',[chosen],viewerHeaders);assert.deepEqual(view.download.rawPayload,owned.download.rawPayload);assert.deepEqual(view.table.rows,owned.table.rows);
  const memberDownload=await app.inject({method:'GET',url:owned.created.downloadUrl,headers:viewerHeaders});assert.equal(memberDownload.statusCode,200);assert.deepEqual(memberDownload.rawPayload,owned.download.rawPayload);
  assert.equal((await adminPool.query('select id from corrections where run_id=$1',[run.id])).rowCount,0);assert.equal((await adminPool.query('select id from approvals where run_id=$1',[run.id])).rowCount,1);
});
