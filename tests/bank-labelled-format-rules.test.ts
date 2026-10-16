import test from 'node:test';
import assert from 'node:assert/strict';
import {checkBankStatement,createBankStatementResult} from '../server/core/bank-statement-domain.js';
import type {RawBankAccount,RawBankValues} from '../shared/bank-statements.js';
import type {Evidence} from '../shared/types.js';

// Author-fixed synthetic CSV literals; no hosted response, credentials or provider is read.
function account():RawBankAccount{return {
 bank_name:'Synthetic Cedar Bank',account_identifier:'SYN-CSV-C01-20261016',currency:'EUR',
 statement_start:'2026-10-01',statement_end:'2026-10-31',opening_balance:'100.00',closing_balance:'102.00',total_debits:'18.00',total_credits:'20.00',
 balance_convention:'Credits increase and debits decrease the displayed account balance.',
 date_format:'Dates use YYYY-MM-DD.',number_format:'Amounts use a decimal point.',transaction_layout:null,movement_convention:null,
 transactions:[
  {date:'2026-10-02',description:'Office, paper',reference:'CSV-C01-01',debit:'12.50',credit:null,balance:'87.50',currency:'EUR'},
  {date:'2026-10-07',description:'Locker rental',reference:'CSV-C01-REPEAT',debit:'2.75',credit:null,balance:'84.75',currency:'EUR'},
  {date:'2026-10-07',description:'Locker rental',reference:'CSV-C01-REPEAT',debit:'2.75',credit:null,balance:'82.00',currency:'EUR'},
  {date:'2026-10-09',description:'Client payment',reference:'CSV-C01-04',debit:null,credit:'20.00',balance:'102.00',currency:'EUR'},
 ],
};}
function quotes(raw:RawBankValues):Record<string,Evidence[]>{
 const evidence:Record<string,Evidence[]>={};
 raw.accounts.forEach((a,i)=>{
  for(const [field,value]of Object.entries(a))if(typeof value==='string')evidence[`accounts[${i}].${field}`]=[{page:i+1,text:value,source:'matched-text'}];
  a.transactions.forEach((row,j)=>{for(const [field,value]of Object.entries(row))if(typeof value==='string')evidence[`accounts[${i}].transactions[${j}].${field}`]=[{page:i+1,text:value,source:'matched-text'}];});
  evidence[`accounts[${i}].date_format`][0].text=`Date format,${a.date_format}`;
  evidence[`accounts[${i}].number_format`][0].text=`Number format,${a.number_format}`;
 });
 return evidence;
}
const extract=(raw:RawBankValues,evidence=quotes(raw))=>createBankStatementResult(raw,evidence,'de-DE',{sourceFormats:true});
const formats=(r:ReturnType<typeof extract>)=>r.context.accounts[r.values.accounts[0].id].formats!;

test('own-field CSV metadata labels retain four exact source rows and decimal-safe reconciliation',()=>{
 const raw={accounts:[account()]},evidence=quotes(raw),beforeRaw=structuredClone(raw),beforeEvidence=structuredClone(evidence),r=extract(raw,evidence),a=r.values.accounts[0];
 assert.equal(formats(r).dateStatus,'supported');assert.equal(formats(r).numberStatus,'supported');assert.equal(formats(r).dateOrder,'ymd');assert.equal(formats(r).decimalSeparator,'.');
 assert.deepEqual([a.statement_start,a.statement_end,a.opening_balance,a.closing_balance,a.total_debits,a.total_credits],['2026-10-01','2026-10-31','100.00','102.00','18.00','20.00']);
 assert.deepEqual(a.transactions.map(({date,description,reference,debit,credit,balance,currency})=>({date,description,reference,debit,credit,balance,currency})),raw.accounts[0].transactions);
 assert.equal(a.transactions.length,4);assert.notEqual(a.transactions[1].id,a.transactions[2].id);assert.equal(r.issues.filter(i=>i.severity==='error').length,0);
 assert.deepEqual(raw,beforeRaw);assert.deepEqual(evidence,beforeEvidence);assert.equal(r.context.accounts[a.id].evidence['accounts[0].number_format'][0].text,'Number format,Amounts use a decimal point.');assert.ok(Object.isFrozen(formats(r)));
});

