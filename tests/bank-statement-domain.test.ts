import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createBankStatementResult,normalizeBankStatementCorrections,checkBankStatement,compareBankStatements,bankAccountKey,bankTransactionFingerprint,bankStatementRows} from '../server/core/bank-statement-domain.js';
import type {BankValues,BankTransaction,RawBankValues} from '../shared/bank-statements.js';
import type {Evidence} from '../shared/types.js';

const fixture=async(name:string)=>JSON.parse(await fs.readFile(new URL(`../fixtures/bank-statements/${name}.json`,import.meta.url),'utf8')) as RawBankValues;
const ids=(start=0)=>()=>`00000000-0000-4000-8000-${String(++start).padStart(12,'0')}`;
const evidence:Record<string,Evidence[]>={'accounts[0].transactions[0].debit':[{page:1,text:'10,00 DR',source:'matched-text'}],'accounts[0].transactions[1].credit':[{page:2,text:'20,00 CR',source:'matched-text'}]};
const errors=(result:{issues:{severity:string}[]})=>result.issues.filter(i=>i.severity==='error');
async function euro(start=0){return createBankStatementResult(await fixture('euro-current-account'),evidence,'de-DE',{id:ids(start)});}
const clone=<T>(value:T):T=>structuredClone(value);
const codes=(issues:{code:string}[])=>issues.map(i=>i.code);
const userRow=(account:BankValues['accounts'][number],id:string):BankTransaction=>({id,origin:'user',excluded:false,exclusion_reason:null,date:'2026-09-05',description:'Manual zero-value record',reference:null,debit:'0.00',credit:null,balance:account.closing_balance,currency:account.currency});

test('EU money and dates normalize exactly while raw values and page provenance remain unchanged',async()=>{
  const raw=await fixture('euro-current-account'),before=clone(raw),originalEvidence=clone(evidence),result=createBankStatementResult(raw,evidence,'de-DE',{id:ids()});assert.equal(errors(result).length,0);
  const account=result.values.accounts[0];assert.equal(account.opening_balance,'1000.00');assert.equal(account.closing_balance,'1010.00');assert.equal(account.statement_start,'2026-09-01');assert.equal(account.transactions[0].date,'2026-09-03');assert.equal(account.transactions[0].debit,'10.00');assert.equal(account.transactions[1].currency,'EUR');
  assert.deepEqual(raw,before);assert.deepEqual(evidence,originalEvidence);assert.deepEqual(result.context.accounts[account.id].sourcePages,[1,2]);assert.equal(result.context.transactions[account.transactions[1].id].rawPath,'accounts[0].transactions[1]');assert.deepEqual(result.context.transactions[account.transactions[1].id].sourcePages,[2]);
  assert.ok(Object.isFrozen(result.context)&&Object.isFrozen(result.context.transactions[account.transactions[0].id].evidence));assert.throws(()=>result.context.transactions[account.transactions[0].id].sourcePages.push(99),TypeError);
  assert.ok(codes(result.issues).includes('source_review_required'),'Reconciliation must not certify extraction completeness.');
});

test('US values beyond Number safe precision reconcile exact cents without floating point',async()=>{
  const result=createBankStatementResult(await fixture('usd-large-values'),{},'en-US',{id:ids()});assert.equal(errors(result).length,0);const account=result.values.accounts[0];assert.equal(account.opening_balance,'9007199254740993.00');assert.equal(account.closing_balance,'9007199254740993.02');assert.equal(account.transactions[0].balance,'9007199254740993.03');
  const changed=clone(result.values);changed.accounts[0].closing_balance='9007199254740993.03';assert.ok(codes(normalizeBankStatementCorrections(changed,result.context,result.values).issues).includes('closing_balance_mismatch'));
});

test('debit-increasing card statements and DR/CR balances retain their own convention',async()=>{
  const result=createBankStatementResult(await fixture('debit-increases-card'),{},'en-IE',{id:ids()});assert.equal(errors(result).length,0);assert.equal(result.values.accounts[0].opening_balance,'100.00');assert.equal(result.values.accounts[0].transactions[1].credit,'50.02');assert.equal(result.values.accounts[0].closing_balance,'69.99');assert.equal(result.values.accounts[0].transactions[0].date,'2026-09-03');
});

test('decimal fractions, leading-zero account identifiers and three-decimal currencies stay exact',async()=>{
  const raw=await fixture('usd-large-values'),a=raw.accounts[0];a.currency='KWD';a.opening_balance='0';a.closing_balance='0.301';a.total_debits='0';a.total_credits='0.301';a.transactions=a.transactions.map((r,i)=>({...r,currency:'KWD',debit:null,credit:i?'0.201':'0.1',balance:i?'0.301':'0.1'}));const result=createBankStatementResult(raw,{},'en-US',{id:ids()});assert.equal(errors(result).length,0);assert.equal(result.values.accounts[0].closing_balance,'0.301');assert.equal(result.values.accounts[0].account_identifier,'0000123456789');
});

