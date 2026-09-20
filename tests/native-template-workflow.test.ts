import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {setSchemaSuggestionProvider} from '../server/core/schema-suggestions.js';
import {readPdfGeometry} from '../server/core/source.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {findPdfRegionAnchor,type PdfRegionRule} from '../shared/pdf-regions.js';
import type {Actor,ParserSchema} from '../shared/types.js';
import type {TemplateDefinition} from '../shared/template-definitions.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;schemaId:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>();
const schema:ParserSchema={fields:[{key:'reference',label:'Reference',type:'string',required:true},{key:'amount',label:'Amount',type:'currency',required:true},{key:'enabled',label:'Enabled',type:'boolean',required:true}]};
const columns=[{source:'reference',label:'Reference'},{source:'amount',label:'Amount'},{source:'enabled',label:'Enabled'}];
let app:Awaited<ReturnType<typeof buildApp>>,verified=false,beforeRead:((key:string)=>Promise<void>)|undefined;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key,maxBytes){await beforeRead?.(key);const bytes=objects.get(key);if(!bytes)throw new Error('Missing owned native template source');if(maxBytes!==undefined&&bytes.length>maxBytes)throw new Error('Owned source exceeds read limit');return Buffer.from(bytes);},async remove(key){objects.delete(key);}};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
async function request(a:Account,method:any,url:string,payload?:unknown,headers:Record<string,string>={}){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,...headers}});}
function ok(response:any,status=200){assert.equal(response.statusCode,status,response.body);return response.json();}
async function account(label:string):Promise<Account>{
  const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned native '+label,workspaceName:'Owned native '+label,email:`native-workflow-${randomUUID()}@example.test`,password:'Owned native workflow password'}});
  const result={...ok(response,201),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(result);
  await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{maxParsers}','20'),'{monthlyPages}','1000') where id=$1",[result.workspace.id]);return result;
}
async function parser(a:Account,mode:'rules'|'ai'='rules'):Promise<Fixture>{const value=ok(await request(a,'POST','/api/parsers',{name:'Owned native parser',useCase:'custom',mode,schema,locale:'en-IE'}),201);return {account:a,parserId:value.parser.id,schemaId:value.schema.id};}
async function pdf(reference:string,shift=0,pages=1){
  const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica);
  for(let i=0;i<pages;i++){const page=doc.addPage([500,700]);for(const [label,value,y] of [['Reference:',reference+(pages>1?'-'+(i+1):''),570],['Amount:','1234.50',470],['Enabled:','false',370]] as const){page.drawText(label,{x:60+shift,y:y-shift,font,size:12});page.drawText(value,{x:250+shift,y:y-shift,font,size:12});}}
  return Buffer.from(await doc.save());
}
async function rulesFor(bytes:Buffer):Promise<PdfRegionRule[]>{
  const geometry=await readPdfGeometry(bytes),page=geometry.pages[0];
  return [['reference','Reference:'],['amount','Amount:'],['enabled','Enabled:']].map(([field,anchor])=>{
    const found=findPdfRegionAnchor(page,anchor);assert.equal(found.matched,true);if(!found.matched)throw new Error('Fixture anchor missing');
    const block=page.items.find(item=>item.rect.x>.45&&Math.abs(item.rect.y-found.anchor.rect.y)<.005);assert.ok(block);
    // Fixed generous right-hand value region supports independently varied identifiers.
    return {field,anchor,page:1,reference:{width:page.width,height:page.height,rotation:page.rotation},offset:{x:.49-found.anchor.rect.x,y:block.rect.y-found.anchor.rect.y-.003,width:.40,height:block.rect.height+.006}};
  });
}
async function nativeTemplate(f:Fixture,bytes:Buffer,name='Owned native template'){
  const definition:TemplateDefinition={kind:'native-pdf-region-v1',name,matchText:'',enabled:true,rules:await rulesFor(bytes)};
  const body={...definition,requestId:randomUUID(),baseSchemaId:f.schemaId};const result=ok(await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,body));return {definition,body,template:result.template};
}
async function upload(f:Fixture,bytes:Buffer,name='owned-native.pdf'){const value=await addDocument(actor(f.account),f.parserId,bytes,name);assert.ok(value.jobId);return {...value,jobId:value.jobId!};}
async function job(id:string){return (await adminPool.query('select * from jobs where id=$1',[id])).rows[0];}
async function detail(f:Fixture,id:string){return ok(await request(f.account,'GET',`/api/documents/${id}`));}
async function ledger(a:Account){return (await adminPool.query('select id,event,pages,idempotency_key from usage_ledger where workspace_id=$1 order by id',[a.workspace.id])).rows;}
async function successful(f:Fixture,id:string,documentId:string){assert.equal(await processOneCoreJob(id),true);const state=await job(id);assert.equal(state.state,'completed',state.error);const d=await detail(f,documentId);assert.equal(d.runs[0].engine,'native-pdf-regions');return d.runs[0];}
function multipart(bytes:Buffer,name:string,fields:Record<string,string>){const boundary='native-'+randomUUID();return {headers:{'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat([...Object.entries(fields).map(([key,value])=>Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)),Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)])};}

before(async()=>{
  const options=adminPool.options,host=options.connectionString?new URL(options.connectionString).hostname:options.host;
  assert.ok(typeof host==='string'&&(host.startsWith('/')||['127.0.0.1','localhost','::1','[::1]'].includes(host)));assert.equal(options.database??new URL(options.connectionString!).pathname.slice(1),'folio');
  verified=true;setStorageForTests(storage);app=await buildApp();
});
afterEach(()=>{beforeRead=undefined;setExtractionProvider(undefined);setSchemaSuggestionProvider(undefined);});
after(async()=>{beforeRead=undefined;setStorageForTests(undefined);setExtractionProvider(undefined);setSchemaSuggestionProvider(undefined);try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}objects.clear();}finally{await closeDatabase();}});

test('real translated native PDF uses a pinned definition after edits/deletion, then correction and exact typed exports preserve its source history',async()=>{
  const f=await parser(await account('history'),'ai'),sample=await pdf('SAMPLE'),saved=await nativeTemplate(f,sample);
  let aiCalls=0;setExtractionProvider({configured:()=>true,extract:async()=>{aiCalls++;throw new Error('Regions must bypass controlled AI');}});
  const bytes=await pdf('SHIFTED-042',35),source=await upload(f,bytes),beforeUsage=await ledger(f.account),pinned=structuredClone((await job(source.jobId)).config);
  const edited=ok(await request(f.account,'PATCH',`/api/templates/${saved.template.id}`,{...saved.definition,name:'Current changed template',rules:saved.definition.rules.map(rule=>({...rule,anchor:'Missing current anchor'})),requestId:randomUUID(),baseSchemaId:f.schemaId,baseRevision:1}));assert.equal(edited.template.revision,2);
  ok(await request(f.account,'DELETE',`/api/templates/${saved.template.id}`,{requestId:randomUUID(),baseRevision:2}));
  const run=await successful(f,source.jobId,source.document.id);assert.equal(aiCalls,0);assert.deepEqual(run.rawValues,{reference:'SHIFTED-042',amount:'1234.50',enabled:'false'});assert.deepEqual(run.normalizedValues,{reference:'SHIFTED-042',amount:1234.5,enabled:false});
  assert.deepEqual(run.templateSnapshot.template,{...saved.definition,id:saved.template.id,revision:1});assert.equal(run.evidence.reference[0].region.sourceSha256,sha(bytes));assert.deepEqual((await job(source.jobId)).config,pinned);assert.deepEqual(await ledger(f.account),beforeUsage);
  const values={reference:'CORRECTED-042',amount:0,enabled:false};const corrected=ok(await request(f.account,'POST',`/api/runs/${run.id}/corrections`,{expectedRevision:run.effectiveRevision,values}));const approval=ok(await request(f.account,'POST',`/api/runs/${run.id}/approve`,{expectedRevision:corrected.run.effectiveRevision})).approval;
  for(const format of ['json','csv','xlsx']){const output=ok(await request(f.account,'POST','/api/exports',{format,documentIds:[source.document.id],revisions:[{documentId:source.document.id,approvalId:approval.id}],columns}));const download=await request(f.account,'GET',output.downloadUrl);assert.equal(download.statusCode,200);
    if(format==='json')assert.deepEqual(JSON.parse(download.body).documents[0].values,values);
    if(format==='csv')assert.equal(download.body,'\uFEFF"Reference","Amount","Enabled"\r\n"CORRECTED-042","0","false"\r\n');
    if(format==='xlsx'){const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(download.rawPayload as any);assert.deepEqual([1,2,3].map(column=>workbook.worksheets[0].getCell(2,column).value),['CORRECTED-042',0,false]);}
  }
  await adminPool.query('delete from jobs where id=$1',[source.jobId]);const historical=ok(await request(f.account,'GET',`/api/runs/${run.id}`)).run;assert.equal(historical.jobId,null);assert.deepEqual(historical.templateSnapshot,run.templateSnapshot);assert.deepEqual(historical.evidence,run.evidence);assert.deepEqual(historical.rawValues,run.rawValues);assert.deepEqual(historical.effectiveValues,values);
  assert.equal(sha((await request(f.account,'GET',`/api/documents/${source.document.id}/original`)).rawPayload),sha(bytes));
});

test('pre-region complete-v1 and unstamped jobs retain their old execution while unknown explicit policies fail without AI',async()=>{
  const f=await parser(await account('legacy'),'ai');ok(await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,{name:'Old text definition',enabled:true,matchText:'',rules:[{field:'reference',anchor:'Reference'},{field:'amount',anchor:'Amount'},{field:'enabled',anchor:'Enabled'}]}));
  let calls=0;setExtractionProvider({configured:()=>true,extract:async()=>{calls++;return {engine:'controlled-legacy',model:'controlled',rawValues:{reference:'AI',amount:'1',enabled:'false'},normalizedValues:{reference:'AI',amount:1,enabled:false},evidence:{},issues:[]};}});
  const old=await upload(f,await pdf('OLD-V1')),legacy=await upload(f,await pdf('UNSTAMPED')),unknown=await upload(f,await pdf('FUTURE'));
  const oldConfig=(await job(old.jobId)).config;oldConfig.templatePolicy='complete-v1';oldConfig.templates=oldConfig.templates.map(({kind,revision,...entry}:any)=>entry);
  await adminPool.query('update jobs set config=$2 where id=$1',[old.jobId,JSON.stringify(oldConfig)]);await adminPool.query("update jobs set config=config-'templatePolicy' where id=$1",[legacy.jobId]);await adminPool.query("update jobs set config=jsonb_set(config,'{templatePolicy}','\"future-policy\"') where id=$1",[unknown.jobId]);
  assert.equal(await processOneCoreJob(old.jobId),true);const v1=(await detail(f,old.document.id)).runs[0];assert.equal(v1.engine,'text-template');assert.equal(v1.selection.policy,'complete-v1');assert.equal(v1.selection.template.revision,undefined);assert.equal(v1.templateSnapshot,null);assert.equal(calls,0);
  assert.equal(await processOneCoreJob(legacy.jobId),true);const unstamped=(await detail(f,legacy.document.id)).runs[0];assert.equal(unstamped.engine,'controlled-legacy');assert.equal(unstamped.selection,null);assert.equal(unstamped.templateSnapshot,null);assert.equal(calls,1);
  assert.equal(await processOneCoreJob(unknown.jobId),true);assert.equal((await job(unknown.jobId)).state,'failed');assert.equal((await detail(f,unknown.document.id)).runs.length,0);assert.equal(calls,1);
});

