import type {BankAccountFormats,BankSource,BankScalar} from '../../shared/bank-statements.js';

export const bankFormatFields=['date_format','number_format','transaction_layout','movement_convention'] as const;
const scalar=(value:unknown):BankScalar=>typeof value==='string'&&value.length<=4000?value:null;
const collapse=(value:string)=>value.replace(/\s+/g,' ').trim();
const clean=(value:string)=>collapse(value).toLowerCase().replace(/[.!]$/,'');
/** A rule belongs to its own account/field and must be covered by that field's
 * literal quote. Image quotations remain model evidence and require review. */
function evidenced(raw:Record<string,unknown>,source:BankSource,field:typeof bankFormatFields[number]):string|null {
 const value=scalar(raw[field]);if(!value?.trim())return null;
 const aliases=[`${source.rawPath}.${field}`,`${source.rawPath.replace(/\[(\d+)\]/g,'.$1')}.${field}`];
 const lists=aliases.filter((key,index)=>aliases.indexOf(key)===index).map(key=>source.evidence[key]).filter(entries=>entries!==undefined);
 if(!lists.length||lists.some(entries=>!Array.isArray(entries)))return null;
 const entries=lists.flat();
 if(entries.length>20||!entries.length||!entries.every(item=>item&&Number.isInteger(item.page)&&item.page>=1&&item.page<=30&&typeof item.text==='string'&&item.text.length<=2000&&['matched-text','matched-region','model-visual'].includes(item.source??''))||!entries.some(item=>collapse(item.text).includes(collapse(value))))return null;
 const signature=(input:string):string|null=>{
  if(field==='date_format')return dateOrder(input);
  if(field==='number_format'){const rule=numberFormat(input);return rule?JSON.stringify(rule):null;}
  if(field==='transaction_layout')return /^(?:signed amount|signed movement|signed transaction amount)$/.test(input)?'signed':null;
  const rule=movementRule(input);return rule!=='unresolved'?rule:markerLegend(input)||markerClause(input)?'marker_legend':null;
 };
 const selected=signature(clean(value));if(!selected)return null;
 if(selected==='marker_legend'&&entries.some(item=>!source.sourcePages.includes(item.page)))return null;
 // Every retained own-field quote must consist of supported, unconditional
 // literal rules. A cropped scalar cannot discard a qualification, opposing
 // alias or a different grouping example in the same source quotation.
 for(const entry of entries){
  const sentences=clean(entry.text).split(/(?<=[a-z0-9])[.!](?=\s|$)/i).map(clean).filter(Boolean);
  if(!sentences.length)return null;
  for(const sentence of sentences){
   const quoted=signature(sentence);
   if(quoted!==null){if(quoted!==selected)return null;}
   else if(!(field==='date_format'&&numberFormat(sentence)||field==='number_format'&&dateOrder(sentence)))return null;
  }
 }
 return clean(value);
}
/** These exact quoted metadata forms declare no date order or separators.
 * Treat them as no printed format rule, never as a supported format. Every
 * own-field alias must contain only the same complete metadata quotation. */
