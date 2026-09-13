import type {ParserSchema,SchemaField} from './types.js';
export interface TemplateRule {field:string;anchor:string;}
export interface TemplateFieldOption {path:string;label:string;kind:'scalar'|'column'|'table';field:SchemaField;}
export interface TemplateSelection {policy:'complete-v1';outcome:'template'|'ai'|'rules'|'failed';reason:'matched'|'no_templates'|'no_match'|'no_readable_text'|'limit';consideredTemplates:number;eligibleTemplates:number;template?:{id:string|null;name:string;fieldCount:number;tieCount:number};}
export interface TemplateCandidate {id:string|null;name:string;matched:boolean;fieldCount:number;matchedFields:number;reasons:string[];unmatchedFields:string[];}
export const templatePolicy='complete-v1' as const;
export const templateLimits=Object.freeze({templates:100,rules:100,nativeBytes:2*1024*1024,schemaFields:600,lineFieldChecks:5_000_000,characterFieldChecks:100_000_000});
export const templateReasonLabels:Record<string,string>={phrase_missing:'Document phrase was not found.',empty_rules:'Add at least one field anchor.',invalid_rules:'Some field anchors are invalid or repeated.',unsupported_field:'An anchor targets a missing or unsupported field.',missing_anchor:'A configured source anchor was not found.',missing_value:'A configured or required field has no source value.',invalid_value:'Extracted values do not pass the saved field checks.',extraction_limit:'The text extraction limit was reached.',check_limit:'This template check exceeds the supported size limits.'};
/** Object groups have no source marker. Flat tables may have a heading and column anchors. */
export function templateFieldOptions(schema:ParserSchema):TemplateFieldOption[]{
 const result:TemplateFieldOption[]=[];
 const walk=(fields:SchemaField[],prefix='',labels:string[]=[]):void=>{for(const field of fields){const path=prefix+field.key,label=[...labels,field.label].join(' / ');
  if(field.type==='object')walk(field.fields??[],path+'.',[...labels,field.label]);
  else if(field.type==='array'){
   if(field.fields?.length&&field.fields.every(child=>!['array','object'].includes(child.type))){result.push({path,label,kind:'table',field});for(const child of field.fields)result.push({path:path+'.'+child.key,label:label+' / '+child.label,kind:'column',field:child});}
  }else result.push({path,label,kind:'scalar',field});
 }};walk(schema.fields);return result;
}