test('ordinary upload, explicit reprocess, PDF splits and ZIP leaves pin and execute the same region policy',async()=>{
  const f=await parser(await account('intake-writers')),bytes=await pdf('REGULAR'),ordinary=await upload(f,bytes);
  assert.equal(await processOneCoreJob(ordinary.jobId),true);assert.equal((await job(ordinary.jobId)).state,'completed');const saved=await nativeTemplate(f,bytes);
  const fresh=await upload(f,await pdf('FRESH'));await successful(f,fresh.jobId,fresh.document.id);
  const reprocessed=ok(await request(f.account,'POST',`/api/documents/${ordinary.document.id}/reprocess`));await successful(f,reprocessed.job.id,ordinary.document.id);
  const splitBytes=await pdf('SPLIT',0,2),splitInput=multipart(splitBytes,'native-pages.pdf',{requestId:randomUUID(),options:JSON.stringify({mode:'every',pagesPerDocument:1})});
  const split=ok(await request(f.account,'POST',`/api/parsers/${f.parserId}/pdf-splits`,splitInput.payload,splitInput.headers),202);
  const zip=new JSZip();zip.file('owned.pdf',await pdf('ZIP'));const zipBytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),requestId=randomUUID(),previewInput=multipart(zipBytes,'owned.zip',{requestId});
  const preview=ok(await request(f.account,'POST',`/api/parsers/${f.parserId}/archive-imports/preview`,previewInput.payload,previewInput.headers));const options={mode:'zip',version:1,sourceSha256:sha(zipBytes),entries:preview.entries.map((entry:any)=>entry.index)};
  const archiveInput=multipart(zipBytes,'owned.zip',{requestId,options:JSON.stringify(options)}),archive=ok(await request(f.account,'POST',`/api/parsers/${f.parserId}/archive-imports`,archiveInput.payload,archiveInput.headers),202);
  for(const child of [...split.documents,...archive.documents]){const pinned=(await adminPool.query('select * from jobs where document_id=$1',[child.id])).rows[0];assert.equal(pinned.config.templatePolicy,'complete-regions-v1');assert.equal(pinned.config.templates[0].kind,'native-pdf-region-v1');assert.equal(pinned.config.templates[0].id,saved.template.id);await successful(f,pinned.id,child.id);}
});

