import {templatePolicy} from '../../shared/template-selection.js';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Actor} from '../../shared/types.js';
import {schemaSuggestionLimits} from '../../shared/schema-suggestions.js';
import {audit,badRequest,notFound} from './db.js';

/** Call under the workspace advisory lock, shared with all suggestion creation. */
export async function requireSuggestionCapacity(c:PoolClient,workspaceId:string){
 const {rows:[counts]}=await c.query("select (select count(*)::int from audit_events where workspace_id=$1 and action='schema.suggestion_requested' and created_at>now()-interval '24 hours') recent,(select count(*)::int from schema_suggestions where workspace_id=$1 and state in('queued','processing')) pending",[workspaceId]);
 if(counts.recent>=schemaSuggestionLimits.perDay)badRequest('This workspace has used its 10 field suggestions for the last 24 hours. Try again later.',429);
 if(counts.pending>=schemaSuggestionLimits.pendingPerWorkspace)badRequest('This workspace already has three field suggestions in progress. Wait for one to finish.',429);
}

export async function parserSetupStatus(c:PoolClient,parser:any,available:boolean){
 const {rows:[source]}=await c.query('select s.id,s.document_id,d.name,s.error from schema_suggestions s join documents d on d.id=s.document_id where s.id=$1 and s.parser_id=$2',[parser.field_setup_suggestion_id,parser.id]);
 const {rows:[waiting]}=await c.query('select count(*)::int count from jobs j join documents d on d.id=j.document_id where d.parser_id=$1 and j.waiting_for_schema',[parser.id]);
 return {state:parser.field_setup_state,suggestionId:source?.id??null,sourceDocumentId:source?.document_id??null,sourceDocumentName:source?.name??null,error:parser.field_setup_error??(parser.field_setup_state==='failed'?source?.error:null)??null,waitingDocuments:waiting.count,available};
}

/** The caller holds workspace and parser locks; upload and setup enqueue commit together. */
export async function queueInitialSetup(c:PoolClient,actor:Actor,parser:any,document:any,requestId:string=randomUUID()){
 const {rows:[prior]}=await c.query('select * from schema_suggestions where workspace_id=$1 and request_id=$2',[actor.workspaceId,requestId]);
 if(prior){
  if(!prior.auto_setup||prior.parser_id!==parser.id||prior.document_id!==document.id)badRequest('This request was already used for another field suggestion.',409);
  return prior;
 }
 if(parser.archived)badRequest('Restore this parser before setting up its fields.',409);
 if(!['awaiting_sample','failed'].includes(parser.field_setup_state))badRequest('This parser is already set up or field discovery is in progress.',409);
 if(document.parser_id!==parser.id||document.workspace_id!==actor.workspaceId)notFound('Document not found in this parser');
 await requireSuggestionCapacity(c,actor.workspaceId);
 const {rows:[suggestion]}=await c.query('insert into schema_suggestions(workspace_id,parser_id,document_id,base_schema_id,requested_by,request_id,document_sha256,config,auto_setup) values($1,$2,$3,$4,$5,$6,$7,$8,true) returning *',[actor.workspaceId,parser.id,document.id,parser.active_schema_id,actor.userId,requestId,document.sha256,JSON.stringify({locale:parser.locale})]);
 await c.query("update parsers set field_setup_state='suggesting',field_setup_suggestion_id=$2,field_setup_error=null where id=$1",[parser.id,suggestion.id]);
 const {rows}=await c.query("update jobs j set state='queued',error=null,available_at=now(),updated_at=now() from documents d where j.document_id=d.id and d.parser_id=$1 and j.waiting_for_schema and j.state='failed' returning j.document_id",[parser.id]);
 if(rows.length)await c.query("update documents set status='queued',error=null,updated_at=now() where id=any($1::uuid[])",[rows.map(row=>row.document_id)]);
 await audit(c,actor.workspaceId,actor.userId,'schema.suggestion_requested',suggestion.id,{parserId:parser.id,documentId:document.id,baseSchemaId:parser.active_schema_id,automaticSetup:true});
 return suggestion;
}