test('unknown conventions do not infer DR/CR signs and wrong column directions remain unresolved',async()=>{
  const raw=await fixture('debit-increases-card');raw.accounts[0].balance_convention='unknown';raw.accounts[0].transactions[0].debit='20.01 CR';const result=createBankStatementResult(raw,{},'en-IE',{id:ids()});assert.equal(result.values.accounts[0].opening_balance,'100.00 DR');assert.equal(result.values.accounts[0].transactions[0].debit,'20.01 CR');assert.ok(codes(result.issues).includes('balance_convention_unknown'));assert.ok(codes(result.issues).includes('amount_direction_ambiguous'));assert.ok(codes(result.issues).includes('amount_direction_conflict'));
});

test('only explicit direction prose establishes a convention; raw source prose is preserved',async()=>{
  for(const [prose,expected] of [['Credits increase your account balance; debits decrease it.','credit_increases'],['Debits increase the amount owed.','debit_increases'],['Credits may increase your balance.','unknown'],['Credits do not increase the balance.','unknown'],['Credits increase the balance; debits increase the balance.','unknown'],['Opening plus transactions equals closing.','unknown']]){const raw=await fixture('debit-increases-card');raw.accounts[0].balance_convention=prose;const result=createBankStatementResult(raw,{},'en-IE',{id:ids()});assert.equal(result.values.accounts[0].balance_convention,expected);assert.equal(raw.accounts[0].balance_convention,prose);if(expected==='unknown')assert.ok(codes(checkBankStatement(result.values,result.context)).includes('balance_convention_unknown'));}
});

test('persisted values retain every blocking parsing failure on a fresh check',async()=>{
  for(const [field,value] of [['debit','20.01 CR'],['balance','(−120.01)'],['credit','1e3'],['date','09/03']]){const raw=await fixture('debit-increases-card');(raw.accounts[0].transactions[0] as any)[field]=value;const result=createBankStatementResult(raw,{},'en-IE',{id:ids()});const restoredValues=JSON.parse(JSON.stringify(result.values)),restoredContext=JSON.parse(JSON.stringify(result.context));assert.ok(checkBankStatement(restoredValues,restoredContext).some(i=>i.severity==='error'&&i.field===field),`${field}: ${value}`);}
});

test('explicit compound convention prose reconciles while conflicting directions remain unknown',async()=>{
  for(const [prose,expected] of [['Credits increase and debits decrease the displayed account balance.','credit_increases'],['Debits increase and credits decrease the displayed account balance.','debit_increases'],['Debits decrease and credits increase your account balance.','credit_increases'],['Credits decrease and debits increase the amount owed.','debit_increases'],['Credits increase and debits increase the displayed account balance.','unknown'],['Credits increase and credits decrease the displayed account balance.','unknown'],['Credits increase and debits decrease the displayed account balance. Debits increase the balance.','unknown']]){const raw=await fixture('debit-increases-card');raw.accounts[0].balance_convention=prose;const result=createBankStatementResult(raw,{},'en-IE',{id:ids()});assert.equal(result.values.accounts[0].balance_convention,expected,prose);}
});

test('explicit compound reduce wording retains both balance polarities and either subject order',async()=>{
  for(const reducing of ['reduce','reduces','reduced'])for(const [prose,expected] of [
    [`Debits increase and credits ${reducing} the displayed balance.`,'debit_increases'],
    [`Credits ${reducing} and debits increase the displayed balance.`,'debit_increases'],
    [`Credits increase and debits ${reducing} your account balance.`,'credit_increases'],
    [`Debits ${reducing} and credits increase the amount owed.`,'credit_increases'],
  ]){
    const raw=await fixture('debit-increases-card');raw.accounts[0].balance_convention=prose;const before=clone(raw);
    const result=createBankStatementResult(raw,{},'en-IE',{id:ids()});assert.equal(result.values.accounts[0].balance_convention,expected,prose);assert.deepEqual(raw,before);
  }
});

