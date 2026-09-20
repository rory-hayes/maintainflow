import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import {makeTiff} from './fixtures/tiff.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {reserveDirectUpload,confirmDirectSplit,finalizeDirectUpload} from '../server/core/upload-routes.js';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,withWorkspace,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {addDocument} from '../server/core/intake.js';
import {addArchiveDocuments} from '../server/core/archive-import-intake.js';
import {addSplitDocuments} from '../server/core/pdf-split-intake.js';
import {splitStoredPdf} from '../server/core/stored-pdf-split.js';
import {splitPdfSource} from '../server/core/source.js';
import {deleteStoredFile} from '../server/core/retention.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;documentId:string;sha256:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>(),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const originalFetch=globalThis.fetch,every={mode:'every' as const,pagesPerDocument:2};
let app:FastifyInstance,verified=false,pdf:Buffer,fetches=0,reads=0,writes=0;
const storage:PrivateStorage={kind:'supabase',async signUpload(key){return 'https://owned.invalid/'+key;},
 async write(key,bytes){writes++;objects.set(key,Buffer.from(bytes));},
 async read(key){reads++;const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned original unavailable'),{statusCode:404});return Buffer.from(bytes);},
 async remove(key){objects.delete(key);},
};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const authorization=(a:Account)=>({actor:actor(a),tokenHash:hashToken(a.cookie.split('; ').find(value=>value.startsWith('folio_session='))!.slice('folio_session='.length))});
async function request(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={}){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id,...headers}});}
async function fixture(label:string):Promise<Fixture>{
 const registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned TIFF split',workspaceName:`Owned TIFF split ${label}`,email:`tiff-split-${randomUUID()}@example.test`,password:'Owned TIFF split fixture password'}});assert.equal(registered.statusCode,201,registered.body);
 const account={...registered.json(),cookie:registered.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000') where id=$1",[account.workspace.id]);
 const parser=await request(account,'POST','/api/parsers',{name:'Owned TIFF split parser',useCase:'custom',mode:'ai',allowedFormats:['tiff'],schema:{fields:[{key:'reference',label:'Reference',type:'string',anchor:'Reference'}]}});assert.equal(parser.statusCode,201,parser.body);
 const parserId=parser.json().parser.id,source=await addDocument(actor(account),parserId,pdf,'owned-stored-source.tiff');
 return {account,parserId,documentId:source.document.id,sha256:hash(pdf)};
}
const submit=(f:Fixture,requestId=randomUUID(),options:unknown=every,sourceSha256=f.sha256,documentId=f.documentId)=>request(f.account,'POST',`/api/documents/${documentId}/pdf-splits`,{requestId,sourceSha256,options});
async function counts(f:Fixture){return (await adminPool.query(`select
 (select count(*)::int from documents where workspace_id=$1) documents,
 (select count(*)::int from jobs where workspace_id=$1) jobs,
 (select count(*)::int from pdf_splits where workspace_id=$1) splits,
 (select count(*)::int from stored_pdf_split_requests where workspace_id=$1) admissions,
 (select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages`,[f.account.workspace.id])).rows[0];}

before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,url?5432:55432);if(!url)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No external requests in TIFF split fixtures');};app=await buildApp();
 pdf=makeTiff([{width:80,height:100,color:[200,20,30],compression:'deflate'},{width:60,height:40,color:[30,200,40],orientation:6,compression:'deflate'},{width:50,height:70,color:[40,50,220],orientation:3,compression:'deflate'},{width:72,height:48,color:[220,180,30],orientation:8,compression:'deflate'}],{bigTiff:true,byteOrder:'MM'});
});
afterEach(()=>{setExtractionProvider(undefined);assert.equal(fetches,0);});
after(async()=>{setExtractionProvider(undefined);setStorageForTests(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}}finally{objects.clear();await closeDatabase();}});

