import type {BankContext,BankIssue,BankValues} from '../../shared/bank-statements.js';
import type {ValidationIssue} from '../../shared/types.js';

const limits={accounts:100,transactions:20_000,description:4000,quotes:20,quoteText:2000,textWork:1024*1024,issues:150_000};
const messages={
 evidence_missing:'No source quote was retained for this originally extracted value. Check the original statement.',
 value_source_mismatch:'The originally extracted value did not match its cited source page. Check the original statement.',
 evidence_incomplete:'The retained quotes do not cover the full originally extracted description. Check its continuation lines in the original statement.',
 visual_evidence:'Some retained quotes were read by AI from an image and are not independently verified against native text. Check the original statement.',
} as const;
type EvidenceCode=keyof typeof messages;
const incomplete='Some original extraction evidence could not be checked completely. Review the original statement.';
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const own=(value:unknown,key:string):unknown=>object(value)&&Object.hasOwn(value,key)?value[key]:undefined;
const collapsed=(value:string)=>value.replace(/\s+/g,' ').trim();
const globalIncomplete=():ValidationIssue=>({field:'_source',code:'evidence_incomplete',message:incomplete});
const dotPath=(field:string)=>field.replace(/\[(\d+)\]/g,'.$1');
function quoteEntries(evidence:unknown,field:string):unknown{
 const canonical=own(evidence,field);return canonical===undefined?own(evidence,dotPath(field)):canonical;
}
function quote(value:unknown):value is {page:number;text:string;source?:string}{
 return object(value)&&typeof value.text==='string'&&value.text.length<=limits.quoteText&&Number.isInteger(value.page)&&Number(value.page)>=1&&Number(value.page)<=30&&(value.source===undefined||typeof value.source==='string'&&['matched-text','model-visual','matched-region'].includes(value.source));
}

/** Literal coverage only: a complete quote does not establish column direction
 * or native verification. Preserve quote provenance, content and order unchanged.
 * Ordered fragments may cover a description; rearranging words never can. */
export function bankDescriptionEvidenceIssues(rawValues:unknown,evidence:unknown,includedDescriptions?:ReadonlySet<string>):ValidationIssue[]{
 const accounts=own(rawValues,'accounts');
 if(!Array.isArray(accounts)||accounts.length>limits.accounts||!object(evidence))return [globalIncomplete()];
 const issues:ValidationIssue[]=[];let rows=0,textWork=0;
 for(const [accountIndex,account] of accounts.entries()){
  const transactions=own(account,'transactions');
  if(!Array.isArray(transactions)||(rows+=transactions.length)>limits.transactions)return [...issues,globalIncomplete()];
  for(const [rowIndex,row] of transactions.entries()){
   const field=`accounts[${accountIndex}].transactions[${rowIndex}].description`;
   if(includedDescriptions&&!includedDescriptions.has(field))continue;
   const raw=own(row,'description');
   if(raw===null||raw===undefined||raw==='')continue;
   if(typeof raw!=='string'||raw.length>limits.description){issues.push({field,code:'evidence_incomplete',message:messages.evidence_incomplete});continue;}
   if((textWork+=raw.length)>limits.textWork)return [...issues,globalIncomplete()];
   const value=collapsed(raw);if(!value)continue;
   const entries=quoteEntries(evidence,field);
   if(entries===undefined||Array.isArray(entries)&&entries.length===0){issues.push({field,code:'evidence_missing',message:messages.evidence_missing});continue;}
   if(!Array.isArray(entries)||entries.length>limits.quotes||!entries.every(quote)){issues.push({field,code:'evidence_incomplete',message:messages.evidence_incomplete});continue;}
   if((textWork+=entries.reduce((sum,item)=>sum+item.text.length,0))>limits.textWork)return [...issues,globalIncomplete()];
   const texts=entries.map(item=>collapsed(item.text));
   const ordered=entries.every((item,index)=>index===0||item.page>=entries[index-1].page);
   if(!texts.some(text=>text.includes(value))&&!(ordered&&texts.join(' ').includes(value)))issues.push({field,code:'evidence_incomplete',message:messages.evidence_incomplete});
  }
 }
 return issues;
}

