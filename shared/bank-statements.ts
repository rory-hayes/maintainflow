import type {Evidence} from './types.js';

export type BankScalar=string|null;
export type BankBalanceConvention='credit_increases'|'debit_increases'|'unknown';
export interface RawBankTransaction {date:BankScalar;description:BankScalar;reference:BankScalar;debit:BankScalar;credit:BankScalar;balance:BankScalar;currency:BankScalar;}
export interface RawBankAccount {bank_name:BankScalar;account_identifier:BankScalar;currency:BankScalar;statement_start:BankScalar;statement_end:BankScalar;opening_balance:BankScalar;closing_balance:BankScalar;total_debits:BankScalar;total_credits:BankScalar;balance_convention:BankScalar;date_format?:BankScalar;number_format?:BankScalar;transaction_layout?:BankScalar;movement_convention?:BankScalar;transactions:RawBankTransaction[];}
export interface RawBankValues {accounts:RawBankAccount[];}
export interface BankIdentity {id:string;origin:'extracted'|'user';excluded:boolean;exclusion_reason:BankScalar;}
/** Amounts are canonical decimal strings when resolved; invalid raw text stays visible with an issue. */
export interface BankTransaction extends RawBankTransaction,BankIdentity {}
export interface BankAccount extends Omit<RawBankAccount,'transactions'|'balance_convention'|'date_format'|'number_format'|'transaction_layout'|'movement_convention'>,BankIdentity {balance_convention:BankBalanceConvention;transactions:BankTransaction[];}
export interface BankValues {version:1;accounts:BankAccount[];}
export interface BankAccountFormats {version:1;dateStatus:'missing'|'supported'|'unresolved';dateOrder:'dmy'|'mdy'|'ymd'|null;numberStatus:'missing'|'supported'|'unresolved';decimalSeparator:'.'|','|null;groupSeparator:'.'|','|' '|null;movement:'columns'|'positive_credit'|'positive_debit'|'unresolved';}
export interface BankSource {rawPath:string;sourcePages:number[];evidence:Record<string,Evidence[]>;formats?:BankAccountFormats;}
/** Server-owned extraction context. Never accept a replacement context from corrections. */
export interface BankContext {version:1;locale:string;accounts:Record<string,BankSource>;transactions:Record<string,BankSource&{accountId:string}>;}
export interface BankIssue {code:string;message:string;severity:'error'|'warning';accountId?:string;transactionId?:string;field?:string;relatedDocumentIds?:string[];}
export interface BankStatementRecord {documentId:string;filename:string;values:BankValues;}
export interface BankStatementExportRow {document_id:string;filename:string;account_id:string;bank_name:BankScalar;account_identifier:BankScalar;currency:BankScalar;statement_start:BankScalar;statement_end:BankScalar;transaction_id:string;date:BankScalar;description:BankScalar;reference:BankScalar;debit:BankScalar;credit:BankScalar;balance:BankScalar;origin:'extracted'|'user';}