test('only the leading own label is removed; decimal and grouping commas remain part of the full rule',()=>{
 for(const [rule,amount,expected]of [
  ['Amounts use a decimal comma.','12,50','12.50'],
  ['Amount format: 1,234.56','1,234.56','1234.56'],
  ['Amount format: 1.234,56','1.234,56','1234.56'],
 ]as const){
  const a=account();a.number_format=rule;a.opening_balance=amount;a.transactions=[];const r=extract({accounts:[a]});
  assert.equal(formats(r).numberStatus,'supported',rule);assert.equal(r.values.accounts[0].opening_balance,expected,rule);
 }
 const a=account();a.date_format='Dates use DD/MM/YYYY.';a.statement_start='03/04/2026';a.statement_end='30/04/2026';a.transactions=[];const r=extract({accounts:[a]});assert.equal(r.values.accounts[0].statement_start,'2026-04-03');
 for(const field of ['date_format','number_format']as const){const raw={accounts:[account()]},evidence=quotes(raw);raw.accounts[0][field]=evidence[`accounts[0].${field}`][0].text;assert.equal(field==='date_format'?formats(extract(raw,evidence)).dateStatus:formats(extract(raw,evidence)).numberStatus,'supported');}
});

test('single-pipe worksheet metadata retains full rules through only bounded empty trailing cells',()=>{
 const raw={accounts:[account()]},evidence=quotes(raw);
 for(const field of ['date_format','number_format']as const)evidence[`accounts[0].${field}`][0].text=evidence[`accounts[0].${field}`][0].text.replace(',', ' | ')+' |  |  |  |  | ';
 const r=extract(raw,evidence);assert.equal(formats(r).dateStatus,'supported');assert.equal(formats(r).numberStatus,'supported');assert.equal(r.issues.filter(i=>i.severity==='error').length,0);
 assert.deepEqual(r.values.accounts[0].transactions.map(({date,debit,credit,balance})=>({date,debit,credit,balance})),raw.accounts[0].transactions.map(({date,debit,credit,balance})=>({date,debit,credit,balance})));
 for(const field of ['date_format','number_format']as const){const labelled=structuredClone(raw);labelled.accounts[0][field]=evidence[`accounts[0].${field}`][0].text;const checked=extract(labelled,evidence);assert.equal(field==='date_format'?formats(checked).dateStatus:formats(checked).numberStatus,'supported');}
 for(const count of [0,198,199]){
  const source=quotes(raw);for(const field of ['date_format','number_format']as const)source[`accounts[0].${field}`][0].text=source[`accounts[0].${field}`][0].text.replace(',', ' | ')+' |'.repeat(count);
  const checked=extract(raw,source);assert.equal(formats(checked).dateStatus,count<=198?'supported':'unresolved',String(count));assert.equal(formats(checked).numberStatus,count<=198?'supported':'unresolved',String(count));
 }
});

test('CSV labels cannot hide qualifications, negation, conflicting rules or extra cells',()=>{
 for(const [field,label,rule,opposite]of [
  ['date_format','Date format','Dates use YYYY-MM-DD.','Dates use DD/MM/YYYY.'],
  ['number_format','Number format','Amounts use a decimal point.','Amounts use a decimal comma.'],
 ]as const){
  for(const quote of [
   `${label},Usually ${rule}`,
   `${label},${rule} Except transaction rows.`,
   `${label},${rule} ${opposite}`,
   `${label},${rule},except transaction rows`,
   `${label},${rule},${opposite}`,
   `Usually ${label},${rule}`,
   `${label},${label},${rule}`,
   `${label==='Date format'?'Number format':'Date format'},${rule}`,
   `${label==='Date format'?'Number format':'Date format'}|${rule}`,
   `Movement convention|${rule}`,
   `${label}||${rule}`,
   `${label}|${rule}|Except transaction rows`,
   `${label}|${rule}|${opposite}`,
   `${label}|${rule}|Except transaction rows| |`,
   `${label}|${rule}|${opposite}| |`,
   `${label}|${rule}| | | | |Except transaction rows`,
   `${label}|${rule}| | | | |${opposite}`,
   `${label},${rule},,`,
  ].flatMap(quote=>[quote,quote.replace(`${label},`,`${label} | `)])){
   const raw={accounts:[account()]};if(field==='date_format')raw.accounts[0].transactions[0].date='03/04/2026';const evidence=quotes(raw);evidence[`accounts[0].${field}`][0].text=quote;const r=extract(raw,evidence);
   assert.equal(field==='date_format'?formats(r).dateStatus:formats(r).numberStatus,'unresolved',quote);assert.equal(field==='date_format'?r.values.accounts[0].transactions[0].date:r.values.accounts[0].transactions[0].debit,null,quote);
  }
  const raw={accounts:[account()]};raw.accounts[0][field]=field==='date_format'?'Dates do not use YYYY-MM-DD.':'Amounts do not use a decimal point.';assert.equal(field==='date_format'?formats(extract(raw)).dateStatus:formats(extract(raw)).numberStatus,'unresolved');
 }
});