test('initial schema release pins the native definition only onto its never-attempted held source',async()=>{
  const a=await account('setup-writer');let calls=0;setExtractionProvider({configured:()=>true,extract:async()=>{calls++;throw new Error('Native released job should bypass AI');}});setSchemaSuggestionProvider({configured:()=>true,suggest:async()=>{throw new Error('Manual release must not run discovery');}});
  const created=ok(await request(a,'POST','/api/parsers',{name:'Owned pending native parser',useCase:'custom',mode:'ai',setupMode:'sample'}),201),f={account:a,parserId:created.parser.id,schemaId:created.schema.id};const bytes=await pdf('HELD'),source=await upload(f,bytes);assert.equal((await job(source.jobId)).waiting_for_schema,true);
  // A restored/preconfigured pending parser can already contain a reusable definition.
  const rules=await rulesFor(bytes);await adminPool.query("insert into templates(workspace_id,parser_id,name,match_text,rules,enabled,kind,revision) values($1,$2,'Preserved pending native','',$3,true,'native-pdf-region-v1',4)",[a.workspace.id,f.parserId,JSON.stringify(rules)]);
  const saved=ok(await request(a,'POST',`/api/parsers/${f.parserId}/schema`,schema));const released=await job(source.jobId);assert.equal(released.waiting_for_schema,false);assert.equal(released.schema_version_id,saved.schema.id);assert.equal(released.config.templatePolicy,'complete-regions-v1');assert.equal(released.config.templates[0].revision,4);
  const run=await successful(f,source.jobId,source.document.id);assert.equal(run.normalizedValues.reference,'HELD');assert.equal(run.templateSnapshot.template.revision,4);assert.equal(calls,0);
});

