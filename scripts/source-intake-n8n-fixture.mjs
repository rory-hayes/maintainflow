/**
 * Synthetic HTTPS service for the real n8n engine acceptance harness.
 * Run only on the harness's internal Docker network. It never makes outbound requests.
 * Importing this module only exposes fixture factories; it does not read files or listen.
 */
import https from 'node:https';
import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const syntheticDriveToken='SYNTHETIC_DRIVE_QA_ONLY';
export const syntheticMaintainFlowToken='SYNTHETIC_MAINTAINFLOW_QA_ONLY';
export const syntheticAdminToken='SYNTHETIC_ADMIN_QA_ONLY';
export const syntheticParserId='81000000-0000-4000-8000-000000000001';
export const syntheticFolderId='synthetic-owned-folder';
const workspaceId='81000000-0000-4000-8000-000000000002';
const stamp='2026-09-26T12:00:00.000Z';
const maxBodyBytes=12*1024*1024;
const digest=(algorithm,bytes)=>createHash(algorithm).update(bytes).digest('hex');
const uuid=(prefix,index)=>`${prefix}0000000-0000-4000-8000-${String(index).padStart(12,'0')}`;

/** A genuine, minimal one-page text PDF with byte-correct xref offsets. */
export function createSyntheticPdf(label='SYNTHETIC SOURCE INTAKE QA ONLY'){
  const escaped=label.replace(/[^\x20-\x7e]/g,'?').replace(/[\\()]/g,'\\$&');
  const stream=`BT /F1 12 Tf 40 750 Td (${escaped}) Tj 0 -20 Td (No real account or customer data.) Tj ET\n`;
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let text='%PDF-1.4\n';const offsets=[0];
  for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${index+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(text);
  text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

/** JSON-safe data, ready to write to /fixtures/scenarios.json. All tokens are fake. */
export function createFixtureCatalog(){
  const files=['A','B'].map((letter,index)=>{
    const bytes=createSyntheticPdf(`SYNTHETIC SOURCE ${letter} - INTAKE QA ONLY`);
    return {id:`synthetic_drive_${letter.toLowerCase()}_0001`,name:`synthetic-source-${letter.toLowerCase()}.pdf`,mimeType:'application/pdf',version:index===0?'18446744073709551615':'12',modifiedTime:stamp,pageCount:1,size:String(bytes.length),md5Checksum:digest('md5',bytes),sha256:digest('sha256',bytes),contentBase64:bytes.toString('base64')};
  });
  const errorCodes={drift:'source_version_drift',checksumMismatch:'download_checksum_mismatch',checksumMissing:'source_checksum_missing',capabilityDenied:'source_not_downloadable',oversize:'source_size_limit',failed:'processing_failed',duplicateFailed:'processing_failed',failedOldRun:'processing_failed',timeout:'poll_timeout',quota:'http_failure',malformedResponse:'upload_receipt_invalid'};
  const scenario=(name,expectedOutcome='success',ids=[files[0].id],options={})=>({name,kind:name,inputItems:ids.map(id=>({id})),expectedOutcome,...(errorCodes[name]?{expectedErrorCode:errorCodes[name]}:{}),...options});
  return {version:1,parserId:syntheticParserId,folderId:syntheticFolderId,driveToken:syntheticDriveToken,maintainflowToken:syntheticMaintainFlowToken,adminToken:syntheticAdminToken,files,scenarios:[
    scenario('happy'),
    scenario('duplicate','success',undefined,{seed:'completed',expectedNewDocuments:0,expectedNewJobs:0,expectedNewPageCharges:0}),
    scenario('multipleFiles','success',files.map(file=>file.id)),
    scenario('reordered','success',files.map(file=>file.id).reverse()),
    scenario('drift','rejected',undefined,{expectedUploadAttempts:0}),
    scenario('checksumMismatch','rejected',undefined,{expectedUploadAttempts:0}),
    scenario('checksumMissing','rejected',undefined,{expectedUploadAttempts:0}),
    scenario('capabilityDenied','rejected',undefined,{expectedUploadAttempts:0}),
    scenario('oversize','rejected',undefined,{expectedUploadAttempts:0,expectedDownloads:0}),
    scenario('failed','failed'),
    scenario('duplicateFailed','failed',undefined,{seed:'failed',expectedNewDocuments:0,expectedNewJobs:0,expectedNewPageCharges:0}),
    scenario('currentReprocessOldRun','success',undefined,{seed:'reprocessing',reverseJobs:true,expectedNewDocuments:0,expectedNewJobs:0,expectedNewPageCharges:0}),
    scenario('failedOldRun','failed',undefined,{seed:'reprocessing',terminalState:'failed',reverseJobs:true}),
    scenario('timeout','timeout',undefined,{terminalState:'processing'}),
    scenario('quota','rejected',undefined,{expectedNewDocuments:0,expectedNewJobs:0,expectedNewPageCharges:0}),
    scenario('malformedResponse','rejected'),
  ]};
}

async function loadCatalog(directory){
  let catalog;
  try{catalog=JSON.parse(await readFile(path.join(directory,'scenarios.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw error;catalog=createFixtureCatalog();}
  const defaults=createFixtureCatalog();
  catalog={...defaults,...catalog,files:catalog.files||defaults.files,scenarios:catalog.scenarios||defaults.scenarios};
  if(!Array.isArray(catalog.scenarios))catalog.scenarios=Object.entries(catalog.scenarios).map(([name,value])=>({name,...value}));
  const root=await realpath(directory),files=new Map();
  for(const supplied of catalog.files){
    let bytes;
    if(supplied.sourcePath){const resolved=await realpath(path.resolve(directory,supplied.sourcePath));if(resolved!==root&&!resolved.startsWith(root+path.sep))throw Error('Fixture sourcePath must stay inside the fixture directory.');bytes=await readFile(resolved);}
    else if(typeof supplied.contentBase64==='string')bytes=Buffer.from(supplied.contentBase64,'base64');
    else if(typeof supplied.contentText==='string')bytes=Buffer.from(supplied.contentText);
    else bytes=createSyntheticPdf(`SYNTHETIC ${supplied.id} - QA ONLY`);
    if(!supplied.id||files.has(supplied.id)||!bytes.length||bytes.length>maxBodyBytes)throw Error('Invalid synthetic fixture file.');
    files.set(supplied.id,{...supplied,bytes,name:supplied.name||`${supplied.id}.pdf`,mimeType:supplied.mimeType||'application/pdf',pageCount:supplied.pageCount||1,version:supplied.version||'1',modifiedTime:supplied.modifiedTime||stamp,size:String(bytes.length),md5Checksum:digest('md5',bytes),sha256:digest('sha256',bytes)});
  }
  return {catalog,files};
}

function failure(message,status=400){return Object.assign(new Error(message),{status});}
async function readBody(request,limit=maxBodyBytes){
  const chunks=[];let size=0;
  for await(const chunk of request){size+=chunk.length;if(size>limit)throw failure('Synthetic request exceeds fixture body limit.',413);chunks.push(chunk);}
  return Buffer.concat(chunks);
}

/** Parse multipart framing as bytes; converting binary payloads to UTF-8 is forbidden. */
export function parseMultipart(body,contentType){
  const match=/^multipart\/form-data\s*;[\s\S]*?boundary=(?:"([^"\r\n]+)"|([^;\s\r\n]+))/i.exec(contentType||'');
  const boundary=match?.[1]||match?.[2];
  if(!boundary||boundary.length>200)throw failure('A multipart/form-data boundary is required.');
  const marker=Buffer.from(`--${boundary}`),delimiter=Buffer.from(`\r\n--${boundary}`),separator=Buffer.from('\r\n\r\n'),files=[];
  if(!body.subarray(0,marker.length).equals(marker))throw failure('Malformed multipart opening boundary.');
  let cursor=marker.length,parts=0;
  while(cursor<body.length){
    if(body.subarray(cursor,cursor+2).toString()==='--')return files;
    if(body.subarray(cursor,cursor+2).toString()!=='\r\n')throw failure('Malformed multipart part boundary.');
    cursor+=2;const headerEnd=body.indexOf(separator,cursor);
    if(headerEnd<0||headerEnd-cursor>16_384||++parts>30)throw failure('Malformed multipart headers.');
    const headerText=body.subarray(cursor,headerEnd).toString('latin1');
    const headers=Object.fromEntries(headerText.split('\r\n').map(line=>{const colon=line.indexOf(':');if(colon<1)throw failure('Malformed multipart header.');return [line.slice(0,colon).trim().toLowerCase(),line.slice(colon+1).trim()];}));
    const disposition=headers['content-disposition']||'',filename=/(?:^|;)\s*filename="([^"\r\n]*)"/i.exec(disposition),name=/(?:^|;)\s*name="([^"\r\n]*)"/i.exec(disposition);
    const contentStart=headerEnd+separator.length,next=body.indexOf(delimiter,contentStart);
    if(next<0)throw failure('Multipart closing boundary is missing.');
    if(filename)files.push({field:name?.[1]||'',filename:filename[1],mimeType:(headers['content-type']||'application/octet-stream').toLowerCase(),bytes:body.subarray(contentStart,next)});
    cursor=next+2+marker.length;
  }
  throw failure('Multipart body is incomplete.');
}

export async function startFixtureServer(options={}){
  const directory=options.directory||process.env.SOURCE_INTAKE_FIXTURE_DIR||'/fixtures';
  const {catalog,files}=await loadCatalog(directory);
  const cert=options.cert??await readFile(options.certPath||process.env.SOURCE_INTAKE_TLS_CERT||path.join(directory,'tls.pem'));
  const key=options.key??await readFile(options.keyPath||process.env.SOURCE_INTAKE_TLS_KEY||path.join(directory,'tls-key.pem'));
  const scenarios=new Map(catalog.scenarios.map(scenario=>[scenario.name,scenario]));
  const documents=new Map(),jobs=new Map(),runs=new Map(),idempotency=new Map();
  let active,state,nextDocument,nextJob,nextRun;
  const counters=()=>({documents:documents.size,jobs:jobs.size,runs:runs.size,pageCharges:[...documents.values()].reduce((sum,doc)=>sum+doc.charges,0)});
  function makeRun(doc,job,old=false){const run={id:uuid('4',nextRun++),documentId:doc.id,jobId:job.id,createdAt:old?'2026-09-26T11:00:00.000Z':stamp,effectiveRevision:`synthetic:${job.id}`,rawValues:{source_file_id:doc.file.id,source_sha256:doc.file.sha256,synthetic:true},values:{source_file_id:doc.file.id,synthetic:true},effectiveValues:{source_file_id:doc.file.id,source_sha256:doc.file.sha256,synthetic:true},corrections:[],approvals:[],validationIssues:[],evidence:{}};runs.set(run.id,run);doc.runIds.unshift(run.id);doc.latestRunId=run.id;return run;}
  function makeJob(doc,jobState='queued',old=false){const job={id:uuid('3',nextJob++),documentId:doc.id,state:jobState,attempts:jobState==='queued'?0:1,maxAttempts:3,error:null,waitingForSchema:false,availableAt:stamp,createdAt:old?'2026-09-26T11:00:00.000Z':stamp,updatedAt:stamp};jobs.set(job.id,job);doc.jobIds.unshift(job.id);return job;}
  function makeDocument(file,seed){const doc={id:uuid('2',nextDocument++),file,parserId:catalog.parserId,status:'queued',latestRunId:null,approvedRunId:null,error:null,jobIds:[],runIds:[],ticks:0,charges:file.pageCount};documents.set(doc.id,doc);const job=makeJob(doc,seed==='completed'?'completed':seed==='failed'?'failed':'queued');doc.currentJobId=job.id;
    if(seed==='completed'){doc.status='needs_review';makeRun(doc,job);}
    if(seed==='failed'){doc.status='failed';doc.error=job.error='Synthetic extraction failed.';}
    if(seed==='reprocessing'){job.state='completed';makeRun(doc,job,true);const current=makeJob(doc);doc.currentJobId=current.id;doc.charges+=file.pageCount;}
    return doc;
  }
  function reset(name){
    active=scenarios.get(name);if(!active)throw failure('Unknown synthetic scenario.',404);
    documents.clear();jobs.clear();runs.clear();idempotency.clear();nextDocument=1;nextJob=1;nextRun=1;
    state={scenario:name,kind:active.kind||name,requests:[],metadataReads:{},downloads:[],uploads:[],uploadAttempts:0,unexpectedRequests:[],completedCurrentRunIds:[],baseline:null};
    const seeded=active.seed||(state.kind==='duplicate'?'completed':state.kind==='duplicateFailed'?'failed':['currentReprocessOldRun','failedOldRun'].includes(state.kind)?'reprocessing':undefined);
    if(seeded)for(const id of new Set((active.inputItems||[]).map(item=>item.id))){const file=files.get(id);if(!file)throw failure('Scenario references an unknown fixture file.');makeDocument(file,seeded);}
    state.baseline=counters();
    return {ok:true,scenario:name,baseline:state.baseline,inputItems:active.inputItems||[]};
  }
  function publicDocument(doc){return {id:doc.id,workspaceId,parserId:doc.parserId,name:doc.file.name,mimeType:doc.file.mimeType,byteSize:doc.file.bytes.length,sha256:doc.file.sha256,pageCount:doc.file.pageCount,status:doc.status,latestRunId:doc.latestRunId,approvedRunId:null,error:doc.error,createdAt:stamp,updatedAt:stamp};}
  function progress(doc){
    const current=jobs.get(doc.currentJobId);if(['completed','failed'].includes(current.state))return;
    doc.ticks++;
    const kind=state.kind,terminal=active.terminalState||(kind==='timeout'?'processing':['failed','failedOldRun'].includes(kind)?'failed':'completed');
    current.state=doc.ticks===1?'queued':doc.ticks===2?'processing':terminal;
    current.attempts=current.state==='queued'?0:1;
    if(current.state==='completed'){doc.status='needs_review';const run=makeRun(doc,current);state.completedCurrentRunIds.push(run.id);}
    else if(current.state==='failed'){doc.status='failed';doc.error=current.error='Synthetic extraction failed.';}
    else doc.status=current.state;
  }
  function metadata(file){const count=(state.metadataReads[file.id]||0)+1;state.metadataReads[file.id]=count;const kind=state.kind,afterDownload=state.downloads.some(item=>item.fileId===file.id);
    const result={id:file.id,name:file.name,mimeType:file.mimeType,size:kind==='oversize'?String(5*1024*1024):file.size,version:kind==='drift'&&afterDownload?(file.version==='1'?'2':'1'):file.version,modifiedTime:kind==='drift'&&afterDownload?'2026-09-26T12:01:00.000Z':file.modifiedTime,md5Checksum:kind==='checksumMismatch'?'0'.repeat(32):file.md5Checksum,capabilities:{canDownload:kind!=='capabilityDenied'},trashed:false,parents:[catalog.folderId]};
    if(kind==='checksumMissing')delete result.md5Checksum;
    return {...result,...active.metadata,...(afterDownload?active.afterMetadata:{})};
  }
  function snapshot(){return {...state,counters:counters(),documents:[...documents.values()].map(doc=>({...publicDocument(doc),currentJobId:doc.currentJobId,polls:doc.ticks})),jobs:[...jobs.values()].map(job=>({...job})),runs:[...runs.values()].map(run=>({id:run.id,documentId:run.documentId,jobId:run.jobId,synthetic:true}))};}
  reset(options.scenario||catalog.scenarios[0].name);
  const server=https.createServer({cert,key},async(request,response)=>{
    const host=(request.headers.host||'').split(':')[0].toLowerCase(),url=new URL(request.url,'https://synthetic.invalid');
    const record={sequence:state.requests.length+1,method:request.method,host,path:url.pathname,status:null};if(state.requests.length<2000)state.requests.push(record);
    const send=(status,value)=>{record.status=status;response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(value));};
    const bearer=expected=>request.headers.authorization===`Bearer ${expected}`;
    try{
      if(url.pathname.startsWith('/__qa/')){
        if(request.headers['x-qa-token']!==catalog.adminToken)return send(401,{message:'Synthetic QA header required.'});
        if(request.method==='GET'&&url.pathname==='/__qa/state')return send(200,snapshot());
        if(request.method==='GET'&&url.pathname==='/__qa/config')return send(200,{parserId:catalog.parserId,folderId:catalog.folderId,scenarios:catalog.scenarios,files:[...files.values()].map(({bytes,...file})=>{const {contentBase64,contentText,sourcePath,...safe}=file;return safe;})});
        if(request.method==='POST'&&url.pathname==='/__qa/reset'){const body=JSON.parse((await readBody(request,64*1024)).toString('utf8'));return send(200,reset(body.scenario));}
        throw failure('Unknown QA endpoint.',404);
      }
      const drive=/^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
      if(drive&&host==='www.googleapis.com'){
        if(!bearer(catalog.driveToken))return send(401,{error:{code:401,message:'Synthetic Drive bearer required.'}});
        if(request.method!=='GET')throw failure('Synthetic Drive only permits GET.',405);
        const file=files.get(decodeURIComponent(drive[1]));if(!file)throw failure('Synthetic Drive file not found.',404);
        record.fileId=file.id;
        if(url.searchParams.get('alt')==='media'){state.downloads.push({fileId:file.id,size:file.bytes.length,sha256:file.sha256});record.status=200;response.writeHead(200,{'content-type':file.mimeType,'content-length':file.bytes.length,'cache-control':'no-store'});return response.end(file.bytes);}
        return send(200,metadata(file));
      }
      if(host!=='maintainflow.io'||!url.pathname.startsWith('/api/'))throw failure('This fixture cannot contact or emulate any other host/path.',404);
      if(!bearer(catalog.maintainflowToken))return send(401,{error:'request_error',message:'Synthetic MaintainFlow bearer required.'});
      const upload=/^\/api\/parsers\/([^/]+)\/documents$/.exec(url.pathname);
      if(upload&&request.method==='POST'){
        state.uploadAttempts++;if(upload[1]!==catalog.parserId)throw failure('Synthetic parser not found.',404);
        const parts=parseMultipart(await readBody(request),request.headers['content-type']);
        if(parts.length!==1)throw failure('The recipe must send exactly one source file per multipart request.');
        const part=parts[0],sha256=digest('sha256',part.bytes),md5=digest('md5',part.bytes),file=[...files.values()].find(candidate=>candidate.sha256===sha256&&candidate.md5Checksum===md5&&candidate.bytes.equals(part.bytes));
        if(!file)throw failure('Multipart bytes do not match any synthetic Drive source.',422);
        if(part.filename!==file.name||part.mimeType!==file.mimeType)throw failure('Multipart filename or MIME type no longer matches its source.',422);
        if(!part.field)throw failure('Multipart file field name is missing.');
        const key=request.headers['idempotency-key'];if(typeof key!=='string'||!key.length||key.length>198)throw failure('A bounded per-file idempotency key is required.');
        if(key!==`gd:${catalog.parserId}:${file.id}:v${file.version}`)throw failure('The source idempotency key does not match its parser, file and exact version string.',409);
        const uploadRecord={fileId:file.id,filename:part.filename,field:part.field,bytes:part.bytes.length,sha256,md5,idempotencyKeySha256:digest('sha256',key),duplicate:false,documentId:null,jobId:null};state.uploads.push(uploadRecord);
        if(state.kind==='quota')throw failure('Synthetic monthly page quota reached.',429);
        const prior=idempotency.get(key);if(prior&&prior.sha256!==sha256)throw failure('Idempotency key reused with different content.',409);
        let doc=prior?documents.get(prior.documentId):[...documents.values()].find(candidate=>candidate.file.sha256===sha256&&candidate.parserId===catalog.parserId);
        const duplicate=Boolean(doc);if(!doc)doc=makeDocument(file);idempotency.set(key,{sha256,documentId:doc.id});
        const jobId=duplicate?null:doc.currentJobId;Object.assign(uploadRecord,{duplicate,documentId:doc.id,jobId});
        if(state.kind==='malformedResponse')return send(202,{document:{id:'malformed-synthetic-id'},duplicate:false,jobId:null,results:[]});
        const result={document:publicDocument(doc),duplicate,jobId};return send(202,{...result,results:[result]});
      }
      const document=/^\/api\/documents\/([^/]+)$/.exec(url.pathname),job=/^\/api\/jobs\/([^/]+)$/.exec(url.pathname),run=/^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if(request.method==='GET'&&document){const doc=documents.get(document[1]);if(!doc)throw failure('Synthetic document not found.',404);progress(doc);const ordered=doc.jobIds.map(id=>jobs.get(id));if(active.reverseJobs)ordered.reverse();return send(200,{document:publicDocument(doc),parser:{id:catalog.parserId,name:'Synthetic QA parser'},jobs:ordered.map(({documentId,...entry})=>entry),runs:doc.runIds.map(id=>runs.get(id)),lifecycle:[],split:null,archive:null});}
      if(request.method==='GET'&&job){const entry=jobs.get(job[1]);if(!entry)throw failure('Synthetic job not found.',404);progress(documents.get(entry.documentId));return send(200,{job:entry});}
      if(request.method==='GET'&&run){const entry=runs.get(run[1]);if(!entry)throw failure('Synthetic run not found.',404);return send(200,{run:entry});}
      state.unexpectedRequests.push({method:request.method,host,path:url.pathname});throw failure('Unexpected synthetic MaintainFlow endpoint.',404);
    }catch(error){send(error.status||500,{error:'request_error',message:error.status?error.message:'Synthetic fixture request failed.'});}
  });
  const port=Number(options.port??process.env.PORT??443),bind=options.host||'0.0.0.0';
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,bind,resolve);});
  return {server,address:server.address(),reset,snapshot,catalog,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const fixture=await startFixtureServer();
  process.stdout.write(JSON.stringify({fixture:'synthetic-source-intake',ready:true,port:fixture.address.port})+'\n');
  const stop=()=>{fixture.server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),5000).unref();};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
