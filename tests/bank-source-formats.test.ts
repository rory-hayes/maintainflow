import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBankStatementResult,normalizeBankStatementCorrections,checkBankStatement,bankStatementRows} from '../server/core/bank-statement-domain.js';
import {bankEvidenceReviewIssues} from '../server/core/bank-statement-evidence.js';
import {bankStatementSchema,legacyBankStatementSchema} from '../shared/bank-statement-preset.js';
import type {Evidence} from '../shared/types.js';
import type {RawBankAccount,RawBankValues} from '../shared/bank-statements.js';

// Independently authored synthetic literals; no hosted QA result/oracle is read.
function account(overrides:Partial<RawBankAccount>={}):RawBankAccount{return {
 bank_name:'Synthetic Format Bank',account_identifier:'FORMAT-000001',currency:'EUR',statement_start:'03/04/2026',statement_end:'30/04/2026',opening_balance:'1.000,00',closing_balance:'1.052,25',total_debits:'12,25',total_credits:'64,50',balance_convention:null,
 date_format:'Dates use DD/MM/YYYY.',number_format:'A decimal comma and full stop for thousands are used.',transaction_layout:null,movement_convention:null,
 transactions:[{date:'04/04/2026',description:'Synthetic\nwrapped description',reference:'FMT-1',debit:'12,25',credit:null,balance:'987,75',currency:null},{date:'05/04/2026',description:'Synthetic credit',reference:'FMT-2',debit:null,credit:'64,50',balance:'1.052,25',currency:null}],...overrides};}
function quotes(raw:RawBankValues,source:Evidence['source']='matched-text'):Record<string,Evidence[]>{const result:Record<string,Evidence[]>={};for(const [a,group]of raw.accounts.entries()){for(const[field,value]of Object.entries(group))if(typeof value==='string')result[`accounts[${a}].${field}`]=[{page:a+1,text:value,source}];for(const[t,row]of group.transactions.entries())for(const[field,value]of Object.entries(row))if(typeof value==='string')result[`accounts[${a}].transactions[${t}].${field}`]=[{page:a+1,text:value,source}];}return result;}
const extract=(raw:RawBankValues,evidence=quotes(raw),locale='en-IE')=>createBankStatementResult(raw,evidence,locale,{sourceFormats:true});
const errors=(result:ReturnType<typeof extract>)=>result.issues.filter(item=>item.severity==='error');
function dotAccount():RawBankAccount{return account({account_identifier:'FORMAT-000002',statement_start:'04/03/2026',statement_end:'04/30/2026',date_format:'Dates use MM/DD/YYYY.',number_format:'Amounts use a decimal point and a comma for thousands.',opening_balance:'1,000.00',closing_balance:'1,052.25',total_debits:'12.25',total_credits:'64.50',transactions:account().transactions.map((row,index)=>({...row,date:index?'04/05/2026':'04/04/2026',debit:row.debit?'12.25':null,credit:row.credit?'64.50':null,balance:index?'1,052.25':'987.75'}))});}

test('source rules independently normalize same-currency account groups against a disagreeing locale',()=>{
 const raw={accounts:[account(),dotAccount()]},evidence=quotes(raw),before=structuredClone(raw),sourceBefore=structuredClone(evidence),result=extract(raw,evidence,'en-US');
 assert.deepEqual(result.values.accounts.map(a=>[a.statement_start,a.statement_end,a.opening_balance,a.closing_balance]),[['2026-04-03','2026-04-30','1000.00','1052.25'],['2026-04-03','2026-04-30','1000.00','1052.25']]);assert.equal(errors(result).length,0);
 assert.deepEqual(result.values.accounts.map(a=>a.transactions.map(r=>[r.date,r.debit,r.credit,r.balance])),[[['2026-04-04','12.25',null,'987.75'],['2026-04-05',null,'64.50','1052.25']],[['2026-04-04','12.25',null,'987.75'],['2026-04-05',null,'64.50','1052.25']]]);
 assert.ok(result.values.accounts.every(a=>a.balance_convention==='unknown'));assert.deepEqual(raw,before);assert.deepEqual(evidence,sourceBefore);assert.ok(result.values.accounts.every(a=>!Object.hasOwn(a,'number_format')));assert.ok(Object.isFrozen(result.context.accounts[result.values.accounts[0].id].formats));
});

