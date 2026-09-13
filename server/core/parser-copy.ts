import {randomUUID} from 'node:crypto';
import type {Actor} from '../../shared/types.js';
import {withWorkspace,notFound,badRequest,audit,camel} from './db.js';
import {parserSchema} from './schema.js';
import {requireParserCapacity} from './parser-capacity.js';
import {templateBody} from './template-input.js';
import {templateLimits} from '../../shared/template-selection.js';
import {compareTemplatePriority,templateRuleValidation} from './template-selection.js';
import {exportMappingInput} from '../integrations/export-input.js';

const maxMappings=100,maxConfigurationBytes=2*1024*1024;
function defaultCopyName(name:string){
 const suffix=' (copy)';let value=name;
 while(value.length+suffix.length>100)value=Array.from(value).slice(0,-1).join('');
 return value+suffix;
}
/** Copy only reusable configuration. Documents, processing and connections retain their own identities. */
export async function copyParser(actor:Actor,sourceId:string,name?:string){
 return withWorkspace(actor.workspaceId,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
  const {rows:[source]}=await c.query('select * from parsers where id=$1 and workspace_id=$2 for update',[sourceId,actor.workspaceId]);
  if(!source)notFound('Parser not found');
  if(source.field_setup_state!=='ready')badRequest('Finish parser setup or save its fields before copying this parser.',409);
  await requireParserCapacity(c,actor.workspaceId);
  const {rows:[version]}=await c.query('select * from schema_versions where id=$1 and parser_id=$2 and workspace_id=$3',[source.active_schema_id,sourceId,actor.workspaceId]);
  if(!version)badRequest('Save valid fields for this parser before copying it.',409);
  // LIMIT+1 detects overflow without copying a truncated configuration.
  const templates=(await c.query('select * from templates where parser_id=$1 and workspace_id=$2 order by created_at,id limit $3',[sourceId,actor.workspaceId,templateLimits.templates+1])).rows;
  const mappings=(await c.query('select * from export_mappings where parser_id=$1 and workspace_id=$2 order by created_at,id limit $3',[sourceId,actor.workspaceId,maxMappings+1])).rows;
  if(templates.length>templateLimits.templates)badRequest('This parser has more than 100 templates. Remove unused templates before copying it.',409);
  if(mappings.length>maxMappings)badRequest('This parser has more than 100 export mappings. Remove unused mappings before copying it.',409);
  const copiedName=name??defaultCopyName(source.name);
  const settings={name:copiedName,useCase:source.use_case,mode:source.mode,instructions:source.instructions,locale:source.locale,timezone:source.timezone,allowedFormats:source.allowed_formats};
  if(Buffer.byteLength(JSON.stringify({settings,schema:version.schema,templates,mappings}))>maxConfigurationBytes)badRequest('This parser configuration exceeds the 2 MiB copy limit. Reduce saved fields, templates or export mappings before copying it.',409);
  if(!parserSchema.safeParse(version.schema).success)badRequest('Save valid fields for this parser before copying it.',409);
  for(const template of templates){
   const valid=templateBody.safeParse({name:template.name,matchText:template.match_text,enabled:template.enabled,rules:template.rules});
   if(!valid.success)badRequest('A saved template has invalid settings. Edit or delete that template before copying this parser.',409);
   if(template.enabled&&!templateRuleValidation(version.schema,template.rules).valid)badRequest('A saved template has invalid field anchors. Fix or disable it before copying this parser.',409);
  }
  for(const mapping of mappings)if(!exportMappingInput.safeParse({parserId:sourceId,name:mapping.name,columns:mapping.columns,lineItems:mapping.line_items??undefined}).success)
   badRequest('A saved export mapping has invalid settings. Edit or remove it before copying this parser.',409);
  const {rows:[parser]}=await c.query('insert into parsers(workspace_id,name,use_case,mode,instructions,locale,timezone,allowed_formats,archived,field_setup_state) values($1,$2,$3,$4,$5,$6,$7,$8,false,\'ready\') returning *',[actor.workspaceId,copiedName,source.use_case,source.mode,source.instructions,source.locale,source.timezone,source.allowed_formats]);
  // Validation must not strip or transform the stored schema being copied.
  const {rows:[schema]}=await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) values($1,$2,1,$3,$4) returning *',[actor.workspaceId,parser.id,JSON.stringify(version.schema),actor.userId]);
  await c.query('update parsers set active_schema_id=$2 where id=$1',[parser.id,schema.id]);
  templates.sort(compareTemplatePriority);
  // Copies are created now. Sorted fresh IDs retain source tie priority at that common timestamp.
  const templateIds=templates.map(()=>randomUUID()).sort(),copiedTemplates=[];
  for(const [index,template] of templates.entries()){
   const {rows:[saved]}=await c.query('insert into templates(id,workspace_id,parser_id,name,match_text,rules,enabled) values($1,$2,$3,$4,$5,$6,$7) returning *',[templateIds[index],actor.workspaceId,parser.id,template.name,template.match_text,JSON.stringify(template.rules),template.enabled]);copiedTemplates.push(camel(saved));
  }
  const copiedMappings=[];
  for(const mapping of mappings){const {rows:[saved]}=await c.query('insert into export_mappings(id,workspace_id,parser_id,name,columns,line_items) values($1,$2,$3,$4,$5,$6) returning *',[randomUUID(),actor.workspaceId,parser.id,mapping.name,JSON.stringify(mapping.columns),mapping.line_items]);copiedMappings.push(camel(saved));}
  await audit(c,actor.workspaceId,actor.userId,'parser.copied',parser.id,{sourceParserId:sourceId,sourceSchemaId:version.id,templateCount:templates.length,mappingCount:mappings.length});
  return {parser:camel({...parser,active_schema_id:schema.id}),schema:{...schema.schema,id:schema.id,version:1},templates:copiedTemplates,mappings:copiedMappings};
 });
}
