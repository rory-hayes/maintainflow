import {z} from 'zod';
import {badRequest} from './db.js';

export const bankLocales=['en-IE','en-US','de-DE'] as const;
export const bankLocaleSchema=z.enum(bankLocales);
export type BankLocale=typeof bankLocales[number];
/** An upload or reprocessing choice belongs to its job, never the shared parser. */
export function withBankLocale<T extends {use_case?:string;locale?:string}>(parser:T,locale:unknown):T{
 if(locale===undefined)return parser;
 const selected=bankLocaleSchema.parse(locale);
 if(parser.use_case!=='bank_statement')badRequest('A bank locale can only be selected for a bank statement.');
 return {...parser,locale:selected};
}
