import test from 'node:test';
import assert from 'node:assert/strict';
import {bankStatementRows,checkBankStatement,createBankStatementResult,normalizeBankStatementCorrections} from '../server/core/bank-statement-domain.js';
import {resolveBankSourceFormats} from '../server/core/bank-source-formats.js';
import {bankEvidenceReviewIssues} from '../server/core/bank-statement-evidence.js';
import type {RawBankAccount,RawBankValues} from '../shared/bank-statements.js';
import type {Evidence} from '../shared/types.js';

// Labelled synthetic first-page PNG literals. No hosted capture or provider is read.
const header='Date | Description | Reference | Debit | Credit | Balance';
function account():RawBankAccount{return {
 bank_name:'Example Bank',account_identifier:'SYN-00001234',currency:'EUR',
 statement_start:'01/09/2026',statement_end:'30/09/2026',opening_balance:'1,000.00',closing_balance:null,total_debits:null,total_credits:null,
 balance_convention:'Credits increase and debits decrease the displayed account balance.',
 date_format:null,number_format:null,transaction_layout:header,movement_convention:null,
 transactions:[{date:'03/09/2026',description:'Coffee supply\nmonthly office stock',reference:'SYN-001',debit:'10.00',credit:null,balance:'990.00',currency:null}],
};}
function quotes(raw:RawBankValues,source:Evidence['source']='model-visual'):Record<string,Evidence[]>{
 const evidence:Record<string,Evidence[]>={};
 raw.accounts.forEach((a,ai)=>{
  const path=`accounts[${ai}]`;
  for(const[field,value]of Object.entries(a))if(typeof value==='string')evidence[`${path}.${field}`]=[{page:1,text:value,source}];
  for(const [ri,row]of a.transactions.entries()){
   const labels=(a.transaction_layout??header).split('|').map(v=>v.trim().toLowerCase());
   const line=labels.map(label=>String(row[label as keyof typeof row]??'').split('\n')[0]).join(' | ');
   for(const[field,value]of Object.entries(row))if(typeof value==='string')evidence[`${path}.transactions[${ri}].${field}`]=[{page:1,text:line,source}];
  }
 });
 return evidence;
}
const extract=(raw:RawBankValues,evidence=quotes(raw))=>createBankStatementResult(raw,evidence,'en-IE',{sourceFormats:true});
const policy=(result:ReturnType<typeof extract>)=>result.context.accounts[result.values.accounts[0].id].formats!;

test('a complete separate-column header retains the synthetic PNG debit without guessing dates, grouping or absent page-two values',()=>{
 const raw={accounts:[account()]},evidence=quotes(raw),beforeRaw=structuredClone(raw),beforeEvidence=structuredClone(evidence),r=extract(raw,evidence),a=r.values.accounts[0],row=a.transactions[0];
 assert.equal(policy(r).movement,'columns');assert.equal(row.debit,'10.00');assert.equal(row.credit,null);assert.equal(row.balance,'990.00');assert.equal(a.balance_convention,'credit_increases');
 assert.equal(row.date,null);assert.equal(a.statement_start,null);assert.equal(a.statement_end,'2026-09-30');assert.equal(a.opening_balance,null);assert.equal(a.closing_balance,null);assert.equal(a.total_debits,null);assert.equal(a.total_credits,null);
 assert.equal(policy(r).dateStatus,'missing');assert.equal(policy(r).numberStatus,'missing');assert.equal(row.description,'Coffee supply\nmonthly office stock');
 assert.ok(r.issues.some(i=>i.code==='transaction_date_unresolved'));assert.ok(r.issues.some(i=>i.code==='source_review_required'));assert.ok(!r.issues.some(i=>i.code==='transaction_amount_missing'));
 const review=bankEvidenceReviewIssues(raw,evidence,[],r.context,r.values);assert.ok(review.some(i=>i.code==='visual_evidence'));assert.ok(review.some(i=>i.code==='evidence_incomplete'&&i.field==='description'));
 assert.deepEqual(raw,beforeRaw);assert.deepEqual(evidence,beforeEvidence);assert.equal(r.context.accounts[a.id].evidence['accounts[0].transaction_layout'][0].text,header);assert.ok(Object.isFrozen(policy(r)));
});