const accountFields=new Set(['bank_name','account_identifier','currency','statement_start','statement_end','opening_balance','closing_balance','total_debits','total_credits','balance_convention']);
const transactionFields=new Set(['date','description','reference','debit','credit','balance','currency']);
type Binding={accountId:string;transactionId?:string};

/** Read-time checks also cover legacy runs whose worker dropped provider issues.
 * Binding uses immutable original raw paths, never corrected array positions.
 * Excluded items retain their stored audit issues but do not affect this review. */
export function bankEvidenceReviewIssues(rawValues:unknown,evidence:unknown,storedIssues:unknown,context:BankContext,values:BankValues):BankIssue[]{
 const bindings=new Map<string,Binding>();
 for(const account of values.accounts){
  if(account.excluded||account.origin!=='extracted')continue;
  const original=context.accounts[account.id];if(original)bindings.set(original.rawPath,{accountId:account.id});
  for(const row of account.transactions){
   if(row.excluded||row.origin!=='extracted')continue;
   const original=context.transactions[row.id];if(original?.accountId===account.id)bindings.set(original.rawPath,{accountId:account.id,transactionId:row.id});
  }
 }
 if(!bindings.size)return [];
 function bind(field:unknown):({field:string}&Binding)|undefined{
  if(typeof field!=='string'||field.length>500)return;
  const canonical=field.replace(/\.(\d+)(?=\.|$)/g,'[$1]'),position=canonical.lastIndexOf('.');
  const binding=bindings.get(canonical.slice(0,position)),name=canonical.slice(position+1);
  if(binding&&(binding.transactionId?transactionFields:accountFields).has(name))return {...binding,field:name};
 }
 const found=new Map<string,BankIssue>();
 function add(code:EvidenceCode,binding?:ReturnType<typeof bind>){
  const issue:BankIssue={code,message:!binding&&code==='evidence_incomplete'?incomplete:messages[code],severity:'warning',...binding};
  found.set(JSON.stringify([code,binding?.accountId,binding?.transactionId,binding?.field]),issue);
 }
 const derived=bankDescriptionEvidenceIssues(rawValues,evidence,new Set([...bindings].filter(([,binding])=>binding.transactionId).map(([path])=>`${path}.description`)));
 for(const issue of derived){const binding=bind(issue.field);if(binding)add(issue.code as EvidenceCode,binding);else if(issue.field==='_source')add('evidence_incomplete');}
 if(Array.isArray(storedIssues)){
  if(storedIssues.length>limits.issues)add('evidence_incomplete');
  for(const item of storedIssues.slice(0,limits.issues)){
   if(!object(item)||typeof item.code!=='string'||!Object.hasOwn(messages,item.code)||item.code==='visual_evidence')continue;
   const binding=bind(item.field);if(binding)add(item.code as EvidenceCode,binding);else if(item.field==='_source'&&item.code==='evidence_incomplete')add('evidence_incomplete');
  }
 }else if(storedIssues!==null&&storedIssues!==undefined)add('evidence_incomplete');
 // A global stored visual warning cannot identify whether its source was later
 // excluded. Keep it active only for explicitly model-visual, included evidence.
 if(object(evidence)){
  let fields=0;
  for(const field in evidence){
   if(!Object.hasOwn(evidence,field))continue;
   if(++fields>limits.issues){add('evidence_incomplete');break;}
   if(!bind(field))continue;
   const entries=evidence[field];
   if(!Array.isArray(entries)||entries.length>limits.quotes){add('evidence_incomplete');continue;}
   if(entries.some(item=>quote(item)&&item.source==='model-visual')){add('visual_evidence');break;}
  }
 }
 return [...found.values()];
}