function nonFormatMetadata(raw:Record<string,unknown>,source:BankSource,field:'date_format'|'number_format'):boolean {
 const value=scalar(raw[field]);if(!value?.trim())return false;
 if(field==='date_format'){
  const start=scalar(raw.statement_start),end=scalar(raw.statement_end);
  const dateLiteral=/^(?:\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2} [\p{L}.]+ \d{4}|[\p{L}.]+ \d{1,2},? \d{4})$/u;
  if(!start||!end||!dateLiteral.test(collapse(start))||!dateLiteral.test(collapse(end))||clean(value)!==clean(`Statement period: ${start} to ${end}`))return false;
 }else{
  const match=clean(value).match(/^all amounts are ([a-z]{3})$/),currency=scalar(raw.currency)?.trim().toLowerCase();
  if(!match||match[1]!==currency)return false;
 }
 const aliases=[`${source.rawPath}.${field}`,`${source.rawPath.replace(/\[(\d+)\]/g,'.$1')}.${field}`];
 const lists=aliases.filter((key,i)=>aliases.indexOf(key)===i).map(key=>source.evidence[key]).filter(entries=>entries!==undefined);
 if(!lists.length||lists.some(entries=>!Array.isArray(entries)))return false;
 const entries=lists.flat();
 return entries.length>0&&entries.length<=20&&entries.every(item=>item&&Number.isInteger(item.page)&&item.page>=1&&item.page<=30&&source.sourcePages.includes(item.page)&&typeof item.text==='string'&&item.text.length<=2000&&['matched-text','matched-region','model-visual'].includes(item.source??'')&&collapse(item.text)===collapse(value));
}
const provided=(raw:Record<string,unknown>,field:typeof bankFormatFields[number])=>Boolean(scalar(raw[field])?.trim());
function dateOrder(value:string|null):BankAccountFormats['dateOrder'] {
 if(!value)return null;
 const match=value.match(/^(?:(?:dates? (?:use|uses|format(?: is)?))|date format:)\s*(dd([./-])mm\2yyyy|mm([./-])dd\3yyyy|yyyy([./-])mm\4dd)$/);
 return match?match[2]?'dmy':match[3]?'mdy':'ymd':null;
}
function numberFormat(value:string|null):Pick<BankAccountFormats,'decimalSeparator'|'groupSeparator'>|null {
 if(!value)return null;
 const word={'point':'.','dot':'.','full stop':'.','comma':',','space':' '} as const;
 const simple=value.match(/^(?:amounts?|numbers?) (?:use|uses) (?:a |the )?decimal (point|dot|comma)$/);
 if(simple)return {decimalSeparator:word[simple[1] as 'point'|'dot'|'comma'],groupSeparator:null};
 const combined=value.match(/^(?:(?:amounts?|numbers?) (?:use|uses) (?:a )?|a )decimal (point|dot|comma) and (?:a |the )?(point|dot|full stop|comma|space) for thousands(?: are used)?$/);
 const declared=value.match(/^decimal separator:\s*(point|dot|full stop|comma|[.,]);\s*(?:thousands|grouping) separator:\s*(point|dot|full stop|comma|space|[.,])$/);
 const example=value.match(/^(?:amount|number) format(?: example)?:\s*(1,234\.56|1\.234,56|1 234,56|1 234\.56)$/);
 if(example){const literal=example[1];return {decimalSeparator:literal.endsWith(',56')?',':'.',groupSeparator:literal[1] as ','|'.'|' '};}
 if(!combined&&!declared)return null;
 const token=(input:string)=>input==='.'||input===','?input:word[input as keyof typeof word];
 const decimal=token((combined??declared)![1]),group=token((combined??declared)![2]);
 return decimal!==' '&&decimal!==group?{decimalSeparator:decimal,groupSeparator:group}:null;
}
function movementRule(value:string|null):BankAccountFormats['movement'] {
 if(!value)return 'unresolved';
 const match=value.match(/^positive (?:signed )?amounts are (credits|debits); (?:negative amounts|parentheses or minus signs|minus signs or parentheses) are (debits|credits)$/);
 if(!match||match[1]===match[2])return 'unresolved';
 return match[1]==='credits'?'positive_credit':'positive_debit';
}
function markerClause(value:string):'DR'|'CR'|null {
 if(/^dr (?:marks|means|indicates|denotes) (?:a )?debit(?: or balance owed)?$/.test(value))return 'DR';
 return /^cr (?:marks|means|indicates|denotes) (?:a )?(?:payment )?credit$/.test(value)?'CR':null;
}
function markerLegend(value:string|null):boolean {
 if(!value)return false;
 const clauses=value.split(/[.;]/).map(clean).filter(Boolean),markers=clauses.map(markerClause);
 return clauses.length===2&&markers.includes('DR')&&markers.includes('CR');
}
/** A suffix legend establishes literal debit/credit roles, never a source
 * column layout or signed polarity. Every present movement needs its own
 * complete, matching amount quote; existing parsing retains explicit signs. */
