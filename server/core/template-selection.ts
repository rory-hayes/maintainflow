import type {ExtractionResult,PageText,ParserSchema,SchemaField} from '../../shared/types.js';
import {templateFieldOptions,templateLimits,templatePolicy,type TemplateRule,type TemplateCandidate,type TemplateSelection} from '../../shared/template-selection.js';
import {extractTemplateValues} from './extraction.js';

export function templateRuleValidation(schema:ParserSchema,rules:unknown){
 const options=templateFieldOptions(schema),byPath=new Map(options.map(option=>[option.path,option])),seen=new Set<string>(),covered=new Set<string>(),reasons=new Set<string>();
 if(!Array.isArray(rules)||rules.length>templateLimits.rules)return {valid:false,reasons:['invalid_rules'],covered:[] as string[]};
 if(!rules.length)reasons.add('empty_rules');
 for(const rule of rules){
  if(!rule||typeof rule!=='object'||typeof rule.field!=='string'||!rule.field||rule.field.length>259||typeof rule.anchor!=='string'||!rule.anchor.trim()||rule.anchor.length>200||seen.has(rule.field)){reasons.add('invalid_rules');continue;}
  seen.add(rule.field);const option=byPath.get(rule.field);if(!option){reasons.add('unsupported_field');continue;}
  if(option.kind==='table')for(const child of option.field.fields??[])covered.add(option.path+'.'+child.key);else covered.add(option.path);
 }
 return {valid:reasons.size===0,reasons:[...reasons],covered:[...covered]};
}
function sourcePresent(value:unknown):boolean{
 if(value===null||value===undefined||typeof value==='string'&&!value.trim())return false;
 if(Array.isArray(value))return value.length>0&&value.every(sourcePresent);
 if(typeof value==='object')return Object.values(value).some(sourcePresent);
 return true;
}
function pathValues(value:any,parts:string[]):unknown[]{
 if(!parts.length)return [value];
 if(Array.isArray(value))return value.flatMap(row=>pathValues(row,parts));
 return pathValues(value?.[parts[0]],parts.slice(1));
}
function missingRequired(values:Record<string,unknown>,fields:SchemaField[],prefix=''):string[]{
 const missing:string[]=[];
 for(const field of fields){const value=values?.[field.key],path=prefix+field.key;
  if(field.required&&!sourcePresent(value))missing.push(path);
  if(field.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value))missing.push(...missingRequired(value as Record<string,unknown>,field.fields??[],path+'.'));
  if(field.type==='array'&&Array.isArray(value))for(const row of value)if(row&&typeof row==='object'&&!Array.isArray(row))missing.push(...missingRequired(row,field.fields??[],path+'.'));
 }
 return [...new Set(missing)];
}
function countFields(fields:SchemaField[]):number{return fields.reduce((count,field)=>count+1+(field.fields?countFields(field.fields):0),0);}
const identity=(template:any)=>({id:typeof template?.id==='string'?template.id.slice(0,64):null,name:typeof template?.name==='string'?template.name.slice(0,100):'Unnamed template'});
const createdAt=(template:any)=>{const value=template?.created_at??template?.createdAt;const parsed=value?new Date(value).getTime():NaN;return Number.isFinite(parsed)?parsed:Infinity;};

/** Shared with parser copying so fresh template identities preserve matching priority. */
export function compareTemplatePriority(a:any,b:any){const aid=identity(a).id??'',bid=identity(b).id??'';return createdAt(a)-createdAt(b)||(aid<bid?-1:aid>bid?1:0);}

