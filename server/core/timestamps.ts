import {Temporal} from '@js-temporal/polyfill';
import type {ParserSchema,SchemaField,ValidationIssue} from '../../shared/types.js';
import {normalizeWrittenDate} from './written-date.js';
import {regionalSourceLocale} from './source-locale.js';
import {fieldSourceLocale,normalizationPolicy,legacyNormalizationPolicy,type NormalizationPolicy} from '../../shared/source-formats.js';

export const timestampPolicy=legacyNormalizationPolicy;
export interface NormalizationContext {version:NormalizationPolicy;locale:string;timezone:string|null;tzdbVersion:string|null;}
type Settings={locale?:string;timezone?:string|null;version?:NormalizationPolicy};
type TimestampResult={value:unknown;issue?:Omit<ValidationIssue,'field'>};
const instantSyntax=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
export function validTimezone(value:unknown):value is string{
 if(typeof value!=='string'||!value||value.length>80||value!==value.trim())return false;
 try{new Intl.DateTimeFormat('en',{timeZone:value});Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value);return true;}catch{return false;}
}
export function isCanonicalTimestamp(value:unknown):value is string{
 if(typeof value!=='string'||!instantSyntax.test(value)||value.startsWith('0000-'))return false;
 try{return Temporal.Instant.from(value).toString()===value;}catch{return false;}
}
/** Local date/times are never interpreted in the host process's timezone. */
export function normalizeTimestamp(value:unknown,settings:Settings={}):TimestampResult{
 const fail=(code:string,message:string):TimestampResult=>({value,issue:{code,message}});
 const invalid=()=>fail('timestamp_invalid','Enter a valid date and 24-hour time, optionally followed by Z or a numeric offset such as +01:00.');
 if(typeof value!=='string'||value.length>200)return invalid();
 const match=value.trim().match(/^(.+?)[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/);
 if(!match)return invalid();
 let date=match[1];
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)){
  if(!settings.locale)return fail('timestamp_locale_missing','This run has no saved locale. Enter an ISO timestamp with an explicit offset, for example 2026-09-17T14:30:00+01:00.');
  try{
   const regional=settings.version===legacyNormalizationPolicy?null:regionalSourceLocale(settings.locale);
   if(settings.version===legacyNormalizationPolicy?new Intl.DateTimeFormat(settings.locale).resolvedOptions().calendar!=='gregory':!regional)return invalid();
   if(settings.version!==legacyNormalizationPolicy&&/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}$/.test(date)&&!/^\d{1,2}([\/.\-])\d{1,2}\1\d{4}$/.test(date))return invalid();
   const numeric=date.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
   if(numeric){if(regional&&!['month-day-year','day-month-year'].includes(regional.dateOrder))return invalid();const us=regional?regional.dateOrder==='month-day-year':/^en-US/i.test(settings.locale);date=`${numeric[3]}-${(us?numeric[1]:numeric[2]).padStart(2,'0')}-${(us?numeric[2]:numeric[1]).padStart(2,'0')}`;}
   else date=normalizeWrittenDate(date,settings.locale)??date;
  }catch{return invalid();}
 }
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.startsWith('0000-'))return invalid();
 // Temporal accepts leap-second strings by constraining them; this contract rejects them.
 if(Number(match[2])>23||Number(match[3])>59||Number(match[4]??0)>59)return invalid();
 const local=`${date}T${match[2]}:${match[3]}:${match[4]??'00'}${match[5]?'.'+match[5]:''}`;
 let plain:Temporal.PlainDateTime;
 try{plain=Temporal.PlainDateTime.from(local,{overflow:'reject'});}catch{return invalid();}
 if(match[6]){
  try{const output=Temporal.Instant.from(local+match[6]).toString();return isCanonicalTimestamp(output)?{value:output}:invalid();}catch{return invalid();}
 }
 if(!validTimezone(settings.timezone))return fail('timestamp_timezone_missing','This timestamp has no offset and this run has no valid saved timezone. Enter an ISO timestamp with Z or a numeric offset.');
 try{
  const output=plain.toZonedDateTime(settings.timezone,{disambiguation:'reject'}).toInstant().toString();
  return isCanonicalTimestamp(output)?{value:output}:invalid();
 }catch{
  const earlier=plain.toZonedDateTime(settings.timezone,{disambiguation:'earlier'});
  const later=plain.toZonedDateTime(settings.timezone,{disambiguation:'later'});
  if(earlier.toPlainDateTime().equals(plain)&&later.toPlainDateTime().equals(plain))return fail('timestamp_ambiguous',`This clock time occurs twice in ${settings.timezone}. Check the source and enter the intended numeric offset, such as +01:00 or +00:00.`);
  return fail('timestamp_nonexistent',`This clock time does not exist in ${settings.timezone} because the clock changes. Check the source and enter the correct time with an explicit offset.`);
 }
}

/** Only timestamp corrections change here; all other manual values retain their existing semantics. */
export function normalizeTimestampCorrections(values:Record<string,unknown>,schema:ParserSchema,settings:Settings={}):Record<string,unknown>{
 const fieldValue=(value:unknown,field:SchemaField):unknown=>{
  if(value===null||value===undefined||value==='')return value;
  if(field.type==='timestamp')return normalizeTimestamp(value,{...settings,locale:fieldSourceLocale(field,settings.locale,settings.version??normalizationPolicy),timezone:field.timezone??settings.timezone}).value;
  if(field.type==='array'&&Array.isArray(value))return value.map(row=>record(row,field.fields??[]));
  if(field.type==='object')return record(value,field.fields??[]);
  return value;
 };
 const record=(value:unknown,fields:SchemaField[]):unknown=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const copy={...value} as Record<string,unknown>;
  for(const field of fields)if(Object.hasOwn(copy,field.key))copy[field.key]=fieldValue(copy[field.key],field);
  return copy;
 };
 return record(values,schema.fields) as Record<string,unknown>;
}