test('real heterogeneous BigTIFF splits retain exact source, image samples and MIME through API replay',async()=>{
 const f=await fixture('samples'),id=randomUUID(),original=(await adminPool.query('select * from documents where id=$1',[f.documentId])).rows[0];
 const response=await submit(f,id);assert.equal(response.statusCode,202,response.body);const accepted=response.json();
 assert.equal(accepted.split.sourceMimeType,'image/tiff');assert.equal(accepted.split.origin,'stored');assert.equal(accepted.split.sourceSha256,f.sha256);
 assert.deepEqual(accepted.documents.map((d:any)=>[d.originalPageStart,d.originalPageEnd,d.pageCount]),[[1,2,2],[3,4,2]]);
 for(const [i,child]of accepted.documents.entries()){
  const detail=(await request(f.account,'GET',`/api/documents/${child.id}`)).json();assert.equal(detail.document.mimeType,'image/tiff');assert.equal(detail.split.sourceMimeType,'image/tiff');assert.match(detail.document.name,/\.tiff$/);
  const output=(await request(f.account,'GET',`/api/documents/${child.id}/original`)).rawPayload;
  assert.equal(detail.document.sha256,hash(output));assert.deepEqual(detail.document.sourceText,[{page:1,text:''},{page:2,text:''}]);
  for(let page=0;page<2;page++){
   const before=sharp(pdf,{page:i*2+page,pages:1}),after=sharp(output,{page,pages:1});
   const [a,b]=await Promise.all([before.metadata(),after.metadata()]);assert.deepEqual([b.width,b.height,b.orientation],[a.width,a.height,a.orientation]);
   assert.deepEqual(await after.raw().toBuffer(),await before.raw().toBuffer());
  }
  const bundle=await request(f.account,'GET',`/api/documents/${child.id}/bundle-original`);assert.equal(bundle.headers['content-type'],'image/tiff');assert.match(String(bundle.headers['content-disposition']),/^attachment/);assert.deepEqual(bundle.rawPayload,pdf);
 }
 assert.deepEqual((await adminPool.query('select * from documents where id=$1',[f.documentId])).rows[0],original);
 const state=await counts(f),io=[reads,writes],replay=await submit(f,id);assert.equal(replay.statusCode,202,replay.body);assert.equal(replay.json().split.id,accepted.split.id);assert.equal(replay.json().replayed,true);assert.deepEqual(await counts(f),state);assert.deepEqual([reads,writes],io);
 assert.deepEqual(state,{documents:3,jobs:3,splits:1,admissions:1,pages:8});
});

test('TIFF upload, ZIP leaves and nested stored children preserve root pages after ancestor undo',async()=>{
 const f=await fixture('lineage'),zip=new JSZip();zip.file('scans/source.tiff',pdf,{createFolders:false});const archiveBytes=await zip.generateAsync({type:'nodebuffer'});
 const archive=await addArchiveDocuments(actor(f.account),f.parserId,archiveBytes,'owned.zip',randomUUID(),{mode:'zip',version:1,sourceSha256:hash(archiveBytes),entries:[1]});
 const zipSource=archive.documents[0].id,zipSplit=await submit(f,randomUUID(),every,f.sha256,zipSource);assert.equal(zipSplit.statusCode,202,zipSplit.body);
 const zipChild=zipSplit.json().documents[0];assert.equal(zipChild.root.kind,'document');assert.equal(zipChild.root.id,zipSource);assert.equal(zipChild.root.pageCount,4);
 const upload=await addSplitDocuments(actor(f.account),f.parserId,pdf,'upload.tiff',randomUUID(),every);assert.equal(upload.split.sourceMimeType,'image/tiff');
 const sourceId=upload.documents[1].id,source=objects.get(`${f.account.workspace.id}/${sourceId}`)!,sourceHash=hash(source);
 const parent=await submit(f,randomUUID(),every,sourceHash,sourceId);assert.equal(parent.statusCode,202,parent.body);const parentReceipt=parent.json();
 const nestedSource=parentReceipt.documents[0].id,nestedBytes=objects.get(`${f.account.workspace.id}/${nestedSource}`)!;
 const nested=await submit(f,randomUUID(),{mode:'ranges',ranges:[{start:2,end:2}]},hash(nestedBytes),nestedSource);assert.equal(nested.statusCode,202,nested.body);const nestedReceipt=nested.json(),leaf=nestedReceipt.documents[0];
 assert.deepEqual(leaf.root,{kind:'pdf-split',id:upload.split.id,sha256:f.sha256,pageCount:4,pageStart:4,pageEnd:4});
 const before=await counts(f),undone=await request(f.account,'POST',`/api/pdf-splits/${parentReceipt.split.id}/undo`,{});assert.equal(undone.statusCode,200,undone.body);assert.equal(undone.json().removedDocuments,1);
 assert.equal((await request(f.account,'GET',`/api/documents/${nestedSource}`)).statusCode,404);
 assert.equal((await request(f.account,'GET',`/api/documents/${leaf.id}`)).statusCode,200);assert.deepEqual((await request(f.account,'GET',`/api/documents/${leaf.id}/bundle-original`)).rawPayload,nestedBytes);
 await deleteStoredFile(f.account.workspace.id,`${f.account.workspace.id}/${nestedSource}`);assert.equal(objects.has(`${f.account.workspace.id}/${nestedSource}`),false);assert.ok(objects.has(`${f.account.workspace.id}/${leaf.id}`));assert.ok(objects.has(`${f.account.workspace.id}/${nestedReceipt.split.id}`));assert.equal((await counts(f)).pages,before.pages);
});