test('literal synthetic QS1 reduce prose reconciles positive DR balances without changing raw values or evidence',()=>{
  // Authored raw extraction and page evidence exercise normalization only, not OCR or provider accuracy.
  const prose='This is an amount owed: debits increase and credits reduce the displayed balance.';
  const raw:RawBankValues={accounts:[{
    bank_name:'Example Lantern Card Bank',account_identifier:'SYN-QS1-GBP-OCT',currency:'GBP',statement_start:'1 October 2026',statement_end:'31 October 2026',
    opening_balance:'40.00 DR',closing_balance:'41.25 DR',total_debits:'21.25 GBP',total_credits:'20.00 GBP',balance_convention:prose,
    transactions:[
      {date:'5 October 2026',description:'Workshop supplies\nReplacement gloves and protective covers',reference:'QS-001',debit:'15.75 DR',credit:null,balance:'55.75 DR',currency:'GBP'},
      {date:'October 6, 2026',description:'Card repayment\nBank transfer receipt',reference:'QS-002',debit:null,credit:'20.00 CR',balance:'35.75 DR',currency:'GBP'},
      {date:'12 Oct 2026',description:'Equipment locker rental\nSeparate daily booking',reference:'QS-RENT',debit:'2.75 DR',credit:null,balance:'38.50 DR',currency:'GBP'},
      {date:'12 Oct 2026',description:'Equipment locker rental\nSeparate daily booking',reference:'QS-RENT',debit:'2.75 DR',credit:null,balance:'41.25 DR',currency:'GBP'},
    ],
  }]};
  const source:Record<string,Evidence[]>={'accounts[0].balance_convention':[{page:1,text:prose,source:'model-visual'},{page:2,text:prose,source:'model-visual'}]};
  raw.accounts[0].transactions.forEach((row,index)=>{source[`accounts[0].transactions[${index}].balance`]=[{page:index<2?1:2,text:row.balance!,source:'model-visual'}];});
  const before=clone(raw),sourceBefore=clone(source),result=createBankStatementResult(raw,source,'en-IE',{id:ids()}),account=result.values.accounts[0];
  assert.equal(account.balance_convention,'debit_increases');assert.equal(account.opening_balance,'40.00');assert.equal(account.closing_balance,'41.25');assert.equal(account.total_debits,'21.25');assert.equal(account.total_credits,'20.00');
  assert.deepEqual(account.transactions.map(row=>[row.debit,row.credit,row.balance]),[['15.75',null,'55.75'],[null,'20.00','35.75'],['2.75',null,'38.50'],['2.75',null,'41.25']]);
  assert.equal(errors(result).length,0);assert.ok(codes(result.issues).includes('source_review_required'));assert.notEqual(account.transactions[2].id,account.transactions[3].id);
  assert.deepEqual(raw,before);assert.deepEqual(source,sourceBefore);assert.deepEqual(result.context.accounts[account.id].evidence['accounts[0].balance_convention'],sourceBefore['accounts[0].balance_convention']);
  account.transactions.forEach((row,index)=>{assert.equal(row.origin,'extracted');assert.equal(result.context.transactions[row.id].rawPath,`accounts[0].transactions[${index}]`);assert.deepEqual(result.context.transactions[row.id].sourcePages,[index<2?1:2]);assert.deepEqual(result.context.transactions[row.id].evidence[`accounts[0].transactions[${index}].balance`],sourceBefore[`accounts[0].transactions[${index}].balance`]);});
  const changed=clone(result.values);changed.accounts[0].closing_balance='41.26';assert.ok(codes(checkBankStatement(changed,result.context)).includes('closing_balance_mismatch'),'Exact decimal reconciliation must still detect a one-penny discrepancy.');
});

test('reduce prose with uncertainty, negation or conflicting directions stays unresolved despite matching balances',async()=>{
  for(const prose of [
    'Debits may increase and credits reduce the displayed balance.',
    'Debits increase and credits might reduce the displayed balance.',
    'Debits increase and credits could reduce the displayed balance.',
    'Debits do not increase and credits reduce the displayed balance.',
    'Debits increase and credits never reduce the displayed balance.',
    'Debits increase and credits reduce the displayed balance; the convention is unclear.',
    'Debits increase and credits reduce the displayed balance. Credits increase the balance.',
    'Debits increase and credits reduce the displayed balance. Credits increase and debits reduce the displayed balance.',
    'Debits decrease and credits reduce the displayed balance.',
    'Debits reduce and credits decrease the displayed balance.',
    'Credits reduce and debits reduce the displayed balance.',
    'Credits reduce and credits increase the displayed balance.',
    'Credits reduce the displayed balance.',
  ]){
    const raw=await fixture('debit-increases-card');raw.accounts[0].balance_convention=prose;const before=clone(raw),result=createBankStatementResult(raw,{},'en-IE',{id:ids()});
    assert.equal(result.values.accounts[0].balance_convention,'unknown',prose);assert.equal(result.values.accounts[0].opening_balance,'100.00 DR');assert.ok(codes(result.issues).includes('balance_convention_unknown'));assert.ok(codes(result.issues).includes('amount_direction_ambiguous'));assert.deepEqual(raw,before);
  }
});

