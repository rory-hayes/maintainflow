import {createHash} from 'node:crypto';
import type {ExtractionResult,PageText,ParserSchema,SchemaField} from '../../shared/types.js';
import {matchPdfRegion,pdfGeometryVersion,type PdfGeometry} from '../../shared/pdf-regions.js';
import {canonicalTemplateDefinition,type TemplateDefinition,type TemplateDefinitionSnapshot} from '../../shared/template-definitions.js';
import {regionTemplatePolicy,templateFieldOptions,templateLimits,type TemplateCandidate,type TemplateSelection} from '../../shared/template-selection.js';
import {templateDefinitionInput} from './template-input.js';
import {compareTemplatePriority,selectTemplateExtraction,templateRuleValidation} from './template-selection.js';
import {normalizeValue} from './extraction.js';
import {validateValues} from './schema.js';

export function storedTemplateDefinition(template:any):unknown {
  return {kind:template?.kind??'text-v1',name:template?.name,matchText:template?.matchText??template?.match_text??'',enabled:template?.enabled,rules:template?.rules};
}
export function validateTemplateDefinition(schema:ParserSchema,definition:unknown){
  const parsed=templateDefinitionInput.safeParse(definition);
  if(!parsed.success)return {valid:false,reasons:['invalid_rules'],covered:[] as string[]};
  if(parsed.data.kind==='text-v1')return templateRuleValidation(schema,parsed.data.rules);
  const allowed=new Set(templateFieldOptions(schema).filter(option=>option.kind==='scalar').map(option=>option.path));
  const seen=new Set<string>(),reasons=new Set<string>();
  if(!parsed.data.rules.length)reasons.add('empty_rules');
  for(const rule of parsed.data.rules){
    if(seen.has(rule.field))reasons.add('invalid_rules');
    seen.add(rule.field);
    if(!allowed.has(rule.field))reasons.add('unsupported_field');
  }
  return {valid:reasons.size===0,reasons:[...reasons],covered:[...seen]};
}
export function needsPdfGeometry(templates:any[]):boolean {
  return Array.isArray(templates)&&templates.some(template=>template?.enabled===true&&template?.kind==='native-pdf-region-v1');
}
function present(value:unknown):boolean {
  if(value===null||value===undefined||typeof value==='string'&&!value.trim())return false;
  if(Array.isArray(value))return value.length>0&&value.every(present);
  if(typeof value==='object')return Object.values(value).some(present);
  return true;
}
function missingRequired(values:Record<string,unknown>,fields:SchemaField[],prefix=''):string[]{
  const missing:string[]=[];
  for(const field of fields){const value=values[field.key],path=prefix+field.key;
    if(field.required&&!present(value))missing.push(path);
    if(field.type==='object'&&value&&typeof value==='object'&&!Array.isArray(value))missing.push(...missingRequired(value as Record<string,unknown>,field.fields??[],path+'.'));
    if(field.type==='array'&&Array.isArray(value))for(const row of value)if(row&&typeof row==='object'&&!Array.isArray(row))missing.push(...missingRequired(row,field.fields??[],path+'.'));
  }
  return [...new Set(missing)];
}
const countFields=(fields:SchemaField[]):number=>fields.reduce((count,field)=>count+1+(field.fields?countFields(field.fields):0),0);
const identity=(template:any)=>({id:typeof template?.id==='string'?template.id.slice(0,64):null,name:typeof template?.name==='string'?template.name.slice(0,100):'Unnamed template'});
export function templateDefinitionDigest(definition:TemplateDefinition):string{return createHash('sha256').update(canonicalTemplateDefinition(definition)).digest('hex');}
function definitionSnapshot(template:any,definition:TemplateDefinition):TemplateDefinitionSnapshot {
  return {version:'folio-template-snapshot-v1',definitionDigest:templateDefinitionDigest(definition),
    template:{...definition,id:identity(template).id,revision:Number.isSafeInteger(template?.revision)&&template.revision>0?template.revision:1},
    ...(definition.kind==='native-pdf-region-v1'?{geometryVersion:pdfGeometryVersion}:{})};
}

