import test from 'node:test';
import assert from 'node:assert/strict';
import {bankStatementRows,checkBankStatement,createBankStatementResult,normalizeBankStatementCorrections} from '../server/core/bank-statement-domain.js';
import {resolveBankSourceFormats} from '../server/core/bank-source-formats.js';
import {bankEvidenceReviewIssues} from '../server/core/bank-statement-evidence.js';
import type {RawBankAccount,RawBankValues} from '../shared/bank-statements.js';
import type {Evidence} from '../shared/types.js';

// Authored synthetic values reproduce the complete CW17 header/amount shape.
// No hosted capture, provider, database or saved approval is read by these tests.
const spaced='Date   Description   Reference   Debit   Credit   Balance';
const pipe='Date | Description | Reference | Debit | Credit | Balance';
function account():RawBankAccount{return {
 bank_name:'Fictional Harbor Deposit Bank',account_identifier:'QA-SPACED-EUR-8406',currency:'EUR',
 statement_start:'2026-10-01',statement_end:'2026-10-07',opening_balance:'250.00',closing_balance:'273.25',total_debits:'8.75',total_credits:'32.00',
 balance_convention:'Credits increase and debits decrease the displayed account balance.',date_format:'Dates use YYYY-MM-DD.',number_format:'Amounts use a decimal dot.',transaction_layout:spaced,movement_convention:null,
 transactions:[
  {date:'2026-10-02',description:'Synthetic storage fee',reference:'QA-SPACED-001',debit:'8.75',credit:null,balance:'241.25',currency:null},
  {date:'2026-10-05',description:'Synthetic reimbursement',reference:'QA-SPACED-002',debit:null,credit:'32.00',balance:'273.25',currency:null},
 ],
};}
function quotes(raw:RawBankValues,source:Evidence['source']='matched-text'):Record<string,Evidence[]>{
 const evidence:Record<string,Evidence[]>={};
 raw.accounts.forEach((a,ai)=>{
  const path=`accounts[${ai}]`;
  for(const[field,value]of Object.entries(a))if(typeof value==='string')evidence[`${path}.${field}`]=[{page:ai+1,text:value,source}];
  for(const[ri,row]of a.transactions.entries())for(const[field,value]of Object.entries(row))if(typeof value==='string')evidence[`${path}.transactions[${ri}].${field}`]=[{page:ai+1,text:value,source}];
 });return evidence;
}
const extract=(raw:RawBankValues,evidence=quotes(raw))=>createBankStatementResult(raw,evidence,'en-IE',{sourceFormats:true});
const policy=(r:ReturnType<typeof extract>,index=0)=>r.context.accounts[r.values.accounts[index].id].formats!;

test('a fully quoted spaced CW17-shaped header retains literal debit and credit values without changing source data',()=>{
 for(const source of ['matched-text','matched-region','model-visual']as const){
  const raw={accounts:[account()]},evidence=quotes(raw,source),originalRaw=structuredClone(raw),originalEvidence=structuredClone(evidence),r=extract(raw,evidence),a=r.values.accounts[0];
  assert.equal(policy(r).movement,'columns',source);assert.deepEqual(a.transactions.map(row=>[row.debit,row.credit,row.balance,row.currency]),[['8.75',null,'241.25','EUR'],[null,'32.00','273.25','EUR']]);
  assert.equal(a.opening_balance,'250.00');assert.equal(a.closing_balance,'273.25');assert.equal(a.total_debits,'8.75');assert.equal(a.total_credits,'32.00');
  assert.equal(r.issues.filter(issue=>issue.severity==='error').length,0);assert.equal(r.issues.filter(issue=>issue.code==='source_review_required').length,1);
  assert.equal(r.context.accounts[a.id].evidence['accounts[0].transaction_layout'][0].text,spaced);assert.ok(Object.isFrozen(policy(r)));
  assert.deepEqual(raw,originalRaw);assert.deepEqual(evidence,originalEvidence);
  if(source==='model-visual')assert.ok(bankEvidenceReviewIssues(raw,evidence,[],r.context,r.values).some(issue=>issue.code==='visual_evidence'));
 }
});