test('standalone reductions only constrain an explicit increasing subject and never infer a convention',async()=>{
  for(const convention of ['debit_increases','credit_increases'])for(const reducing of ['decrease','decreases','decreased','reduce','reduces','reduced']){
    const raw=await fixture('debit-increases-card'),account=raw.accounts[0],creditIncreases=convention==='credit_increases',increasingSubject=creditIncreases?'Credits':'Debits',reducingSubject=creditIncreases?'Debits':'Credits';
    if(creditIncreases){
      [account.total_debits,account.total_credits]=[account.total_credits,account.total_debits];account.opening_balance=account.opening_balance!.replace('DR','CR');account.closing_balance=account.closing_balance!.replace('DR','CR');
      for(const row of account.transactions){[row.debit,row.credit]=[row.credit?.replace('CR','DR')??null,row.debit?.replace('DR','CR')??null];row.balance=row.balance!.replace('DR','CR');}
    }
    const compound=`${increasingSubject} increase and ${reducingSubject.toLowerCase()} reduce the displayed balance.`;
    for(const [prose,expected] of [
      [`${compound} ${increasingSubject} ${reducing} the amount owed.`,'unknown'],
      [`${compound} ${reducingSubject} ${reducing} the displayed balance.`,convention],
      [`${reducingSubject} ${reducing} the displayed balance.`,'unknown'],
    ]){
      account.balance_convention=prose;const before=clone(raw),result=createBankStatementResult(raw,{},'en-IE',{id:ids()}),normalized=result.values.accounts[0];
      assert.equal(normalized.balance_convention,expected,prose);assert.deepEqual(raw,before);
      if(expected==='unknown'){
        assert.equal(normalized.opening_balance,account.opening_balance);assert.equal(normalized.closing_balance,account.closing_balance);assert.deepEqual(normalized.transactions.map(row=>row.balance),account.transactions.map(row=>row.balance));
        assert.ok(codes(result.issues).includes('balance_convention_unknown'));assert.ok(result.issues.some(issue=>issue.severity==='error'&&issue.code==='amount_direction_ambiguous'));
      }else{
        assert.equal(normalized.opening_balance,'100.00');assert.equal(normalized.closing_balance,'69.99');assert.deepEqual(normalized.transactions.map(row=>row.balance),['120.01','69.99']);assert.equal(errors(result).length,0);
      }
    }
  }
});

test('bad grouping, currency signs and dual signs are not silently repaired',async()=>{
  for(const value of ['1,23,4.00','EUR 1.00','(−1.00)','1e3','1.234.56','NaN']){const raw=await fixture('usd-large-values');raw.accounts[0].transactions[0].credit=value;const result=createBankStatementResult(raw,{},'en-US',{id:ids()});assert.equal(result.values.accounts[0].transactions[0].credit,value);assert.ok(result.issues.some(i=>i.severity==='error'&&i.transactionId===result.values.accounts[0].transactions[0].id&&i.field==='credit'),value);}
});

test('parenthesized and trailing negative column amounts are explicit reviewable reversals',async()=>{
  const raw=await fixture('usd-large-values'),a=raw.accounts[0];a.opening_balance='100';a.closing_balance='103';a.total_debits='(3.00)';a.total_credits='0';a.transactions=[{...a.transactions[0],debit:'3.00-',credit:null,balance:'103',currency:'USD'}];const result=createBankStatementResult(raw,{},'en-US',{id:ids()});assert.equal(errors(result).length,0);assert.equal(result.values.accounts[0].transactions[0].debit,'-3.00');assert.ok(codes(result.issues).includes('signed_column_amount'));
});

test('ambiguous locale dates, missing years and impossible leap days stay visible as errors',async()=>{
  for(const [date,locale] of [['03/04/2026','en'],['03/04','en-US'],['2025-02-29','en-US'],['31/02/2026','en-IE']]){const raw=await fixture('usd-large-values');raw.accounts[0].transactions[0].date=date;const result=createBankStatementResult(raw,{},locale,{id:ids()});assert.equal(result.values.accounts[0].transactions[0].date,date);assert.ok(result.issues.some(i=>i.severity==='error'&&i.field==='date'));}
  const raw=await fixture('usd-large-values');raw.accounts[0].transactions[0].date='2024-02-29';const result=createBankStatementResult(raw,{},'en-US',{id:ids()});assert.equal(result.values.accounts[0].transactions[0].date,'2024-02-29');assert.ok(codes(result.issues).includes('transaction_outside_period'));
});