test('supported explicit date orders and punctuation declarations cover bounded literal variants',()=>{
 for(const[rule,date,expected]of [['Dates use DD.MM.YYYY.','11.02.2026','2026-02-11'],['Date format: MM-DD-YYYY','02-11-2026','2026-02-11'],['Date format: YYYY/MM/DD','2026/02/11','2026-02-11']]as const){const a=account({date_format:rule,statement_start:date,statement_end:date,transactions:[]}),result=extract({accounts:[a]});assert.equal(result.values.accounts[0].statement_start,expected,rule);}
 for(const[rule,value,expected]of [['Decimal separator: comma; thousands separator: full stop','1.234,5678','1234.5678'],['Decimal separator: .; thousands separator: comma','1,234.56','1234.56'],['Number format example: 1 234,56','1 234,56','1234.56'],['Amount format: 1 234.56','1 234.56','1234.56'],['Amounts use a decimal point.','1234.56','1234.56']]as const){const result=extract({accounts:[account({number_format:rule,opening_balance:value,transactions:[]})]});assert.equal(result.values.accounts[0].opening_balance,expected,rule);}
});

test('metadata needs its own exact account field quote and a valid retained page/provenance',()=>{
 for(const mode of ['absent','transaction','other-account','wrong-literal','wrong-page','unverified']as const){const raw={accounts:[account(),dotAccount()]},evidence=quotes(raw),key='accounts[0].date_format';delete evidence[key];if(mode==='transaction')evidence['accounts[0].transactions[0].description']=[{page:1,text:raw.accounts[0].date_format!,source:'matched-text'}];if(mode==='other-account')evidence['accounts[1].date_format']=[{page:2,text:raw.accounts[0].date_format!,source:'matched-text'}];if(mode==='wrong-literal')evidence[key]=[{page:1,text:'Dates use MM/DD/YYYY.',source:'matched-text'}];if(mode==='wrong-page')evidence[key]=[{page:0,text:raw.accounts[0].date_format!,source:'matched-text'}];if(mode==='unverified')evidence[key]=[{page:1,text:raw.accounts[0].date_format!}];
  if(mode==='wrong-page')assert.throws(()=>extract(raw,evidence),/Invalid source evidence/);else {const result=extract(raw,evidence);assert.equal(result.values.accounts[0].statement_start,null,mode);assert.equal(result.context.accounts[result.values.accounts[0].id].formats?.dateStatus,'unresolved');assert.ok(errors(result).some(i=>i.code==='date_format_unresolved'));assert.equal(result.values.accounts[1].statement_start,mode==='other-account'?null:'2026-04-03');}
 }
});

test('negated, conflicting or unsupported printed rules stay unresolved without currency/balance guessing',()=>{
 for(const rule of ['Dates do not use MM/DD/YYYY.','Dates use MM/DD/YYYY or DD/MM/YYYY.','Dates use DD/MM/YYYY. Dates use MM/DD/YYYY.','Date format: YY/MM/DD','Dates may use DD/MM/YYYY.']){const result=extract({accounts:[account({date_format:rule})]});assert.equal(result.values.accounts[0].statement_start,null,rule);assert.equal(result.values.accounts[0].transactions[0].date,null);}
 for(const rule of ['Amounts do not use a decimal comma.','Amounts use a decimal comma or decimal point.','Decimal separator: comma; thousands separator: comma','Amounts may use a decimal point.']){const result=extract({accounts:[account({number_format:rule})]});assert.equal(result.values.accounts[0].transactions[0].debit,null,rule);assert.ok(errors(result).some(i=>i.code==='transaction_amount_missing'));}
});

test('missing printed formats leave ambiguous dates/grouping unresolved and accept only self-contained literals',()=>{
 const a=dotAccount();a.date_format=null;a.number_format=null;a.transactions[0].date='04/09/2026';a.transactions[0].debit='1,234';a.transactions[0].balance='12.34';a.transactions[1].date='23/04/2026';a.transactions[1].credit='64,50';const result=extract({accounts:[a]});
 assert.equal(result.values.accounts[0].statement_start,null);assert.equal(result.values.accounts[0].transactions[0].date,null);assert.equal(result.values.accounts[0].transactions[0].debit,null);assert.equal(result.values.accounts[0].transactions[0].balance,'12.34');assert.equal(result.values.accounts[0].transactions[1].date,'2026-04-23');assert.equal(result.values.accounts[0].transactions[1].credit,'64.50');assert.equal(result.values.accounts[0].opening_balance,null);assert.equal(result.values.accounts[0].balance_convention,'unknown');
});

