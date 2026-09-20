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
try{
 for(const [pool,role]of [[db.adminPool,cfg.adminRole],[db.appPool,cfg.appRole]] as const){const r=(await pool.query("select current_database() db,current_schema() schema,current_user role,inet_server_addr() address")).rows[0];assert.equal(r.db,cfg.database.database);assert.equal(r.schema,'folio');assert.equal(r.role,role);assert.equal(r.address,null);}
 if(phase==='blocked'){
  assert.ok(await fs.stat(path.join(cfg.storageDir,'.folio-restore-pending.json')));
  let apiRefused=false,workerRefused=false;
  const pendingMessage='This restored instance is inactive. Verify and activate the backup before starting Folio.';
  const isPending=(error:any)=>{assert.equal(error?.code,'FOLIO_RESTORE_PENDING');assert.equal(error?.message,pendingMessage);return true;};
  await assert.rejects(async()=>{app=await buildApp();await app.ready();},isPending);apiRefused=true;
  await assert.rejects(worker.processOneCoreJob(randomUUID()),isPending);
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
  const otherDoc=await upload(other,otherParser.id,Buffer.from(sourceText.replace('000042','OTHER-42')),'other.txt');
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
  const integrationId=randomUUID(),canary=randomBytes(32).toString('base64url');
  // Direct canaries are fixture-only rows: no provider is configured or contacted.
  await db.adminPool.query("insert into integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext,enabled) values($1,$2,$3,'Synthetic encryption canary','webhook',$4,$5,true)",[integrationId,owner.workspace.id,parser.id,JSON.stringify({url:'https://backup-fixture.invalid/webhook'}),encryptSecret(canary)]);
  const deliveryId=randomUUID();await db.adminPool.query("insert into webhook_deliveries(id,workspace_id,integration_id,event_key,payload) values($1,$2,$3,'owned-backup-delivery',$4)",[deliveryId,owner.workspace.id,integrationId,JSON.stringify({synthetic:true,reference:'CONTROLLED-OUTBOX'})]);
  const deletionKey=owner.workspace.id+'/'+randomUUID();await fs.writeFile(path.join(cfg.storageDir,deletionKey),Buffer.from('SYNTHETIC PENDING DELETION'));await db.adminPool.query('insert into file_deletions(workspace_id,storage_key) values($1,$2)',[owner.workspace.id,deletionKey]);
  const emailCanary=encryptSecret(JSON.stringify({to:owner.email,subject:'Synthetic restore message',text:'Controlled fixture only'}));await db.adminPool.query("insert into account_email_outbox(user_id,kind,payload_ciphertext,expires_at) values($1,'password_changed',$2,now()+interval '1 day')",[owner.user.id,emailCanary]);
  const originals=[];for(const row of(await db.adminPool.query('select id,storage_key,sha256,workspace_id from documents order by id')).rows)originals.push({...row,actualSha256:hash(await fs.readFile(path.join(cfg.storageDir,row.storage_key)))});
  const fixture={accounts,parserId:parser.id,otherParserId:otherParser.id,ordinary,queued,otherDoc,runId:runDetail.id,approvalId:approval.id,corrected,normalized:runDetail.normalizedValues,raw:runDetail.rawValues,exports,template,mapping,schema2,split,splitRequestId,splitOptions,pdfSha256:hash(pdfBytes),storedSourceId,storedSourceSha256,storedOptions,storedRequestId,storedSplit,undoneRequestId,undoneSplit,tiffOriginal,tiffOptions,tiffRequestId,tiffUndoneId,tiffSplit,tiffUndone,tiffSha256:hash(tiffBytes),archive,zipRequestId,zipOptions,zipSha256:hash(zipBytes),originals,integrationId,canarySha256:hash(canary),deliveryId,deletionKey,usage:await ledger()};
  await fs.writeFile(path.join(run,'source.pdf'),pdfBytes,{mode:0o600});await fs.writeFile(path.join(run,'source.zip'),zipBytes,{mode:0o600});await write('fixture-private.json',fixture);
  await write('runtime-seed.json',{accounts:2,workspaces:2,documents:originals.length,exports:3,schemaVersions:3,syntheticCanaries:['encrypted integration','pending webhook','pending account email','pending file deletion'],forbiddenNetwork});
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
  const cipher=(await db.adminPool.query('select secret_ciphertext from integrations where id=$1',[f.integrationId])).rows[0].secret_ciphertext;assert.equal(hash(decryptSecret(cipher)),f.canarySha256);checks.encryptionKeyCanary=true;
  assert.equal(await worker.processOneCoreJob(f.queued.jobId),true);assert.equal(await worker.processOneCoreJob(f.queued.jobId),false);const queued=ok(await request(owner,'GET',`/api/documents/${f.queued.document.id}`));assert.equal(queued.runs.length,1);assert.equal(queued.jobs[0].attempts,1);assert.equal(queued.jobs[0].state,'completed');assert.equal(queued.runs[0].effectiveValues.reference,'QUEUED-42');assert.deepEqual(await ledger(),f.usage);checks.deterministicQueuedJobOnceWithoutRecharging=true;
  const {deleteStoredFile}=await import('../../server/core/retention.js');assert.equal(await deleteStoredFile(owner.workspace.id,f.deletionKey),'complete');assert.equal(await deleteStoredFile(owner.workspace.id,f.deletionKey),'complete');assert.equal(await fs.stat(path.join(cfg.storageDir,f.deletionKey)).then(()=>true,()=>false),false);checks.pendingDeletionResumed=true;
  const {processOneDelivery,signDelivery}=await import('../../server/integrations/webhooks.js');let deliveries=0;await processOneDelivery({workspaceId:owner.workspace.id,transport:async(_url,options:any)=>{deliveries++;const body=options.body;assert.equal(options.headers['X-Folio-Signature'],'v1='+signDelivery(decryptSecret(cipher),options.headers['X-Folio-Timestamp'],body));return{status:204,body:'',headers:{}} as any;}});await processOneDelivery({workspaceId:owner.workspace.id,transport:async()=>{deliveries++;throw new Error('No duplicate fixture delivery');}});assert.equal(deliveries,1);assert.equal((await db.adminPool.query('select status from webhook_deliveries where id=$1',[f.deliveryId])).rows[0].status,'delivered');checks.pendingOutboxControlledDeliveryOnce=true;
  assert.equal((await db.adminPool.query("select count(*)::int n from account_email_outbox where state='pending'")).rows[0].n,1);checks.pendingEmailPreservedWithoutSending=true;
  await write('runtime-verification.json',{checks,forbiddenNetwork,realProviderCalls:0,controlledWebhookDeliveries:deliveries,verifiedLiveOriginals:f.originals.length,savedExports:3,accounts:2});
 }
 }
 assert.equal(forbiddenNetwork,0);
}finally{await app?.close();await db.closeDatabase();}
