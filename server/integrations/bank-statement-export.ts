import type {BankValues} from '../../shared/bank-statements.js';
import {bankStatementExportColumns} from '../../shared/bank-statement-preset.js';
import type {ExportRecord} from './export-format.js';

const amountPattern=/^-?(?:0|[1-9]\d{0,69})(?:\.\d{1,8})?$/;
const protectedText=(value:unknown)=>{const text=value==null?'':String(value);return /^[\s\u0000-\u001f]*[=+@-]/u.test(text)?`'${text}`:text;};
/** Only a complete decimal literal bypasses spreadsheet formula escaping. */
function amount(value:string|null,format:'csv'|'xlsx'):string|number {
  if(value===null)return '';
  if(!amountPattern.test(value))throw new Error('An approved statement contains an unresolved amount.');
  if(format==='csv')return value;
  // Excel supports 15 significant digits. Larger amounts remain exact text.
  const digits=value.replace(/[-.]/g,'').replace(/^0+/,'').replace(/0+$/,'');
  const numeric=Number(value),places=value.split('.')[1]?.length??0;
  if(digits.length<=15&&Number.isFinite(numeric)&&Math.abs(numeric)<1e15&&numeric.toFixed(places)===value)return numeric;
  return value;
}
export function bankExportTable(records:ExportRecord[],format:'csv'|'xlsx') {
  const rows:Array<Array<string|number|boolean>>=[];
  const decimals:number[][]=[];
  for(const record of records){
    const values=record.values as unknown as BankValues;
    if(values.version!==1||!Array.isArray(values.accounts)||!record.approvalId)throw new Error('A reviewed statement revision is required.');
    for(const account of values.accounts){if(account.excluded)continue;
      for(const row of account.transactions){if(row.excluded)continue;
        if(rows.length>=100_000||(rows.length+1)*bankStatementExportColumns.length>2_000_000)throw Object.assign(new Error('Export a smaller selection of statements.'),{statusCode:413});
        const textCells=[
          record.filename,record.documentId,record.approvalId,account.id,account.bank_name,account.account_identifier,account.currency,
          account.statement_start,account.statement_end,account.balance_convention,row.id,row.origin,row.date,row.description,row.reference,
        ].map(protectedText);
        rows.push([...textCells,amount(row.debit,format),amount(row.credit,format),amount(row.balance,format)]);
        decimals.push([row.debit,row.credit,row.balance].map(value=>Math.max(2,value?.split('.')[1]?.length??0)));
      }
    }
  }
  return {headers:[...bankStatementExportColumns],rows,decimals};
}