function signed(positive:'credits'|'debits'='credits'):RawBankAccount {const negative=positive==='credits'?'debits':'credits',a=dotAccount();a.transaction_layout='Signed amount';a.movement_convention=`Positive signed amounts are ${positive}; parentheses or minus signs are ${negative}.`;a.opening_balance=null;a.closing_balance=positive==='credits'?'305.40':'-305.40';a.total_debits=positive==='credits'?'20.05':'325.40';a.total_credits=positive==='credits'?'325.40':'20.05';a.transactions=[{date:'04/04/2026',description:'Signed positive',reference:'SGN-1',debit:positive==='debits'?'+325.40':null,credit:positive==='credits'?'+325.40':null,balance:null,currency:null},{date:'04/09/2026',description:'Signed negative',reference:'SGN-2',debit:positive==='credits'?'(15.10)':null,credit:positive==='debits'?'(15.10)':null,balance:null,currency:null},{date:'04/23/2026',description:'Signed negative',reference:'SGN-3',debit:positive==='credits'?'-4.90':null,credit:positive==='debits'?'-4.90':null,balance:'305.40',currency:null}];return a;}
test('both evidenced single signed movement polarities convert only direction-proven magnitudes',()=>{
 for(const positive of ['credits','debits']as const){const raw={accounts:[signed(positive)]},before=structuredClone(raw),result=extract(raw),a=result.values.accounts[0];assert.deepEqual(a.transactions.map(r=>[r.debit,r.credit]),positive==='credits'?[[null,'325.40'],['15.10',null],['4.90',null]]:[['325.40',null],[null,'15.10'],[null,'4.90']]);assert.equal(a.balance_convention,'unknown');assert.equal(a.opening_balance,null);assert.ok(errors(result).some(i=>i.code==='statement_total_mismatch'&&i.field===(positive==='credits'?'total_debits':'total_credits')));assert.ok(!errors(result).some(i=>i.code==='movement_direction_conflict'));assert.deepEqual(raw,before);}
});
test('signed layout requires both own-field proofs and never fixes a contradictory column assignment',()=>{
 for(const mutation of ['missing-header','missing-rule','unverified-header','negated','contradiction','wrong-role','ordinary-columns']as const){const a=signed(),raw={accounts:[a]},evidence=quotes(raw);if(mutation==='missing-header')a.transaction_layout=null;if(mutation==='missing-rule')a.movement_convention=null;if(mutation==='unverified-header')delete evidence['accounts[0].transaction_layout'];if(mutation==='negated')a.movement_convention='Positive amounts are not credits; negative amounts are debits.';if(mutation==='contradiction')a.movement_convention='Positive amounts are credits; negative amounts are credits.';if(mutation==='wrong-role'){a.transactions[1].credit=a.transactions[1].debit;a.transactions[1].debit=null;}if(mutation==='ordinary-columns')a.transaction_layout='Debit | Credit';const result=extract(raw,mutation==='unverified-header'?evidence:quotes(raw));assert.equal(mutation==='wrong-role'?result.values.accounts[0].transactions[1].credit:result.values.accounts[0].transactions[1].debit,null,mutation);assert.ok(errors(result).some(i=>['movement_convention_unresolved','movement_direction_conflict'].includes(i.code)),mutation);}
});
test('genuine negative column reversals survive new source rules and canonical user corrections',()=>{
 const a=dotAccount();a.balance_convention='Credits increase and debits decrease the displayed balance.';a.opening_balance='100.00';a.closing_balance='103.00';a.total_debits='(3.00)';a.total_credits='0.00';a.transactions=[{...a.transactions[0],debit:'3.00-',credit:null,balance:'103.00'}];const result=extract({accounts:[a]});assert.equal(result.values.accounts[0].transactions[0].debit,'-3.00');assert.equal(errors(result).length,0);assert.ok(result.issues.some(i=>i.code==='signed_column_amount'));
 const single=extract({accounts:[signed()]}),values=structuredClone(single.values);values.accounts[0].transactions[1].debit='-2.00';const corrected=normalizeBankStatementCorrections(values,single.context,single.values);assert.equal(corrected.values.accounts[0].transactions[1].debit,'-2.00');assert.ok(corrected.issues.some(i=>i.code==='signed_column_amount'));
});