test('complete header order and case/whitespace variants work only when every own alias agrees',()=>{
 for(const layout of ['Debit | Credit','Credit | Debit','Credit | Date | Debit | Currency | Balance','  DATE  | Description | Reference | DEBIT | CREDIT | Balance ']){
  for(const source of ['matched-text','matched-region','model-visual']as const){
   const raw={accounts:[account()]};raw.accounts[0].transaction_layout=layout;const evidence=quotes(raw,source);
   evidence['accounts[0].transaction_layout'][0].text=layout.toUpperCase().replace(/\|/g,'\n | \t');
   evidence['accounts.0.transaction_layout']=[{page:1,text:layout.toLowerCase(),source}];
   const r=extract(raw,evidence);assert.equal(policy(r).movement,'columns',layout+':'+source);assert.equal(r.values.accounts[0].transactions[0].debit,'10.00');
  }
 }
});

test('ordinary column headers never establish signed polarity or swallow any non-null movement rule',()=>{
 for(const rule of ['', ' ', 'Positive amounts are credits; negative amounts are debits.','Positive amounts are debits; negative amounts are credits.','DR means debit. CR means credit.','Unclear','No sign rule']){
  const raw={accounts:[account()]};raw.accounts[0].movement_convention=rule;const r=extract(raw);
  assert.equal(policy(r).movement,'unresolved',rule);assert.equal(r.values.accounts[0].transactions[0].debit,null,rule);
 }
 for(const layout of ['Date | Description | Reference | Debit','Debit | Debit | Credit','Debit | Credit | Amount','Debit | Credit | Signed amount','Date, Description, Debit, Credit','Debit | Credit |','03/09/2026 | 10.00 | 990.00','Usually Debit | Credit','Debit | Credit. Except reversals']){
  const raw={accounts:[account()]};raw.accounts[0].transaction_layout=layout;assert.equal(policy(extract(raw)).movement,'unresolved',layout);
 }
});

test('missing, foreign, wrong-field, unverified and out-of-range header evidence cannot recover a movement',()=>{
 for(const mode of ['missing','foreign-account','wrong-field','unverified','page31','too-long','malformed-list']as const){
  const raw={accounts:[account()]},evidence=quotes(raw),key='accounts[0].transaction_layout',original=evidence[key];
  if(mode==='missing')delete evidence[key];
  if(mode==='foreign-account'){delete evidence[key];evidence['accounts[1].transaction_layout']=original;}
  if(mode==='wrong-field'){delete evidence[key];evidence['accounts[0].transactions[0].transaction_layout']=original;}
  if(mode==='unverified')evidence[key][0].source=undefined;
  if(mode==='page31')evidence[key][0].page=31;
  if(mode==='too-long')evidence[key][0].text=' '.repeat(2001)+header;
  if(mode==='malformed-list'){(evidence as Record<string,unknown>)[key]=null;assert.throws(()=>extract(raw,evidence),/Invalid source evidence/);continue;}
  const r=extract(raw,evidence);assert.equal(policy(r).movement,'unresolved',mode);assert.equal(r.values.accounts[0].transactions[0].debit,null,mode);
 }
 const raw={accounts:[account()]},r=extract(raw),source=structuredClone(r.context.accounts[r.values.accounts[0].id]);
 source.evidence['accounts[0].transaction_layout'][0].page=2;source.sourcePages=[1];
 assert.equal(resolveBankSourceFormats(raw.accounts[0]as unknown as Record<string,unknown>,source).movement,'unresolved');
});