test('all retained own-field aliases still require matching supported full rules and verified evidence',()=>{
 for(const field of ['date_format','number_format']as const){
  const raw={accounts:[account()]},key=`accounts[0].${field}`,alias=`accounts.0.${field}`,opposite=field==='date_format'?'Date format,Dates use DD/MM/YYYY.':'Number format,Amounts use a decimal comma.';
  for(const mode of ['conflicting-alias','qualified-alias','conflicting-pipe-alias','qualified-pipe-alias','wrong-field','unverified','too-many']as const){
   const evidence=quotes(raw);
   if(mode==='conflicting-alias')evidence[alias]=[{page:1,text:opposite,source:'matched-text'}];
   if(mode==='qualified-alias')evidence[alias]=[{page:1,text:evidence[key][0].text+' Except transaction rows.',source:'matched-text'}];
   if(mode==='conflicting-pipe-alias')evidence[alias]=[{page:1,text:opposite.replace(',', ' | '),source:'matched-text'}];
   if(mode==='qualified-pipe-alias')evidence[alias]=[{page:1,text:evidence[key][0].text.replace(',', ' | ')+' Except transaction rows.',source:'matched-text'}];
   if(mode==='wrong-field'){evidence[`accounts[0].transactions[0].${field}`]=evidence[key];delete evidence[key];}
   if(mode==='unverified')evidence[key][0].source=undefined;
   if(mode==='too-many')evidence[alias]=Array.from({length:20},()=>({...evidence[key][0]}));
   const r=extract(raw,evidence);assert.equal(field==='date_format'?formats(r).dateStatus:formats(r).numberStatus,'unresolved',`${field}:${mode}`);
  }
 }
});

test('CSV label support does not extend to movement instructions or recompute saved unresolved contexts',()=>{
 const raw={accounts:[account()]},evidence=quotes(raw),r=extract(raw,evidence),oldContext=structuredClone(r.context),oldValues=structuredClone(r.values),a=oldValues.accounts[0];
 oldContext.accounts[a.id].formats={version:1,dateStatus:'unresolved',dateOrder:null,numberStatus:'unresolved',decimalSeparator:null,groupSeparator:null,movement:'columns'};
 a.opening_balance=null;a.closing_balance=null;a.total_debits=null;a.total_credits=null;a.transactions.forEach(t=>{t.date=null;t.debit=null;t.credit=null;t.balance=null;});const before=structuredClone({oldContext,oldValues});
 assert.ok(checkBankStatement(oldValues,oldContext).some(i=>i.code==='amount_format_unresolved'));assert.deepEqual({oldContext,oldValues},before);
 for(const separator of [',',' | ']){const signed=account();signed.transaction_layout='Signed amount';signed.movement_convention='Positive amounts are credits; negative amounts are debits.';const signedRaw={accounts:[signed]},signedEvidence=quotes(signedRaw);signedEvidence['accounts[0].movement_convention'][0].text=`Movement convention${separator}${signed.movement_convention}`;assert.equal(formats(extract(signedRaw,signedEvidence)).movement,'unresolved');}
});