/** These initial jobs have never been attempted. Finalize their first schema, not a reprocess. */
export async function releaseInitialJobs(c:PoolClient,parser:any,schemaId:string){
 const templates=(await c.query('select * from templates where parser_id=$1 order by created_at,id',[parser.id])).rows;
 const config={mode:parser.mode,instructions:parser.instructions,locale:parser.locale,timezone:parser.timezone,templates,templatePolicy};
 const {rows}=await c.query("update jobs j set waiting_for_schema=false,schema_version_id=$2,config=$3,state='queued',error=null,available_at=now(),updated_at=now() from documents d where j.document_id=d.id and d.parser_id=$1 and j.waiting_for_schema returning j.document_id",[parser.id,schemaId,JSON.stringify(config)]);
 if(rows.length)await c.query("update documents set status='queued',error=null,updated_at=now() where id=any($1::uuid[])",[rows.map(row=>row.document_id)]);
 return rows.length;
}

export async function failInitialSetup(c:PoolClient,parser:any,message:string){
 if(parser.field_setup_state==='ready')return;
 const safe=message.slice(0,500);
 await c.query("update parsers set field_setup_state='failed',field_setup_error=$2 where id=$1",[parser.id,safe]);
 const {rows}=await c.query("update jobs j set state='failed',error=$2,updated_at=now() from documents d where j.document_id=d.id and d.parser_id=$1 and j.waiting_for_schema returning j.document_id",[parser.id,safe]);
 if(rows.length)await c.query("update documents set status='failed',error=$2,updated_at=now() where id=any($1::uuid[])",[rows.map(row=>row.document_id),safe]);
}

/** Called inside the successful fenced suggestion transaction, after locking its parser. */
export async function finishInitialSetup(c:PoolClient,suggestion:any){
 if(!suggestion.auto_setup)return;
 const {rows:[parser]}=await c.query('select * from parsers where id=$1 for update',[suggestion.parser_id]);
 if(!parser||parser.field_setup_state!=='suggesting'||parser.field_setup_suggestion_id!==suggestion.id)return;
 if(parser.archived||parser.active_schema_id!==suggestion.base_schema_id){
  await failInitialSetup(c,parser,'Field discovery could not be applied because the parser changed. Review its fields or retry setup.');return;
 }
 const {rows:[version]}=await c.query('insert into schema_versions(workspace_id,parser_id,version,schema,created_by) select $1,$2,coalesce(max(version),0)+1,$3,$4 from schema_versions where parser_id=$2 returning *',[suggestion.workspace_id,parser.id,JSON.stringify(suggestion.proposed_schema),suggestion.requested_by]);
 await c.query("update parsers set active_schema_id=$2,field_setup_state='ready',field_setup_error=null where id=$1",[parser.id,version.id]);
 await c.query('update schema_suggestions set applied_schema_id=$2 where id=$1',[suggestion.id,version.id]);
 const documents=await releaseInitialJobs(c,parser,version.id);
 await audit(c,parser.workspace_id,suggestion.requested_by,'schema.version_created',parser.id,{version:version.version,suggestionId:suggestion.id,automaticSetup:true});
 await audit(c,parser.workspace_id,suggestion.requested_by,'parser.setup_completed',parser.id,{suggestionId:suggestion.id,schemaId:version.id,documents});
}

/** Common ordering for removal: workspace, parser, then document and dependent jobs. */
export async function lockParserForDocument(c:PoolClient,workspaceId:string,documentId:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[workspaceId]);
 const {rows:[parser]}=await c.query('select p.* from parsers p join documents d on d.parser_id=p.id where d.id=$1 and d.workspace_id=$2 for update of p',[documentId,workspaceId]);
 return parser;
}

export async function detachSetupSource(c:PoolClient,parser:any,documentId:string){
 if(!parser||parser.field_setup_state==='ready'||!parser.field_setup_suggestion_id)return;
 if(!(await c.query('select 1 from schema_suggestions where id=$1 and document_id=$2',[parser.field_setup_suggestion_id,documentId])).rowCount)return;
 await failInitialSetup(c,parser,'The setup sample was deleted. Upload another sample or choose a document to retry.');
 await c.query('update parsers set field_setup_suggestion_id=null where id=$1',[parser.id]);
}