test('missing amounts, both-sided amounts and unresolved currencies block approval',async()=>{
  for(const mutation of [(r:RawBankValues)=>{r.accounts[0].transactions[0].debit=null;r.accounts[0].transactions[0].credit=null;},(r:RawBankValues)=>{r.accounts[0].transactions[0].debit='1';r.accounts[0].transactions[0].credit='2';},(r:RawBankValues)=>{r.accounts[0].currency='$';}]){const raw=await fixture('usd-large-values');mutation(raw);const result=createBankStatementResult(raw,{},'en-US',{id:ids()});assert.ok(errors(result).length>0);}
});

test('explicit absent-money labels normalize to null while raw text and evidence remain unchanged',async()=>{
  for(const marker of ['Not provided','not supplied','NOT STATED','not available','Not applicable','N/A','  not\n provided  ']){
    const raw=await fixture('euro-current-account'),a=raw.accounts[0];
    a.opening_balance=marker;a.closing_balance=marker;a.total_debits=marker;a.total_credits=marker;
    a.transactions[0].balance=marker;a.transactions[0].credit=marker;a.transactions[1].debit=marker;
    const source:Record<string,Evidence[]>={'accounts[0].opening_balance':[{page:1,text:marker,source:'matched-text'}],'accounts[0].transactions[0].balance':[{page:1,text:marker,source:'matched-text'}]},before=clone(raw),sourceBefore=clone(source);
    const result=createBankStatementResult(raw,source,'de-DE',{id:ids()}),account=result.values.accounts[0];
    for(const field of ['opening_balance','closing_balance','total_debits','total_credits'] as const)assert.equal(account[field],null,`${marker}: ${field}`);
    assert.equal(account.transactions[0].balance,null);assert.equal(account.transactions[0].credit,null);assert.equal(account.transactions[1].debit,null);
    assert.equal(account.transactions[0].debit,'10.00');assert.equal(account.transactions[1].credit,'20.00');assert.equal(errors(result).length,0);
    assert.ok(codes(result.issues).includes('statement_balance_missing'));assert.ok(codes(result.issues).includes('statement_total_missing'));assert.ok(codes(result.issues).includes('running_balances_incomplete'));
    assert.deepEqual(raw,before);assert.deepEqual(source,sourceBefore);assert.deepEqual(result.context.accounts[account.id].evidence['accounts[0].opening_balance'],sourceBefore['accounts[0].opening_balance']);
    assert.deepEqual(result.context.transactions[account.transactions[0].id].evidence['accounts[0].transactions[0].balance'],sourceBefore['accounts[0].transactions[0].balance']);
  }
});

test('absence-like or malformed amount text containing other content remains a blocking unresolved value',async()=>{
  for(const value of ['Not provided 100.00','0.00 not available','not supplied yet','N/A 1.00','unknown','—','-','not applicable (-3.00)','1e3','Not provided?']){
    const raw=await fixture('euro-current-account');raw.accounts[0].opening_balance=value;
    const result=createBankStatementResult(raw,{},'de-DE',{id:ids()});assert.equal(result.values.accounts[0].opening_balance,value);
    assert.ok(result.issues.some(i=>i.field==='opening_balance'&&i.severity==='error'),value);assert.ok(checkBankStatement(clone(result.values),clone(result.context)).some(i=>i.field==='opening_balance'&&i.severity==='error'),value);
  }
});

test('absence labels in corrections preserve identities and cannot bypass a missing transaction amount',async()=>{
  const result=await euro(),changed=clone(result.values),account=changed.accounts[0],row=account.transactions[0],contextBefore=clone(result.context);
  account.opening_balance='Not stated';row.debit='N/A';row.credit='not provided';row.balance='Not available';
  const corrected=normalizeBankStatementCorrections(changed,result.context,result.values),normalized=corrected.values.accounts[0];
  assert.equal(normalized.opening_balance,null);assert.equal(normalized.transactions[0].debit,null);assert.equal(normalized.transactions[0].credit,null);assert.equal(normalized.transactions[0].balance,null);
  assert.ok(corrected.issues.some(i=>i.code==='transaction_amount_missing'&&i.transactionId===row.id&&i.severity==='error'));
  assert.ok(corrected.issues.some(i=>i.code==='statement_balance_missing'&&i.field==='opening_balance'));
  assert.equal(normalized.id,account.id);assert.deepEqual(normalized.transactions.map(r=>r.id),account.transactions.map(r=>r.id));assert.deepEqual(result.context,contextBefore);
});

