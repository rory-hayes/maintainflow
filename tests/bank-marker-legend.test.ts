import test from 'node:test';
import assert from 'node:assert/strict';
import {createBankStatementResult,normalizeBankStatementCorrections,bankStatementRows} from '../server/core/bank-statement-domain.js';
import {resolveBankSourceFormats} from '../server/core/bank-source-formats.js';
import {bankEvidenceReviewIssues} from '../server/core/bank-statement-evidence.js';
import type {RawBankAccount,RawBankValues} from '../shared/bank-statements.js';
import type {Evidence} from '../shared/types.js';

// Synthetic literals from the printed QS1 source; no hosted capture/provider is read.
const legend='DR marks a debit or balance owed. CR marks a payment credit.';
function account():RawBankAccount{return {bank_name:'Synthetic Lantern Bank',account_identifier:'SYNTHETIC-QS1',currency:'GBP',statement_start:'1 October 2026',statement_end:'31 October 2026',opening_balance:'40.00 DR',closing_balance:'41.25 DR',total_debits:'21.25 GBP',total_credits:'20.00 GBP',balance_convention:'This is an amount owed: debits increase and credits reduce the displayed balance.',date_format:null,number_format:null,transaction_layout:null,movement_convention:legend,transactions:[
 {date:'5 October 2026',description:'Workshop supplies\nReplacement gloves and protective covers',reference:'QS-001',debit:'15.75 DR',credit:null,balance:'55.75 DR',currency:'GBP'},
 {date:'October 6, 2026',description:'Card repayment\nBank transfer receipt',reference:'QS-002',debit:null,credit:'20.00 CR',balance:'35.75 DR',currency:'GBP'},
 {date:'12 Oct 2026',description:'Equipment locker rental\nSeparate daily booking',reference:'QS-RENT',debit:'2.75 DR',credit:null,balance:'38.50 DR',currency:'GBP'},
 {date:'12 Oct 2026',description:'Equipment locker rental\nSeparate daily booking',reference:'QS-RENT',debit:'2.75 DR',credit:null,balance:'41.25 DR',currency:'GBP'},
]};}
function quotes(raw:RawBankValues,source:Evidence['source']='model-visual'):Record<string,Evidence[]>{const evidence:Record<string,Evidence[]>={};raw.accounts.forEach((a,ai)=>{for(const[field,value]of Object.entries(a))if(typeof value==='string')evidence['accounts['+ai+'].'+field]=[{page:1,text:value,source}];a.transactions.forEach((row,ri)=>{for(const[field,value]of Object.entries(row))if(typeof value==='string')evidence['accounts['+ai+'].transactions['+ri+'].'+field]=[{page:ri<2?1:2,text:value,source}];});});return evidence;}
const extract=(raw:RawBankValues,evidence=quotes(raw))=>createBankStatementResult(raw,evidence,'en-IE',{sourceFormats:true});
const movement=(r:ReturnType<typeof extract>)=>r.context.accounts[r.values.accounts[0].id].formats!.movement;
const money=(r:ReturnType<typeof extract>)=>r.values.accounts[0].transactions.map(t=>[t.debit,t.credit]);
const amounts=[['15.75',null],[null,'20.00'],['2.75',null],['2.75',null]];

test('a complete quoted DR/CR legend preserves QS1 literal tagged amounts without claiming a signed or column header',()=>{
 const raw={accounts:[account()]},evidence=quotes(raw),rawBefore=structuredClone(raw),evidenceBefore=structuredClone(evidence),result=extract(raw,evidence),a=result.values.accounts[0];
 assert.deepEqual(money(result),amounts);assert.equal(movement(result),'columns');assert.equal(a.balance_convention,'debit_increases');assert.equal(a.closing_balance,'41.25');assert.equal(result.issues.filter(i=>i.severity==='error').length,0);
 assert.deepEqual(raw,rawBefore);assert.deepEqual(evidence,evidenceBefore);assert.equal(raw.accounts[0].transaction_layout,null);assert.equal(result.context.accounts[a.id].evidence['accounts[0].movement_convention'][0].text,legend);
 assert.ok(bankEvidenceReviewIssues(raw,evidence,[],result.context,result.values).some(i=>i.code==='visual_evidence'));
 assert.ok(result.issues.some(i=>i.code==='source_review_required'));assert.equal(new Set(a.transactions.map(t=>t.id)).size,4);
 assert.deepEqual(a.transactions.slice(2).map(t=>[t.reference,t.balance]),[['QS-RENT','38.50'],['QS-RENT','41.25']]);
 const contextBefore=structuredClone(result.context),values=structuredClone(result.values);values.accounts[0].transactions.reverse();const corrected=normalizeBankStatementCorrections(values,result.context,result.values);
 assert.deepEqual(result.context,contextBefore);assert.deepEqual(corrected.values.accounts[0].transactions.map(t=>t.id),a.transactions.map(t=>t.id).toReversed());
 assert.deepEqual(bankStatementRows([{documentId:'SYNTHETIC',filename:'synthetic.pdf',values:corrected.values}]).map(t=>[t.debit,t.credit]),amounts.toReversed());
});

test('bounded DR/CR role definitions support both orders without interpreting positive or negative signed movement rules',()=>{
 for(const rule of ['DR means debit. CR means credit.','CR indicates a credit; DR indicates a debit.','DR denotes debit; CR denotes payment credit.']){const raw={accounts:[account()]};raw.accounts[0].movement_convention=rule;assert.deepEqual(money(extract(raw)),amounts,rule);}
 for(const layout of ['Signed amount','Signed movement','Signed transaction amount','Debit | Credit','Unclear']){const raw={accounts:[account()]};raw.accounts[0].transaction_layout=layout;assert.equal(movement(extract(raw)),'unresolved',layout);}
 const raw={accounts:[account()]};raw.accounts[0].movement_convention='Positive signed amounts are credits; parentheses or minus signs are debits.';assert.equal(movement(extract(raw)),'unresolved');
});

