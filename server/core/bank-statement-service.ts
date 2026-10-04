import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Actor} from '../../shared/types.js';
import type {BankContext,BankIssue,BankValues} from '../../shared/bank-statements.js';
import {bankStatementInstructions,bankStatementSchema,legacyBankStatementSchema,legacyBankStatementInstructions} from '../../shared/bank-statement-preset.js';
import {BankStatementValidationError,bankAccountKey,bankTransactionFingerprint,checkBankStatement,compareBankStatements,normalizeBankStatementCorrections} from './bank-statement-domain.js';
import {audit,badRequest,camel,withWorkspace} from './db.js';
import {requireParserCapacity} from './parser-capacity.js';
import {publicRun} from './runs.js';
import {bankEvidenceReviewIssues} from './bank-statement-evidence.js';

import {bankLocales} from './bank-locale.js';
export {bankLocales} from './bank-locale.js';
export function bankDomain<T>(work:()=>T):T{try{return work();}catch(error){if(error instanceof BankStatementValidationError)badRequest(error.message);throw error;}}
/** Caller owns the workspace lock. Only the exact historical preset can be
 * upgraded; pinned versions and arbitrary custom schemas are immutable. */
export async function adoptBankStatementPreset(c:PoolClient,actor:Actor,parser:any,requireCurrent=false){
 let schema=(await c.query('select id,version,schema from schema_versions where id=$1 and parser_id=$2 and workspace_id=$3',[parser.active_schema_id,parser.id,actor.workspaceId])).rows[0];
 if(schema&&isDeepStrictEqual(schema.schema,legacyBankStatementSchema)){
  schema=(await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) select $1,$2,coalesce(max(version),0)+1,$3,$4 from schema_versions where parser_id=$2 and workspace_id=$1 returning *',[actor.workspaceId,parser.id,JSON.stringify(bankStatementSchema),actor.userId])).rows[0];
  parser=(await c.query('update parsers set active_schema_id=$2,instructions=case when instructions=$4 then $5 else instructions end where id=$1 and workspace_id=$3 returning *',[parser.id,schema.id,actor.workspaceId,legacyBankStatementInstructions,bankStatementInstructions])).rows[0];
  await audit(c,actor.workspaceId,actor.userId,'parser.schema_updated',parser.id,{schemaVersionId:schema.id,source:'bank_statement_preset',preservedHistoricalSchemas:true});
 }
 if(!schema||requireCurrent&&!isDeepStrictEqual(schema.schema,bankStatementSchema))badRequest('The saved bank schema is not a supported preset. Its fields have been preserved; review them before choosing the current preset.',409);
 return {parser,schema};
}
export async function setupBankStatements(actor:Actor,locale?:typeof bankLocales[number]){
 return withWorkspace(actor.workspaceId,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
  let parser=(await c.query("select * from parsers where workspace_id=$1 and use_case='bank_statement' and not archived order by created_at,id limit 1 for update",[actor.workspaceId])).rows[0];
  if(parser){
   if(locale&&locale!==parser.locale){parser=(await c.query('update parsers set locale=$2 where id=$1 returning *',[parser.id,locale])).rows[0];await audit(c,actor.workspaceId,actor.userId,'parser.updated',parser.id,{locale});}
   const adopted=await adoptBankStatementPreset(c,actor,parser);parser=adopted.parser;const schema=adopted.schema;
   return {parser:camel(parser),schema:{id:schema.id,version:schema.version,...schema.schema}};
  }
  await requireParserCapacity(c,actor.workspaceId);
  parser=(await c.query("insert into parsers(workspace_id,name,use_case,mode,instructions,locale,timezone,field_setup_state) values($1,'Bank statements','bank_statement','ai',$2,$3,'Europe/Dublin','ready') returning *",[actor.workspaceId,bankStatementInstructions,locale??'en-IE'])).rows[0];
  const schema=(await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) values($1,$2,1,$3,$4) returning *',[actor.workspaceId,parser.id,JSON.stringify(bankStatementSchema),actor.userId])).rows[0];
  await c.query('update parsers set active_schema_id=$2 where id=$1',[parser.id,schema.id]);await audit(c,actor.workspaceId,actor.userId,'parser.created',parser.id,{workflow:'bank_statement'});
  return {parser:camel({...parser,active_schema_id:schema.id}),schema:{id:schema.id,version:schema.version,...schema.schema}};
 });
}
function validDate(value:string|null):string|null{
 if(!value||!/^\d{4}-\d{2}-\d{2}$/.test(value)||value.startsWith('0000-'))return null;
 const date=new Date(value+'T00:00:00Z');return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value?value:null;
}
const currency=(value:string|null)=>value&&/^[A-Z]{3}$/.test(value)?value:null;
/** Caller owns the workspace lock. Historical corrections never replace current indexes. */
export async function indexBankStatement(c:PoolClient,workspaceId:string,documentId:string,runId:string,values:BankValues,revision=`run:${runId}`){
 if(!(await c.query('select 1 from documents where id=$1 and workspace_id=$2 and latest_run_id=$3',[documentId,workspaceId,runId])).rowCount)return;
 await c.query('delete from bank_statement_accounts where workspace_id=$1 and document_id=$2',[workspaceId,documentId]);
 const accounts=values.accounts.filter(account=>!account.excluded).map(account=>({id:account.id,key:bankAccountKey(account),currency:currency(account.currency),start:validDate(account.statement_start),end:validDate(account.statement_end)}));
 await c.query('insert into bank_statement_accounts(workspace_id,document_id,run_id,revision,account_id,account_key,currency,statement_start,statement_end) select $1,$2,$3,$4,x.id,x.key,x.currency,x.start,x."end" from jsonb_to_recordset($5::jsonb) as x(id uuid,key text,currency text,start date,"end" date)',[workspaceId,documentId,runId,revision,JSON.stringify(accounts)]);
 const rows=values.accounts.filter(account=>!account.excluded).flatMap(account=>account.transactions.flatMap(row=>{const fingerprint=bankTransactionFingerprint(account,row);return fingerprint?[{account:account.id,id:row.id,fingerprint}]:[];}));
 await c.query('insert into bank_statement_transactions(workspace_id,document_id,account_id,transaction_id,fingerprint) select $1,$2,x.account,x.id,x.fingerprint from jsonb_to_recordset($3::jsonb) as x(account uuid,id uuid,fingerprint text)',[workspaceId,documentId,JSON.stringify(rows)]);
}
function orderedIssues(issues:BankIssue[]):BankIssue[]{
 const merged=new Map<string,BankIssue>();
 for(const issue of issues){const {relatedDocumentIds,...base}=issue,key=JSON.stringify(base),existing=merged.get(key);merged.set(key,{...base,...(relatedDocumentIds?.length||existing?.relatedDocumentIds?.length?{relatedDocumentIds:[...new Set([...(existing?.relatedDocumentIds??[]),...(relatedDocumentIds??[])])].sort()}: {})});}
 return [...merged.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b),'en'));
}
/** Indexed comparisons read only matching account keys/fingerprints, never workspace values. */
async function bankStatementChecks(c:PoolClient,workspaceId:string,documentId:string,values:BankValues,context:BankContext){
 const issues=bankDomain(()=>[...checkBankStatement(values,context),...compareBankStatements(values,[])]);
 const accounts=values.accounts.filter(account=>!account.excluded),keys=[...new Set(accounts.map(bankAccountKey).filter((key):key is string=>key!==null))];
 const matches=keys.length?(await c.query('select a.document_id,a.run_id,a.revision,a.account_key,a.currency,a.statement_start::text,a.statement_end::text from bank_statement_accounts a join documents d on d.id=a.document_id and d.workspace_id=a.workspace_id and d.latest_run_id=a.run_id where a.workspace_id=$1 and a.document_id<>$2 and a.account_key=any($3::text[])',[workspaceId,documentId,keys])).rows:[];
 const relatedRevisions=new Set<string>();
 for(const account of accounts){const key=bankAccountKey(account);if(!key)continue;const start=validDate(account.statement_start),end=validDate(account.statement_end),period=Boolean(start&&end&&start<=end);
  for(const other of matches){if(other.account_key!==key||other.currency!==account.currency)continue;relatedRevisions.add(`${other.document_id}:${other.run_id}:${other.revision}`);const otherPeriod=Boolean(other.statement_start&&other.statement_end&&other.statement_start<=other.statement_end);
   if(period&&otherPeriod&&start!<=other.statement_end&&other.statement_start<=end!)issues.push({code:'statement_period_overlap',message:'Another statement for the same account and currency covers an overlapping period. This can be legitimate; review both files.',severity:'warning',accountId:account.id,relatedDocumentIds:[other.document_id]});
   else if(!otherPeriod)issues.push({code:'related_statement_period_unresolved',message:'A related account statement has an unresolved period, so overlap cannot be ruled out.',severity:'warning',accountId:account.id,relatedDocumentIds:[other.document_id]});
  }
 }
 const fingerprints=accounts.flatMap(account=>account.transactions.flatMap(row=>{const fingerprint=bankTransactionFingerprint(account,row);return fingerprint?[{accountId:account.id,transactionId:row.id,fingerprint}]:[];}));
 const duplicates=fingerprints.length?(await c.query('select t.fingerprint,array_agg(distinct t.document_id::text order by t.document_id::text) documents from bank_statement_transactions t join bank_statement_accounts a using(workspace_id,document_id,account_id) join documents d on d.id=a.document_id and d.workspace_id=a.workspace_id and d.latest_run_id=a.run_id where t.workspace_id=$1 and t.document_id<>$2 and t.fingerprint=any($3::text[]) group by t.fingerprint',[workspaceId,documentId,[...new Set(fingerprints.map(row=>row.fingerprint))]])).rows:[];
 const byFingerprint=new Map<string,string[]>(duplicates.map(row=>[row.fingerprint,row.documents]));
 for(const row of fingerprints){const relatedDocumentIds=byFingerprint.get(row.fingerprint);if(relatedDocumentIds?.length)issues.push({code:'possible_duplicate_transaction',message:'A matching transaction appears in another file. Repeated payments can be legitimate; verify both sources before excluding anything.',severity:'warning',accountId:row.accountId,transactionId:row.transactionId,relatedDocumentIds});}
 return {issues:orderedIssues(issues),relatedRevisions:[...relatedRevisions].sort()};
}
export async function bankStatementIssues(c:PoolClient,workspaceId:string,documentId:string,values:BankValues,context:BankContext){return (await bankStatementChecks(c,workspaceId,documentId,values,context)).issues;}
export async function bankReview(c:PoolClient,run:any){
 const context=run.bank_statement_context as BankContext,values=run.effectiveValues as BankValues;
 const checks=await bankStatementChecks(c,run.workspace_id,run.document_id,values,context);
 const issues=orderedIssues([...checks.issues,...bankEvidenceReviewIssues(run.raw_values,run.evidence,run.issues,context,values)]),relatedRevisions=checks.relatedRevisions;
 const token=createHash('sha256').update(JSON.stringify({version:1,runId:run.id,revision:run.effectiveRevision,values,issues,relatedRevisions})).digest('hex');
 return {version:1,revision:run.effectiveRevision,token,issues};
}
export async function publicBankRun(c:PoolClient,run:any){
 const result=publicRun(run);if(!run.bank_statement_context)return result;
 const review=await bankReview(c,run);return {...result,bankContext:run.bank_statement_context,bankValues:run.effectiveValues,bankIssues:review.issues,bankReviewToken:review.token};
}
export function bankCorrections(input:unknown,run:any){return bankDomain(()=>normalizeBankStatementCorrections(input,run.bank_statement_context,run.effectiveValues));}