test('mixed currencies are kept separate and never included in the account reconciliation',async()=>{
  const result=await euro(),changed=clone(result.values);changed.accounts[0].transactions[1].currency='USD';changed.accounts[0].transactions[1].balance='1.00';const reviewed=normalizeBankStatementCorrections(changed,result.context,result.values);assert.ok(codes(reviewed.issues).includes('currency_conflict'));assert.equal(codes(reviewed.issues).includes('statement_total_mismatch'),false);assert.equal(codes(reviewed.issues).includes('closing_running_balance_mismatch'),false);assert.equal(bankTransactionFingerprint(reviewed.values.accounts[0],reviewed.values.accounts[0].transactions[1]),null);
});

test('totals, closing and running balances are independent exact checks',async()=>{
  const result=await euro(),changed=clone(result.values);changed.accounts[0].total_debits='11.00';changed.accounts[0].closing_balance='1011.00';changed.accounts[0].transactions[0].balance='991.00';const reviewed=normalizeBankStatementCorrections(changed,result.context,result.values);for(const code of ['statement_total_mismatch','closing_balance_mismatch','running_balance_mismatch','closing_running_balance_mismatch'])assert.ok(codes(reviewed.issues).includes(code),code);
});

test('missing running balances preserve the interval between available anchors',async()=>{
  const result=await euro(),changed=clone(result.values);changed.accounts[0].transactions[0].balance=null;const reviewed=normalizeBankStatementCorrections(changed,result.context,result.values);assert.equal(errors(reviewed).length,0);assert.ok(codes(reviewed.issues).includes('running_balances_incomplete'));changed.accounts[0].transactions[1].balance='1011.00';assert.ok(codes(normalizeBankStatementCorrections(changed,result.context,result.values).issues).includes('running_balance_mismatch'));
});

test('reordering retains original source paths and validates the intentional displayed order',async()=>{
  const result=await euro(),contextBefore=clone(result.context),changed=clone(result.values);changed.accounts[0].transactions.reverse();const reordered=normalizeBankStatementCorrections(changed,result.context,result.values);assert.deepEqual(reordered.values.accounts[0].transactions.map(r=>r.id),changed.accounts[0].transactions.map(r=>r.id));assert.ok(codes(reordered.issues).includes('running_balance_mismatch'));assert.deepEqual(result.context,contextBefore);assert.equal(result.context.transactions[changed.accounts[0].transactions[0].id].rawPath,'accounts[0].transactions[1]');
  changed.accounts[0].transactions[0].balance='1020.00';changed.accounts[0].transactions[1].balance='1010.00';assert.equal(errors(normalizeBankStatementCorrections(changed,result.context,result.values)).length,0);
});

test('a repeated header stays reviewable with source identity and wrapped descriptions stay intact',async()=>{
  const raw=await fixture('euro-current-account');raw.accounts[0].transactions[1].description='Client payment\nInvoice carried over from page 1';raw.accounts[0].transactions.splice(1,0,{date:'Date',description:'Description',reference:null,debit:'Debit',credit:'Credit',balance:'Balance',currency:'Currency'});
  const result=createBankStatementResult(raw,{'accounts.0.transactions.0.debit':[{page:1,text:'10,00'}],'accounts.0.transactions.1.date':[{page:2,text:'Date Description Debit Credit Balance'}],'accounts.0.transactions.2.description':[{page:1,text:'Client payment'},{page:2,text:'Invoice carried over from page 1'}]},'de-DE',{id:ids()});const header=result.values.accounts[0].transactions[1],wrapped=result.values.accounts[0].transactions[2];assert.equal(result.values.accounts[0].transactions.length,3);assert.ok(result.issues.some(i=>i.transactionId===header.id&&i.severity==='error'));assert.deepEqual(result.context.transactions[wrapped.id].sourcePages,[1,2]);assert.equal(wrapped.description,'Client payment\nInvoice carried over from page 1');
  const corrected=clone(result.values);corrected.accounts[0].transactions[1].excluded=true;corrected.accounts[0].transactions[1].exclusion_reason='Repeated column header on page 2';const reviewed=normalizeBankStatementCorrections(corrected,result.context,result.values);assert.equal(errors(reviewed).length,0);assert.equal(reviewed.values.accounts[0].transactions[1].id,header.id);assert.deepEqual(result.context.transactions[header.id].sourcePages,[2]);
});

test('canonical correction decimals remain canonical in an EU-locale statement',async()=>{
  const result=await euro();assert.deepEqual(normalizeBankStatementCorrections(result.values,result.context,result.values).values,result.values);
  const changed=clone(result.values);changed.accounts[0].transactions[0].debit='10,00';assert.equal(normalizeBankStatementCorrections(changed,result.context,result.values).values.accounts[0].transactions[0].debit,'10.00');
});

