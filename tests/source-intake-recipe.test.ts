/** Synthetic recipe contracts; real n8n execution is a separate isolated check. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const {guards:g,buildWorkflow,codeSource}=await import(new URL('../examples/automations/source-intake/google-drive-n8n.mjs',import.meta.url).href);
const source=JSON.parse(await readFile(new URL('../fixtures/automations/google-drive-intake-source.json',import.meta.url),'utf8'));
const responses=JSON.parse(await readFile(new URL('../fixtures/automations/google-drive-intake-results.json',import.meta.url),'utf8'));
const response=(body:unknown,statusCode=200)=>({statusCode,body});
const prepared=()=>g.prepareSource(g.configure(source.trigger,source.config),response(source.metadata));
const downloaded=()=>g.verifyBytes(prepared(),Buffer.byteLength(source.contentUtf8),source.metadata.md5Checksum,source.binaryMetadata);
const polling=()=>g.beginPolling(downloaded(),responses.upload,1000);

test('import artifact is inactive, credential-free and exactly generated from the tested guard source',async()=>{
 const artifact=JSON.parse(await readFile(new URL('../examples/automations/google-drive-n8n.workflow.json',import.meta.url),'utf8'));
 assert.deepEqual(artifact,buildWorkflow());assert.equal(artifact.active,false);assert.deepEqual(artifact.pinData,{});
 const nodes=new Map<string,any>(artifact.nodes.map((n:any)=>[n.name,n]));assert.equal(nodes.size,artifact.nodes.length);
 for(const node of artifact.nodes){assert.equal(node.credentials,undefined);assert.notEqual(node.retryOnFail,true);if(node.type==='n8n-nodes-base.code')assert.ok(node.parameters.jsCode.startsWith(codeSource('')));}
 assert.deepEqual(artifact.nodes.filter((n:any)=>n.type==='n8n-nodes-base.googleDriveTrigger').map((n:any)=>n.parameters.event).sort(),['fileCreated','fileUpdated']);
 assert.equal(nodes.get('Loop over files').parameters.batchSize,1);
 const upload=nodes.get('Upload to MaintainFlow');assert.equal(upload.parameters.contentType,'multipart-form-data');assert.deepEqual(upload.parameters.bodyParameters.parameters,[{parameterType:'formBinaryData',name:'file',inputDataFieldName:'data'}]);
 assert.equal(upload.parameters.options.redirect.redirect.followRedirects,false);
 assert.equal(upload.parameters.genericAuthType,'httpHeaderAuth');
 for(const connection of Object.values(artifact.connections) as any[])for(const outputs of connection.main)for(const edge of outputs)assert.ok(nodes.has(edge.node));
 assert.equal(artifact.nodes.filter((n:any)=>n.parameters.method==='POST').length,1,'Only document intake can mutate MaintainFlow');
 assert.equal(JSON.stringify(artifact).includes('/approve'),false);assert.equal(JSON.stringify(artifact).includes('/reprocess'),false);
});

test('source bytes and opaque large version produce an exact parser-specific key without number coercion',()=>{
 assert.equal(source.synthetic,true);assert.equal(responses.synthetic,true);
 assert.equal(createHash('sha256').update(source.contentUtf8).digest('hex'),source.sha256);
 assert.equal(createHash('md5').update(source.contentUtf8).digest('hex'),source.metadata.md5Checksum);
 const p=prepared();assert.equal(p.idempotencyKey,source.expectedIdempotencyKey);assert.equal(p.source.version,source.metadata.version);
 const other=g.prepareSource(g.configure(source.trigger,{...source.config,parserId:'a015ec08-2026-4000-8000-000000000002'}),response(source.metadata));assert.notEqual(other.idempotencyKey,p.idempotencyKey);
 assert.deepEqual(g.verifyStableSource(downloaded(),response(source.metadata)),downloaded());
});

test('configuration and metadata reject foreign folders, paths, missing identity, native documents and unsafe filenames',()=>{
 for(const origin of ['https://example.test','http://maintainflow.io','https://maintainflow.io.evil.test','https://maintainflow.io@evil.test'])assert.throws(()=>g.configure(source.trigger,{...source.config,origin}),/configuration_required/);
 assert.throws(()=>g.configure({id:'../bad'},source.config),/source_id_invalid/);
 assert.throws(()=>g.configure({...source.trigger,parents:['different']},source.config),/source_folder_mismatch/);
 const invalid=[{id:'different'},{parents:['different']},{trashed:true},{capabilities:{canDownload:false}},{version:17},{version:null},{size:'0'},{size:'4194305'},{md5Checksum:undefined},{name:'../statement.pdf'},{name:'invoice\n.txt'},{name:'document',mimeType:'application/vnd.google-apps.document'},{name:'archive.zip',mimeType:'application/zip'},{name:'file.__proto__'},{name:'file.constructor'}];
 for(const change of invalid)assert.throws(()=>g.prepareSource(g.configure(source.trigger,source.config),response({...source.metadata,...change})),JSON.stringify(change));
 for(const name of ['file.__proto__','file.constructor'])assert.throws(()=>g.prepareSource(g.configure(source.trigger,source.config),response({...source.metadata,name})),/source_format_unsupported/);
});

test('byte length, checksum, filename and content type must match before a source can be uploaded',()=>{
 const p=prepared(),n=Buffer.byteLength(source.contentUtf8),md5=source.metadata.md5Checksum;
 assert.throws(()=>g.verifyBytes(p,n-1,md5,source.binaryMetadata),/download_size_mismatch/);
 assert.throws(()=>g.verifyBytes(p,n,'0'.repeat(32),source.binaryMetadata),/download_checksum_mismatch/);
 assert.throws(()=>g.verifyBytes(p,n,md5,{...source.binaryMetadata,fileName:'changed.txt'}),/download_metadata_mismatch/);
 assert.throws(()=>g.verifyBytes(p,n,md5,{...source.binaryMetadata,mimeType:'application/pdf'}),/download_metadata_mismatch/);
 assert.throws(()=>g.verifyStableSource(p,response(source.metadata)),/download_unverified/);
});

test('post-download changes in version, name, contents, location or access stop before intake',()=>{
 const changes=[{version:'2'},{name:'renamed.txt'},{md5Checksum:'0'.repeat(32)},{size:'77'},{parents:['moved-folder']},{trashed:true},{capabilities:{canDownload:false}}];
 for(const change of changes)assert.throws(()=>g.verifyStableSource(downloaded(),response({...source.metadata,...change})),JSON.stringify(change));
});

test('typed HTTP failures preserve actionable retry boundaries without reflecting remote response text',()=>{
 for(const status of [401,403,404,409,410,413,429,500,502])assert.throws(()=>g.responseBody(response({message:'secret content must not enter errors'},status),'Upload'),(e:any)=>e.message.includes(`HTTP ${status}`)&&!e.message.includes('secret content'));
 assert.throws(()=>g.responseBody(response({message:'redirect'},302),'Upload'),/http_failure/);
 assert.throws(()=>g.responseBody({statusCode:200,body:[]},'Read'),/response_invalid/);
 assert.throws(()=>g.responseBody({body:{}},'Read'),/response_invalid/);
 assert.throws(()=>g.responseBody(response({message:'Document decoding is busy. Retry shortly.'},429),'Upload'),/same.*(?:source|file).*version/i);
});

test('accepted upload is pending and a duplicate with no job must resolve the current document',()=>{
 const p=polling();assert.equal(p.done,false);assert.throws(()=>g.result(p),/not_complete/);
 const duplicate=g.beginPolling(downloaded(),responses.duplicate,1000);assert.equal(duplicate.uploadedJobId,null);assert.equal(duplicate.done,false);
 const queued=g.inspectDocument(g.nextPoll(duplicate,1100),responses.queued);assert.equal(queued.done,false);assert.equal(queued.jobId,responses.upload.body.jobId);
 const ready=g.inspectDocument(g.nextPoll(queued,1200),responses.ready),out=g.result(ready);assert.equal(out.documentId,responses.upload.body.document.id);assert.equal(out.runId,responses.ready.body.document.latestRunId);assert.equal(out.duplicate,true);assert.match(out.approval,/Manual review/);
});

test('receipt identity and new-job requirements prevent treating unrelated or malformed admission as success',()=>{
 for(const change of [{document:{...responses.upload.body.document,parserId:'a015ec08-2026-4000-8000-000000000002'}},{document:{id:'not-uuid'}},{jobId:null},{duplicate:'true'}])assert.throws(()=>g.beginPolling(downloaded(),response({...responses.upload.body,...change},202),1000));
 assert.throws(()=>g.beginPolling(downloaded(),response(responses.upload.body,200),1000),/http_failure/);
});

test('current active or failed reprocessing takes precedence over a preserved historical successful run',()=>{
 const detail=structuredClone(responses.ready);detail.body.document.status='queued';detail.body.jobs.push({id:'c015ec08-2026-4000-8000-000000000002',state:'queued',waitingForSchema:false});
 const current=g.inspectDocument(polling(),detail);assert.equal(current.done,false);assert.equal(current.jobId,'c015ec08-2026-4000-8000-000000000002');
 detail.body.document.status='failed';detail.body.jobs[1].state='failed';assert.throws(()=>g.inspectDocument(polling(),detail),/processing_failed/);
 detail.body.document.status='queued';assert.throws(()=>g.inspectDocument(polling(),detail),/processing_state_unresolved/);
});

test('missing schemas, ambiguous jobs, wrong documents and incomplete result bindings stay unresolved',()=>{
 const schema=structuredClone(responses.queued);schema.body.jobs[0].waitingForSchema=true;assert.throws(()=>g.inspectDocument(polling(),schema),/schema_required/);
 const two=structuredClone(responses.queued);two.body.jobs.push({...two.body.jobs[0],id:'c015ec08-2026-4000-8000-000000000002'});assert.throws(()=>g.inspectDocument(polling(),two),/job_identity_ambiguous/);
 const wrong=structuredClone(responses.ready);wrong.body.document.id='b015ec08-2026-4000-8000-000000000002';assert.throws(()=>g.inspectDocument(polling(),wrong),/document_identity_mismatch/);
 const missing=structuredClone(responses.ready);missing.body.runs=[];assert.throws(()=>g.inspectDocument(polling(),missing),/latest_run_mismatch/);
 const foreign=structuredClone(responses.ready);foreign.body.runs[0].documentId='b015ec08-2026-4000-8000-000000000002';assert.throws(()=>g.inspectDocument(polling(),foreign),/latest_run_mismatch/);
 const job=structuredClone(responses.ready);job.body.jobs[0].state='failed';assert.throws(()=>g.inspectDocument(polling(),job),/latest_job_unresolved/);
});

test('polling ends at the read or time bound without manufacturing a result or requesting reprocessing',()=>{
 let state=polling();for(let i=0;i<60;i++){state=g.nextPoll(state,1000+i);state=g.inspectDocument(state,responses.queued);assert.equal(state.done,false);}
 assert.equal(state.polls,60);assert.throws(()=>g.nextPoll(state,1100),/poll_timeout/);assert.throws(()=>g.result(state),/not_complete/);
 assert.throws(()=>g.nextPoll(polling(),601000),/poll_timeout/);assert.throws(()=>g.nextPoll(polling(),999),/poll_state_invalid/);
});
