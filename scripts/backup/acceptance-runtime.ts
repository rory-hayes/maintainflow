/** Fresh-process fixture/runtime verification for verify-backup-restore.ts. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import type {BackupConfig} from './types.js';

const [phase,configPath,run]=process.argv.slice(2) as [string,string,string];
assert.ok(['seed','blocked','verify'].includes(phase));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
assert.equal(path.dirname(run),path.join(root,'.local/backup-restore-2026-09-20/runs'));
const cfg:BackupConfig=JSON.parse(await fs.readFile(configPath,'utf8'));
assert.equal(cfg.database.host,path.join(await fs.realpath('/tmp'),`fbr-${path.basename(run).slice(0,8)}`));assert.equal(cfg.database.port,55439);assert.equal(cfg.schema,'folio');
assert.ok(['backup_source','backup_target'].includes(cfg.database.database));
assert.equal(process.cwd(),path.join(run,'empty-cwd'));assert.deepEqual(await fs.readdir(process.cwd()),[]);
process.umask(0o077);
const require=createRequire(import.meta.url);require('dotenv').config=()=>({parsed:{}});
for(const key of Object.keys(process.env))if(/(?:API_KEY|TOKEN|SECRET|PASSWORD|^DATABASE_|^PG|^SUPABASE_|^RESEND_|^GOOGLE_|^STRIPE_|^OPENAI_|^VERCEL|^FOLIO_|^INTEGRATION_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',PGHOST:cfg.database.host,PGPORT:String(cfg.database.port),PGDATABASE:cfg.database.database,PGADMINUSER:cfg.adminRole,PGUSER:cfg.appRole,DATABASE_SCHEMA:cfg.schema,DATABASE_POOL_MAX:'2',STORAGE_DRIVER:'filesystem',STORAGE_DIR:cfg.storageDir,INTEGRATION_ENCRYPTION_KEY_FILE:cfg.integrationKeyFile,APP_ORIGIN:'http://127.0.0.1:4399',FOLIO_BILLING_MOCK:'true',FOLIO_PREVIEW_MODE:'false',FOLIO_REQUIRE_EMAIL_VERIFICATION:'false',LOG_LEVEL:'silent'});
let forbiddenNetwork=0;
const blocked=()=>{forbiddenNetwork++;throw new Error('External transport disabled in owned backup acceptance');};
globalThis.fetch=async()=>blocked();
for(const name of ['node:http','node:https']){const module=require(name);module.request=blocked;module.get=blocked;}
require('node:dgram').createSocket=blocked;require('node:dns').lookup=blocked;
const net=require('node:net'),originalConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args:any[]){const value=args[0],socket=typeof value==='string'?value:value?.path;if(socket!==cfg.database.host+'/.s.PGSQL.55439')return blocked();return originalConnect.apply(this,args);};
syncBuiltinESMExports();
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const write=(name:string,data:unknown)=>fs.writeFile(path.join(run,name),JSON.stringify(data,null,2)+'\n',{mode:0o600});
if(phase==='seed'){
 const owner=new pg.Client(cfg.database);await owner.connect();
 try{await owner.query('CREATE SCHEMA folio AUTHORIZATION backup_owner');const {buildMigrationSql,readMigrations}=await import('../migrate.js');await owner.query(buildMigrationSql(await readMigrations(path.join(root,'migrations')),{schema:cfg.schema,adminRole:cfg.adminRole,appRole:cfg.appRole}));}finally{await owner.end();}
}
const db=await import('../../server/core/db.js');
const {buildApp}=await import('../../server/app.js');
const worker=await import('../../server/core/worker.js');
const splitSuggestions=await import('../../server/core/split-suggestions.js');
let controlledSplitCalls=0;
function configureControlledSplitSuggestions(){
 splitSuggestions.setSplitSuggestionProvider({configured:()=>true,suggest:async input=>{
  controlledSplitCalls++;assert.ok(input.pages.length>=1);
  if(input.mimeType==='image/tiff'){assert.equal(input.visualDocument?.sourceSha256,hash(input.bytes));assert.equal(input.visualDocument?.pageCount,input.pages.length);assert.equal(input.visualDocument?.mimeType,'application/pdf');}
  return {startPages:input.pages.length>1?[1,input.pages.length]:[1],model:'controlled-backup-split-model',promptVersion:'controlled-backup-split-v1',tokenUsage:{inputTokens:100,outputTokens:10,totalTokens:110},costUsd:0.000123};
 }});
}
const suggestionPath=(parserId:string)=>`/api/parsers/${parserId}/split-suggestions`;
async function suggestionRows(workspaceId:string){return JSON.parse(JSON.stringify((await db.adminPool.query('select * from split_suggestions where workspace_id=$1 order by id',[workspaceId])).rows));}
const {encryptSecret,decryptSecret}=await import('../../server/integrations/secrets.js');
let app:Awaited<ReturnType<typeof buildApp>>|undefined;
const checks:Record<string,boolean>={};
type Account={user:{id:string};workspace:{id:string};cookie:string;email:string;password:string};
const headers=(a:Account)=>({origin:process.env.APP_ORIGIN!,cookie:a.cookie});
async function request(a:Account,method:any,url:string,payload?:any,extra:Record<string,string>={}){return app!.inject({method,url,payload,headers:{...headers(a),...extra}});}
function ok(response:any,status=200){assert.equal(response.statusCode,status,`Owned ${response.request?.method??'API'} request expected ${status}, got ${response.statusCode}: ${response.json().message??''}`);return response.json();}
function multipart(bytes:Buffer,name:string,fields:Record<string,string>={}){
 const boundary='backup-'+randomUUID();return{payload:Buffer.concat([...Object.entries(fields).map(([key,value])=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)),Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]),headers:{'content-type':`multipart/form-data; boundary=${boundary}`}};
}
async function upload(a:Account,parser:string,bytes:Buffer,name:string,fields:Record<string,string>={},suffix='documents',idempotency?:string){const data=multipart(bytes,name,fields);return ok(await request(a,'POST',`/api/parsers/${parser}/${suffix}`,data.payload,{...data.headers,...(idempotency?{'idempotency-key':idempotency}:{})}),202);}
async function download(a:Account,url:string){const r=await request(a,'GET',url);assert.equal(r.statusCode,200);assert.match(String(r.headers['cache-control']),/private/);return r.rawPayload;}
async function login(a:Account){const r=await app!.inject({method:'POST',url:'/api/auth/login',headers:{origin:process.env.APP_ORIGIN!},payload:{email:a.email,password:a.password}});const value=ok(r);assert.equal(value.user.id,a.user.id);return{...a,cookie:r.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};}
async function ledger(){return(await db.adminPool.query('select id::text,event,pages,idempotency_key from usage_ledger order by id')).rows;}
let forbiddenExtractionCalls=0;
function refuseExtractionProvider(){worker.setExtractionProvider({configured:()=>true,extract:async()=>{forbiddenExtractionCalls++;throw new Error('Native backup fixture must not call an extraction provider');}});}
async function templateState(parserId:string){
 const state:Record<string,unknown>={};
 for(const table of ['templates','template_mutations'])state[table]=JSON.parse(JSON.stringify((await db.adminPool.query(`select * from ${table} where parser_id=$1 order by id`,[parserId])).rows));
 return state;
}
async function seedNativeTemplates(owner:Account){
 // Fixture-only capacity for the existing parser, region parser and copy. This
 // isolated cluster never changes a user's billing plan or contacts billing.
 await db.adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','3') where id=$1",[owner.workspace.id]);
 const nativeSchema={fields:[{key:'reference',label:'Reference',type:'string',required:true},{key:'amount',label:'Amount',type:'currency',required:true},{key:'paid',label:'Paid',type:'boolean',required:true}]};
 const created=ok(await request(owner,'POST','/api/parsers',{name:'Owned native region restore parser',mode:'ai',useCase:'custom',schema:nativeSchema}),201),parserId=created.parser.id,schemaId=created.schema.id;
 const {PDFDocument,StandardFonts}=await import('pdf-lib');
 const source=async(reference:string)=>{const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([500,500]);for(const [index,[label,value]] of [['Reference',reference],['Amount','0.00'],['Paid','false']].entries()){page.drawText(label,{x:40,y:420-index*70,size:16,font});page.drawText(value,{x:220,y:420-index*70,size:16,font});}return Buffer.from(await pdf.save());};
 const bytes=await source('000042'),queuedBytes=await source('PINNED-000043');
 const {readPdfGeometry}=await import('../../server/core/source.js'),{findPdfRegionAnchor}=await import('../../shared/pdf-regions.js'),geometry=await readPdfGeometry(bytes),page=geometry.pages[0];
 const rules=[['reference','Reference'],['amount','Amount'],['paid','Paid']].map(([field,anchor],index)=>{const match=findPdfRegionAnchor(page,anchor);assert.ok(match.matched);return {field,anchor,page:1,reference:{width:page.width,height:page.height,rotation:page.rotation},offset:{x:220/500-match.anchor.rect.x-.002,y:-.002,width:.4,height:.04}};});
 const definition={kind:'native-pdf-region-v1',name:'Pinned source region revision',enabled:true,matchText:'',rules},createBody={...definition,requestId:randomUUID(),baseSchemaId:schemaId};
 const saved=ok(await request(owner,'POST',`/api/parsers/${parserId}/templates`,createBody));assert.equal(saved.template.revision,1);
 refuseExtractionProvider();
 const completed=await upload(owner,parserId,bytes,'native-completed.pdf');assert.equal(await worker.processOneCoreJob(completed.jobId),true);
 const detail=ok(await request(owner,'GET',`/api/documents/${completed.document.id}`)),run=detail.runs[0];
 assert.equal(run.engine,'native-pdf-regions');assert.deepEqual(run.normalizedValues,{reference:'000042',amount:0,paid:false});assert.equal(run.templateSnapshot.template.revision,1);assert.deepEqual(run.templateSnapshot.template.rules,rules);assert.equal(run.evidence.reference[0].source,'matched-region');assert.equal(run.evidence.reference[0].region.sourceSha256,hash(bytes));
 const approval=ok(await request(owner,'POST',`/api/runs/${run.id}/approve`,{expectedRevision:run.effectiveRevision})).approval,exports=[];
 for(const format of ['csv','xlsx','json']){const data=ok(await request(owner,'POST','/api/exports',{format,documentIds:[completed.document.id],revisions:[{documentId:completed.document.id,approvalId:approval.id}],columns:[{source:'reference',label:'Reference'},{source:'amount',label:'Amount'},{source:'paid',label:'Paid'}]}));exports.push({format,...data,sha256:hash(await download(owner,data.downloadUrl))});}
 const queued=await upload(owner,parserId,queuedBytes,'native-queued.pdf'),pinned=(await db.adminPool.query('select config from jobs where id=$1',[queued.jobId])).rows[0].config;
 assert.equal(pinned.templatePolicy,'complete-regions-v1');assert.equal(pinned.templates[0].revision,1);assert.equal(pinned.templates[0].enabled,true);
 const updateBody={...definition,name:'Current edited and disabled region',enabled:false,requestId:randomUUID(),baseSchemaId:schemaId,baseRevision:1};
 const updated=ok(await request(owner,'PATCH',`/api/templates/${saved.template.id}`,updateBody));assert.equal(updated.template.revision,2);
 const copy=ok(await request(owner,'POST',`/api/parsers/${parserId}/copy`,{name:'Copied native region configuration'}),201);assert.equal(copy.templates.length,1);assert.notEqual(copy.templates[0].id,saved.template.id);assert.equal(copy.templates[0].kind,'native-pdf-region-v1');assert.equal(copy.templates[0].revision,1);assert.deepEqual(copy.templates[0].rules,rules);
 const closedRequestId=randomUUID();assert.equal(ok(await request(owner,'POST',`/api/parsers/${parserId}/template-mutations/requests/${closedRequestId}/close`,{})).mutation.state,'closed');
 assert.equal(forbiddenExtractionCalls,0);
 return {parserId,schemaId,definition,createBody,updateBody,templateId:saved.template.id,closedRequestId,completed,queued,pinned,run:ok(await request(owner,'GET',`/api/documents/${completed.document.id}`)).runs[0],approvalId:approval.id,exports,copy,sourceSha256:hash(bytes),queuedSha256:hash(queuedBytes),savedState:await templateState(parserId),copyState:await templateState(copy.parser.id)};
}
async function verifyNativeTemplates(owner:Account,other:Account,native:any,usage:unknown){
 assert.deepEqual(await templateState(native.parserId),native.savedState);assert.deepEqual(await templateState(native.copy.parser.id),native.copyState);
 const before=ok(await request(owner,'GET',`/api/documents/${native.completed.document.id}`));assert.deepEqual(before.runs[0],native.run);assert.equal(hash(await download(owner,`/api/documents/${native.completed.document.id}/original`)),native.sourceSha256);
 for(const entry of native.exports){const bytes=await download(owner,entry.downloadUrl);assert.equal(hash(bytes),entry.sha256);assert.equal((await request(other,'GET',entry.downloadUrl)).statusCode,404);if(entry.format==='csv')assert.equal(bytes.toString(),'\uFEFF"Reference","Amount","Paid"\r\n"000042","0","false"\r\n');if(entry.format==='json')assert.deepEqual(JSON.parse(bytes.toString()).documents[0].values,{reference:'000042',amount:0,paid:false});}
 checks.nativeRegionDefinitionsSnapshotsEvidenceAndApprovedExports=true;
 const createReplay=ok(await request(owner,'POST',`/api/parsers/${native.parserId}/templates`,native.createBody));assert.equal(createReplay.mutation.replayed,true);assert.equal(createReplay.mutation.acceptedRevision,1);assert.equal(createReplay.mutation.currentRevision,2);assert.equal(createReplay.template.id,native.templateId);assert.equal(createReplay.template.enabled,true);
 const updateReplay=ok(await request(owner,'PATCH',`/api/templates/${native.templateId}`,native.updateBody));assert.equal(updateReplay.mutation.replayed,true);assert.equal(updateReplay.mutation.acceptedRevision,2);
 const closed=ok(await request(owner,'GET',`/api/parsers/${native.parserId}/template-mutations/requests/${native.closedRequestId}`));assert.equal(closed.mutation.state,'closed');assert.equal((await request(owner,'POST',`/api/parsers/${native.parserId}/templates`,{...native.createBody,requestId:native.closedRequestId})).statusCode,410);
 assert.equal((await request(other,'GET',`/api/parsers/${native.parserId}/template-mutations/requests/${native.createBody.requestId}`)).statusCode,404);assert.deepEqual(await templateState(native.parserId),native.savedState);assert.deepEqual(await ledger(),usage);
 checks.nativeTemplateMutationReplayClosureAndIndependentParserCopy=true;
 const pinned=(await db.adminPool.query('select config from jobs where id=$1',[native.queued.jobId])).rows[0].config;assert.deepEqual(pinned,native.pinned);assert.equal(hash(await download(owner,`/api/documents/${native.queued.document.id}/original`)),native.queuedSha256);
 refuseExtractionProvider();assert.equal(await worker.processOneCoreJob(native.queued.jobId),true);assert.equal(await worker.processOneCoreJob(native.queued.jobId),false);
 const after=ok(await request(owner,'GET',`/api/documents/${native.queued.document.id}`));assert.equal(after.jobs[0].attempts,1);assert.equal(after.runs.length,1);assert.deepEqual(after.runs[0].normalizedValues,{reference:'PINNED-000043',amount:0,paid:false});assert.equal(after.runs[0].engine,'native-pdf-regions');assert.equal(after.runs[0].templateSnapshot.template.id,native.templateId);assert.equal(after.runs[0].templateSnapshot.template.revision,1);assert.equal(after.runs[0].templateSnapshot.template.enabled,true);assert.deepEqual(after.runs[0].templateSnapshot.template.rules,native.definition.rules);assert.equal(after.runs[0].evidence.reference[0].region.sourceSha256,native.queuedSha256);assert.equal(forbiddenExtractionCalls,0);assert.deepEqual(await ledger(),usage);
 assert.deepEqual(ok(await request(owner,'GET',`/api/documents/${native.completed.document.id}`)).runs[0],native.run);checks.queuedNativeRegionUsesPinnedRevisionOnceWithoutAiOrRecharging=true;
}
async function bankIndexState(workspaceId:string){
 return {accounts:(await db.adminPool.query('select workspace_id,document_id,run_id,revision,account_id,account_key,currency,statement_start::text,statement_end::text from bank_statement_accounts where workspace_id=$1 order by document_id,account_id',[workspaceId])).rows,
  transactions:(await db.adminPool.query('select * from bank_statement_transactions where workspace_id=$1 order by document_id,transaction_id',[workspaceId])).rows};
}
async function seedBankStatements(owner:Account){
 await db.adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','4') where id=$1",[owner.workspace.id]);
 const {bankRawFixture,setBankFixtureProvider}=await import('../../tests/bank-statement-fixtures.js');
 const parser=ok(await request(owner,'POST','/api/bank-statements/setup',{locale:'en-IE'})).parser,raw=bankRawFixture(),documents=[];
 for(const label of ['first','related']){const source=await upload(owner,parser.id,Buffer.from('SYNTHETIC BANK RESTORE '+label),'synthetic-bank-'+label+'.txt');setBankFixtureProvider(raw);assert.equal(await worker.processOneCoreJob(source.jobId),true);documents.push(source);}
 worker.setExtractionProvider(undefined);
 let run=ok(await request(owner,'GET',`/api/bank-statements/${documents[0].document.id}`)).runs[0];const values=structuredClone(run.bankValues);values.accounts[0].transactions[0].description='Corrected wrapped description\nPreserved after restore';
 run=ok(await request(owner,'POST',`/api/runs/${run.id}/corrections`,{values,expectedRevision:run.effectiveRevision})).run;
 assert.ok(run.bankIssues.some((issue:any)=>issue.code==='possible_duplicate_transaction'));assert.ok(run.bankIssues.some((issue:any)=>issue.code==='statement_period_overlap'));
 const approval=ok(await request(owner,'POST',`/api/runs/${run.id}/approve`,{expectedRevision:run.effectiveRevision,bankReviewToken:run.bankReviewToken,acknowledgeBankWarnings:true})).approval;
 const exports=[];for(const format of ['csv','xlsx']){const result=ok(await request(owner,'POST','/api/exports',{workflow:'bank_statement',format,documentIds:[documents[0].document.id],revisions:[{documentId:documents[0].document.id,approvalId:approval.id}]}));exports.push({...result,format,sha256:hash(await download(owner,result.downloadUrl))});}
 const runs=[];for(const source of documents)runs.push(ok(await request(owner,'GET',`/api/bank-statements/${source.document.id}`)).runs[0]);
 const indexes=await bankIndexState(owner.workspace.id);assert.equal(indexes.accounts.length,2);assert.equal(indexes.transactions.length,4);assert.ok(indexes.accounts.every(row=>row.statement_start==='2026-09-01'&&row.statement_end==='2026-09-30'));
 // An aged cleaned capability has no active signed upload or staging object, but
 // its chosen locale must survive the same binary table capture as live columns.
 const uploadId=randomUUID(),first=documents[0];
 const reservation=(await db.adminPool.query("insert into direct_uploads(id,workspace_id,parser_id,created_by,storage_key,filename,expected_bytes,expected_sha256,state,document_id,job_id,bank_locale,expires_at,cleanup_after) values($1,$2,$3,$4,$5,'',1,$6,'cleaned',$7,$8,'en-IE',now()-interval '1 day',now()-interval '1 day') returning id,document_id,job_id,bank_locale,state",[uploadId,owner.workspace.id,parser.id,owner.user.id,owner.workspace.id+'/'+uploadId,hash('synthetic cleaned upload'),first.document.id,first.jobId])).rows[0];
 return {parser,documents,runs,indexes,exports,approval,reservation};
}
async function verifyBankStatements(owner:Account,other:Account,bank:any){
 assert.deepEqual(await bankIndexState(owner.workspace.id),bank.indexes);
 assert.deepEqual((await db.adminPool.query('select id,document_id,job_id,bank_locale,state from direct_uploads where id=$1',[bank.reservation.id])).rows[0],bank.reservation);
 for(const [index,source] of bank.documents.entries()){const current=ok(await request(owner,'GET',`/api/bank-statements/${source.document.id}`)).runs[0];assert.deepEqual(current,bank.runs[index]);assert.equal((await request(other,'GET',`/api/bank-statements/${source.document.id}`)).statusCode,404);}
 await db.withWorkspace(other.workspace.id,async c=>{assert.equal((await c.query('select 1 from bank_statement_accounts where workspace_id=$1',[owner.workspace.id])).rowCount,0);assert.equal((await c.query('select 1 from bank_statement_transactions where workspace_id=$1',[owner.workspace.id])).rowCount,0);});
 checks.bankDateIndexesContextsIdentitiesCorrectionsApprovalsAndTenantIsolation=true;
 for(const entry of bank.exports){const bytes=await download(owner,entry.downloadUrl);assert.equal(hash(bytes),entry.sha256);assert.equal((await request(other,'GET',entry.downloadUrl)).statusCode,404);if(entry.format==='csv'){assert.match(bytes.toString(),/Corrected wrapped description/);assert.match(bytes.toString(),/00001234/);assert.match(bytes.toString(),/20\.00/);}}
 checks.bankExactApprovedCsvExcelSnapshotsSurviveRestore=true;
 const before=bank.runs[0],related=bank.runs[1],values=structuredClone(related.bankValues);values.accounts[0].statement_start='2026-08-31';
 ok(await request(owner,'POST',`/api/runs/${related.id}/corrections`,{values,expectedRevision:related.effectiveRevision}));
 assert.equal((await request(owner,'POST',`/api/runs/${before.id}/approve`,{expectedRevision:before.effectiveRevision,bankReviewToken:before.bankReviewToken,acknowledgeBankWarnings:true})).statusCode,409);
 const refreshed=ok(await request(owner,'GET',`/api/bank-statements/${bank.documents[0].document.id}`)).runs[0];assert.deepEqual(refreshed.bankIssues,before.bankIssues);assert.notEqual(refreshed.bankReviewToken,before.bankReviewToken);
 assert.deepEqual((await db.adminPool.query('select values,bank_review from approvals where id=$1',[bank.approval.id])).rows[0],{values:bank.approval.values,bank_review:bank.approval.bankReview});
 for(const entry of bank.exports)assert.equal(hash(await download(owner,entry.downloadUrl)),entry.sha256);
 checks.bankRestoredCrossFileWarningsRequireFreshAcknowledgement=true;
}
try{
 for(const [pool,role]of [[db.adminPool,cfg.adminRole],[db.appPool,cfg.appRole]] as const){const r=(await pool.query("select current_database() db,current_schema() schema,current_user role,inet_server_addr() address")).rows[0];assert.equal(r.db,cfg.database.database);assert.equal(r.schema,'folio');assert.equal(r.role,role);assert.equal(r.address,null);}
 if(phase==='blocked'){
  assert.ok(await fs.stat(path.join(cfg.storageDir,'.folio-restore-pending.json')));
  let apiRefused=false,workerRefused=false;
  const pendingMessage='This restored instance is inactive. Verify and activate the backup before starting MaintainFlow.';
  const isPending=(error:any)=>{assert.equal(error?.code,'FOLIO_RESTORE_PENDING');assert.equal(error?.message,pendingMessage);return true;};
  await assert.rejects(async()=>{app=await buildApp();await app.ready();},isPending);apiRefused=true;
  await assert.rejects(worker.processOneCoreJob(randomUUID()),isPending);
  await assert.rejects(splitSuggestions.processOneSplitSuggestion(randomUUID()),isPending);
  await assert.rejects(splitSuggestions.reconcileExpiredSplitSuggestions(),isPending);
  const {processOneSchemaSuggestion}=await import('../../server/core/schema-suggestions.js');
  await assert.rejects(processOneSchemaSuggestion(randomUUID()),isPending);
  // If a regression starts the loop, stop it promptly and fail rather than hanging or advancing further jobs.
  const timeout=setTimeout(()=>process.emit('SIGINT'),1000);
  try{await assert.rejects(worker.startWorker(),isPending);workerRefused=true;}finally{clearTimeout(timeout);}
  assert.equal(apiRefused,true,'Fresh API refuses pending restore');assert.equal(workerRefused,true,'Fresh worker refuses pending restore');
  await write('runtime-blocked.json',{apiRefused,workerRefused,forbiddenNetwork});
 }else{
 app=await buildApp();await app.ready();
 const schema={fields:[{key:'reference',label:'Reference',type:'string',required:true},{key:'amount',label:'Amount',type:'currency',required:true},{key:'paid',label:'Paid',type:'boolean',required:true},{key:'missing_date',label:'Missing date',type:'date'}]};
 const columns=[{source:'reference',label:'Reference'},{source:'amount',label:'Amount'},{source:'paid',label:'Paid'},{source:'missing_date',label:'Missing date'}];
 const sourceText='SYNTHETIC OWNED BACKUP DOCUMENT\nReference: 000042\nAmount: 12.50\nPaid: no';
 if(phase==='seed'){
  const accounts:Account[]=[];
  for(const label of ['primary','other']){const email=`backup-${label}-${randomUUID()}@example.test`,password=randomBytes(24).toString('base64url');const r=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:process.env.APP_ORIGIN!},payload:{name:'Synthetic backup '+label,email,password,workspaceName:'Synthetic backup '+label}});const a=ok(r,201);accounts.push({...a,email,password,cookie:r.cookies.map(c=>`${c.name}=${c.value}`).join('; ')});}
  const [owner,other]=accounts as [Account,Account];
  const parser=ok(await request(owner,'POST','/api/parsers',{name:'Owned restore parser',useCase:'custom',mode:'rules',schema}),201).parser;
  const otherParser=ok(await request(other,'POST','/api/parsers',{name:'Other tenant parser',useCase:'custom',mode:'rules',schema}),201).parser;
  const ordinary=await upload(owner,parser.id,Buffer.from(sourceText),'ordinary.txt',{},'documents','owned-backup-ordinary');assert.ok(ordinary.jobId);assert.equal(await worker.processOneCoreJob(ordinary.jobId),true);
  const detail=ok(await request(owner,'GET',`/api/documents/${ordinary.document.id}`)),runDetail=detail.runs[0];assert.deepEqual(runDetail.normalizedValues,{reference:'000042',amount:12.5,paid:false,missing_date:null});
  const corrected={reference:'CORRECTED-000042',amount:0,paid:false,missing_date:null};
  const correction=ok(await request(owner,'POST',`/api/runs/${runDetail.id}/corrections`,{expectedRevision:runDetail.effectiveRevision,values:corrected}));
  const approval=ok(await request(owner,'POST',`/api/runs/${runDetail.id}/approve`,{expectedRevision:correction.run.effectiveRevision})).approval;
  const exports=[];
  for(const format of ['csv','xlsx','json']){const data=ok(await request(owner,'POST','/api/exports',{format,documentIds:[ordinary.document.id],revisions:[{documentId:ordinary.document.id,approvalId:approval.id}],columns}));const bytes=await download(owner,data.downloadUrl);exports.push({format,id:data.id,downloadUrl:data.downloadUrl,sha256:hash(bytes)});if(format==='csv')assert.equal(bytes.toString(),'\uFEFF"Reference","Amount","Paid","Missing date"\r\n"CORRECTED-000042","0","false",""\r\n');if(format==='json')assert.deepEqual(JSON.parse(bytes.toString()).documents[0].values,corrected);}
  const template=ok(await request(owner,'POST',`/api/parsers/${parser.id}/templates`,{name:'Disabled preserved template',matchText:'SYNTHETIC',rules:[{field:'reference',anchor:'Reference'}],enabled:false}));
  const mapping=ok(await request(owner,'POST','/api/export-mappings',{parserId:parser.id,name:'Preserved typed columns',columns}));
  const schema2=ok(await request(owner,'POST',`/api/parsers/${parser.id}/schema`,schema)).schema;
  const queued=await upload(owner,parser.id,Buffer.from(sourceText.replace('000042','QUEUED-42')),'queued.txt');
  const odtBytes=await fs.readFile(path.join(root,'fixtures/source-formats/synthetic-receipt.odt'));
  const odtQueued=await upload(owner,parser.id,odtBytes,'synthetic-restored.odt');
  assert.equal(odtQueued.document.mimeType,'application/vnd.oasis.opendocument.text');
  assert.equal(odtQueued.document.pageCount,1);
  const otherDoc=await upload(other,otherParser.id,Buffer.from(sourceText.replace('000042','OTHER-42')),'other.txt');
  // Model the two pre-region job policies explicitly; restore must not upgrade
  // their selector or manufacture a native-template snapshot.
  await db.adminPool.query("update jobs set config=jsonb_set(config,'{templatePolicy}','\"complete-v1\"') where id=$1",[queued.jobId]);
  await db.adminPool.query("update jobs set config=config-'templatePolicy' where id=$1",[otherDoc.jobId]);
  const {PDFDocument,StandardFonts}=await import('pdf-lib');const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);for(let n=1;n<=3;n++)pdf.addPage([300,300]).drawText(`Reference: BACKUP-PDF-${n}\nAmount: 1\nPaid: no`,{x:20,y:240,size:12,font});const pdfBytes=Buffer.from(await pdf.save());
  const splitRequestId=randomUUID(),splitOptions={mode:'ranges',ranges:[{start:1,end:1},{start:3,end:3}]};const split=await upload(owner,parser.id,pdfBytes,'retained.pdf',{requestId:splitRequestId,options:JSON.stringify(splitOptions)},'pdf-splits');
  const storedSourceId=split.documents[1].id,storedSourceSha256=hash(await download(owner,`/api/documents/${storedSourceId}/original`));
  const storedOptions={mode:'every',pagesPerDocument:1},storedRequestId=randomUUID(),undoneRequestId=randomUUID();
  const storedSplit=ok(await request(owner,'POST',`/api/documents/${storedSourceId}/pdf-splits`,{requestId:storedRequestId,sourceSha256:storedSourceSha256,options:storedOptions}),202);
  const undoneSplit=ok(await request(owner,'POST',`/api/documents/${storedSourceId}/pdf-splits`,{requestId:undoneRequestId,sourceSha256:storedSourceSha256,options:storedOptions}),202);
  assert.ok(ok(await request(owner,'POST',`/api/pdf-splits/${undoneSplit.split.id}/undo`,{})).receipt.split.undoneAt);
  const {makeTiff}=await import('../../tests/fixtures/tiff.js');
  const tiffBytes=makeTiff([{width:30,height:40,color:[10,20,200],compression:'deflate'},{width:50,height:25,orientation:6,color:[220,30,50],compression:'deflate'}],{bigTiff:true,byteOrder:'MM'});
  const tiffOriginal=await upload(owner,parser.id,tiffBytes,'restore.tiff'),tiffOptions={mode:'every',pagesPerDocument:1},tiffRequestId=randomUUID(),tiffUndoneId=randomUUID();
  const tiffSplit=ok(await request(owner,'POST',`/api/documents/${tiffOriginal.document.id}/pdf-splits`,{requestId:tiffRequestId,sourceSha256:hash(tiffBytes),options:tiffOptions}),202);
  const tiffUndone=ok(await request(owner,'POST',`/api/documents/${tiffOriginal.document.id}/pdf-splits`,{requestId:tiffUndoneId,sourceSha256:hash(tiffBytes),options:tiffOptions}),202);
  assert.equal(tiffSplit.split.sourceMimeType,'image/tiff');assert.ok(ok(await request(owner,'POST',`/api/pdf-splits/${tiffUndone.split.id}/undo`,{})).receipt.split.undoneAt);
  const {default:JSZip}=await import('jszip');const zip=new JSZip();zip.file('docs/deleted.txt',sourceText.replace('000042','ZIP-DELETED'));zip.file('docs/live.txt',sourceText.replace('000042','ZIP-LIVE'));zip.file('excluded.txt','EXCLUDED ORIGINAL CANARY');const zipBytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),zipRequestId=randomUUID();
  const previewData=multipart(zipBytes,'retained.zip',{requestId:zipRequestId});const preview=ok(await request(owner,'POST',`/api/parsers/${parser.id}/archive-imports/preview`,previewData.payload,previewData.headers));const zipOptions={mode:'zip',version:1,sourceSha256:hash(zipBytes),entries:preview.entries.filter((e:any)=>e.path==='docs/deleted.txt'||e.path==='docs/live.txt').map((e:any)=>e.index)};
  const archive=await upload(owner,parser.id,zipBytes,'retained.zip',{requestId:zipRequestId,options:JSON.stringify(zipOptions)},'archive-imports');ok(await request(owner,'DELETE',`/api/documents/${archive.documents[0].id}`));
  configureControlledSplitSuggestions();
  const suggestionBefore={usage:await ledger(),documents:(await db.adminPool.query('select count(*)::int n from documents where workspace_id=$1',[owner.workspace.id])).rows[0].n};
  const suggestions:Record<string,any>={};
  // Real local PDF/TIFF decoding with a controlled provider result. Suggestions
  // copy sources without accepting pages; only explicit Create charges children.
  for(const label of ['ready','applied','undone','expired','queued']){
   const stored=label==='applied'||label==='undone',bytes=stored||label==='expired'?tiffBytes:pdfBytes;
   const suggestionRequestId=randomUUID();
   const response=stored
    ?ok(await request(owner,'POST',suggestionPath(parser.id),{requestId:suggestionRequestId,documentId:tiffOriginal.document.id,sourceSha256:hash(bytes)}),202)
    :await upload(owner,parser.id,bytes,label==='expired'?'expired-draft.tiff':'draft.pdf',{requestId:suggestionRequestId,sourceSha256:hash(bytes)},'split-suggestions');
   const suggestion=response.suggestion;
   if(label!=='queued'){
    assert.equal(await splitSuggestions.processOneSplitSuggestion(suggestion.id),true);
    assert.equal(ok(await request(owner,'GET',`${suggestionPath(parser.id)}/${suggestion.id}`)).suggestion.state,'ready');
   }
   suggestions[label]={id:suggestion.id,requestId:suggestionRequestId,sha256:hash(bytes)};
  }
  assert.deepEqual(await ledger(),suggestionBefore.usage);
  assert.equal((await db.adminPool.query('select count(*)::int n from documents where workspace_id=$1',[owner.workspace.id])).rows[0].n,suggestionBefore.documents);
  for(const label of ['applied','undone']){
   const entry=suggestions[label],createRequestId=randomUUID(),options={mode:'ranges',ranges:[{start:1,end:1},{start:2,end:2}]};
   const receipt=ok(await request(owner,'POST',`${suggestionPath(parser.id)}/${entry.id}/create`,{requestId:createRequestId,options}),202);
   assert.equal(receipt.split.aiSuggestion.suggestionId,entry.id);assert.deepEqual(receipt.split.aiSuggestion.startPages,[1,2]);
   Object.assign(entry,{createRequestId,options,receipt});
   if(label==='undone')assert.ok(ok(await request(owner,'POST',`/api/pdf-splits/${receipt.split.id}/undo`,{})).receipt.split.undoneAt);
  }
  await db.adminPool.query("update split_suggestions set expires_at=now()-interval '1 second' where id=$1",[suggestions.expired.id]);
  const splitSuggestionRows=await suggestionRows(owner.workspace.id),splitSuggestionObjects=[];
  for(const row of splitSuggestionRows){assert.ok(row.source_storage_key);const bytes=await fs.readFile(path.join(cfg.storageDir,row.source_storage_key));assert.equal(hash(bytes),row.source_sha256);splitSuggestionObjects.push({key:row.source_storage_key,sha256:hash(bytes),bytes:bytes.length});}
  const integrationId=randomUUID(),canary=randomBytes(32).toString('base64url');
  // Direct canaries are fixture-only rows: no provider is configured or contacted.
  await db.adminPool.query("insert into integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext,enabled) values($1,$2,$3,'Synthetic encryption canary','webhook',$4,$5,true)",[integrationId,owner.workspace.id,parser.id,JSON.stringify({url:'https://backup-fixture.invalid/webhook'}),encryptSecret(canary)]);
  const deliveryId=randomUUID();await db.adminPool.query("insert into webhook_deliveries(id,workspace_id,integration_id,event_key,payload) values($1,$2,$3,'owned-backup-delivery',$4)",[deliveryId,owner.workspace.id,integrationId,JSON.stringify({synthetic:true,reference:'CONTROLLED-OUTBOX'})]);
  const deletionKey=owner.workspace.id+'/'+randomUUID();await fs.writeFile(path.join(cfg.storageDir,deletionKey),Buffer.from('SYNTHETIC PENDING DELETION'));await db.adminPool.query('insert into file_deletions(workspace_id,storage_key) values($1,$2)',[owner.workspace.id,deletionKey]);
  const emailCanary=encryptSecret(JSON.stringify({to:owner.email,subject:'Synthetic restore message',text:'Controlled fixture only'}));await db.adminPool.query("insert into account_email_outbox(user_id,kind,payload_ciphertext,expires_at) values($1,'password_changed',$2,now()+interval '1 day')",[owner.user.id,emailCanary]);
  const native=await seedNativeTemplates(owner),bank=await seedBankStatements(owner);
  const originals=[];for(const row of(await db.adminPool.query('select id,storage_key,sha256,workspace_id from documents order by id')).rows)originals.push({...row,actualSha256:hash(await fs.readFile(path.join(cfg.storageDir,row.storage_key)))});
  const fixture={accounts,parserId:parser.id,otherParserId:otherParser.id,ordinary,queued,odtQueued,otherDoc,native,bank,runId:runDetail.id,approvalId:approval.id,corrected,normalized:runDetail.normalizedValues,raw:runDetail.rawValues,exports,template,mapping,schema2,split,splitRequestId,splitOptions,pdfSha256:hash(pdfBytes),storedSourceId,storedSourceSha256,storedOptions,storedRequestId,storedSplit,undoneRequestId,undoneSplit,tiffOriginal,tiffOptions,tiffRequestId,tiffUndoneId,tiffSplit,tiffUndone,tiffSha256:hash(tiffBytes),suggestions,splitSuggestionRows,splitSuggestionObjects,archive,zipRequestId,zipOptions,zipSha256:hash(zipBytes),originals,integrationId,canarySha256:hash(canary),deliveryId,deletionKey,usage:await ledger()};
  await fs.writeFile(path.join(run,'source.pdf'),pdfBytes,{mode:0o600});await fs.writeFile(path.join(run,'source.zip'),zipBytes,{mode:0o600});await write('fixture-private.json',fixture);
  await write('runtime-seed.json',{accounts:2,workspaces:2,documents:originals.length,exports:8,schemaVersions:6,bankStatements:{documents:2,accountDateRows:2,transactionFingerprints:4,approvedSnapshots:2,controlledProviderCalls:2},nativeTemplates:{completed:1,queuedPinnedRevision:1,savedCurrentRevision:2,independentCopies:1,closedMutations:1},splitSuggestions:{queued:1,ready:1,applied:1,undone:1,expired:1,controlledProviderCalls:controlledSplitCalls},syntheticCanaries:['encrypted integration','pending webhook','pending account email','pending file deletion'],forbiddenNetwork});
 }else{
  const f=JSON.parse(await fs.readFile(path.join(run,'fixture-private.json'),'utf8'));
  const owner=await login(f.accounts[0]),other=await login(f.accounts[1]);checks.login=true;
  for(const id of [f.ordinary.document.id,f.queued.document.id])assert.equal((await request(other,'GET',`/api/documents/${id}`)).statusCode,404);assert.equal((await request(owner,'GET',`/api/documents/${f.otherDoc.document.id}`)).statusCode,404);checks.tenantIsolation=true;
  const d=ok(await request(owner,'GET',`/api/documents/${f.ordinary.document.id}`));assert.equal(d.runs[0].id,f.runId);assert.deepEqual(d.runs[0].rawValues,f.raw);assert.deepEqual(d.runs[0].normalizedValues,f.normalized);assert.deepEqual(d.runs[0].effectiveValues,f.corrected);assert.equal(d.runs[0].approvals[0].id,f.approvalId);checks.correctionApprovalRawProvenance=true;
  for(const e of f.exports){
   const bytes=await download(owner,e.downloadUrl);assert.equal(hash(bytes),e.sha256);assert.equal((await request(other,'GET',e.downloadUrl)).statusCode,404);
   if(e.format==='csv')assert.equal(bytes.toString(),'\uFEFF"Reference","Amount","Paid","Missing date"\r\n"CORRECTED-000042","0","false",""\r\n');
   if(e.format==='json')assert.deepEqual(JSON.parse(bytes.toString()).documents[0].values,f.corrected);
   if(e.format==='xlsx'){const {default:ExcelJS}=await import('exceljs');const book=new ExcelJS.Workbook();await book.xlsx.load(bytes as any);assert.deepEqual([1,2].map(row=>[1,2,3,4].map(col=>book.worksheets[0].getCell(row,col).value)),[['Reference','Amount','Paid','Missing date'],['CORRECTED-000042',0,false,'']]);}
  }checks.exactSavedCsvXlsxJsonBytesAndTypedValues=true;
  const parser=ok(await request(owner,'GET',`/api/parsers/${f.parserId}`));assert.equal(parser.schemas.length,2);assert.equal(parser.schema.id,f.schema2.id);assert.equal(parser.templates.length,1);assert.equal(ok(await request(owner,'GET','/api/export-mappings')).mappings[0].id,f.mapping.id);checks.schemasTemplateMapping=true;
  for(const object of f.originals){const a=object.workspace_id===owner.workspace.id?owner:other;assert.equal(hash(await download(a,`/api/documents/${object.id}/original`)),object.actualSha256);assert.equal(object.actualSha256,object.sha256);}checks.exactEveryLiveOriginal=true;
  const splitChild=f.split.documents[0];assert.equal(hash(await download(owner,`/api/documents/${splitChild.id}/bundle-original`)),f.pdfSha256);const splitDetail=ok(await request(owner,'GET',`/api/documents/${splitChild.id}`));assert.equal(splitDetail.split.originalPageStart,1);assert.equal(splitDetail.document.sourceText[0].page,1);
  const zipChild=f.archive.documents[1];assert.equal(hash(await download(owner,`/api/documents/${zipChild.id}/archive-original`)),f.zipSha256);const zipDetail=ok(await request(owner,'GET',`/api/documents/${zipChild.id}`));assert.equal(zipDetail.archive.retainedDocuments,1);checks.retainedPdfAndZipLineage=true;
  const replay=await upload(owner,f.parserId,await fs.readFile(path.join(run,'source.zip')),'retained.zip',{requestId:f.zipRequestId,options:JSON.stringify(f.zipOptions)},'archive-imports');assert.equal(replay.replayed,true);assert.equal(replay.documents[0].available,false);assert.equal(replay.documents[1].available,true);assert.equal(replay.archive.id,f.archive.archive.id);
  const splitReplay=await upload(owner,f.parserId,await fs.readFile(path.join(run,'source.pdf')),'retained.pdf',{requestId:f.splitRequestId,options:JSON.stringify(f.splitOptions)},'pdf-splits');assert.equal(splitReplay.replayed,true);assert.equal(splitReplay.split.id,f.split.split.id);assert.deepEqual(await ledger(),f.usage);checks.replaysTombstonesUnchangedPageUsage=true;
  const storedReplay=ok(await request(owner,'POST',`/api/documents/${f.storedSourceId}/pdf-splits`,{requestId:f.storedRequestId,sourceSha256:f.storedSourceSha256,options:f.storedOptions}),202);
  assert.equal(storedReplay.replayed,true);assert.equal(storedReplay.split.id,f.storedSplit.split.id);assert.equal(storedReplay.split.sourceDocumentId,f.storedSourceId);
  assert.deepEqual(storedReplay.documents[0].root,{kind:'pdf-split',id:f.split.split.id,sha256:f.pdfSha256,pageCount:3,pageStart:3,pageEnd:3});
  assert.equal(hash(await download(owner,`/api/documents/${storedReplay.documents[0].id}/bundle-original`)),f.storedSourceSha256);
  assert.equal((await request(other,'GET',`/api/parsers/${f.parserId}/pdf-splits/requests/${f.storedRequestId}`)).statusCode,404);checks.storedSplitRootLineageAndSourceCopy=true;
  const undoneReplay=ok(await request(owner,'POST',`/api/documents/${f.storedSourceId}/pdf-splits`,{requestId:f.undoneRequestId,sourceSha256:f.storedSourceSha256,options:f.storedOptions}),202);
  assert.equal(undoneReplay.replayed,true);assert.equal(undoneReplay.split.id,f.undoneSplit.split.id);assert.ok(undoneReplay.split.undoneAt);assert.equal(undoneReplay.documents[0].available,false);
  assert.equal((await request(owner,'GET',`/api/documents/${undoneReplay.documents[0].id}`)).statusCode,404);
  const bound=(await db.adminPool.query('select source_document_id,source_sha256 from stored_pdf_split_requests where workspace_id=$1 and request_id=any($2::uuid[])',[owner.workspace.id,[f.storedRequestId,f.undoneRequestId]])).rows;
  assert.equal(bound.length,2);assert.ok(bound.every(row=>row.source_document_id===f.storedSourceId&&row.source_sha256===f.storedSourceSha256));assert.deepEqual(await ledger(),f.usage);checks.storedUndoAndAdmissionIdentitySurviveRestore=true;
  const tiffReplay=ok(await request(owner,'POST',`/api/documents/${f.tiffOriginal.document.id}/pdf-splits`,{requestId:f.tiffRequestId,sourceSha256:f.tiffSha256,options:f.tiffOptions}),202);
  assert.equal(tiffReplay.replayed,true);assert.equal(tiffReplay.split.id,f.tiffSplit.split.id);assert.equal(tiffReplay.split.sourceMimeType,'image/tiff');
  for(const child of tiffReplay.documents){const detail=ok(await request(owner,'GET',`/api/documents/${child.id}`));assert.equal(detail.document.mimeType,'image/tiff');assert.equal(detail.split.sourceMimeType,'image/tiff');assert.equal(hash(await download(owner,`/api/documents/${child.id}/bundle-original`)),f.tiffSha256);const image=await request(owner,'GET',`/api/documents/${child.id}/preview?page=1`);assert.equal(image.statusCode,200);assert.equal(image.headers['content-type'],'image/jpeg');}
  checks.restoredTiffMimeOriginalPreviewAndSplitReplay=true;
  const tiffUndoneReplay=ok(await request(owner,'POST',`/api/documents/${f.tiffOriginal.document.id}/pdf-splits`,{requestId:f.tiffUndoneId,sourceSha256:f.tiffSha256,options:f.tiffOptions}),202);
  assert.equal(tiffUndoneReplay.split.sourceMimeType,'image/tiff');assert.ok(tiffUndoneReplay.split.undoneAt);assert.ok(tiffUndoneReplay.documents.every((d:any)=>!d.available));assert.deepEqual(await ledger(),f.usage);checks.restoredTiffUndoKeepsPageLedgerAndTombstones=true;
  assert.deepEqual(await suggestionRows(owner.workspace.id),f.splitSuggestionRows);
  for(const object of f.splitSuggestionObjects){const bytes=await fs.readFile(path.join(cfg.storageDir,object.key));assert.equal(bytes.length,object.bytes);assert.equal(hash(bytes),object.sha256);}
  checks.splitSuggestionExactRowsSourcesAndConfirmationNonces=true;
  for(const label of ['queued','ready','applied','undone','expired']){
   const entry=f.suggestions[label],endpoint=`${suggestionPath(f.parserId)}/${entry.id}`;
   const current=ok(await request(owner,'GET',`${suggestionPath(f.parserId)}/requests/${entry.requestId}`)).suggestion;
   assert.equal(current.id,entry.id);assert.equal(current.sourceSha256,entry.sha256);
   assert.equal((await request(other,'GET',endpoint)).statusCode,404);
   if(label==='expired'){assert.equal(current.creationClosed,true);assert.equal((await request(owner,'GET',endpoint+'/source')).statusCode,410);}
   else assert.equal(hash(await download(owner,endpoint+'/source')),entry.sha256);
   if(label==='applied'||label==='undone'){
    assert.equal(current.confirmedRequestId,entry.createRequestId);assert.deepEqual(current.confirmedOptions,entry.options);assert.equal(current.acceptedSplitId,entry.receipt.split.id);
    const replay=ok(await request(owner,'POST',endpoint+'/create',{requestId:entry.createRequestId,options:entry.options}),202);
    assert.equal(replay.replayed,true);assert.equal(replay.split.id,entry.receipt.split.id);assert.deepEqual(replay.split.aiSuggestion,entry.receipt.split.aiSuggestion);
    if(label==='undone'){assert.ok(replay.split.undoneAt);assert.ok(replay.documents.every((document:any)=>!document.available));}
    else for(const child of replay.documents){assert.equal(child.available,true);const detail=ok(await request(owner,'GET',`/api/documents/${child.id}`));assert.deepEqual(detail.split.aiSuggestion,replay.split.aiSuggestion);}
    assert.equal((await request(owner,'POST',endpoint+'/create',{requestId:randomUUID(),options:entry.options})).statusCode,409);
   }
  }
  assert.deepEqual(await ledger(),f.usage);checks.splitSuggestionRestoreIsolationSourceExpiryAndAppliedUndoReplays=true;
  configureControlledSplitSuggestions();
  assert.equal(await splitSuggestions.processOneSplitSuggestion(f.suggestions.queued.id),true);
  assert.equal(await splitSuggestions.processOneSplitSuggestion(f.suggestions.queued.id),false);
  const restoredSuggestion=ok(await request(owner,'GET',`${suggestionPath(f.parserId)}/${f.suggestions.queued.id}`)).suggestion;
  assert.equal(restoredSuggestion.state,'ready');assert.equal(restoredSuggestion.attempts,1);assert.deepEqual(restoredSuggestion.startPages,[1,3]);assert.equal(controlledSplitCalls,1);assert.deepEqual(await ledger(),f.usage);
  checks.queuedSplitSuggestionResumesOnceWithoutAcceptingOrChargingPages=true;
  const expiredRow=f.splitSuggestionRows.find((row:any)=>row.id===f.suggestions.expired.id);
  assert.deepEqual(await splitSuggestions.reconcileExpiredSplitSuggestions(owner.workspace.id),{removed:1});
  assert.equal(await fs.stat(path.join(cfg.storageDir,expiredRow.source_storage_key)).then(()=>true,()=>false),false);
  const cleaned=(await db.adminPool.query('select * from split_suggestions where id=$1',[expiredRow.id])).rows[0];
  assert.equal(cleaned.source_storage_key,null);assert.equal(cleaned.source_reserved_bytes,0);assert.deepEqual(cleaned.start_pages,expiredRow.start_pages);assert.equal(cleaned.model,expiredRow.model);assert.equal(cleaned.prompt_version,expiredRow.prompt_version);
  assert.deepEqual(await ledger(),f.usage);checks.expiredSplitSuggestionSourceCleanupPreservesDraftAndLedger=true;
  const cipher=(await db.adminPool.query('select secret_ciphertext from integrations where id=$1',[f.integrationId])).rows[0].secret_ciphertext;assert.equal(hash(decryptSecret(cipher)),f.canarySha256);checks.encryptionKeyCanary=true;
  await verifyNativeTemplates(owner,other,f.native,f.usage);
  await verifyBankStatements(owner,other,f.bank);
  assert.equal((await request(other,'GET',`/api/documents/${f.odtQueued.document.id}`)).statusCode,404);
  assert.equal(await worker.processOneCoreJob(f.odtQueued.jobId),true);
  assert.equal(await worker.processOneCoreJob(f.odtQueued.jobId),false);
  const restoredOdt=ok(await request(owner,'GET',`/api/documents/${f.odtQueued.document.id}`));
  assert.equal(restoredOdt.document.mimeType,'application/vnd.oasis.opendocument.text');
  assert.equal(restoredOdt.runs.length,1);assert.equal(restoredOdt.jobs[0].attempts,1);
  assert.deepEqual(restoredOdt.runs[0].effectiveValues,{reference:'000042',amount:12.5,paid:false,missing_date:null});
  assert.equal(restoredOdt.runs[0].normalizationContext.version,'regional-v2');
  assert.deepEqual(await ledger(),f.usage);checks.queuedOdtOriginalAndPinnedNormalizationResumeOnceWithoutRecharging=true;
  assert.equal(await worker.processOneCoreJob(f.queued.jobId),true);assert.equal(await worker.processOneCoreJob(f.queued.jobId),false);const queued=ok(await request(owner,'GET',`/api/documents/${f.queued.document.id}`));assert.equal(queued.runs.length,1);assert.equal(queued.jobs[0].attempts,1);assert.equal(queued.jobs[0].state,'completed');assert.equal(queued.runs[0].effectiveValues.reference,'QUEUED-42');assert.deepEqual(await ledger(),f.usage);checks.deterministicQueuedJobOnceWithoutRecharging=true;
  assert.equal(queued.runs[0].selection.policy,'complete-v1');assert.equal(queued.runs[0].templateSnapshot,null);
  assert.equal(await worker.processOneCoreJob(f.otherDoc.jobId),true);assert.equal(await worker.processOneCoreJob(f.otherDoc.jobId),false);const legacy=ok(await request(other,'GET',`/api/documents/${f.otherDoc.document.id}`));assert.equal(legacy.runs[0].effectiveValues.reference,'OTHER-42');assert.equal(legacy.runs[0].selection,null);assert.equal(legacy.runs[0].templateSnapshot,null);assert.deepEqual(await ledger(),f.usage);checks.legacyAndCompleteV1QueuedSelectorsRemainUnchanged=true;
  const {deleteStoredFile}=await import('../../server/core/retention.js');assert.equal(await deleteStoredFile(owner.workspace.id,f.deletionKey),'complete');assert.equal(await deleteStoredFile(owner.workspace.id,f.deletionKey),'complete');assert.equal(await fs.stat(path.join(cfg.storageDir,f.deletionKey)).then(()=>true,()=>false),false);checks.pendingDeletionResumed=true;
  const {processOneDelivery,signDelivery}=await import('../../server/integrations/webhooks.js');let deliveries=0;await processOneDelivery({workspaceId:owner.workspace.id,transport:async(_url,options:any)=>{deliveries++;const body=options.body;assert.equal(options.headers['X-Folio-Signature'],'v1='+signDelivery(decryptSecret(cipher),options.headers['X-Folio-Timestamp'],body));return{status:204,body:'',headers:{}} as any;}});await processOneDelivery({workspaceId:owner.workspace.id,transport:async()=>{deliveries++;throw new Error('No duplicate fixture delivery');}});assert.equal(deliveries,1);assert.equal((await db.adminPool.query('select status from webhook_deliveries where id=$1',[f.deliveryId])).rows[0].status,'delivered');checks.pendingOutboxControlledDeliveryOnce=true;
  assert.equal((await db.adminPool.query("select count(*)::int n from account_email_outbox where state='pending'")).rows[0].n,1);checks.pendingEmailPreservedWithoutSending=true;
  await write('runtime-verification.json',{checks,forbiddenNetwork,realProviderCalls:0,forbiddenExtractionCalls,controlledSplitProviderCalls:controlledSplitCalls,restoredSplitSuggestions:f.splitSuggestionRows.length,controlledWebhookDeliveries:deliveries,verifiedLiveOriginals:f.originals.length,savedExports:8,restoredBankAccountDateRows:f.bank.indexes.accounts.length,restoredBankTransactionFingerprints:f.bank.indexes.transactions.length,accounts:2});
 }
 }
 assert.equal(forbiddenNetwork,0);
}finally{await app?.close();await db.closeDatabase();}