test('TIFF-only policy, unsupported marker and durable rejections retain exact source binding',async()=>{
 const f=await fixture('rejections'),id=randomUUID();
 await adminPool.query("update parsers set allowed_formats=ARRAY['pdf'] where id=$1",[f.parserId]);
 const refused=await submit(f,id);assert.equal(refused.statusCode,415,refused.body);
 const recovered=await request(f.account,'GET',`/api/parsers/${f.parserId}/pdf-splits/requests/${id}`);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().rejected.sourceMimeType,'image/tiff');assert.equal(recovered.json().rejected.reason,'tiff');assert.equal(recovered.json().rejected.sourceSha256,f.sha256);
 await adminPool.query("update parsers set allowed_formats=ARRAY['tiff'] where id=$1",[f.parserId]);assert.equal((await submit(f,id)).statusCode,415);
 const markerId=randomUUID(),marker=await submit(f,markerId,{mode:'marker',marker:'Invoice',ranges:[{start:1,end:4}]});assert.equal(marker.statusCode,400,marker.body);const markerReceipt=await request(f.account,'GET',`/api/parsers/${f.parserId}/pdf-splits/requests/${markerId}`);assert.equal(markerReceipt.statusCode,200,markerReceipt.body);assert.equal(markerReceipt.json().rejected.reason,'tiff_marker_unsupported');assert.equal(markerReceipt.json().rejected.sourceMimeType,'image/tiff');
 assert.deepEqual(await counts(f),{documents:1,jobs:1,splits:2,admissions:2,pages:4});
 const fresh=await submit(f);assert.equal(fresh.statusCode,202,fresh.body);
 const wrongMime=randomUUID();await adminPool.query("update documents set mime_type='application/pdf' where id=$1",[f.documentId]);assert.equal((await submit(f,wrongMime)).statusCode,409);
});

test('signed TIFF preview reservations confirm one plan, finalize once and retain TIFF tombstones',async()=>{
 const f=await fixture('signed'),requestId=randomUUID();
 const reservation=await reserveDirectUpload(actor(f.account),f.parserId,{filename:'scan.tiff',size:pdf.length,sha256:f.sha256,pdfSplit:{requestId}});
 objects.set(`${f.account.workspace.id}/${reservation.uploadId}`,pdf);
 await assert.rejects(finalizeDirectUpload(actor(f.account),reservation.uploadId),(e:any)=>e.statusCode===409);
 assert.equal((await counts(f)).pages,4);
 await confirmDirectSplit(actor(f.account),reservation.uploadId,{options:every});
 await assert.rejects(confirmDirectSplit(actor(f.account),reservation.uploadId,{options:{mode:'every',pagesPerDocument:1}}),(e:any)=>e.statusCode===409);
 const first=await finalizeDirectUpload(actor(f.account),reservation.uploadId);assert.equal(first.split.sourceMimeType,'image/tiff');assert.equal(first.documents.length,2);assert.equal((await counts(f)).pages,8);
 await confirmDirectSplit(actor(f.account),reservation.uploadId,{options:every});const replay=await finalizeDirectUpload(actor(f.account),reservation.uploadId);assert.equal(replay.split.id,first.split.id);assert.equal(replay.replayed,true);
 await request(f.account,'DELETE',`/api/documents/${first.documents[0].id}`);const tombstone=await finalizeDirectUpload(actor(f.account),reservation.uploadId);assert.equal(tombstone.documents[0].available,false);assert.equal(tombstone.split.sourceMimeType,'image/tiff');assert.equal((await counts(f)).pages,8);
});

