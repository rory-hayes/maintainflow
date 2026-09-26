import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import ExcelJS from 'exceljs';
import type {BankValues,BankAccount,BankTransaction} from '../shared/bank-statements.js';
import {bankExportTable} from '../server/integrations/bank-statement-export.js';
import {renderExport,type ExportRecord} from '../server/integrations/export-format.js';

// Clearly synthetic approved snapshots. Provider accuracy is not exercised here.
const identity=()=>({id:randomUUID(),origin:'extracted' as const,excluded:false,exclusion_reason:null});
function transaction(overrides:Partial<BankTransaction>={}):BankTransaction{return {...identity(),date:'2026-09-03',description:'Synthetic recurring payment',reference:'SYN-001',debit:'42.50',credit:null,balance:'957.50',currency:'EUR',...overrides};}
function account(overrides:Partial<BankAccount>={}):BankAccount{return {...identity(),bank_name:'Synthetic Bank',account_identifier:'00001234',currency:'EUR',statement_start:'2026-09-01',statement_end:'2026-09-30',opening_balance:'1000.00',closing_balance:'957.50',total_debits:'42.50',total_credits:null,balance_convention:'credit_increases',transactions:[transaction()],...overrides};}
function record(accounts:BankAccount[]=[account()]):ExportRecord{return {documentId:randomUUID(),filename:'SYNTHETIC-statement.pdf',runId:randomUUID(),approvalId:randomUUID(),revision:1,values:{version:1,accounts} satisfies BankValues};}
const index=(label:string,table:ReturnType<typeof bankExportTable>)=>table.headers.indexOf(label as any);

test('bank export retains caller order, account/currency groups, stable row identities and legitimate repeats',()=>{
  const repeated=transaction(),first=account({transactions:[repeated,{...repeated,...identity()},{...transaction(),excluded:true,exclusion_reason:'Synthetic incorrect row'}]}),second=account({currency:'USD',transactions:[transaction({currency:'USD',origin:'user',debit:null,credit:'10.00'})]}),excluded=account({excluded:true,exclusion_reason:'Synthetic unrelated account'});
  const records=[record([first,second,excluded]),record()],table=bankExportTable(records,'csv');
  assert.equal(table.rows.length,4);
  assert.deepEqual(table.rows.map(row=>row[index('Document ID',table)]),[records[0].documentId,records[0].documentId,records[0].documentId,records[1].documentId]);
  assert.deepEqual(table.rows.map(row=>row[index('Currency',table)]),['EUR','EUR','USD','EUR']);
  assert.deepEqual(table.rows.slice(0,2).map(row=>row[index('Transaction ID',table)]),first.transactions.slice(0,2).map(row=>row.id));
  assert.equal(table.rows[2][index('Transaction origin',table)],'user');
  assert.equal(table.rows[2][index('Debit',table)],'');
  assert.equal(table.rows[0][index('Account identifier',table)],'00001234');
  assert.equal(table.rows[0][index('Approval ID',table)],records[0].approvalId);
});

test('CSV exact decimals and quoting preserve literal values while text formula injection remains escaped',async()=>{
  const source=record([account({transactions:[transaction({description:'\t=HYPERLINK("https://example.test")\nSynthetic',reference:'+cmd',debit:'-42.50',balance:'9007199254740993.12'})]})]);
  const output=await renderExport([source],{format:'csv',workflow:'bank_statement'}),csv=output.bytes.toString();
  assert.match(csv,/"-42\.50"/);assert.match(csv,/"9007199254740993\.12"/);
  assert.ok(csv.includes('"\'\t=HYPERLINK(""https://example.test"")\nSynthetic"'));
  assert.ok(csv.includes('"\'+cmd"'));assert.ok(csv.startsWith('\uFEFF"Source statement"'));
  assert.equal((source.values as unknown as BankValues).accounts[0].transactions[0].reference,'+cmd');
});

test('XLSX money is usable numerically within Excel precision and exact text beyond it',async()=>{
  const source=record([account({transactions:[transaction(),transaction({debit:'-0.00000001',balance:'9007199254740993.12'})]})]),table=bankExportTable([source],'xlsx');
  const output=await renderExport([source],{format:'xlsx',workflow:'bank_statement'}),book=new ExcelJS.Workbook();await book.xlsx.load(output.bytes as any);
  const sheet=book.getWorksheet('Transactions')!;
  assert.equal(sheet.getCell(2,index('Debit',table)+1).value,42.5);
  assert.equal(sheet.getCell(2,index('Debit',table)+1).numFmt,'0.00');
  assert.equal(sheet.getCell(3,index('Debit',table)+1).value,-0.00000001);
  assert.equal(sheet.getCell(3,index('Debit',table)+1).numFmt,'0.00000000');
  assert.equal(sheet.getCell(3,index('Running balance',table)+1).value,'9007199254740993.12');
  assert.equal(sheet.getCell(2,index('Account identifier',table)+1).value,'00001234');
  assert.equal(sheet.getCell(2,index('Date',table)+1).value,'2026-09-03');
  assert.equal(sheet.rowCount,3);
});

test('unresolved amounts and unapproved or unsupported exports fail instead of silently coercing',async()=>{
  const source=record([account({transactions:[transaction({debit:'=1+1'})]})]);
  assert.throws(()=>bankExportTable([source],'csv'),/unresolved amount/);
  assert.throws(()=>bankExportTable([{...record(),approvalId:undefined}],'xlsx'),/reviewed statement/);
  await assert.rejects(renderExport([record()],{format:'json',workflow:'bank_statement'}),/fixed CSV/);
  await assert.rejects(renderExport([record()],{format:'csv',workflow:'bank_statement',columns:[{source:'accounts',label:'custom'}]}),/fixed CSV/);
});