test('horizontal header boundaries and full own aliases preserve column order across tabs, spaces and pipe evidence',()=>{
 for(const layout of [spaced,'Date  Description  Reference  Debit  Credit  Balance','Date\tDescription\tReference\tDebit\tCredit\tBalance','  DATE \t Description   Reference\t DEBIT  CREDIT \t Balance  ','Credit   Date   Debit   Currency   Balance']){
  const raw={accounts:[account()]};raw.accounts[0].transaction_layout=layout;const evidence=quotes(raw);
  evidence['accounts.0.transaction_layout']=[{page:1,text:layout.toLowerCase(),source:'matched-region'}];
  const r=extract(raw,evidence);assert.equal(policy(r).movement,'columns',layout);assert.equal(r.values.accounts[0].transactions[0].debit,'8.75');
 }
 const raw={accounts:[account()]},evidence=quotes(raw);evidence['accounts.0.transaction_layout']=[{page:1,text:pipe,source:'matched-text'}];assert.equal(policy(extract(raw,evidence)).movement,'columns');
});

test('single-space, multiline, prose, repeated, signed and currency-mixed candidate headers stay unresolved',()=>{
 for(const layout of [
  'Date Description Reference Debit Credit Balance','Date\tDescription\tReference\tDebit Credit\tBalance',
  'Date  Description  Reference  Debit  Debit  Credit  Balance','Date  Description  Reference  Debit  Credit  Amount  Balance',
  'Date  Description  Reference  Signed Amount  Debit  Credit  Balance','Usually  Debit  Credit',
  'Date  Description  Reference  Debit  Credit  Balance except refunds','Date   Description\nReference   Debit   Credit   Balance',
  'Date   Description   Reference   Debit   Credit   Balance\nUnless noted otherwise','Date\f  Description  Reference  Debit  Credit  Balance',
  'Date\u00a0\u00a0Description\u00a0\u00a0Reference\u00a0\u00a0Debit\u00a0\u00a0Credit\u00a0\u00a0Balance','Debit   Credit   EUR','EUR Debit   USD Credit',
  'Date, Description, Reference, Debit, Credit, Balance',
 ]){
  const raw={accounts:[account()]};raw.accounts[0].transaction_layout=layout;const r=extract(raw);
  assert.equal(policy(r).movement,'unresolved',layout);assert.equal(r.values.accounts[0].transactions[0].debit,null,layout);assert.equal(r.values.accounts[0].transactions[1].credit,null,layout);
 }
});

test('spaced headers require complete same-account quotes and refuse cropped, qualified or conflicting aliases',()=>{
 for(const mode of ['missing','foreign','wrong-field','unverified','cropped','reordered','qualified','signed-alias','extra-line']as const){
  const raw={accounts:[account()]},evidence=quotes(raw),key='accounts[0].transaction_layout',original=evidence[key];
  if(mode==='missing')delete evidence[key];
  if(mode==='foreign'){delete evidence[key];evidence['accounts[1].transaction_layout']=original;}
  if(mode==='wrong-field'){delete evidence[key];evidence['accounts[0].transactions[0].transaction_layout']=original;}
  if(mode==='unverified')evidence[key][0].source=undefined;
  if(mode==='cropped')evidence[key][0].text='Debit   Credit';
  if(mode==='reordered')evidence['accounts.0.transaction_layout']=[{page:1,text:'Date   Description   Reference   Credit   Debit   Balance',source:'matched-text'}];
  if(mode==='qualified')evidence[key][0].text+='  Except refunds.';
  if(mode==='signed-alias')evidence['accounts.0.transaction_layout']=[{page:1,text:'Signed amount',source:'matched-text'}];
  if(mode==='extra-line')evidence[key][0].text+='\nDates use YYYY-MM-DD.';
  const r=extract(raw,evidence);assert.equal(policy(r).movement,'unresolved',mode);assert.equal(r.values.accounts[0].transactions[0].debit,null,mode);
 }
 const raw={accounts:[account()]},r=extract(raw),source=structuredClone(r.context.accounts[r.values.accounts[0].id]);source.evidence['accounts[0].transaction_layout'][0].page=2;source.sourcePages=[1];
 assert.equal(resolveBankSourceFormats(raw.accounts[0]as unknown as Record<string,unknown>,source).movement,'unresolved');
});