test('cropped, qualified and reordered aliases refuse while the existing combined evidence cap remains',()=>{
 for(const quote of ['Debit | Credit','Date | Description | Reference | Credit | Debit | Balance',header+' Dates use DD/MM/YYYY.',header+' Positive amounts are credits; negative amounts are debits.',header+' unless otherwise stated']){
  const raw={accounts:[account()]},evidence=quotes(raw);evidence['accounts.0.transaction_layout']=[{page:1,text:quote,source:'model-visual'}];const r=extract(raw,evidence);
  assert.equal(policy(r).movement,'unresolved',quote);assert.equal(r.values.accounts[0].transactions[0].debit,null);
 }
 const cropped={accounts:[account()]};cropped.accounts[0].transaction_layout='Debit | Credit';const evidence=quotes(cropped);evidence['accounts[0].transaction_layout'][0].text=header;assert.equal(policy(extract(cropped,evidence)).movement,'unresolved');
 const raw={accounts:[account()]},tooMany=quotes(raw);tooMany['accounts.0.transaction_layout']=Array.from({length:20},()=>({page:1,text:header,source:'model-visual' as const}));assert.equal(policy(extract(raw,tooMany)).movement,'unresolved');
 const bounded=quotes(raw);bounded['accounts.0.transaction_layout']=Array.from({length:19},()=>({page:1,text:header,source:'model-visual' as const}));assert.equal(policy(extract(raw,bounded)).movement,'columns');
});

test('separate-column negatives retain reversals and incompatible DR/CR or currency markers still refuse',()=>{
 for(const debit of ['-10.00','(10.00)','10.00-']){
  const raw={accounts:[account()]};raw.accounts[0].transactions[0].debit=debit;const r=extract(raw);
  assert.equal(r.values.accounts[0].transactions[0].debit,'-10.00',debit);assert.ok(r.issues.some(i=>i.code==='signed_column_amount'));
 }
 for(const [value,code]of [['10.00 CR','amount_direction_conflict'],['USD 10.00','amount_currency_conflict']]as const){
  const raw={accounts:[account()]};raw.accounts[0].transactions[0].debit=value;const r=extract(raw);
  assert.equal(policy(r).movement,'columns');assert.notEqual(r.values.accounts[0].transactions[0].debit,'10.00');assert.ok(r.issues.some(i=>i.code===code),code);
 }
 const raw={accounts:[account()]};raw.accounts[0].transactions[0].debit=null;raw.accounts[0].transactions[0].credit='10.00';const r=extract(raw);assert.equal(r.values.accounts[0].transactions[0].credit,'10.00');assert.equal(r.values.accounts[0].transactions[0].debit,null);
});

test('verified column metadata cannot override unsupported date or numeric rules',()=>{
 for(const field of ['date_format','number_format']as const){
  const raw={accounts:[account()]};raw.accounts[0][field]=field==='date_format'?'Dates may use DD/MM/YYYY.':'Amounts may use a decimal point.';const r=extract(raw);
  assert.equal(policy(r).movement,'columns');assert.equal(field==='date_format'?policy(r).dateStatus:policy(r).numberStatus,'unresolved');assert.equal(field==='date_format'?r.values.accounts[0].transactions[0].date:r.values.accounts[0].transactions[0].debit,null);
 }
});

test('stored unresolved context stays pinned through checks, explicit corrections and old export values',()=>{
 const current=extract({accounts:[account()]}),context=structuredClone(current.context),oldValues=structuredClone(current.values),a=oldValues.accounts[0];
 context.accounts[a.id].formats!.movement='unresolved';a.transactions[0].debit=null;
 const contextBefore=structuredClone(context),valuesBefore=structuredClone(oldValues);
 assert.equal(policy(current).movement,'columns');assert.ok(checkBankStatement(oldValues,context).some(i=>i.code==='movement_convention_unresolved'));assert.equal(oldValues.accounts[0].transactions[0].debit,null);
 const explicit=structuredClone(oldValues);explicit.accounts[0].transactions[0].debit='10.00';explicit.accounts[0].transactions[0].date='2026-09-03';
 const corrected=normalizeBankStatementCorrections(explicit,context,oldValues);assert.equal(corrected.values.accounts[0].transactions[0].debit,'10.00');assert.ok(corrected.issues.some(i=>i.code==='movement_convention_unresolved'));
 const rows=bankStatementRows([{documentId:'11111111-1111-4111-8111-111111111111',filename:'synthetic-page.png',values:oldValues}]);assert.equal(rows[0].debit,null);assert.equal(rows[0].date,null);
 assert.deepEqual(context,contextBefore);assert.deepEqual(oldValues,valuesBefore);assert.equal(context.accounts[a.id].formats!.version,1);
});