function evaluateRegion(pages:PageText[],schema:ParserSchema,locale:string,template:any,geometry?:PdfGeometry,timezone?:string){
  const candidate:TemplateCandidate={...identity(template),matched:false,fieldCount:0,matchedFields:0,reasons:[],unmatchedFields:[]};
  const parsed=templateDefinitionInput.safeParse(storedTemplateDefinition(template));
  if(!parsed.success||parsed.data.kind!=='native-pdf-region-v1'){candidate.reasons.push('invalid_rules');return {candidate};}
  const definition=parsed.data,validation=validateTemplateDefinition(schema,definition);
  candidate.fieldCount=validation.covered.length;candidate.reasons.push(...validation.reasons);
  if(definition.matchText&&!pages.map(page=>page.text).join('\n').includes(definition.matchText))candidate.reasons.push('phrase_missing');
  if(!geometry)candidate.reasons.push('region_source_unsupported');
  if(candidate.reasons.length)return {candidate};
  const captured=new Map<string,string>(),evidence:ExtractionResult['evidence']={};
  for(const rule of definition.rules){
    const match=matchPdfRegion(geometry!,rule);
    if(!match.matched){candidate.reasons.push('region_'+match.reason);candidate.unmatchedFields.push(rule.field);continue;}
    captured.set(rule.field,match.text);candidate.matchedFields++;
    evidence[rule.field]=[{page:match.page,text:match.text,source:'matched-region',region:{version:match.version,sourceSha256:geometry!.sourceSha256,rect:match.rect,anchor:match.anchor,itemIds:match.itemIds}}];
  }
  const collect=(fields:SchemaField[],prefix=''):Record<string,unknown>=>Object.fromEntries(fields.map(field=>{
    const key=prefix+field.key;
    return [field.key,field.type==='object'?collect(field.fields??[],key+'.'):captured.get(key)??null];
  }));
  const rawValues=collect(schema.fields),normalizedValues=Object.fromEntries(schema.fields.map(field=>[field.key,normalizeValue(rawValues[field.key],field,locale,timezone)]));
  const issues=validateValues(normalizedValues,schema,{locale,timezone}),missing=missingRequired(rawValues,schema.fields);
  if(missing.length){candidate.reasons.push('missing_value');candidate.unmatchedFields.push(...missing);}
  if(issues.some(issue=>!issue.code.startsWith('timestamp_')))candidate.reasons.push('invalid_value');
  candidate.reasons=[...new Set(candidate.reasons)];candidate.unmatchedFields=[...new Set(candidate.unmatchedFields)].slice(0,templateLimits.schemaFields);
  candidate.matched=candidate.reasons.length===0;
  const result:ExtractionResult={rawValues,normalizedValues,evidence,issues,engine:'native-pdf-regions',model:'deterministic-pdf-regions-v1',promptVersion:'folio-native-pdf-regions-v1'};
  return {candidate,result,definition};
}

