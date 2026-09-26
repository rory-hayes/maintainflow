import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {bankLocales,bankReview,setupBankStatements} from './bank-statement-service.js';
import {documentDetail} from './document-routes.js';
import {editors,requireActor} from './auth.js';
import {camel,notFound,withWorkspace} from './db.js';
import {resolveRun} from './runs.js';
import {aiConfigured} from './worker.js';
import {config} from './config.js';
import type {BankValues} from '../../shared/bank-statements.js';

export async function registerBankStatements(app:FastifyInstance){
 app.post('/api/bank-statements/setup',async req=>{
  const actor=await requireActor(req,{roles:editors,scope:'parsers:write'}),body=z.object({locale:z.enum(bankLocales).optional()}).strict().parse(req.body??{});
  return setupBankStatements(actor,body.locale);
 });
 app.get('/api/bank-statements',async req=>{
  const actor=await requireActor(req,{scope:'documents:read'}),query=z.object({page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(50),search:z.string().max(150).default('')}).parse(req.query);
  return withWorkspace(actor.workspaceId,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
   const parser=(await c.query("select * from parsers where workspace_id=$1 and use_case='bank_statement' and not archived order by created_at,id limit 1",[actor.workspaceId])).rows[0];
   const workspace=(await c.query('select plan from workspaces where id=$1',[actor.workspaceId])).rows[0];
   const search=`%${query.search.replace(/[\\%_]/g,'\\$&')}%`;
   const total=(await c.query("select count(*)::integer total from documents d join parsers p on p.id=d.parser_id where d.workspace_id=$1 and p.use_case='bank_statement' and d.name ilike $2",[actor.workspaceId,search])).rows[0].total;
   const rows=(await c.query("select d.id,d.name,d.status,d.page_count,d.mime_type,d.error,d.approved_run_id,d.latest_run_id,d.created_at,d.updated_at from documents d join parsers p on p.id=d.parser_id where d.workspace_id=$1 and p.use_case='bank_statement' and d.name ilike $2 order by d.created_at desc,d.id desc limit $3 offset $4",[actor.workspaceId,search,query.pageSize,(query.page-1)*query.pageSize])).rows;
   const documents=[];
   for(const document of rows){const approval=document.approved_run_id?(await c.query('select id from approvals where run_id=$1 and workspace_id=$2 and bank_review is not null order by created_at desc,id desc limit 1',[document.approved_run_id,actor.workspaceId])).rows[0]:undefined;let bankSummary={accountCount:0,transactionCount:0,errorCount:0,warningCount:0,approvalId:approval?.id??null,approvedRunId:approval?document.approved_run_id:null};
    if(document.latest_run_id){const run=await resolveRun(c,document.latest_run_id);if(run.bank_statement_context){const values=run.effectiveValues as BankValues,review=await bankReview(c,run),accounts=values.accounts.filter(account=>!account.excluded);bankSummary={accountCount:accounts.length,transactionCount:accounts.reduce((count,account)=>count+account.transactions.filter(row=>!row.excluded).length,0),errorCount:review.issues.filter(issue=>issue.severity==='error').length,warningCount:review.issues.filter(issue=>issue.severity==='warning').length,approvalId:approval?.id??null,approvedRunId:approval?document.approved_run_id:null};}}
    documents.push({...camel(document),bankSummary});
   }
   return {documents,parser:parser?camel(parser):null,limits:{maxFiles:20,maxBytes:Math.min(config.maxBytes,workspace.plan.maxBytes),maxPages:Math.min(config.maxPages,workspace.plan.maxPages)},providerConfigured:aiConfigured(),total,page:query.page,pageSize:query.pageSize};
  });
 });
 app.get('/api/bank-statements/:documentId',async req=>{
  const actor=await requireActor(req,{scope:'documents:read'}),{documentId}=z.object({documentId:z.string().uuid()}).parse(req.params);
  return withWorkspace(actor.workspaceId,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
   if(!(await c.query("select 1 from documents d join parsers p on p.id=d.parser_id where d.id=$1 and d.workspace_id=$2 and p.use_case='bank_statement'",[documentId,actor.workspaceId])).rowCount)notFound('Bank statement not found');
   return documentDetail(c,actor.workspaceId,documentId);
  });
 });
}
