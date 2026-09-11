import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import type {Resend,GetReceivingEmailResponseSuccess} from 'resend';
import {Webhook} from 'svix';
import {buildApp} from '../server/app.js';
import {adminPool,withWorkspace,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {addDocument} from '../server/core/intake.js';
import {processResendEvent,type ResendDependencies} from '../server/integrations/providers.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
let app:FastifyInstance,owner:Account,other:Account,archivedParser:string,emailParser:string;
const workspaceIds:string[]=[],userIds:string[]=[],suffix=randomUUID();
const eventId=`msg_policy_${suffix}`,storedEventId=`resend:${eventId}`,emailId=randomUUID(),routeId=randomUUID(),attachmentId=randomUUID();
const address=`policy-${suffix}@example.test`,sender='unlisted@example.test';
const webhookSecret=`whsec_${randomBytes(32).toString('base64')}`,priorWebhookSecret=process.env.RESEND_WEBHOOK_SECRET;
const bytes=Buffer.from('SYNTHETIC OWNED INTAKE POLICY FIXTURE\nReference: 000055');
async function request(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown,actor=owner){
 return app.inject({method,url,payload:payload as any,headers:{cookie:actor.cookie,origin:config.origin}});
}
async function signup(label:string):Promise<Account>{
 const response=await app.inject({method:'POST',url:'/api/auth/register',payload:{name:`Owned policy ${label}`,email:`policy-${label}-${suffix}@example.test`,password:'owned intake policy password',workspaceName:`Owned policy ${label}`},headers:{origin:config.origin}});
 assert.equal(response.statusCode,201,response.body);const body=response.json();workspaceIds.push(body.workspace.id);userIds.push(body.user.id);return {...body,cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};
}
async function uploadArchived(){
 const boundary=`policy-${randomUUID()}`;
 const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="archived-policy.txt"\r\nContent-Type: text/plain\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 return app.inject({method:'POST',url:`/api/parsers/${archivedParser}/documents`,payload,headers:{cookie:owner.cookie,origin:config.origin,'idempotency-key':`archived-${suffix}`,'content-type':`multipart/form-data; boundary=${boundary}`}});
}
async function assertNoIntake(){
 for(const table of ['documents','jobs','usage_ledger','intake_events','intake_files','file_deletions'])assert.equal((await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`,[owner.workspace.id])).rows[0].n,0,`${table} remains empty`);
 assert.deepEqual(await fs.readdir(path.join(config.storageDir,owner.workspace.id)).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error;}),[]);
}
before(async()=>{
 process.env.RESEND_WEBHOOK_SECRET=webhookSecret;
 app=await buildApp();await app.ready();owner=await signup('owner');other=await signup('other');
 // The intake policy fixture compares two active parsers independently of signup quotas.
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','2'::jsonb) where id=$1",[owner.workspace.id]);
 for(const name of ['Archived intake policy','Email sender policy']){const created=await request('POST','/api/parsers',{name,useCase:'custom',mode:'rules'});assert.equal(created.statusCode,201,created.body);if(name.startsWith('Archived'))archivedParser=created.json().parser.id;else emailParser=created.json().parser.id;}
});
after(async()=>{
 await app?.close();for(const id of workspaceIds){await adminPool.query('delete from workspaces where id=$1',[id]);await fs.rm(path.join(config.storageDir,id),{recursive:true,force:true});}
 for(const id of userIds)await adminPool.query('delete from users where id=$1',[id]);await adminPool.query('delete from provider_events where id=$1',[storedEventId]);
 if(priorWebhookSecret===undefined)delete process.env.RESEND_WEBHOOK_SECRET;else process.env.RESEND_WEBHOOK_SECRET=priorWebhookSecret;
 await closeDatabase();
});
test('archived parser rejects valid multipart and sample intake without persisting originals, jobs, usage or write reservations',async()=>{
 assert.equal((await request('PATCH',`/api/parsers/${archivedParser}`,{archived:true})).statusCode,200);
 assert.equal((await request('GET',`/api/parsers/${archivedParser}`)).json().parser.archived,true);
 const upload=await uploadArchived();assert.equal(upload.statusCode,404,upload.body);assert.match(upload.json().message,/Active parser not found/);await assertNoIntake();
 const sample=await request('POST',`/api/parsers/${archivedParser}/sample`,{});assert.equal(sample.statusCode,404,sample.body);assert.match(sample.json().message,/Active parser not found/);await assertNoIntake();
 assert.equal((await request('GET',`/api/parsers/${emailParser}`)).json().parser.archived,false);
});
test('a valid signed envelope from a disallowed sender is audited before body or attachment intake',async()=>{
 await adminPool.query('insert into email_routes(id,workspace_id,parser_id,address,provider_domain_id,created_by,domain_verified_at,allowed_senders) values($1,$2,$3,$4,$5,$6,now(),$7)',[routeId,owner.workspace.id,emailParser,address,'controlled-domain',owner.user.id,JSON.stringify(['allowed@example.test'])]);
 const timestamp=new Date(),raw=JSON.stringify({type:'email.received',data:{email_id:emailId,received_for:[address],subject:'PRIVATE CONTROLLED EMAIL CONTENT'}});
 const signed={'content-type':'application/json','svix-id':eventId,'svix-timestamp':String(Math.floor(timestamp.getTime()/1000)),'svix-signature':new Webhook(webhookSecret).sign(eventId,timestamp,raw)};
 const accepted=await app.inject({method:'POST',url:'/api/providers/resend/webhook',payload:raw,headers:signed});assert.equal(accepted.statusCode,202,accepted.body);assert.equal(accepted.json().duplicate,false);
 const pointer=(await adminPool.query('select payload from provider_events where id=$1',[storedEventId])).rows[0].payload;assert.deepEqual(pointer,{emailId,recipients:[address]});
 const email={id:emailId,from:`Unlisted sender <${sender}>`,to:[address],cc:[],bcc:[],received_for:[address],subject:'Owned sender policy',text:'Reference: EMAIL-000055',html:null,attachments:[{id:attachmentId,filename:'policy-attachment.txt',content_type:'text/plain',content_disposition:'attachment',size:bytes.length}],headers:{},created_at:new Date().toISOString(),message_id:eventId,reply_to:[]} as unknown as GetReceivingEmailResponseSuccess;
 let messageReads=0,metadataReads=0,downloads=0,intakes=0;
 const client={emails:{receiving:{get:async()=>{messageReads++;return {data:email,error:null};},attachments:{get:async()=>{metadataReads++;return {data:{download_url:'https://fixture.example.test/policy-attachment',size:bytes.length},error:null};}}}}} as unknown as Resend;
 const dependencies:ResendDependencies={client,download:async()=>{downloads++;return {status:200,bytes};},intake:async(...args)=>{intakes++;return addDocument(...args);}};
 await processResendEvent(storedEventId,pointer,dependencies);
 assert.deepEqual({messageReads,metadataReads,downloads,intakes},{messageReads:1,metadataReads:0,downloads:0,intakes:0});await assertNoIntake();
 const audit=(await request('GET','/api/workspace/audit')).json().events.find((entry:any)=>entry.action==='email.rejected');assert.ok(audit);assert.equal(audit.entityId,routeId);assert.deepEqual(audit.metadata,{reason:'Sender not on allowlist'});
 assert.equal((await adminPool.query('select last_received_at from email_routes where id=$1',[routeId])).rows[0].last_received_at,null);
 assert.equal((await adminPool.query('select * from provider_event_workspaces where event_id=$1 and workspace_id=$2',[storedEventId,owner.workspace.id])).rowCount,1);
 assert.equal((await withWorkspace(other.workspace.id,c=>c.query("select * from audit_events where action='email.rejected' and entity_id=$1",[routeId]))).rowCount,0);
 assert.ok(!(await request('GET','/api/workspace/audit',undefined,other)).json().events.some((entry:any)=>entry.entityId===routeId));
 // Positive control: the same otherwise valid envelope is accepted after the owned
 // route explicitly permits its sender. Both originals use real core intake.
 await adminPool.query('update email_routes set allowed_senders=$2 where id=$1',[routeId,JSON.stringify([sender])]);
 await processResendEvent(storedEventId,pointer,dependencies);
 assert.deepEqual({messageReads,metadataReads,downloads,intakes},{messageReads:2,metadataReads:1,downloads:1,intakes:2});
 assert.equal((await adminPool.query('select count(*)::int n from documents where workspace_id=$1 and parser_id=$2',[owner.workspace.id,emailParser])).rows[0].n,2);
 assert.equal((await adminPool.query('select count(*)::int n from usage_ledger where workspace_id=$1',[owner.workspace.id])).rows[0].n,2);
 assert.ok((await adminPool.query('select last_received_at from email_routes where id=$1',[routeId])).rows[0].last_received_at);
 assert.ok((await request('GET','/api/workspace/audit')).json().events.some((entry:any)=>entry.action==='email.received'&&entry.entityId===routeId));
});

test('an expired owned session rejects protected reads and intake without mutating data or invalidating the fresh session',async()=>{
 const token=randomUUID();
 await adminPool.query("insert into sessions(token_hash,user_id,workspace_id,expires_at) values($1,$2,$3,now()-interval '1 second')",[hashToken(token),owner.user.id,owner.workspace.id]);
 const counts=async()=>{const result:Record<string,number>={};for(const table of ['parsers','documents','jobs','usage_ledger','intake_events'])result[table]=(await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`,[owner.workspace.id])).rows[0].n;return result;};
 const before=await counts();
 for(const [method,url,payload] of [['GET','/api/parsers',undefined],['POST',`/api/parsers/${emailParser}/sample`,{}]] as const){
  const response=await app.inject({method,url,payload,headers:{cookie:`folio_session=${token}`,origin:config.origin}});
  assert.equal(response.statusCode,401,response.body);assert.match(response.json().message,/session has expired.*Sign in again/i);
 }
 assert.deepEqual(await counts(),before);
 const fresh=await request('GET',`/api/parsers/${emailParser}`);assert.equal(fresh.statusCode,200,fresh.body);assert.equal(fresh.json().parser.id,emailParser);
 const me=await request('GET','/api/auth/me');assert.equal(me.statusCode,200);assert.equal(me.json().user.id,owner.user.id);
});
