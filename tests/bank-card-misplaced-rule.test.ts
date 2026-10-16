/** Labelled synthetic MB17-B native-source regression; no database or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createBankStatementResult,normalizeBankStatementCorrections,checkBankStatement} from '../server/core/bank-statement-domain.js';
import {bankBalanceRuleFromMovement} from '../server/core/bank-source-formats.js';
const fixture=JSON.parse(await fs.readFile(new URL('../fixtures/bank-statements/SYNTHETIC-MB17-card-misplaced-rule.json',import.meta.url),'utf8'));
type Input={raw:any;evidence:Record<string,any[]>;nativeSource?:{mimeType:string;pages:{page:number;text:string}[]}};
const header='Date | Description | Reference | Debit | Credit | Balance';
const model=():Input=>structuredClone({raw:fixture.raw,evidence:fixture.evidence,nativeSource:{mimeType:'text/plain',pages:[{page:1,text:fixture.source_text}]}});
function extract(input=model(),modern=true){let i=0;return createBankStatementResult(input.raw,input.evidence,'en-IE',{sourceFormats:modern,nativeSource:input.nativeSource,id:()=>fixture.ids[i++]??`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`});}
const errors=(result:ReturnType<typeof extract>)=>result.issues.filter(issue=>issue.severity==='error');
const identity=new Set(['id','origin','excluded','exclusion_reason']);
function business(account:any){return Object.fromEntries(Object.entries(account).filter(([key])=>!identity.has(key)).map(([key,value])=>[key,key==='transactions'?(value as any[]).map(row=>Object.fromEntries(Object.entries(row).filter(([name])=>!identity.has(name)))):value]));}

test('actual synthetic misfiled owed-balance note resolves only through complete same-account native evidence',()=>{
 const input=model(),before=structuredClone(input),result=extract(input),account=result.values.accounts[0];
 assert.equal(createHash('sha256').update(fixture.source_text).digest('hex'),fixture.source_sha256);
 for(const entries of Object.values(input.evidence) as any[][])for(const item of entries)assert.ok(fixture.source_text.includes(item.text));
 assert.deepEqual(business(account),fixture.expected_business);assert.equal(errors(result).length,0);
 assert.deepEqual(result.issues.map(issue=>issue.code),['source_review_required']);
 assert.deepEqual([account.id,...account.transactions.map(row=>row.id)],fixture.ids);
 assert.equal(result.context.accounts[account.id].formats?.movement,'columns');
 assert.deepEqual(result.context.accounts[account.id].nativeColumns,{version:1,mimeType:'text/plain',page:1,header});
 assert.ok(Object.isFrozen(result.context.accounts[account.id].nativeColumns));
 assert.deepEqual(result.context.accounts[account.id].evidence,fixture.evidence);
 assert.deepEqual(input,before,'Literal provider fields and native evidence must not be reassigned or rewritten.');
 assert.equal(input.raw.accounts[0].balance_convention,'Positive balance is the amount owed.');
 assert.equal(input.raw.accounts[0].movement_convention,'Debits increase and credits decrease the amount owed.');
});

test('missing, conflicting, cropped, foreign and non-native rule proofs remain unresolved',()=>{
 const cases:Array<[string,(x:ReturnType<typeof model>)=>void]>=[
  ['missing own quote',x=>{delete x.evidence['accounts[0].movement_convention'];}],
  ['foreign account quote',x=>{x.evidence['accounts[1].movement_convention']=x.evidence['accounts[0].movement_convention'];delete x.evidence['accounts[0].movement_convention'];}],
  ['different account anchor',x=>{x.evidence['accounts[0].account_identifier'][0].text='Account identifier: SYNTHETIC-OTHER';}],
  ['different page',x=>{x.evidence['accounts[0].movement_convention'][0].page=2;}],
  ['model visual',x=>{x.evidence['accounts[0].movement_convention'][0].source='model-visual';}],
  ['conflicting alias',x=>{x.evidence['accounts.0.movement_convention']=[{page:1,text:'Credits increase and debits decrease the amount owed.',source:'matched-text'}];}],
  ['qualified quote',x=>{x.evidence['accounts[0].movement_convention'][0].text+=' Except refunds.';}],
  ['cropped rule',x=>{x.raw.accounts[0].movement_convention='Debits increase';}],
  ['unsupported layout',x=>{x.raw.accounts[0].transaction_layout='Signed amount';x.evidence['accounts[0].transaction_layout']=[{page:1,text:'Signed amount',source:'matched-text'}];}],
 ];
 for(const [name,mutate]of cases){const input=model();mutate(input);const before=structuredClone(input),result=extract(input),account=result.values.accounts[0];
  assert.equal(bankBalanceRuleFromMovement(input.raw.accounts[0],result.context.accounts[account.id]),null,name);
  assert.equal(account.balance_convention,'unknown',name);assert.equal(result.context.accounts[account.id].formats?.movement,'unresolved',name);
  assert.deepEqual(account.transactions.map(row=>[row.debit,row.credit]),[[null,null],[null,null]],name);
  assert.ok(errors(result).some(issue=>issue.code==='transaction_amount_missing'),name);assert.deepEqual(input,before,name);
 }
});

test('an explicit primary direction or signed polarity is never replaced by the recovery rule',()=>{
 const primary=model();primary.raw.accounts[0].balance_convention='Credits increase and debits decrease the balance.';primary.evidence['accounts[0].balance_convention'][0].text=primary.raw.accounts[0].balance_convention;
 const a=extract(primary);assert.equal(a.values.accounts[0].balance_convention,'credit_increases');assert.equal(a.context.accounts[a.values.accounts[0].id].formats?.movement,'unresolved');
 const signed=model();signed.raw.accounts[0].movement_convention='Positive amounts are debits; negative amounts are credits.';signed.evidence['accounts[0].movement_convention'][0].text=signed.raw.accounts[0].movement_convention;
 const b=extract(signed);assert.equal(b.values.accounts[0].balance_convention,'unknown');assert.equal(b.context.accounts[b.values.accounts[0].id].formats?.movement,'unresolved');
});

test('literal direction is not selected or flipped to make a mismatched balance reconcile',()=>{
 const input=model();input.raw.accounts[0].closing_balance='999.00';const result=extract(input);
 assert.equal(result.values.accounts[0].balance_convention,'debit_increases');
 assert.deepEqual(result.values.accounts[0].transactions.map(row=>[row.debit,row.credit]),[['20.00',null],[null,'50.00']]);
 assert.ok(errors(result).some(issue=>issue.code==='closing_balance_mismatch'));
});

test('an opposite complete printed direction is retained even when the original numbers disagree',()=>{
 const input=model(),old=input.raw.accounts[0].movement_convention,rule='Credits increase and debits decrease the amount owed.';
 input.raw.accounts[0].movement_convention=rule;input.evidence['accounts[0].movement_convention'][0].text=rule;
 input.nativeSource!.pages[0].text=input.nativeSource!.pages[0].text.replace(old,rule);
 const result=extract(input);assert.equal(result.values.accounts[0].balance_convention,'credit_increases');
 assert.equal(result.context.accounts[fixture.ids[0]].formats?.movement,'columns');
 assert.deepEqual(result.values.accounts[0].transactions.map(row=>[row.debit,row.credit]),[['20.00',null],[null,'50.00']]);
 assert.ok(errors(result).some(issue=>issue.code==='running_balance_mismatch'));
});

test('existing unresolved saved contexts stay unresolved and retain identities through correction validation',()=>{
 const created=extract(),context=structuredClone(created.context);context.accounts[fixture.ids[0]].formats=structuredClone(fixture.captured_formats);delete context.accounts[fixture.ids[0]].nativeColumns;
 const before=structuredClone(context),values=structuredClone(fixture.captured_values),result=normalizeBankStatementCorrections(values,context,values);
 assert.deepEqual(result.values,values);assert.deepEqual(context,before);
 assert.equal(result.values.accounts[0].balance_convention,'unknown');
 assert.deepEqual(result.values.accounts[0].transactions.map(row=>[row.id,row.debit,row.credit]),fixture.ids.slice(1).map((id:string)=>[id,null,null]));
 assert.ok(checkBankStatement(result.values,context).some(issue=>issue.code==='transaction_amount_missing'));
});

test('legacy locale-only creation does not adopt the new native recovery policy',()=>{
 const result=extract(model(),false),account=result.values.accounts[0];assert.equal(result.context.accounts[account.id].formats,undefined);
 assert.equal(account.balance_convention,'unknown');assert.deepEqual(account.transactions.map(row=>[row.debit,row.credit]),[['20.00',null],[null,'50.00']]);
});


test('null provider layout cannot substitute for a native separate Debit/Credit header',()=>{
 const cases:Array<[string,(x:Input)=>void]>=[
  ['missing native pages',x=>{delete x.nativeSource;}],
  ['non-TXT source',x=>{x.nativeSource!.mimeType='application/pdf';}],
  ['signed Amount source with null layout',x=>{x.nativeSource!.pages[0].text=x.nativeSource!.pages[0].text.replace(header,'Date | Description | Reference | Amount | Balance');}],
  ['signed amount source with null layout',x=>{x.nativeSource!.pages[0].text=x.nativeSource!.pages[0].text.replace(header,'Date | Description | Reference | Signed amount | Balance');}],
  ['no native header',x=>{x.nativeSource!.pages[0].text=x.nativeSource!.pages[0].text.replace(header,'');}],
  ['competing signed table',x=>{x.nativeSource!.pages[0].text+='\nDate | Description | Amount | Balance\n';}],
  ['competing comma amount table',x=>{x.nativeSource!.pages[0].text+='\nDate,Description,Reference,Amount,Balance\n';}],
  ['competing tab amount table',x=>{x.nativeSource!.pages[0].text+='\nDate\tDescription\tReference\tAmount\tBalance\n';}],
  ['separate signed-layout declaration',x=>{x.nativeSource!.pages[0].text+='\nTransaction layout: Signed amount\n';}],
  ['repeated separate header',x=>{x.nativeSource!.pages[0].text+='\n'+header+'\n';}],
  ['extra unknown column',x=>{x.nativeSource!.pages[0].text=x.nativeSource!.pages[0].text.replace(header,header+' | Amount');}],
  ['multiple pages',x=>{x.nativeSource!.pages.push({page:2,text:'Second synthetic page'});}],
  ['wrong page identity',x=>{x.nativeSource!.pages[0].page=2;}],
  ['multiple raw accounts',x=>{x.raw.accounts.push(structuredClone(x.raw.accounts[0]));}],
  ['another native account anchor',x=>{x.nativeSource!.pages[0].text+='\nAccount identifier: SYNTHETIC-OTHER\n';}],
  ['another native currency anchor',x=>{x.nativeSource!.pages[0].text+='\nCurrency: EUR\n';}],
  ['another native bank anchor',x=>{x.nativeSource!.pages[0].text+='\nBank: Synthetic Other Bank\n';}],
  ['different native identifier',x=>{x.nativeSource!.pages[0].text=x.nativeSource!.pages[0].text.replace('Account identifier: QA-MB17-USD-CARD-7395','Account identifier: SYNTHETIC-OTHER');}],
  ['native rule absent',x=>{x.nativeSource!.pages[0].text=x.nativeSource!.pages[0].text.replace(x.raw.accounts[0].movement_convention,'');}],
  ['native rule qualified',x=>{x.nativeSource!.pages[0].text=x.nativeSource!.pages[0].text.replace(x.raw.accounts[0].movement_convention,x.raw.accounts[0].movement_convention+' Except refunds.');}],
  ['separate native exception',x=>{x.nativeSource!.pages[0].text+='\nExcept refunds.\n';}],
  ['separate leading negation',x=>{x.nativeSource!.pages[0].text+='\nNot refunds.\n';}],
  ['conflicting native balance rule',x=>{x.nativeSource!.pages[0].text+='\nCredits increase and debits decrease the amount owed.\n';}],
  ['inflected opposite native rule',x=>{x.nativeSource!.pages[0].text+='\nA credit increases the amount owed; a debit decreases the amount owed.\n';}],
  ['reversed-order opposite native rule',x=>{x.nativeSource!.pages[0].text+='\nThe amount owed increases with a credit and decreases with a debit.\n';}],
  ['separate non-leading exception',x=>{x.nativeSource!.pages[0].text+='\nThe above rule does not apply to refunds.\n';}],
  ['separate refund reversal',x=>{x.nativeSource!.pages[0].text+='\nFor refunds, reverse the rule.\n';}],
  ['pipe-separated prose exception',x=>{x.nativeSource!.pages[0].text+='\nFor refunds | reverse the rule.\n';}],
  ['separate prose qualification',x=>{x.nativeSource!.pages[0].text+='\nFor refunds, the convention is not applicable.\n';}],
  ['oversized native page',x=>{x.nativeSource!.pages[0].text+='x'.repeat(64_001);}],
 ];
 for(const [name,mutate]of cases){const input=model();mutate(input);const before=structuredClone(input),result=extract(input),account=result.values.accounts[0];
  assert.equal(input.raw.accounts[0].transaction_layout,null,name);
  assert.equal(result.context.accounts[account.id].nativeColumns,undefined,name);
  assert.equal(account.balance_convention,'unknown',name);assert.equal(result.context.accounts[account.id].formats?.movement,'unresolved',name);
  assert.deepEqual(account.transactions.map(row=>[row.debit,row.credit]),[[null,null],[null,null]],name);
  assert.ok(errors(result).some(issue=>issue.code==='transaction_amount_missing'),name);assert.deepEqual(input,before,name);
 }
});

test('retained native header proof and source identities survive valid corrections and reordering',()=>{
 const created=extract(),context=structuredClone(created.context),before=structuredClone(context),values=structuredClone(created.values);
 values.accounts[0].transactions.reverse();
 const corrected=normalizeBankStatementCorrections(values,context,created.values);
 assert.deepEqual(corrected.values.accounts[0].transactions.map(row=>row.id),fixture.ids.slice(1).reverse());
 assert.deepEqual(context,before);assert.deepEqual(context.accounts[fixture.ids[0]].nativeColumns,{version:1,mimeType:'text/plain',page:1,header});
 for(const id of fixture.ids.slice(1))assert.deepEqual(context.transactions[id],created.context.transactions[id]);
 assert.equal(corrected.values.accounts[0].balance_convention,'debit_increases');
});

test('invalid native proof cannot be retained as server correction context',()=>{
 const created=extract();
 for(const patch of [{header:'Date | Description | Amount | Balance'},{mimeType:'image/png'},{page:2},{version:2},{extra:true}]){
  const context=structuredClone(created.context);Object.assign(context.accounts[fixture.ids[0]].nativeColumns!,patch);
  assert.throws(()=>normalizeBankStatementCorrections(created.values,context,created.values),/Invalid native account column proof/);
 }
});


test('a transaction description is not treated as a global balance-rule qualification',()=>{
 const input=model(),old=input.raw.accounts[0].transactions[1].description,description='Reverse synthetic refund';
 input.raw.accounts[0].transactions[1].description=description;
 for(const entries of Object.values(input.evidence))for(const item of entries)item.text=item.text.replace(old,description);
 input.nativeSource!.pages[0].text=input.nativeSource!.pages[0].text.replace(old,description);
 const result=extract(input);assert.equal(result.values.accounts[0].balance_convention,'debit_increases');
 assert.equal(result.context.accounts[fixture.ids[0]].formats?.movement,'columns');assert.equal(errors(result).length,0);
 assert.equal(result.values.accounts[0].transactions[1].description,description);
});