test('parser copy retains native rules with fresh identity/revision and no copied documents, history or mutation receipts',async()=>{
  const f=await parser(await account('copy')),bytes=await pdf('COPIED'),saved=await nativeTemplate(f,bytes);
  ok(await request(f.account,'PATCH',`/api/templates/${saved.template.id}`,{...saved.definition,name:'Version two region',requestId:randomUUID(),baseSchemaId:f.schemaId,baseRevision:1}));
  const usage=await ledger(f.account),copy=ok(await request(f.account,'POST',`/api/parsers/${f.parserId}/copy`,{name:'Independent region copy'}),201);
  assert.equal(copy.templates[0].kind,'native-pdf-region-v1');assert.equal(copy.templates[0].revision,1);assert.notEqual(copy.templates[0].id,saved.template.id);assert.deepEqual(copy.templates[0].rules,saved.definition.rules);
  assert.equal((await adminPool.query('select count(*)::int n from documents where parser_id=$1',[copy.parser.id])).rows[0].n,0);assert.equal((await adminPool.query('select count(*)::int n from template_mutations where parser_id=$1',[copy.parser.id])).rows[0].n,0);assert.deepEqual(await ledger(f.account),usage);
  const target={account:f.account,parserId:copy.parser.id,schemaId:copy.schema.id},source=await upload(target,bytes),run=await successful(target,source.jobId,source.document.id);assert.equal(run.templateSnapshot.template.id,copy.templates[0].id);assert.equal(run.normalizedValues.reference,'COPIED');
});