test('spaced ordinary headers never consume non-null signed or otherwise unsupported movement metadata',()=>{
 for(const rule of ['', ' ', 'Positive amounts are credits; negative amounts are debits.','Positive amounts are debits; negative amounts are credits.','DR means debit. CR means credit.','Unknown']){
  const raw={accounts:[account()]};raw.accounts[0].movement_convention=rule;const r=extract(raw);assert.equal(policy(r).movement,'unresolved',rule);assert.equal(r.values.accounts[0].transactions[0].debit,null,rule);
 }
 const raw={accounts:[account()]};raw.accounts[0].transactions[0].debit='USD 8.75';const r=extract(raw);assert.equal(policy(r).movement,'columns');assert.equal(r.values.accounts[0].transactions[0].debit,'USD 8.75');assert.ok(r.issues.some(issue=>issue.code==='amount_currency_conflict'&&issue.severity==='error'));
});

test('different account currencies keep separate spaced-header proofs and cannot borrow another account quote',()=>{
 const raw={accounts:[account(),account()]};raw.accounts[1].currency='USD';raw.accounts[1].account_identifier='QA-SPACED-USD-8406';
 const good=extract(raw);assert.deepEqual(good.values.accounts.map(a=>[a.currency,a.transactions[0].currency,a.transactions[0].debit]),[['EUR','EUR','8.75'],['USD','USD','8.75']]);
 const evidence=quotes(raw);delete evidence['accounts[1].transaction_layout'];const r=extract(raw,evidence);
 assert.equal(policy(r,0).movement,'columns');assert.equal(policy(r,1).movement,'unresolved');assert.equal(r.values.accounts[0].transactions[0].debit,'8.75');assert.equal(r.values.accounts[1].transactions[0].debit,null);
});

test('legacy and saved unresolved contexts, original identities and historical export values are not reinterpreted',()=>{
 const raw={accounts:[account()]},evidence=quotes(raw),legacy=createBankStatementResult(raw,evidence,'en-IE'),r=extract(raw),old=structuredClone(r.values),context=structuredClone(r.context),a=old.accounts[0];
 assert.equal(legacy.context.accounts[legacy.values.accounts[0].id].formats,undefined);
 context.accounts[a.id].formats!.movement='unresolved';a.transactions[0].debit=null;a.transactions[1].credit=null;const beforeValues=structuredClone(old),beforeContext=structuredClone(context);
 assert.ok(checkBankStatement(old,context).some(issue=>issue.code==='movement_convention_unresolved'));
 const explicit=structuredClone(old);explicit.accounts[0].transactions[0].debit='8.75';explicit.accounts[0].transactions[1].credit='32.00';
 const corrected=normalizeBankStatementCorrections(explicit,context,old);assert.deepEqual(corrected.values.accounts[0].transactions.map(row=>row.id),a.transactions.map(row=>row.id));assert.ok(corrected.issues.some(issue=>issue.code==='movement_convention_unresolved'));
 const rows=bankStatementRows([{documentId:'11111111-1111-4111-8111-111111111111',filename:'SYNTHETIC-historical.pdf',values:old}]);assert.equal(rows[0].debit,null);assert.equal(rows[1].credit,null);
 assert.deepEqual(old,beforeValues);assert.deepEqual(context,beforeContext);
});