test('split TIFFs complete controlled extraction, correction, approval and typed exports while undo preserves prior original exports',async()=>{
 const f=await fixture('workflow');let calls=0;
 setExtractionProvider({configured:()=>true,extract:async input=>{calls++;assert.equal(input.mimeType,'image/tiff');assert.ok(input.visualDocument);const pdf=await PDFDocument.load(input.visualDocument.bytes);assert.equal(pdf.getPageCount(),input.pages.length);return {rawValues:{reference:'CONTROLLED'},normalizedValues:{reference:'CONTROLLED'},evidence:{reference:[{page:input.pages.length,text:'CONTROLLED',source:'model-visual'}]},issues:[],model:'controlled-tiff-split',engine:'controlled-ai',promptVersion:'fixture-v1',tokenUsage:{inputTokens:1},costUsd:0};}});
 const originalJob=(await adminPool.query('select id from jobs where document_id=$1',[f.documentId])).rows[0].id;assert.equal(await processOneCoreJob(originalJob),true);
 async function approve(id:string,value:string){const detail=(await request(f.account,'GET',`/api/documents/${id}`)).json(),run=detail.runs[0];assert.equal(run.documentSha256,detail.document.sha256);const correction=await request(f.account,'POST',`/api/runs/${run.id}/corrections`,{expectedRevision:run.effectiveRevision,values:{reference:value}});assert.equal(correction.statusCode,200,correction.body);const approval=await request(f.account,'POST',`/api/runs/${run.id}/approve`,{expectedRevision:correction.json().run.effectiveRevision});assert.equal(approval.statusCode,200,approval.body);return approval.json().approval.id;}
 async function exported(ids:string[],approvalIds:string[],format:string){const r=await request(f.account,'POST','/api/exports',{format,documentIds:ids,revisions:ids.map((documentId,i)=>({documentId,approvalId:approvalIds[i]})),columns:[{source:'reference',label:'Reference'}]});assert.equal(r.statusCode,200,r.body);const e=r.json(),download=await request(f.account,'GET',e.downloadUrl);assert.equal(download.statusCode,200,download.body);return {...e,bytes:download.rawPayload};}
 const originalApproval=await approve(f.documentId,'ORIGINAL'),saved=[];
 for(const format of ['csv','xlsx','json'])saved.push(await exported([f.documentId],[originalApproval],format));
 const response=await submit(f);assert.equal(response.statusCode,202,response.body);const receipt=response.json(),approvals=[];
 for(const [i,child]of receipt.documents.entries()){assert.equal(await processOneCoreJob(child.jobId),true);assert.equal(await processOneCoreJob(child.jobId),false);approvals.push(await approve(child.id,`CHILD-${i+1}`));}
 assert.equal(calls,3);const children=[];
 for(const format of ['csv','xlsx','json']){
  const e=await exported(receipt.documents.map((d:any)=>d.id),approvals,format);children.push(e);
  if(format==='csv')assert.match(e.bytes.toString(),/"CHILD-1"\r\n"CHILD-2"/);
  if(format==='json')assert.deepEqual(JSON.parse(e.bytes.toString()).documents.map((d:any)=>d.values.reference),['CHILD-1','CHILD-2']);
  if(format==='xlsx'){const {default:ExcelJS}=await import('exceljs');const book=new ExcelJS.Workbook();await book.xlsx.load(e.bytes);assert.deepEqual([book.worksheets[0].getCell('A2').value,book.worksheets[0].getCell('A3').value],['CHILD-1','CHILD-2']);}
 }
 const reversed=await exported(receipt.documents.map((d:any)=>d.id).reverse(),[...approvals].reverse(),'json');children.push(reversed);assert.deepEqual(JSON.parse(reversed.bytes.toString()).documents.map((d:any)=>d.values.reference),['CHILD-2','CHILD-1']);
 const undone=await request(f.account,'POST',`/api/pdf-splits/${receipt.split.id}/undo`,{});assert.equal(undone.statusCode,200,undone.body);assert.equal(undone.json().removedDocuments,2);
 for(const e of saved)assert.deepEqual((await request(f.account,'GET',e.downloadUrl)).rawPayload,e.bytes);
 for(const e of children)assert.equal((await request(f.account,'GET',e.downloadUrl)).statusCode,404);
 assert.deepEqual((await request(f.account,'GET',`/api/documents/${f.documentId}/original`)).rawPayload,pdf);assert.equal((await counts(f)).pages,8);
});