test('source replacement before or during geometry work cannot save a region run or call AI',async()=>{
  const f=await parser(await account('source-fence'),'ai'),bytes=await pdf('VERIFIED');await nativeTemplate(f,bytes);let calls=0;setExtractionProvider({configured:()=>true,extract:async()=>{calls++;throw new Error('Unverified geometry cannot fall back to AI');}});
  const replaced=await upload(f,bytes),key=(await adminPool.query('select storage_key from documents where id=$1',[replaced.document.id])).rows[0].storage_key;objects.set(key,await pdf('DIFFERENT'));
  const usage=await ledger(f.account);assert.equal(await processOneCoreJob(replaced.jobId),true);assert.equal((await job(replaced.jobId)).state,'failed');assert.equal((await detail(f,replaced.document.id)).runs.length,0);assert.deepEqual(await ledger(f.account),usage);
  const racing=await upload(f,await pdf('RACING')),racingKey=(await adminPool.query('select storage_key from documents where id=$1',[racing.document.id])).rows[0].storage_key;
  beforeRead=async current=>{if(current===racingKey){beforeRead=undefined;await adminPool.query('update documents set sha256=$2 where id=$1',[racing.document.id,'b'.repeat(64)]);}};
  assert.equal(await processOneCoreJob(racing.jobId),true);assert.equal((await job(racing.jobId)).state,'failed');assert.equal((await detail(f,racing.document.id)).runs.length,0);assert.equal(calls,0);
});

test('an interrupted source read cannot commit late and a retry processes the same job without another page charge',async()=>{
  const f=await parser(await account('deadline')),bytes=await pdf('RETRY');await nativeTemplate(f,bytes);const source=await upload(f,bytes),usage=await ledger(f.account);
  let release!:()=>void,entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});beforeRead=async()=>{entered();await held;};
  const running=processOneCoreJob(source.jobId,{providerTimeoutMs:60});await started;assert.equal(await running,true);assert.equal((await job(source.jobId)).state,'queued');assert.equal((await detail(f,source.document.id)).runs.length,0);
  beforeRead=undefined;release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal((await detail(f,source.document.id)).runs.length,0);
  await adminPool.query('update jobs set available_at=now() where id=$1',[source.jobId]);await successful(f,source.jobId,source.document.id);assert.deepEqual(await ledger(f.account),usage);assert.equal(await processOneCoreJob(source.jobId),false);
});