/** New jobs use this version. Queued complete-v1 and legacy jobs keep their original selectors. */
export function selectCurrentTemplateExtraction(pages:PageText[],schema:ParserSchema,locale:string,templates:any[],mode:'ai'|'rules',geometry?:PdfGeometry,timezone?:string):{
  selection:TemplateSelection;candidates:TemplateCandidate[];availableSourceText:boolean;result?:ExtractionResult;
}{
  const enabled=(Array.isArray(templates)?templates:[]).filter(template=>template?.enabled===true),text=pages.map(page=>page.text).join('\n'),availableSourceText=Boolean(text.trim());
  const base={policy:regionTemplatePolicy,consideredTemplates:enabled.length,eligibleTemplates:0};
  const fallback=(reason:TemplateSelection['reason'],candidates:TemplateCandidate[]=[])=>({selection:{...base,outcome:mode==='ai'?'ai':reason==='no_templates'?'rules':'failed',reason} as TemplateSelection,candidates,availableSourceText});
  if(!enabled.length)return fallback(availableSourceText?'no_templates':'no_readable_text');
  const fields=countFields(schema.fields);
  if(enabled.length>templateLimits.templates||fields>templateLimits.schemaFields||Buffer.byteLength(text)>templateLimits.nativeBytes||enabled.some(template=>Array.isArray(template?.rules)&&template.rules.length>templateLimits.rules)||text.split(/\r?\n/).length*Math.max(1,fields)*enabled.length>templateLimits.lineFieldChecks||text.length*Math.max(1,fields)*enabled.length>templateLimits.characterFieldChecks)
    return fallback('limit',enabled.slice(0,templateLimits.templates).map(template=>({...identity(template),matched:false,fieldCount:0,matchedFields:0,reasons:['check_limit'],unmatchedFields:[]})));
  const evaluated=enabled.map<{template:any;index:number;candidate:TemplateCandidate;result?:ExtractionResult;definition?:TemplateDefinition}>((template,index)=>{
    if(template.kind==='native-pdf-region-v1')return {...evaluateRegion(pages,schema,locale,template,geometry,timezone),template,index};
    if(template.kind!==undefined&&template.kind!==null&&template.kind!=='text-v1')return {template,index,candidate:{...identity(template),matched:false,fieldCount:0,matchedFields:0,reasons:['invalid_rules'],unmatchedFields:[]} as TemplateCandidate};
    const selected=selectTemplateExtraction(pages,schema,locale,[template],mode,timezone);
    const parsed=templateDefinitionInput.safeParse(storedTemplateDefinition(template));
    if(!parsed.success)return {template,index,candidate:{...selected.candidates[0],matched:false,reasons:[...new Set([...selected.candidates[0].reasons,'invalid_rules'])]}};
    return {template,index,candidate:selected.candidates[0],result:selected.result,definition:parsed.data};
  });
  const candidates=evaluated.map(row=>row.candidate),qualified=evaluated.filter(row=>row.candidate.matched&&row.result&&row.definition);
  if(!qualified.length)return fallback(availableSourceText?'no_match':'no_readable_text',candidates);
  qualified.sort((a,b)=>b.candidate.fieldCount-a.candidate.fieldCount||compareTemplatePriority(a.template,b.template)||a.index-b.index);
  const chosen=qualified[0],snapshot=definitionSnapshot(chosen.template,chosen.definition!);
  const selection:TemplateSelection={...base,outcome:'template',reason:'matched',eligibleTemplates:qualified.length,template:{...identity(chosen.template),fieldCount:chosen.candidate.fieldCount,tieCount:qualified.filter(row=>row.candidate.fieldCount===chosen.candidate.fieldCount).length,kind:snapshot.template.kind,revision:snapshot.template.revision,definitionDigest:snapshot.definitionDigest,...(snapshot.geometryVersion?{geometryVersion:snapshot.geometryVersion}:{})}};
  return {selection,candidates,availableSourceText,result:{...chosen.result!,templateSnapshot:snapshot}};
}

/** Partial values belong only to an explicitly labelled unsaved check, never worker admission. */
export function previewTemplateDefinition(pages:PageText[],schema:ParserSchema,locale:string,definition:TemplateDefinition,geometry?:PdfGeometry,timezone?:string){
  const candidate={...definition,id:null,revision:1,enabled:true};
  const selection=selectCurrentTemplateExtraction(pages,schema,locale,[candidate],'rules',geometry,timezone);
  if(definition.kind!=='native-pdf-region-v1')return selection;
  const evaluated=evaluateRegion(pages,schema,locale,candidate,geometry,timezone);
  return {...selection,...(evaluated.result?{result:evaluated.result}:{})};
}
