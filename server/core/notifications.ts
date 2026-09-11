import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {requireActor,requireSession} from './auth.js';
import {withWorkspace} from './db.js';

export async function registerNotifications(app:FastifyInstance){
 app.get('/api/workspace/notifications',async request=>{
  const actor=await requireActor(request);requireSession(actor);
  return withWorkspace(actor.workspaceId,async c=>{
   const {rows:[workspace]}=await c.query('select settings from workspaces where id=$1',[actor.workspaceId]);
   if(workspace.settings.notifications===false)return {enabled:false,unreadCount:0,notifications:[]};
   const {rows}=await c.query(`select j.id,d.id document_id,d.name,j.state,j.updated_at,
    (r.job_id is not null and r.state=j.state) is_read
    from jobs j join documents d on d.id=j.document_id and d.workspace_id=j.workspace_id
    left join notification_reads r on r.job_id=j.id and r.user_id=$2
    where j.workspace_id=$1 and j.state in('completed','failed')
    order by j.updated_at desc,j.id limit 50`,[actor.workspaceId,actor.userId]);
   const {rows:[count]}=await c.query(`select count(*)::int unread from jobs j
    where j.workspace_id=$1 and j.state in('completed','failed')
    and not exists(select 1 from notification_reads r where r.job_id=j.id and r.user_id=$2 and r.state=j.state)`,[actor.workspaceId,actor.userId]);
   return {enabled:true,unreadCount:count.unread,notifications:rows.map(row=>({
    id:row.id,documentId:row.document_id,documentName:row.name,
    kind:row.state==='completed'?'ready_for_review':'processing_failed',
    occurredAt:row.updated_at,read:row.is_read,
   }))};
  });
 });
 app.post('/api/workspace/notifications/read',async request=>{
  const actor=await requireActor(request);requireSession(actor);
  const input=z.object({jobIds:z.array(z.uuid()).min(1).max(100).optional()}).strict().parse(request.body||{});
  return withWorkspace(actor.workspaceId,async c=>{
   // Query-derived IDs make guessed foreign/queued job IDs inert. No document/job mutation.
   const result=await c.query(`insert into notification_reads(workspace_id,job_id,user_id,state)
    select j.workspace_id,j.id,$2,j.state from jobs j
    where j.workspace_id=$1 and j.state in('completed','failed') and ($3::uuid[] is null or j.id=any($3::uuid[]))
    on conflict(job_id,user_id) do update set state=excluded.state,read_at=clock_timestamp()
    returning job_id`,[actor.workspaceId,actor.userId,input.jobIds||null]);
   return {markedRead:result.rowCount};
  });
 });
}
