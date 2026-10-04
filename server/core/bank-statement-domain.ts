import {createHash,randomUUID} from 'node:crypto';
import type {Evidence} from '../../shared/types.js';
import type {BankAccount,BankAccountFormats,BankBalanceConvention,BankContext,BankIssue,BankScalar,BankSource,BankStatementExportRow,BankStatementRecord,BankTransaction,BankValues} from '../../shared/bank-statements.js';

import {resolveBankSourceFormats,validBankSourceFormats} from './bank-source-formats.js';

const accountFields=['bank_name','account_identifier','currency','statement_start','statement_end','opening_balance','closing_balance','total_debits','total_credits','balance_convention'] as const;
const rowFields=['date','description','reference','debit','credit','balance','currency'] as const;
const identityFields=['id','origin','excluded','exclusion_reason'];
const accountMoney=['opening_balance','closing_balance','total_debits','total_credits'] as const;
const conventions=['credit_increases','debit_increases','unknown'];
const uuidPattern=/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const canonicalMoney=/^-?(?:0|[1-9]\d{0,69})(?:\.\d{1,8})?$/;
// Explicit whole-value absence labels are missing amounts, never zero. Other invalid text stays reviewable.
const absentAmount=/^(?:not (?:provided|supplied|stated|available|applicable)|n\/a)$/i;
const currencies=new Set(Intl.supportedValuesOf('currency'));
const limits={accounts:100,transactions:20_000,text:4_000};
export class BankStatementValidationError extends Error {readonly code='bank_statement_validation';constructor(message:string){super(message);this.name='BankStatementValidationError';}}
function requireValue(value:unknown,message:string):asserts value {if(!value)throw new BankStatementValidationError(message);}
function object(value:unknown):Record<string,unknown>{requireValue(value!==null&&typeof value==='object'&&!Array.isArray(value),'Expected a bank statement object.');return value as Record<string,unknown>;}
function scalar(value:unknown):BankScalar {if(value===undefined||value===null)return null;requireValue(typeof value==='string'&&value.length<=limits.text,'Statement fields must be bounded strings or null; numeric values cannot establish exact money.');return value;}
function text(value:BankScalar){return value?.trim()||null;}
function onlyKeys(value:Record<string,unknown>,allowed:readonly string[]){requireValue(Object.keys(value).every(key=>allowed.includes(key)),'Unexpected bank statement fields or client-supplied evidence.');}
function freeze<T>(value:T):T {if(value&&typeof value==='object'){Object.freeze(value);for(const nested of Object.values(value))freeze(nested);}return value;}
function normalizedLocale(locale:string){try{return Intl.getCanonicalLocales(locale)[0]??'en';}catch{throw new BankStatementValidationError('Invalid statement locale.');}}
function issue(code:string,message:string,severity:'error'|'warning',accountId?:string,transactionId?:string,field?:string):BankIssue{return {code,message,severity,...(accountId?{accountId}:{}),...(transactionId?{transactionId}:{}),...(field?{field}:{})};}
function uniqueIssues(issues:BankIssue[]){const seen=new Set<string>();return issues.filter(item=>{const key=JSON.stringify(item);if(seen.has(key))return false;seen.add(key);return true;});}
function canonicalDecimal(integer:string,fraction='',negative=false){integer=integer.replace(/^0+(?=\d)/,'');fraction=fraction.replace(/0+$/,'');fraction=fraction.padEnd(2,'0');return `${negative&&(!/^0+$/.test(integer)||!/^0+$/.test(fraction))?'-':''}${integer}.${fraction}`;}
type Exact={units:bigint;scale:number};
function exact(value:BankScalar):Exact|null {if(value===null||!canonicalMoney.test(value))return null;const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');return {units:BigInt(whole+fraction)*(negative?-1n:1n),scale:fraction.length};}
function add(a:Exact,b:Exact):Exact{const scale=Math.max(a.scale,b.scale);return {units:a.units*10n**BigInt(scale-a.scale)+b.units*10n**BigInt(scale-b.scale),scale};}
function negate(a:Exact):Exact{return {units:-a.units,scale:a.scale};}
const zero:Exact={units:0n,scale:0};
function same(a:Exact,b:Exact){return add(a,negate(b)).units===0n;}
function decimal(a:Exact){const negative=a.units<0n,digits=(negative?-a.units:a.units).toString().padStart(a.scale+1,'0');return canonicalDecimal(a.scale?digits.slice(0,-a.scale):digits,a.scale?digits.slice(-a.scale):'',negative);}
function canonical(value:BankScalar){const result=exact(value);return result?decimal(result):null;}
type AmountRole='debit'|'credit'|'balance';
type ParsedAmount={value:BankScalar;error?:string;warning?:string};

/** Only locale-valid grouping is accepted. Canonical correction values take precedence over locale grouping. */
function parseAmount(raw:BankScalar,locale:string,currency:BankScalar,role:AmountRole,convention:BankBalanceConvention,correction:boolean,formats?:BankAccountFormats,movement=false):ParsedAmount{
  if(!text(raw)||absentAmount.test(raw!.trim().replace(/\s+/g,' ')))return {value:null};let value=raw!.trim(),negative=false,explicitSign=false;
  if(correction&&canonicalMoney.test(value)){const parsed=canonical(value)!;return {value:parsed,...(role!=='balance'&&parsed.startsWith('-')?{warning:'signed_column_amount'}:{})};}
  if(value.length>160)return {value:raw,error:'amount_invalid'};
  const directionMatch=value.match(/\s*(DR|CR)\.?$/i),direction=directionMatch?.[1].toUpperCase();if(directionMatch)value=value.slice(0,directionMatch.index).trim();
  if(value.startsWith('(')&&value.endsWith(')')){negative=true;explicitSign=true;value=value.slice(1,-1).trim();}
  if(/^[+−-]/.test(value)){if(explicitSign)return {value:raw,error:'amount_sign_ambiguous'};negative=/^[−-]/.test(value);explicitSign=true;value=value.slice(1).trim();}
  if(/[+−-]$/.test(value)){if(explicitSign)return {value:raw,error:'amount_sign_ambiguous'};negative=/[−-]$/.test(value);explicitSign=true;value=value.slice(0,-1).trim();}
  const codeMatch=value.match(/^([A-Za-z]{3})\s+|\s+([A-Za-z]{3})$/);
  if(codeMatch){const code=(codeMatch[1]??codeMatch[2]).toUpperCase();if(code!==currency)return {value:raw,error:'amount_currency_conflict'};value=value.replace(codeMatch[0],'').trim();}
  const symbol=value.match(/^[€£$¥]|[€£$¥]$/)?.[0];
  if(symbol){const compatible=currency&&(symbol==='€'?currency==='EUR':symbol==='£'?currency==='GBP':symbol==='¥'?['JPY','CNY'].includes(currency):['USD','CAD','AUD','NZD','SGD','HKD','MXN'].includes(currency));if(!compatible)return {value:raw,error:'amount_currency_ambiguous'};value=value.replace(symbol,'').trim();}
  if(direction){
    if(role!=='balance'&&direction!==(role==='debit'?'DR':'CR'))return {value:raw,error:'amount_direction_conflict'};
    if(role==='balance'){
      if(convention==='unknown')return {value:raw,error:'amount_direction_ambiguous'};
      const directionNegative=convention==='credit_increases'?direction==='DR':direction==='CR';
      if(explicitSign&&negative!==directionNegative)return {value:raw,error:'amount_sign_ambiguous'};
      negative=directionNegative;
    }
  }
  let decimalSeparator:string,groupSeparator:string|undefined;
  if(formats){
    if(formats.numberStatus==='unresolved')return {value:null,error:'amount_format_unresolved'};
    if(formats.numberStatus==='supported'){decimalSeparator=formats.decimalSeparator!;groupSeparator=formats.groupSeparator??undefined;}
    // Without a printed rule only integers and a single 1–2 digit fractional
    // separator are self-contained. Three-digit punctuation may be grouping.
    else if(/^\d{1,70}$/.test(value)){decimalSeparator='.';}
    else {const standalone=value.match(/^\d{1,70}([.,])\d{1,2}$/);if(!standalone)return {value:null,error:'amount_format_unresolved'};decimalSeparator=standalone[1];}
  }
  else {const parts=new Intl.NumberFormat(locale).formatToParts(12345.6);decimalSeparator=parts.find(p=>p.type==='decimal')?.value??'.';groupSeparator=parts.find(p=>p.type==='group')?.value;}

  if(groupSeparator&&/\s/u.test(groupSeparator))value=value.replace(/[\s\u00a0\u202f]/gu,groupSeparator);
  const pieces=value.split(decimalSeparator);if(pieces.length>2)return {value:raw,error:'amount_invalid'};
  let integer=pieces[0];const fraction=pieces[1]??'';
  if(pieces.length===2&&(!/^\d{1,8}$/.test(fraction)))return {value:raw,error:'amount_invalid'};
  if(groupSeparator&&integer.includes(groupSeparator)){
    const groups=integer.split(groupSeparator);if(!/^\d{1,3}$/.test(groups[0])||!groups.slice(1).every(g=>/^\d{3}$/.test(g)))return {value:raw,error:'amount_grouping_ambiguous'};
    integer=groups.join('');
  }
  if(!/^\d{1,70}$/.test(integer))return {value:raw,error:'amount_invalid'};
  let result=canonicalDecimal(integer,fraction,negative);
  if(movement&&formats&&!correction&&formats.movement!=='columns'){
    if(formats.movement==='unresolved')return {value:null,error:'movement_convention_unresolved'};
    const expectsNegative=formats.movement==='positive_credit'?role==='debit':role==='credit';
    if(exact(result)!.units!==0n&&negative!==expectsNegative)return {value:null,error:'movement_direction_conflict'};
    // Only a source-proven single signed movement layout has magnitudes in the
    // debit/credit exports. Separate signed columns retain genuine reversals.
    if(result.startsWith('-'))result=result.slice(1);
  }
  return {value:result,...(role!=='balance'&&result.startsWith('-')?{warning:'signed_column_amount'}:{})};
}
function isoDate(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const [year,month,day]=value.split('-').map(Number);if(year<1||month<1||month>12||day<1)return false;const leap=year%4===0&&(year%100!==0||year%400===0);return day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];}
const dateString=(y:number,m:number,d:number)=>`${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
function parseDate(raw:BankScalar,locale:string,formats?:BankAccountFormats):{value:BankScalar;error?:string}{
  const input=text(raw);if(!input)return {value:null};if(isoDate(input))return {value:input};
  if(formats?.dateStatus==='unresolved')return {value:null,error:'date_format_unresolved'};
  if(formats?.dateOrder==='ymd'){
    const match=input.match(/^(\d{4})([/.\-])(\d{1,2})\2(\d{1,2})$/);if(match){const result=dateString(Number(match[1]),Number(match[3]),Number(match[4]));return isoDate(result)?{value:result}:{value:raw,error:'date_invalid'};}
  }
  const numeric=input.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  if(numeric){const first=Number(numeric[1]),second=Number(numeric[2]),year=Number(numeric[3]);
    if(formats){
      const order=formats.dateOrder??(first>12&&second<=12?'dmy':second>12&&first<=12?'mdy':first===second?'dmy':null);
      if(!order||order==='ymd')return {value:null,error:'date_ambiguous'};
      const result=dateString(year,order==='mdy'?first:second,order==='mdy'?second:first);return isoDate(result)?{value:result}:{value:raw,error:'date_invalid'};
    }
    const region=new Intl.Locale(locale).region;if(!region&&first<=12&&second<=12&&first!==second)return {value:raw,error:'date_ambiguous'};
    const order=new Intl.DateTimeFormat(locale,{day:'numeric',month:'numeric',year:'numeric',timeZone:'UTC'}).formatToParts(new Date(Date.UTC(2001,10,23))).filter(p=>['day','month','year'].includes(p.type)).map(p=>p.type);
    const monthFirst=order.indexOf('month')<order.indexOf('day'),result=dateString(year,monthFirst?first:second,monthFirst?second:first);return isoDate(result)?{value:result}:{value:raw,error:'date_invalid'};
  }
  const normalized=input.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g,'$1').replace(/[.,]/g,' ').trim().replace(/\s+/g,' ');
  const named=normalized.match(/^(?:(\d{1,2}) ([^\d]+)|(\D+) (\d{1,2})) (\d{4})$/);
  if(named){const day=Number(named[1]??named[4]),name=(named[2]??named[3]).trim(),year=Number(named[5]);const months=new Map<string,number>();for(let month=1;month<=12;month++)for(const language of [locale,'en-US'])for(const style of ['long','short'] as const){const label=new Intl.DateTimeFormat(language,{month:style,timeZone:'UTC'}).format(new Date(Date.UTC(2001,month-1,1))).normalize('NFKD').replace(/\p{M}/gu,'').replace(/\./g,'').toLowerCase();months.set(label,month);}const month=months.get(name);if(month){const result=dateString(year,month,day);if(isoDate(result))return {value:result};}}
  return {value:raw,error:/\d/.test(input)?'date_ambiguous':'date_invalid'};
}
function normalizeCurrency(value:BankScalar){const result=text(value)?.toUpperCase()??null;return result;}
function normalizeConvention(value:BankScalar):BankBalanceConvention{
  const normalized=text(value)?.toLowerCase();if(normalized&&conventions.includes(normalized))return normalized as BankBalanceConvention;
  if(!normalized||/\b(?:not|never|may|might|could|unknown|unclear)\b/.test(normalized))return 'unknown';
  let credit=/\bcredits?\s+(?:increase[sd]?|raise[sd]?|adds? to)\s+(?:(?:the|your|account|statement|available|displayed)\s+)*(?:balance|amount owed)\b/.test(normalized);
  let debit=/\bdebits?\s+(?:increase[sd]?|raise[sd]?|adds? to)\s+(?:(?:the|your|account|statement|available|displayed)\s+)*(?:balance|amount owed)\b/.test(normalized);
  for(const match of normalized.matchAll(/\b(credits?|debits?)\s+(increase[sd]?|decrease[sd]?|reduce[sd]?)\s+and\s+(credits?|debits?)\s+(increase[sd]?|decrease[sd]?|reduce[sd]?)\s+(?:(?:the|your|account|statement|available|displayed)\s+)*(?:balance|amount owed)\b/g)){
    const firstIncreases=match[2].startsWith('increase'),secondIncreases=match[4].startsWith('increase');
    if(match[1][0]===match[3][0]||firstIncreases===secondIncreases)return 'unknown';
    const increasing=firstIncreases?match[1]:match[3];if(increasing.startsWith('credit'))credit=true;else debit=true;
  }
  // Standalone reductions constrain an established direction; they never establish its opposite.
  for(const match of normalized.matchAll(/\b(credits?|debits?)\s+(?:decrease[sd]?|reduce[sd]?)\s+(?:(?:the|your|account|statement|available|displayed)\s+)*(?:balance|amount owed)\b/g)){
    if(match[1].startsWith('credit')?credit:debit)return 'unknown';
  }
  return credit===debit?'unknown':credit?'credit_increases':'debit_increases';
}
function indexSources(evidence:Record<string,Evidence[]>):Map<string,BankSource>{
  const sources=new Map<string,BankSource>();
  for(const [key,rows] of Object.entries(evidence)){
    const normalized=key.replace(/\.(\d+)(?=\.|$)/g,'[$1]'),account=normalized.match(/^accounts\[\d+\](?=\.|$)/)?.[0],transaction=normalized.match(/^accounts\[\d+\]\.transactions\[\d+\](?=\.|$)/)?.[0];if(!account)continue;
    requireValue(Array.isArray(rows)&&rows.every(e=>e&&Number.isInteger(e.page)&&e.page>0&&typeof e.text==='string'),'Invalid source evidence.');const copied=structuredClone(rows);
    for(const rawPath of [account,...(transaction?[transaction]:[])]){let source=sources.get(rawPath);if(!source){source={rawPath,sourcePages:[],evidence:{}};sources.set(rawPath,source);}source.evidence[key]=copied;source.sourcePages.push(...copied.map(e=>e.page));}
  }
  for(const source of sources.values())source.sourcePages=[...new Set(source.sourcePages)].sort((a,b)=>a-b);
  return sources;
}
const sourceAt=(sources:Map<string,BankSource>,rawPath:string):BankSource=>sources.get(rawPath)??{rawPath,sourcePages:[],evidence:{}};
function normalizeValues(values:BankValues,locale:string,correction:boolean,context?:BankContext):{values:BankValues;issues:BankIssue[]}{
  const result=structuredClone(values),issues:BankIssue[]=[];
  for(const account of result.accounts){const formats=context?.accounts[account.id]?.formats;account.bank_name=text(account.bank_name);account.account_identifier=text(account.account_identifier);account.currency=normalizeCurrency(account.currency);
    for(const field of ['statement_start','statement_end'] as const){const parsed=parseDate(account[field],locale,formats);account[field]=parsed.value;if(parsed.error&&!account.excluded)issues.push(issue(parsed.error,'Use a complete, unambiguous calendar date.','error',account.id,undefined,field));}
    for(const field of accountMoney){const role=field==='total_debits'?'debit':field==='total_credits'?'credit':'balance',parsed=parseAmount(account[field],locale,account.currency,role,account.balance_convention,correction,formats);account[field]=parsed.value;if(!account.excluded&&parsed.error)issues.push(issue(parsed.error,'The amount cannot be interpreted safely; enter an exact decimal amount and check its sign and currency.','error',account.id,undefined,field));if(!account.excluded&&parsed.warning)issues.push(issue(parsed.warning,'A signed debit or credit may be a reversal. Verify the source before accepting it.','warning',account.id,undefined,field));}
    for(const row of account.transactions){row.description=text(row.description);row.reference=text(row.reference);row.currency=normalizeCurrency(row.currency)??account.currency;const parsedDate=parseDate(row.date,locale,formats);row.date=parsedDate.value;if(parsedDate.error&&!account.excluded&&!row.excluded)issues.push(issue(parsedDate.error,'Use a complete, unambiguous transaction date.','error',account.id,row.id,'date'));
      for(const field of ['debit','credit','balance'] as const){const parsed=parseAmount(row[field],locale,row.currency,field,account.balance_convention,correction,formats,field!=='balance');row[field]=parsed.value;if(!account.excluded&&!row.excluded&&parsed.error)issues.push(issue(parsed.error,'The amount cannot be interpreted safely; enter an exact decimal amount and check its sign and currency.','error',account.id,row.id,field));if(!account.excluded&&!row.excluded&&parsed.warning)issues.push(issue(parsed.warning,'A signed debit or credit may be a reversal. Verify the source before accepting it.','warning',account.id,row.id,field));}
    }
  }
  return {values:result,issues};
}

export function createBankStatementResult(rawValues:unknown,evidence:Record<string,Evidence[]>,locale:string,options:{id?:()=>string;sourceFormats?:boolean}={}):{values:BankValues;context:BankContext;issues:BankIssue[]}{
  locale=normalizedLocale(locale);const raw=object(rawValues);requireValue(Array.isArray(raw.accounts)&&raw.accounts.length<=limits.accounts,'Statements must contain an accounts array of at most 100 accounts.');object(evidence);
  const context:BankContext={version:1,locale,accounts:{},transactions:{}},sources=indexSources(evidence),ids=new Set<string>(),newId=()=>{const id=(options.id??randomUUID)().toLowerCase();requireValue(uuidPattern.test(id)&&!ids.has(id),'Generated bank identity must be a unique UUID.');ids.add(id);return id;};let count=0;
  const accounts=raw.accounts.map((candidate,index)=>{const row=object(candidate);requireValue(Array.isArray(row.transactions),'Each statement account must have a transactions array.');count+=row.transactions.length;requireValue(count<=limits.transactions,'Statement transaction limit exceeded.');const id=newId(),rawPath=`accounts[${index}]`;context.accounts[id]=sourceAt(sources,rawPath);if(options.sourceFormats){for(const field of ['date_format','number_format','transaction_layout','movement_convention'])scalar(row[field]);context.accounts[id].formats=resolveBankSourceFormats(row,context.accounts[id]);}
    const fields=Object.fromEntries(accountFields.map(field=>[field,scalar(row[field])]));const convention=normalizeConvention(fields.balance_convention);
    const transactions=row.transactions.map((candidate,position)=>{const item=object(candidate),rowId=newId();context.transactions[rowId]={...sourceAt(sources,`${rawPath}.transactions[${position}]`),accountId:id};return {...Object.fromEntries(rowFields.map(field=>[field,scalar(item[field])])),id:rowId,origin:'extracted',excluded:false,exclusion_reason:null} as BankTransaction;});
    return {...fields,balance_convention:convention,id,origin:'extracted',excluded:false,exclusion_reason:null,transactions} as BankAccount;
  });
  const normalized=normalizeValues({version:1,accounts},locale,false,context);return {values:normalized.values,context:freeze(context),issues:uniqueIssues([...normalized.issues,...checkBankStatement(normalized.values,context)])};
}
function identity(value:Record<string,unknown>,all:Set<string>){requireValue(typeof value.id==='string'&&uuidPattern.test(value.id),'Every account and transaction needs a UUID.');const id=value.id.toLowerCase();requireValue(!all.has(id),'Account and transaction UUIDs must be globally unique.');all.add(id);requireValue(['extracted','user'].includes(String(value.origin))&&typeof value.excluded==='boolean','Invalid row origin or exclusion state.');const reason=scalar(value.exclusion_reason);requireValue(!value.excluded||Boolean(text(reason)),'Excluded accounts and transactions require a reason.');return {id,origin:value.origin as 'extracted'|'user',excluded:value.excluded,exclusion_reason:text(reason)};}
function parseValues(input:unknown):BankValues{
  const raw=object(input);onlyKeys(raw,['version','accounts']);requireValue(raw.version===1&&Array.isArray(raw.accounts)&&raw.accounts.length<=limits.accounts,'Invalid bank statement version or accounts.');const all=new Set<string>();let count=0;
  const accounts=raw.accounts.map(candidate=>{const account=object(candidate);onlyKeys(account,[...accountFields,...identityFields,'transactions']);const accountIdentity=identity(account,all);requireValue(conventions.includes(String(account.balance_convention))&&Array.isArray(account.transactions),'Invalid balance convention or transactions.');count+=account.transactions.length;requireValue(count<=limits.transactions,'Statement transaction limit exceeded.');const fields=Object.fromEntries(accountFields.map(field=>[field,scalar(account[field])]));const transactions=account.transactions.map(candidate=>{const row=object(candidate);onlyKeys(row,[...rowFields,...identityFields]);return {...Object.fromEntries(rowFields.map(field=>[field,scalar(row[field])])),...identity(row,all)} as BankTransaction;});return {...fields,...accountIdentity,balance_convention:account.balance_convention,transactions} as BankAccount;});return {version:1,accounts};
}
function validateContext(context:BankContext){requireValue(context?.version===1&&typeof context.locale==='string','Invalid server statement context.');object(context.accounts);object(context.transactions);const all=new Set<string>();for(const [id,source] of Object.entries(context.accounts)){requireValue(uuidPattern.test(id)&&!all.has(id)&&/^accounts\[\d+\]$/.test(source.rawPath),'Invalid original account provenance.');requireValue(source.formats===undefined||validBankSourceFormats(source.formats),'Invalid original account format policy.');all.add(id);}for(const [id,source] of Object.entries(context.transactions)){requireValue(uuidPattern.test(id)&&!all.has(id)&&Object.hasOwn(context.accounts,source.accountId)&&source.rawPath.startsWith(context.accounts[source.accountId].rawPath+'.transactions['),'Invalid original transaction provenance.');all.add(id);}}
function bindIdentities(values:BankValues,context:BankContext,previous?:BankValues){
  validateContext(context);const accounts=new Map(values.accounts.map(a=>[a.id,a])),rows=new Map(values.accounts.flatMap(a=>a.transactions.map(r=>[r.id,{accountId:a.id,row:r}] as const)));
  for(const id of Object.keys(context.accounts)){const account=accounts.get(id);requireValue(account?.origin==='extracted','Original accounts must retain their identities; exclude instead of deleting.');}
  for(const [id,source] of Object.entries(context.transactions)){const item=rows.get(id);requireValue(item?.row.origin==='extracted'&&item.accountId===source.accountId,'Original transactions must stay with their account; exclude instead of deleting or moving.');}
  for(const account of values.accounts){requireValue(account.origin!=='extracted'||Object.hasOwn(context.accounts,account.id),'Forged extracted account identity.');requireValue(account.origin!=='user'||!Object.hasOwn(context.accounts,account.id)&&!Object.hasOwn(context.transactions,account.id),'An original identity cannot be relabelled as user added.');for(const row of account.transactions){requireValue(row.origin!=='extracted'||Object.hasOwn(context.transactions,row.id),'Forged extracted transaction identity.');requireValue(row.origin!=='user'||!Object.hasOwn(context.accounts,row.id)&&!Object.hasOwn(context.transactions,row.id),'An original identity cannot be relabelled as user added.');}}
  if(previous)for(const account of previous.accounts){const current=accounts.get(account.id);requireValue(current&&current.origin===account.origin,'Previously saved account identities must be retained; exclude instead of deleting.');for(const row of account.transactions){const currentRow=rows.get(row.id);requireValue(currentRow?.accountId===account.id&&currentRow.row.origin===row.origin,'Previously saved transaction identities must be retained; exclude instead of deleting or moving.');}}
}
export function normalizeBankStatementCorrections(input:unknown,context:BankContext,previousValues:BankValues):{values:BankValues;issues:BankIssue[]}{
  const values=parseValues(input),previous=parseValues(previousValues);bindIdentities(previous,context);bindIdentities(values,context,previous);const normalized=normalizeValues(values,normalizedLocale(context.locale),true,context);return {values:normalized.values,issues:uniqueIssues([...normalized.issues,...checkBankStatement(normalized.values,context)])};
}

function accountIdentity(account:BankAccount):{bank:string;identifier:string}|null{
  const bank=text(account.bank_name)?.normalize('NFKC').toLowerCase().replace(/\s+/g,' '),raw=text(account.account_identifier)?.normalize('NFKC');
  if(!bank||/^(unknown|n\/?a|not (?:provided|stated|known))$/.test(bank)||!raw||/[*•…]|\.{2}|(?:x{2,})|\b(?:ending|last|masked|unknown|n\/a)\b/i.test(raw))return null;
  const identifier=raw.replace(/[\s.\-]/g,'').toUpperCase();if(!/^[A-Z0-9]{6,64}$/.test(identifier))return null;return {bank,identifier};
}
export function bankAccountKey(account:BankAccount):string|null{if(account.excluded)return null;const binding=accountIdentity(account);return binding?createHash('sha256').update(JSON.stringify([binding.bank,binding.identifier])).digest('hex'):null;}
function rowAmounts(row:BankTransaction):{debit:Exact;credit:Exact}|null {const debit=row.debit===null?zero:exact(row.debit),credit=row.credit===null?zero:exact(row.credit);return debit&&credit&&!(row.debit===null&&row.credit===null)&&!(debit.units!==0n&&credit.units!==0n)?{debit,credit}:null;}
function rowResolved(account:BankAccount,row:BankTransaction){return !account.excluded&&!row.excluded&&Boolean(account.currency&&currencies.has(account.currency)&&row.currency===account.currency&&row.date&&isoDate(row.date)&&rowAmounts(row)&&(row.balance===null||exact(row.balance)));}
export function bankTransactionFingerprint(account:BankAccount,row:BankTransaction):string|null{
  const accountKey=bankAccountKey(account);if(!accountKey||!rowResolved(account,row))return null;const description=text(row.description)?.normalize('NFKC').toLowerCase().replace(/\s+/g,' ')??'',reference=text(row.reference)?.normalize('NFKC').toLowerCase().replace(/\s+/g,' ')??'';if(!description&&!reference)return null;
  return createHash('sha256').update(JSON.stringify([accountKey,account.currency,row.date,canonical(row.debit??'0'),canonical(row.credit??'0'),reference,description])).digest('hex');
}

export function checkBankStatement(input:BankValues,context:BankContext):BankIssue[]{
  const values=parseValues(input);bindIdentities(values,context);const issues:BankIssue[]=[];
  if(!values.accounts.some(a=>!a.excluded))issues.push(issue('no_active_accounts','Keep at least one account in the statement.','error',undefined,undefined,'accounts'));
  for(const account of values.accounts){if(account.excluded)continue;const accountIssue=(code:string,message:string,severity:'error'|'warning',field?:string)=>issues.push(issue(code,message,severity,account.id,undefined,field));
    const formats=context.accounts[account.id]?.formats;
    if(formats?.dateStatus==='unresolved')accountIssue('date_format_unresolved','The printed date rule is unsupported, conflicting or lacks its own source quote. Enter complete ISO dates and review the original.','warning');
    if(formats?.numberStatus==='unresolved')accountIssue('amount_format_unresolved','The printed number rule is unsupported, conflicting or lacks its own source quote. Enter exact decimal amounts and review the original.','warning');
    if(formats?.movement==='unresolved')accountIssue('movement_convention_unresolved','A single signed movement rule or its column header could not be verified. Review the source and enter debit/credit magnitudes explicitly.','warning');
    if(!text(account.bank_name))accountIssue('bank_name_missing','The bank name is missing; cross-file account matching is unavailable.','warning','bank_name');
    if(!text(account.account_identifier))accountIssue('account_identifier_missing','The account identifier is missing; keep this account separate and verify it manually.','warning','account_identifier');
    else if(!accountIdentity(account))accountIssue('account_identity_unresolved','A full, unambiguous bank and account identifier is needed for cross-file matching; masked identifiers are not merged.','warning','account_identifier');
    if(!account.currency||!currencies.has(account.currency))accountIssue('currency_unresolved','Specify an unambiguous three-letter currency code for this account.','error','currency');
    for(const field of ['statement_start','statement_end'] as const){if(!account[field])accountIssue('statement_period_missing','A statement boundary is missing; date-range and overlap checks are incomplete.','warning',field);else if(!isoDate(account[field]!))accountIssue('date_invalid','Use a valid complete statement date.','error',field);}
    const periodValid=Boolean(account.statement_start&&account.statement_end&&isoDate(account.statement_start)&&isoDate(account.statement_end));if(periodValid&&account.statement_start!>account.statement_end!)accountIssue('statement_period_reversed','The statement end is before its start.','error','statement_end');
    if(account.balance_convention==='unknown')accountIssue('balance_convention_unknown','Confirm whether credits or debits increase the balance; balance reconciliation is unavailable until then.','warning','balance_convention');
    for(const field of accountMoney){if(account[field]===null)accountIssue(field==='opening_balance'||field==='closing_balance'?'statement_balance_missing':'statement_total_missing','A stated balance or total is missing; the corresponding reconciliation cannot be checked.','warning',field);else if(!exact(account[field]))accountIssue('amount_invalid','Enter an exact decimal amount; this field remains unresolved.','error',field);if((field==='total_debits'||field==='total_credits')&&(exact(account[field])?.units??0n)<0n)accountIssue('signed_column_amount','A signed debit or credit may be a reversal. Verify the source before accepting it.','warning',field);}
    const rows=account.transactions.filter(r=>!r.excluded);if(!rows.length)accountIssue('no_transactions','No active transactions were captured. Verify that this is a statement with no activity.','warning','transactions');
    let sumDebit=zero,sumCredit=zero,canTotal=true,running=exact(account.opening_balance),lastProvided:Exact|null=null,missingRunning=false;
    for(const row of rows){const rowIssue=(code:string,message:string,severity:'error'|'warning',field?:string)=>issues.push(issue(code,message,severity,account.id,row.id,field));
      if(!row.date||!isoDate(row.date))rowIssue('transaction_date_unresolved','A complete valid transaction date is required.','error','date');
      else if(periodValid&&account.statement_start!<=account.statement_end!&&(row.date<account.statement_start!||row.date>account.statement_end!))rowIssue('transaction_outside_period','The transaction date is outside this statement period; verify posting and value dates.','warning','date');
      if(!text(row.description)&&!text(row.reference))rowIssue('transaction_description_missing','Add or verify a description or reference for this transaction.','warning','description');
      if(!row.currency||!currencies.has(row.currency))rowIssue('currency_unresolved','Specify the transaction currency.','error','currency');else if(row.currency!==account.currency)rowIssue('currency_conflict','This transaction currency differs from its account; keep currencies in separate accounts.','error','currency');
      for(const field of ['debit','credit','balance'] as const){if(row[field]!==null&&!exact(row[field]))rowIssue('amount_invalid','Enter an exact decimal amount; this value remains unresolved.','error',field);if(field!=='balance'&&exact(row[field])?.units!<0n)rowIssue('signed_column_amount','A signed debit or credit may be a reversal. Verify the source before accepting it.','warning',field);}
      const amounts=rowAmounts(row);if(row.debit===null&&row.credit===null)rowIssue('transaction_amount_missing','Enter a debit or credit from the source; the direction must be explicit.','error','debit');
      else if(exact(row.debit)?.units!==undefined&&exact(row.credit)?.units!==undefined&&exact(row.debit)!.units!==0n&&exact(row.credit)!.units!==0n)rowIssue('transaction_direction_ambiguous','Both debit and credit are non-zero. Resolve the transaction direction from the source.','error','debit');
      if(amounts&&amounts.debit.units===0n&&amounts.credit.units===0n)rowIssue('zero_value_transaction','This is a zero-value transaction. Verify that it belongs in the statement.','warning','debit');
      const sameCurrency=Boolean(account.currency&&currencies.has(account.currency)&&row.currency===account.currency);
      if(!amounts||!sameCurrency){canTotal=false;running=null;}else{sumDebit=add(sumDebit,amounts.debit);sumCredit=add(sumCredit,amounts.credit);if(running&&account.balance_convention!=='unknown'){const delta=add(amounts.credit,negate(amounts.debit));running=add(running,account.balance_convention==='credit_increases'?delta:negate(delta));}}
      const balance=exact(row.balance);if(row.balance===null)missingRunning=true;
      if(balance&&sameCurrency){if(running&&account.balance_convention!=='unknown'&&!same(balance,running))rowIssue('running_balance_mismatch',`The running balance differs from the expected ${decimal(running)}. Check source order, amounts and missing transactions.`,'error','balance');running=balance;lastProvided=balance;}else if(row.balance!==null){running=null;lastProvided=null;}else lastProvided=null;
      if(row.origin==='extracted'&&!context.transactions[row.id]?.sourcePages.length)rowIssue('source_evidence_missing','No page-specific evidence was captured for this transaction; check the original statement.','warning');
    }
    if(missingRunning)accountIssue('running_balances_incomplete','Some transaction balances are absent; running-balance checks cover only the available anchors.','warning','transactions');
    if(canTotal){for(const [field,sum] of [['total_debits',sumDebit],['total_credits',sumCredit]] as const){const stated=exact(account[field]);if(stated&&!same(stated,sum))accountIssue('statement_total_mismatch',`The stated total differs from the transaction sum ${decimal(sum)}.`,'error',field);}
      const opening=exact(account.opening_balance),closing=exact(account.closing_balance);if(opening&&closing&&account.balance_convention!=='unknown'){const delta=add(sumCredit,negate(sumDebit)),expected=add(opening,account.balance_convention==='credit_increases'?delta:negate(delta));if(!same(expected,closing))accountIssue('closing_balance_mismatch',`Opening balance and transactions imply ${decimal(expected)}, which differs from the closing balance.`,'error','closing_balance');}
    }
    const closing=exact(account.closing_balance);if(lastProvided&&closing&&!same(lastProvided,closing))accountIssue('closing_running_balance_mismatch','The final transaction balance differs from the stated closing balance.','error','closing_balance');
    accountIssue('source_review_required','Matching balances do not prove every transaction is correct or complete. Review the original statement before approval.','warning');
  }
  return uniqueIssues(issues);
}

export function compareBankStatements(current:BankValues,others:BankStatementRecord[]):BankIssue[]{
  const issues:BankIssue[]=[];for(const account of current.accounts){if(account.excluded)continue;const key=bankAccountKey(account);if(!key||!account.currency||!currencies.has(account.currency)){issues.push(issue('cross_file_identity_unresolved','Cross-file duplicate and overlap checks require a full account identity and currency. Accounts remain separate.','warning',account.id));continue;}
    const start=account.statement_start,end=account.statement_end,validPeriod=Boolean(start&&end&&isoDate(start)&&isoDate(end)&&start<=end);if(!validPeriod)issues.push(issue('cross_file_period_unresolved','Cross-file overlap checking is incomplete because this statement period is unresolved.','warning',account.id));
    const fingerprints=new Map<string,string[]>();for(const row of account.transactions){const fingerprint=bankTransactionFingerprint(account,row);if(fingerprint)fingerprints.set(row.id,[fingerprint]);}
    for(const record of others){const matched=record.values.accounts.filter(a=>!a.excluded&&bankAccountKey(a)===key&&a.currency===account.currency);if(!matched.length)continue;
      for(const other of matched){const otherStart=other.statement_start,otherEnd=other.statement_end,otherPeriod=Boolean(otherStart&&otherEnd&&isoDate(otherStart)&&isoDate(otherEnd)&&otherStart<=otherEnd);
        if(validPeriod&&otherPeriod&&start!<=otherEnd!&&otherStart!<=end!)issues.push({...issue('statement_period_overlap','Another statement for the same account and currency covers an overlapping period. This can be legitimate; review both files.','warning',account.id),relatedDocumentIds:[record.documentId]});
        else if(!otherPeriod)issues.push({...issue('related_statement_period_unresolved','A related account statement has an unresolved period, so overlap cannot be ruled out.','warning',account.id),relatedDocumentIds:[record.documentId]});
        const otherFingerprints=new Set(other.transactions.map(row=>bankTransactionFingerprint(other,row)).filter((v):v is string=>v!==null));for(const [rowId,[fingerprint]] of fingerprints)if(otherFingerprints.has(fingerprint))issues.push({...issue('possible_duplicate_transaction','A matching transaction appears in another file. Repeated payments can be legitimate; verify both sources before excluding anything.','warning',account.id,rowId),relatedDocumentIds:[record.documentId]});
      }
    }
  }
  return uniqueIssues(issues);
}
export function bankStatementRows(records:BankStatementRecord[]):BankStatementExportRow[]{return records.flatMap(record=>record.values.accounts.filter(account=>!account.excluded).flatMap(account=>account.transactions.filter(row=>!row.excluded).map(row=>({document_id:record.documentId,filename:record.filename,account_id:account.id,bank_name:account.bank_name,account_identifier:account.account_identifier,currency:row.currency,statement_start:account.statement_start,statement_end:account.statement_end,transaction_id:row.id,date:row.date,description:row.description,reference:row.reference,debit:row.debit,credit:row.credit,balance:row.balance,origin:row.origin}))));}