/** Read-only, bounded selection. All inputs belong to a pinned job or an explicitly labelled preview. */
export function selectTemplateExtraction(pages:PageText[],schema:ParserSchema,locale:string,templates:any[],mode:'ai'|'rules'):{selection:TemplateSelection;candidates:TemplateCandidate[];availableSourceText:boolean;result?:ExtractionResult}{
 const enabled=(Array.isArray(templates)?templates:[]).filter(template=>template?.enabled===true),text=pages.map(page=>page.text).join('\n'),availableSourceText=Boolean(text.trim());
 const base={policy:templatePolicy,consideredTemplates:enabled.length,eligibleTemplates:0};
 const fallback=(reason:TemplateSelection['reason'],candidates:TemplateCandidate[]=[])=>({selection:{...base,outcome:mode==='ai'?'ai':reason==='no_templates'?'rules':'failed',reason} as TemplateSelection,candidates,availableSourceText});
 if(!enabled.length)return fallback(availableSourceText?'no_templates':'no_readable_text');
 const descriptors=countFields(schema.fields);
 if(enabled.length>templateLimits.templates||enabled.some(template=>Array.isArray(template.rules)&&template.rules.length>templateLimits.rules)||Buffer.byteLength(text)>templateLimits.nativeBytes||descriptors>templateLimits.schemaFields||text.split(/\r?\n/).length*Math.max(1,descriptors)*enabled.length>templateLimits.lineFieldChecks||text.length*Math.max(1,descriptors)*enabled.length>templateLimits.characterFieldChecks)
  return fallback('limit',enabled.slice(0,templateLimits.templates).map(template=>({...identity(template),matched:false,fieldCount:0,matchedFields:0,reasons:['check_limit'],unmatchedFields:[]})));
 const evaluated=enabled.map((template,index)=>{
  const candidate:TemplateCandidate={...identity(template),matched:false,fieldCount:0,matchedFields:0,reasons:[],unmatchedFields:[]};
  const validation=templateRuleValidation(schema,template.rules);candidate.fieldCount=validation.covered.length;candidate.reasons.push(...validation.reasons);
  const phrase=template.match_text??template.matchText??'';
  if(typeof phrase!=='string'||phrase.length>1000)candidate.reasons.push('invalid_rules');
  else if(phrase&&!text.includes(phrase))candidate.reasons.push('phrase_missing');
  if(!availableSourceText)candidate.reasons.push('missing_anchor');
  if(candidate.reasons.length)return {candidate,index,template};
  const extracted=extractTemplateValues(pages,schema,locale,template),result=extracted.result;
  const rules=template.rules as TemplateRule[];
  for(const rule of rules){
   if(!extracted.matchedRules.has(rule.field)){candidate.reasons.push('missing_anchor');candidate.unmatchedFields.push(rule.field);}
  }
  for(const path of validation.covered){const values=pathValues(result.rawValues,path.split('.'));if(!values.length||!values.every(sourcePresent)){candidate.reasons.push('missing_value');candidate.unmatchedFields.push(path);}else candidate.matchedFields++;}
  const required=missingRequired(result.rawValues,schema.fields);if(required.length){candidate.reasons.push('missing_value');candidate.unmatchedFields.push(...required);}
  if(result.issues.some(issue=>['multiline_limit','table_limit'].includes(issue.code)))candidate.reasons.push('extraction_limit');
  if(result.issues.length)candidate.reasons.push('invalid_value');
  candidate.reasons=[...new Set(candidate.reasons)];candidate.unmatchedFields=[...new Set(candidate.unmatchedFields)].slice(0,templateLimits.schemaFields);candidate.matched=candidate.reasons.length===0;
  return {candidate,index,template,result};
 });
 const candidates=evaluated.map(row=>row.candidate),qualified=evaluated.filter(row=>row.candidate.matched);
 if(!qualified.length)return fallback(availableSourceText?'no_match':'no_readable_text',candidates);
 qualified.sort((a,b)=>b.candidate.fieldCount-a.candidate.fieldCount||compareTemplatePriority(a.template,b.template)||a.index-b.index);
 const chosen=qualified[0],selection:TemplateSelection={...base,outcome:'template',reason:'matched',eligibleTemplates:qualified.length,template:{...identity(chosen.template),fieldCount:chosen.candidate.fieldCount,tieCount:qualified.filter(row=>row.candidate.fieldCount===chosen.candidate.fieldCount).length}};
 return {selection,candidates,availableSourceText,result:{...chosen.result!,engine:'text-template',model:'deterministic-v3',promptVersion:'folio-text-template-v1'}};
}
