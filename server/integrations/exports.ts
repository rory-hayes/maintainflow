import type {FastifyInstance} from 'fastify';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireActor} from '../core/auth.js';
import {withWorkspace,audit,badRequest,notFound,camel} from '../core/db.js';
import {appendDocumentEvent} from '../core/document-events.js';
import {renderExport,type ExportRecord} from './export-format.js';

const columns = z.array(z.object({source:z.string().min(1).max(120),label:z.string().min(1).max(120)})).max(100);
const optionsSchema = z.object({format:z.enum(['csv','xlsx','json']),columns:columns.optional(),lineItems:z.string().max(100).optional()});
const exportSchema = optionsSchema.extend({documentIds:z.array(z.uuid()).min(1).max(100),revisions:z.array(z.object({documentId:z.uuid(),approvalId:z.uuid()})).max(100).optional()});
const hostedExportMaxBytes=4*1024*1024;
class HostedExportSizeError extends Error {
  statusCode=413;
  constructor(){super('This export is too large to download here. Select fewer documents and export again.');}
}
function checkHostedExportSize(bytes:Buffer){
  if(process.env.VERCEL==='1'&&bytes.byteLength>hostedExportMaxBytes)throw new HostedExportSizeError();
}

export async function registerExports(app:FastifyInstance, services:{render?:typeof renderExport}={}) {
  const render=services.render??renderExport;
  app.post('/api/exports',async request => {
    const actor=await requireActor(request,{scope:'results:read'});
    const {documentIds,revisions,...options}=exportSchema.parse(request.body);
    const outcome=await withWorkspace(actor.workspaceId,async client=> {
      const uniqueIds=[...new Set(documentIds)];
      // Lock in one stable order so approval, export and deletion cannot interleave.
      const found=await client.query(`SELECT d.id,d.name,d.approved_run_id FROM documents d WHERE d.id=ANY($1::uuid[]) AND d.workspace_id=$2 ORDER BY d.id FOR UPDATE OF d`,[uniqueIds,actor.workspaceId]);
      if(found.rows.length!==uniqueIds.length) notFound('One or more documents were not found.');
      const records:ExportRecord[]=[];
      for(const document of found.rows) {
        const selection=revisions?.find(r=>r.documentId===document.id);
        if(revisions&&!selection)badRequest('Select an approval revision for every exported document.');
        if(!selection&&!document.approved_run_id) badRequest('Approve every selected document before exporting.');
        const approval=await client.query(`SELECT a.*, (SELECT count(*)::int FROM corrections c WHERE c.run_id=a.run_id AND c.created_at<=a.created_at) revision FROM approvals a JOIN extraction_runs r ON r.id=a.run_id WHERE r.document_id=$1 AND a.workspace_id=$2 AND (($3::uuid is not null AND a.id=$3) OR ($3::uuid is null AND a.run_id=$4)) ORDER BY a.created_at DESC,a.id DESC LIMIT 1`,[document.id,actor.workspaceId,selection?.approvalId||null,document.approved_run_id]);
        if(!approval.rowCount) badRequest('An approved revision is no longer available.');
        const row=approval.rows[0];
        records.push({documentId:document.id,filename:document.name,runId:row.run_id,revision:row.revision,approvalId:row.id,correctionId:row.correction_id,values:row.values});
      }
      const id=randomUUID();
      const phase=async(state:'exporting'|'exported'|'failed',reason?:string)=> {
        for(const record of records)await appendDocumentEvent(client,actor.workspaceId,record.documentId,{
          phase:'export',state,operationId:id,
          details:{format:options.format,approvalId:record.approvalId,runId:record.runId,...(reason?{reason}:{})},
        });
      };
      await phase('exporting');
      // Keep the attempt journal if rendering or snapshot persistence fails, while
      // reverting all partial export writes and leaving processing status intact.
      await client.query('SAVEPOINT export_attempt');
      try {
        const rendered=await render(records,options);
        checkHostedExportSize(rendered.bytes);
        await client.query('INSERT INTO export_snapshots(id,workspace_id,created_by,format,document_ids,run_ids,records,options,mime_type,bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[id,actor.workspaceId,actor.userId,options.format,uniqueIds,records.map(r=>r.runId),JSON.stringify(records),JSON.stringify(options),rendered.mime,rendered.bytes]);
        await client.query("UPDATE documents SET status=case when approved_run_id=latest_run_id and status in('processed','exported') then 'exported' else status end,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[]) AND workspace_id=$2",[uniqueIds,actor.workspaceId]);
        await audit(client,actor.workspaceId,actor.userId,'export.created',id,{documentCount:records.length,format:options.format});
        await phase('exported');
        await client.query('RELEASE SAVEPOINT export_attempt');
        return {result:{id,downloadUrl:`/api/exports/${id}/download`,format:options.format,documentCount:records.length,revisions:records.map(r=>({documentId:r.documentId,approvalId:r.approvalId,runId:r.runId}))}};
      } catch(error) {
        await client.query('ROLLBACK TO SAVEPOINT export_attempt');
        const tooLarge=typeof error==='object'&&error!==null&&'statusCode' in error&&error.statusCode===413;
        const reason=error instanceof HostedExportSizeError?error.message:tooLarge
          ?'This export exceeds the supported size limits. Export a smaller selection.'
          :'Export generation failed. Try again or select another format.';
        await phase('failed',reason);
        await client.query('RELEASE SAVEPOINT export_attempt');
        return {failure:{reason,statusCode:tooLarge?413:500}};
      }
    });
    // Throw only after COMMIT so a handled export failure remains visible in history.
    if(outcome.failure)badRequest(outcome.failure.reason,outcome.failure.statusCode);
    return outcome.result;
  });
  app.get('/api/exports',async request=> {
    const actor=await requireActor(request,{scope:'results:read'});
    return withWorkspace(actor.workspaceId,async c=>({exports:(await c.query('SELECT id,format,document_ids,created_at FROM export_snapshots WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 100',[actor.workspaceId])).rows.map(camel)}));
  });
  app.get<{Params:{id:string}}>('/api/exports/:id/download',async(request,reply)=> {
    const actor=await requireActor(request,{scope:'results:read'});
    const id=z.uuid().parse(request.params.id);
    const row=await withWorkspace(actor.workspaceId,async c=>(await c.query('SELECT format,mime_type,bytes FROM export_snapshots WHERE id=$1 AND workspace_id=$2',[id,actor.workspaceId])).rows[0]);
    if(!row)notFound();
    checkHostedExportSize(row.bytes);
    return reply.header('Cache-Control','private, no-store').header('Content-Disposition',`attachment; filename="folio-export-${id.slice(0,8)}.${row.format}"`).type(row.mime_type).send(row.bytes);
  });
  app.get('/api/export-mappings',async request=> {
    const actor=await requireActor(request,{scope:'results:read'});
    return withWorkspace(actor.workspaceId,async c=>({mappings:(await c.query('SELECT * FROM export_mappings WHERE workspace_id=$1 ORDER BY created_at DESC',[actor.workspaceId])).rows.map(camel)}));
  });
  app.post('/api/export-mappings',async request=> {
    const actor=await requireActor(request,{roles:['owner','admin','editor'],scope:'parsers:write'});
    const input=z.object({parserId:z.uuid(),name:z.string().min(1).max(100),columns,lineItems:z.string().max(100).optional()}).parse(request.body);
    return withWorkspace(actor.workspaceId,async c=> {
      if(!(await c.query('SELECT id FROM parsers WHERE id=$1 AND workspace_id=$2',[input.parserId,actor.workspaceId])).rowCount)notFound();
      return camel((await c.query('INSERT INTO export_mappings(id,workspace_id,parser_id,name,columns,line_items) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),actor.workspaceId,input.parserId,input.name,JSON.stringify(input.columns),input.lineItems||null])).rows[0]);
    });
  });
  app.delete<{Params:{id:string}}>('/api/export-mappings/:id',async request=> {
    const actor=await requireActor(request,{roles:['owner','admin','editor'],scope:'parsers:write'});
    return withWorkspace(actor.workspaceId,async c=>({deleted:Boolean((await c.query('DELETE FROM export_mappings WHERE id=$1 AND workspace_id=$2',[z.uuid().parse(request.params.id),actor.workspaceId])).rowCount)}));
  });
}