test('original identities cannot be deleted, reparented, relabelled or forged',async()=>{
  const raw=await fixture('euro-current-account');raw.accounts.push(clone(raw.accounts[0]));raw.accounts[1].account_identifier='IE99 EXAM 1234 5678 9012 34';const result=createBankStatementResult(raw,evidence,'de-DE',{id:ids()});
  for(const mutate of [(v:BankValues)=>{v.accounts.shift();},(v:BankValues)=>{v.accounts[0].transactions.pop();},(v:BankValues)=>{v.accounts[1].transactions.push(v.accounts[0].transactions.pop()!);},(v:BankValues)=>{v.accounts[0].origin='user';},(v:BankValues)=>{v.accounts[0].transactions[0].id=ids(500)();},(v:BankValues)=>{v.accounts[0].transactions[0].id=v.accounts[0].id;}]){const changed=clone(result.values);mutate(changed);assert.throws(()=>normalizeBankStatementCorrections(changed,result.context,result.values));}
  const forged=clone(result.values) as any;forged.accounts[0].transactions[0].evidence={page:99};assert.throws(()=>normalizeBankStatementCorrections(forged,result.context,result.values),/evidence/);
});

test('new user rows get no fabricated source provenance and saved identities must be retained',async()=>{
  const result=await euro(),changed=clone(result.values),added=userRow(changed.accounts[0],ids(900)());changed.accounts[0].transactions.push(added);const first=normalizeBankStatementCorrections(changed,result.context,result.values);assert.equal(errors(first).length,0);assert.equal(first.values.accounts[0].transactions[2].origin,'user');assert.equal(result.context.transactions[added.id],undefined);
  const deleted=clone(first.values);deleted.accounts[0].transactions.pop();assert.throws(()=>normalizeBankStatementCorrections(deleted,result.context,first.values),/Previously saved transaction/);
  const excluded=clone(first.values);excluded.accounts[0].transactions[2].excluded=true;excluded.accounts[0].transactions[2].exclusion_reason='Entered during review in error';assert.equal(errors(normalizeBankStatementCorrections(excluded,result.context,first.values)).length,0);
});

test('exclusions require reasons, retain originals, and cannot produce an approved empty statement',async()=>{
  const result=await euro(),changed=clone(result.values);changed.accounts[0].transactions[0].excluded=true;assert.throws(()=>normalizeBankStatementCorrections(changed,result.context,result.values),/reason/);changed.accounts[0].transactions[0].exclusion_reason='Repeated source line';const excluded=normalizeBankStatementCorrections(changed,result.context,result.values);assert.equal(excluded.values.accounts[0].transactions.length,2);assert.ok(codes(excluded.issues).includes('statement_total_mismatch'));
  changed.accounts[0].excluded=true;changed.accounts[0].exclusion_reason='Wrong statement';assert.ok(codes(normalizeBankStatementCorrections(changed,result.context,result.values).issues).includes('no_active_accounts'));
});

test('same-currency accounts stay independent and do not collide by currency alone',async()=>{
  const current=await euro(),other=await euro(100);other.values.accounts[0].account_identifier='IE99 EXAM 9999 9999 9999 99';assert.notEqual(bankAccountKey(current.values.accounts[0]),bankAccountKey(other.values.accounts[0]));assert.deepEqual(compareBankStatements(current.values,[{documentId:'other',filename:'other.pdf',values:other.values}]),[]);
  const raw=await fixture('euro-current-account');raw.accounts.push(clone(raw.accounts[0]));raw.accounts[1].account_identifier='IE99 EXAM 9999 9999 9999 99';const result=createBankStatementResult(raw,{},'de-DE',{id:ids()});assert.equal(result.values.accounts.length,2);assert.equal(new Set(result.values.accounts.map(a=>a.id)).size,2);
});

test('cross-file matches are warnings and never remove legitimate repeated payments',async()=>{
  const current=await euro(),other=await euro(100),before=clone(current.values);const warnings=compareBankStatements(current.values,[{documentId:'document-b',filename:'same-account.pdf',values:other.values}]);assert.equal(warnings.filter(i=>i.code==='possible_duplicate_transaction').length,2);assert.ok(warnings.some(i=>i.code==='statement_period_overlap'));assert.ok(warnings.every(i=>i.severity==='warning'));assert.deepEqual(current.values,before);
  const raw=await fixture('usd-large-values'),a=raw.accounts[0];a.opening_balance='100';a.closing_balance='120';a.total_debits='0';a.total_credits='20';a.transactions=[0,1].map(i=>({...a.transactions[0],date:'2026-09-03',description:'Same regular payment',reference:null,debit:null,credit:'10',balance:i?'120':'110',currency:'USD'}));const repeated=createBankStatementResult(raw,{},'en-US',{id:ids()});assert.equal(errors(repeated).length,0);assert.equal(repeated.values.accounts[0].transactions.length,2);assert.ok(repeated.values.accounts[0].transactions.every(r=>!r.excluded));
});

