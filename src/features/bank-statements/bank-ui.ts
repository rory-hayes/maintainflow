import type {BankContext,BankIssue,BankValues} from '../../../shared/bank-statements';
import type {Evidence} from '../../../shared/types';
import {downloadFile,post} from '../../lib/api';

export type BankDocument={id:string;name:string;status:string;pageCount:number;mimeType:string;sourceText?:{page:number;text:string}[];sha256?:string;error?:string|null;approvedRunId?:string|null;createdAt?:string;bankSummary?:{accountCount?:number;transactionCount?:number;errorCount?:number;warningCount?:number;approvalId?:string|null}};
export type BankApproval={id:string;createdAt:string;values:BankValues;correctionId?:string|null};
export type BankRun={id:string;createdAt:string;bankValues?:BankValues;effectiveValues:BankValues;effectiveRevision:string;bankReviewToken:string;bankContext:BankContext;bankIssues:BankIssue[];rawValues:Record<string,unknown>;evidence:Record<string,Evidence[]>;corrections:{id:string;createdAt:string;values:BankValues}[];approvals:BankApproval[]};
export const bankLocales=[['en-IE','Day / month / year · 1,234.56'],['en-US','Month / day / year · 1,234.56'],['de-DE','Day / month / year · 1.234,56']] as const;
export type BankLocale=typeof bankLocales[number][0];
export const bankAccept='.pdf,.png,.jpg,.jpeg,.tif,.tiff,.txt,.html,.htm,.eml,.csv,.docx,.xlsx';
export async function exportBankStatements(format:'csv'|'xlsx',revisions:{documentId:string;approvalId:string}[]){
  const result=await post<{downloadUrl:string}>('/api/exports',{format,documentIds:revisions.map(item=>item.documentId),revisions,workflow:'bank_statement'});
  if(!/^\/api\/exports\/[a-f0-9-]+\/download$/i.test(result.downloadUrl))throw new Error('The export download could not be verified. Please try again.');
  await downloadFile(result.downloadUrl,`maintainflow-bank-statements.${format}`);
}
export function rawSourceAt(raw:unknown,path:string):unknown{
  const parts=path.replace(/\[(\d+)\]/g,'.$1').split('.');
  let value=raw;
  for(const part of parts){if(!value||typeof value!=='object'||!Object.hasOwn(value,part))return undefined;value=(value as Record<string,unknown>)[part];}
  return value;
}