test('format provenance, raw values and identities survive corrections, reordering and exports',()=>{
 const raw={accounts:[signed()]},evidence=quotes(raw),result=extract(raw),contextBefore=structuredClone(result.context),values=structuredClone(result.values),a=values.accounts[0],ids=a.transactions.map(r=>r.id);a.transactions.reverse();a.total_debits='20.00';a.transactions.push({...a.transactions[0],id:randomUUID(),origin:'user',debit:'0.00',credit:null,date:'2026-04-24',balance:null});const corrected=normalizeBankStatementCorrections(values,result.context,result.values);
 assert.deepEqual(result.context,contextBefore);assert.deepEqual(corrected.values.accounts[0].transactions.slice(0,3).map(r=>r.id),ids.toReversed());assert.equal(corrected.values.accounts[0].transactions[3].origin,'user');assert.ok(!corrected.issues.some(i=>i.code==='statement_total_mismatch'&&i.field==='total_debits'));assert.deepEqual(bankStatementRows([{documentId:'synthetic-source',filename:'synthetic.pdf',values:corrected.values}]).map(r=>[r.transaction_id,r.debit,r.credit]),corrected.values.accounts[0].transactions.map(r=>[r.id,r.debit,r.credit]));
 assert.throws(()=>normalizeBankStatementCorrections({...values,context:result.context},result.context,result.values),/Unexpected/);(a as unknown as Record<string,unknown>).number_format='Amounts use a decimal comma.';assert.throws(()=>normalizeBankStatementCorrections(values,result.context,result.values),/Unexpected/);
});
test('model-visual metadata keeps its provenance warning and native metadata mismatch is reviewable',()=>{
 const raw={accounts:[account()]},visual=quotes(raw,'model-visual'),result=extract(raw,visual);assert.equal(errors(result).length,0);assert.ok(bankEvidenceReviewIssues(raw,visual,[],result.context,result.values).some(i=>i.code==='visual_evidence'));const native=quotes(raw),nativeResult=extract(raw,native);const warnings=bankEvidenceReviewIssues(raw,native,[{field:'accounts[0].number_format',code:'value_source_mismatch'}],nativeResult.context,nativeResult.values);assert.ok(warnings.some(i=>i.code==='value_source_mismatch'&&i.accountId===nativeResult.values.accounts[0].id&&i.field==='number_format'));
});
test('legacy creation/context behavior stays unchanged and invalid server format policies fail closed',()=>{
 const raw={accounts:[dotAccount()]},legacy=createBankStatementResult(raw,quotes(raw),'en-IE');assert.equal(legacy.values.accounts[0].statement_start,'2026-03-04');assert.equal(legacy.context.accounts[legacy.values.accounts[0].id].formats,undefined);const modern=extract(raw),bad=structuredClone(modern.context);bad.accounts[modern.values.accounts[0].id].formats!.dateOrder=null;assert.throws(()=>checkBankStatement(modern.values,bad),/Invalid original account format policy/);
 assert.equal(legacyBankStatementSchema.fields[0].fields?.length,11);assert.equal(bankStatementSchema.fields[0].fields?.length,15);assert.ok(!legacyBankStatementSchema.fields[0].fields?.some(f=>f.key==='date_format'));
});