test('masked account suffixes and missing periods never establish an overlap match',async()=>{
  const current=await euro(),other=await euro(100);for(const identifier of ['****1234','XXXX1234','ending 1234','1234']){const masked=clone(current.values);masked.accounts[0].account_identifier=identifier;assert.equal(bankAccountKey(masked.accounts[0]),null);const issues=compareBankStatements(masked,[{documentId:'b',filename:'b.pdf',values:other.values}]);assert.ok(codes(issues).includes('cross_file_identity_unresolved'));assert.equal(codes(issues).includes('statement_period_overlap'),false);}
  current.values.accounts[0].statement_end=null;const issues=compareBankStatements(current.values,[{documentId:'b',filename:'b.pdf',values:other.values}]);assert.ok(codes(issues).includes('cross_file_period_unresolved'));assert.equal(codes(issues).includes('statement_period_overlap'),false);
});

test('comparison respects currency, exclusion, exact amounts and complete row identity',async()=>{
  const a=await euro(),b=await euro(100);assert.equal(bankAccountKey(a.values.accounts[0]),bankAccountKey(b.values.accounts[0]));b.values.accounts[0].currency='USD';assert.deepEqual(compareBankStatements(a.values,[{documentId:'b',filename:'b.pdf',values:b.values}]),[]);
  const account=a.values.accounts[0],row=account.transactions[0],fingerprint=bankTransactionFingerprint(account,row);assert.ok(fingerprint);for(const patch of [{excluded:true},{date:null},{debit:'unreadable'},{credit:'1.00'},{currency:'USD'},{balance:'unreadable'}])assert.equal(bankTransactionFingerprint(account,{...row,...patch}),null);
});

test('consistent export rows keep exact money and stable IDs and omit excluded rows',async()=>{
  const a=await euro(),b=await euro(100);a.values.accounts[0].transactions[0].excluded=true;a.values.accounts[0].transactions[0].exclusion_reason='Reviewed duplicate';const rows=bankStatementRows([{documentId:'a',filename:'a.pdf',values:a.values},{documentId:'b',filename:'b.pdf',values:b.values}]);assert.equal(rows.length,3);assert.equal(rows[0].document_id,'a');assert.equal(rows[0].transaction_id,a.values.accounts[0].transactions[1].id);assert.equal(rows[0].credit,'20.00');assert.equal(typeof rows[0].credit,'string');assert.equal(new Set(rows.map(r=>r.account_id)).size,2);assert.ok(rows.every(r=>!Object.hasOwn(r,'evidence')));
});

test('malformed shapes, unsafe numeric extraction and duplicate generated IDs fail before publishing a result',async()=>{
  const raw=await fixture('euro-current-account');(raw.accounts[0] as any).opening_balance=9007199254740993;assert.throws(()=>createBankStatementResult(raw,{},'de-DE'),/numeric values/);assert.throws(()=>createBankStatementResult({accounts:'bad'},{},'en-US'));assert.throws(()=>createBankStatementResult({accounts:Array.from({length:101},()=>({}))},{},'en-US'));
  assert.throws(()=>createBankStatementResult({accounts:[]},{},'not_a_locale'),/locale/);const valid=await fixture('euro-current-account');assert.throws(()=>createBankStatementResult(valid,{},'de-DE',{id:()=>ids()()}),/unique UUID/);const empty=createBankStatementResult({accounts:[]},{},'en-US');assert.ok(codes(empty.issues).includes('no_active_accounts'));
});

test('unknown conventions and missing totals remain explicit review warnings without a fabricated pass',async()=>{
  const result=await euro(),changed=clone(result.values);changed.accounts[0].balance_convention='unknown';changed.accounts[0].total_debits=null;changed.accounts[0].opening_balance=null;const reviewed=normalizeBankStatementCorrections(changed,result.context,result.values);assert.equal(errors(reviewed).length,0);for(const code of ['balance_convention_unknown','statement_total_missing','statement_balance_missing','source_review_required'])assert.ok(codes(reviewed.issues).includes(code));assert.deepEqual(checkBankStatement(reviewed.values,result.context),reviewed.issues);
});