function taggedMovements(raw:Record<string,unknown>,source:BankSource):boolean {
 if(!Array.isArray(raw.transactions)||raw.transactions.length>20_000)return false;
 let present=false;
 for(const [index,row]of raw.transactions.entries()){
  if(!row||typeof row!=='object'||Array.isArray(row))return false;
  for(const role of ['debit','credit']as const){
   const value=row[role];if(value===null||value===undefined||typeof value==='string'&&!value.trim())continue;
   if(typeof value!=='string'||value.length>160||value.match(/\s+(DR|CR)\.?$/i)?.[1].toUpperCase()!==(role==='debit'?'DR':'CR'))return false;
   present=true;
   const path=`${source.rawPath}.transactions[${index}].${role}`,aliases=[path,path.replace(/\[(\d+)\]/g,'.$1')];
   const lists=aliases.filter((key,i)=>aliases.indexOf(key)===i).map(key=>source.evidence[key]).filter(entries=>entries!==undefined);
   if(!lists.length||lists.some(entries=>!Array.isArray(entries)))return false;
   const entries=lists.flat();
   if(!entries.length||entries.length>20||!entries.every(item=>item&&Number.isInteger(item.page)&&item.page>=1&&item.page<=30&&source.sourcePages.includes(item.page)&&typeof item.text==='string'&&item.text.length<=2000&&collapse(item.text)===collapse(value)&&['matched-text','matched-region','model-visual'].includes(item.source??'')))return false;
  }
 }
 return present;
}
export function resolveBankSourceFormats(raw:Record<string,unknown>,source:BankSource):BankAccountFormats {
 const date=dateOrder(evidenced(raw,source,'date_format')),number=numberFormat(evidenced(raw,source,'number_format'));
 const hasMovement=provided(raw,'transaction_layout')||provided(raw,'movement_convention');
 const layout=evidenced(raw,source,'transaction_layout'),signed=layout!==null&&/^(?:signed amount|signed movement|signed transaction amount)$/.test(layout),movement=evidenced(raw,source,'movement_convention');
 const tagged=!provided(raw,'transaction_layout')&&markerLegend(movement)&&taggedMovements(raw,source);
 return {version:1,dateStatus:date?'supported':provided(raw,'date_format')&&!nonFormatMetadata(raw,source,'date_format')?'unresolved':'missing',dateOrder:date,
  numberStatus:number?'supported':provided(raw,'number_format')&&!nonFormatMetadata(raw,source,'number_format')?'unresolved':'missing',decimalSeparator:number?.decimalSeparator??null,groupSeparator:number?.groupSeparator??null,
  movement:hasMovement?signed?movementRule(movement):tagged?'columns':'unresolved':'columns'};
}
export function validBankSourceFormats(value:unknown):value is BankAccountFormats {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as BankAccountFormats;
 if(Object.keys(v).sort().join(',')!=='dateOrder,dateStatus,decimalSeparator,groupSeparator,movement,numberStatus,version'||v.version!==1||!['missing','supported','unresolved'].includes(v.dateStatus)||!['missing','supported','unresolved'].includes(v.numberStatus)||!['columns','positive_credit','positive_debit','unresolved'].includes(v.movement))return false;
 return (v.dateStatus==='supported'?['dmy','mdy','ymd'].includes(v.dateOrder??''):v.dateOrder===null)&&(v.numberStatus==='supported'?['.',','].includes(v.decimalSeparator??'')&&[null,'.',',',' '].includes(v.groupSeparator)&&v.groupSeparator!==v.decimalSeparator:v.decimalSeparator===null&&v.groupSeparator===null);
}