test('cropped supported scalars cannot hide contradictions or qualifications in their own quotes',()=>{
 for(const[field,quote]of [
  ['date_format','Dates use DD/MM/YYYY. Dates use MM/DD/YYYY.'],
  ['date_format','Usually Dates use DD/MM/YYYY.'],
  ['date_format','Dates use DD/MM/YYYY. Except transaction dates.'],
  ['number_format','A decimal comma and full stop for thousands are used. Decimal separator: point; thousands separator: comma'],
  ['number_format','A decimal comma and full stop for thousands are used. Amount format: 1,234.56'],
  ['number_format','A decimal comma and full stop for thousands are used. Thousands separator: space'],
  ['movement_convention','Positive signed amounts are credits; parentheses or minus signs are debits. Positive amounts are debits; negative amounts are credits.'],
  ['movement_convention','Positive signed amounts are credits; parentheses or minus signs are debits. Negative amounts are credits.'],
  ['movement_convention','Usually positive signed amounts are credits; parentheses or minus signs are debits.'],
 ]as const){const raw={accounts:[field==='movement_convention'?signed():account()]},evidence=quotes(raw);evidence[`accounts[0].${field}`]=[{page:1,text:quote,source:'matched-text'}];const result=extract(raw,evidence);assert.equal(field==='date_format'?result.values.accounts[0].statement_start:result.values.accounts[0].transactions[0][field==='number_format'?'debit':'credit'],null,quote);}
 const malformed={accounts:[account()]};(malformed.accounts[0]as any).date_format=20260403;assert.throws(()=>extract(malformed),/bounded strings/);
});


test('conflicting supported semantics across separate own-field quotes remain unresolved',()=>{
 for(const[field,other]of [['date_format','Dates use MM/DD/YYYY.'],['number_format','Decimal separator: point; thousands separator: comma'],['number_format','Number format example: 1,234.56'],['movement_convention','Positive amounts are debits; negative amounts are credits.']]as const){const raw={accounts:[field==='movement_convention'?signed():account()]},evidence=quotes(raw);evidence[`accounts[0].${field}`].push({page:2,text:other,source:'matched-text'});const result=extract(raw,evidence);assert.equal(field==='date_format'?result.values.accounts[0].statement_start:result.values.accounts[0].transactions[0][field==='number_format'?'debit':'credit'],null,other);}
});


test('all bracket/dotted aliases and grouping examples share one bounded conflict boundary',()=>{
 for(const[field,other]of [['date_format','Dates use DD/MM/YYYY.'],['number_format','Number format example: 1 234.56'],['movement_convention','Positive amounts are debits; negative amounts are credits.']]as const){const a=field==='movement_convention'?signed():dotAccount(),raw={accounts:[a]},evidence=quotes(raw);evidence[`accounts.0.${field}`]=[{page:2,text:other,source:'matched-text'}];const result=extract(raw,evidence);assert.equal(field==='date_format'?result.values.accounts[0].statement_start:result.values.accounts[0].transactions[0][field==='number_format'?'debit':'credit'],null,other);}
 const raw={accounts:[account()]},evidence=quotes(raw);evidence['accounts.0.date_format']=Array.from({length:20},()=>({page:1,text:raw.accounts[0].date_format!,source:'matched-text'}));assert.equal(extract(raw,evidence).values.accounts[0].statement_start,null);
 for(const extra of ['But some transaction dates follow another format.','The rule applies unless a row says otherwise.','Numbers are generally formatted this way.']){const source=quotes(raw);source['accounts[0].date_format'][0].text+=' '+extra;assert.equal(extract(raw,source).values.accounts[0].statement_start,null,extra);}
 const source=quotes(raw);source['accounts[0].date_format'][0].text+=' '+raw.accounts[0].number_format;assert.equal(extract(raw,source).values.accounts[0].statement_start,'2026-04-03');
});


test('raw corrections keep account source rules; ISO dates and exact decimal corrections remain explicit',()=>{
 const result=extract({accounts:[dotAccount()]}),values=structuredClone(result.values);values.accounts[0].transactions[0].date='04/09/2026';const sourceDate=normalizeBankStatementCorrections(values,result.context,result.values);assert.equal(sourceDate.values.accounts[0].transactions[0].date,'2026-04-09');
 const missing=extract({accounts:[dotAccount()]},{}),corrected=structuredClone(missing.values);corrected.accounts[0].transactions[0].date='04/09/2026';corrected.accounts[0].transactions[0].debit='1,234';let checked=normalizeBankStatementCorrections(corrected,missing.context,missing.values);assert.equal(checked.values.accounts[0].transactions[0].date,null);assert.equal(checked.values.accounts[0].transactions[0].debit,null);corrected.accounts[0].transactions[0].date='2026-04-09';corrected.accounts[0].transactions[0].debit='1234.00';checked=normalizeBankStatementCorrections(corrected,missing.context,missing.values);assert.equal(checked.values.accounts[0].transactions[0].date,'2026-04-09');assert.equal(checked.values.accounts[0].transactions[0].debit,'1234.00');
});