test('missing, foreign, unverified, qualified or conflicting legend evidence leaves movement unresolved',()=>{
 const badRules=['DR marks a credit. CR marks a debit.','DR marks a debit.','CR marks a credit.','DR may mark a debit. CR marks a credit.','DR does not mark a debit. CR marks a credit.','DR means debit. CR means credit. Positive amounts are credits; negative amounts are debits.'];
 for(const rule of badRules){const raw={accounts:[account()]};raw.accounts[0].movement_convention=rule;assert.equal(movement(extract(raw)),'unresolved',rule);}
 for(const mode of ['missing','foreign-account','wrong-field','wrong-value','unverified','invalid-page','contradiction','dotted-conflict','cropped-qualified']as const){const raw={accounts:[account()]},evidence=quotes(raw),key='accounts[0].movement_convention',original=evidence[key];
  if(mode==='missing')delete evidence[key];if(mode==='foreign-account'){delete evidence[key];evidence['accounts[1].movement_convention']=original;}
  if(mode==='wrong-field'){delete evidence[key];evidence['accounts[0].balance_convention']=original;}
  if(mode==='wrong-value')evidence[key]=[{page:1,text:'DR marks a credit. CR marks a debit.',source:'model-visual'}];
  if(mode==='unverified')evidence[key]=[{page:1,text:legend}];if(mode==='invalid-page')evidence[key][0].page=31;
  if(mode==='contradiction')evidence[key].push({page:2,text:'DR means credit. CR means debit.',source:'model-visual'});
  if(mode==='dotted-conflict')evidence['accounts.0.movement_convention']=[{page:2,text:'Positive amounts are credits; negative amounts are debits.',source:'model-visual'}];
  if(mode==='cropped-qualified')evidence[key][0].text=legend+' Except some debit markers are credits.';
  assert.equal(movement(extract(raw,evidence)),'unresolved',mode);
 }
});

test('legend recovery requires every present row amount marker and exact own quote on an available source page',()=>{
 for(const mode of ['unmarked','wrong-marker','unknown-marker','missing-quote','foreign-quote','wrong-literal','partial-quote','unverified-quote','conflicting-alias']as const){const raw={accounts:[account()]};
  if(mode==='unmarked')raw.accounts[0].transactions[0].debit='15.75';if(mode==='wrong-marker')raw.accounts[0].transactions[0].debit='15.75 CR';if(mode==='unknown-marker')raw.accounts[0].transactions[0].debit='15.75 DX';
  const evidence=quotes(raw),key='accounts[0].transactions[0].debit';if(mode==='missing-quote')delete evidence[key];
  if(mode==='foreign-quote'){evidence['accounts[1].transactions[0].debit']=evidence[key];delete evidence[key];}
  if(mode==='wrong-literal')evidence[key][0].text='15.76 DR';if(mode==='partial-quote')evidence[key][0].text='15.75';if(mode==='unverified-quote')delete evidence[key][0].source;
  if(mode==='conflicting-alias')evidence['accounts.0.transactions.0.debit']=[{page:1,text:'15.75 CR',source:'model-visual'}];
  const result=extract(raw,evidence);assert.equal(movement(result),'unresolved',mode);assert.ok(result.issues.some(i=>i.severity==='error'&&['movement_convention_unresolved','amount_direction_conflict','amount_format_unresolved'].includes(i.code)),mode);
 }
 const raw={accounts:[account()]},r=extract(raw),source=structuredClone(r.context.accounts[r.values.accounts[0].id]);source.sourcePages=[1];assert.equal(resolveBankSourceFormats(raw.accounts[0]as unknown as Record<string,unknown>,source).movement,'unresolved');
 const evidence=quotes(raw),empty={accounts:[{...account(),transactions:[]}]};assert.equal(movement(extract(empty,quotes(empty))),'unresolved');
 delete evidence['accounts[0].transactions[0].debit'];evidence['accounts.0.transactions.0.debit']=[{page:1,text:'15.75 DR',source:'matched-text'}];assert.deepEqual(money(extract(raw,evidence)),amounts);
});

test('tagged negative debit reversals preserve their explicit sign and review warning instead of taking absolute amounts',()=>{
 for(const amount of ['-2.75 DR','(2.75) DR','2.75- DR']){const a=account();a.closing_balance='37.25 DR';a.total_debits='-2.75 GBP';a.total_credits='0.00 GBP';a.transactions=[{...a.transactions[0],debit:amount,balance:'37.25 DR'}];const result=extract({accounts:[a]});assert.equal(movement(result),'columns');assert.deepEqual(money(result),[['-2.75',null]]);assert.ok(result.issues.some(i=>i.code==='signed_column_amount'));assert.equal(result.issues.filter(i=>i.severity==='error').length,0);}
});

test('marker legends do not override unknown signed layouts, absent currency or existing amount conflicts',()=>{
 const raw={accounts:[account()]};raw.accounts[0].movement_convention='Positive amounts are credits; negative amounts are debits.';assert.equal(movement(extract(raw)),'unresolved');
 const missing={accounts:[account()]};missing.accounts[0].currency=null;const result=extract(missing);assert.ok(result.issues.some(i=>i.code==='currency_missing'||i.code==='amount_currency_conflict'));
 const foreign={accounts:[account()]};foreign.accounts[0].transactions[0].debit='USD 15.75 DR';const conflict=extract(foreign);assert.ok(conflict.issues.some(i=>i.code==='amount_currency_conflict'));assert.notEqual(conflict.values.accounts[0].transactions[0].debit,'15.75');
});
