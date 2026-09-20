import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import ExcelJS from 'exceljs';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import type {PdfSplitSpec} from '../shared/pdf-split.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,databaseSchema,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {inspectSource} from '../server/core/source.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {processOneCoreJob} from '../server/core/worker.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;documentId:string;bytes:Buffer;sha256:string};
const accounts:Account[]=[],objects=new Map<string,Buffer>();
const originalFetch=globalThis.fetch;
let app:FastifyInstance,verified=false,fetches=0;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);if(!bytes)throw new Error('Missing owned stored-PDF fixture');return Buffer.from(bytes);},async remove(key){objects.delete(key);}};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const finalValues={reference:'ORIGINAL-APPROVED',amount:42.5,count:0,enabled:false};
const columns=[{source:'reference',label:'Reference'},{source:'amount',label:'Amount'},{source:'count',label:'Count'},{source:'enabled',label:'Enabled'}];
async function request(a:Account,method:'GET'|'POST'|'DELETE',url:string,payload?:unknown){return app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,'x-workspace-id':a.workspace.id}});}
async function fixture(label:string):Promise<Fixture>{
 const registered=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned stored PDF',workspaceName:`Owned stored PDF ${label}`,email:`stored-pdf-workflow-${randomUUID()}@example.test`,password:'Owned stored PDF fixture password'}});assert.equal(registered.statusCode,201,registered.body);
 const account={...registered.json(),cookie:registered.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(account);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','1000') where id=$1",[account.workspace.id]);
 const created=await request(account,'POST','/api/parsers',{name:'Owned stored PDF parser',useCase:'custom',mode:'rules',allowedFormats:['pdf'],schema:{fields:[{key:'reference',label:'Reference',type:'string',required:true},{key:'amount',label:'Amount',type:'currency',required:true},{key:'count',label:'Count',type:'number',required:true},{key:'enabled',label:'Enabled',type:'boolean',required:true}]}});assert.equal(created.statusCode,201,created.body);const parserId=created.json().parser.id;
 const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(let number=1;number<=6;number++){const page=pdf.addPage([360,480]);page.drawText(`Reference: ROOT-${number}\nAmount: 42.50\nCount: 0\nEnabled: false\n${number%2?'SECTION START':'Continued page'}\nOriginal page ${number}`,{font,size:14,x:32,y:420});}
 const bytes=Buffer.from(await pdf.save()),uploaded=await addDocument(actor(account),parserId,bytes,'owned-six-page.pdf');assert.equal(uploaded.document.pageCount,6);assert.ok(uploaded.jobId);assert.equal(await processOneCoreJob(uploaded.jobId),true);
 return {account,parserId,documentId:uploaded.document.id,bytes,sha256:hash(bytes)};
}
async function approve(f:Fixture,id=f.documentId,values=finalValues){
 const detail=await request(f.account,'GET',`/api/documents/${id}`);assert.equal(detail.statusCode,200,detail.body);const run=detail.json().runs[0];assert.ok(run);
 const corrected=await request(f.account,'POST',`/api/runs/${run.id}/corrections`,{values,expectedRevision:run.effectiveRevision});assert.equal(corrected.statusCode,200,corrected.body);
 const approved=await request(f.account,'POST',`/api/runs/${run.id}/approve`,{expectedRevision:corrected.json().run.effectiveRevision});assert.equal(approved.statusCode,200,approved.body);return approved.json().approval;
}
async function exported(f:Fixture,ids:string[],format:'csv'|'xlsx'|'json'){
 const response=await request(f.account,'POST','/api/exports',{documentIds:ids,format,columns});assert.equal(response.statusCode,200,response.body);const result=response.json(),download=await request(f.account,'GET',result.downloadUrl);assert.equal(download.statusCode,200,download.body);return {id:result.id,url:result.downloadUrl,bytes:download.rawPayload};
}
async function originalSnapshot(f:Fixture){
 const result:Record<string,unknown>={};
 for(const [name,query] of Object.entries({
  documents:'select * from documents where id=$1',jobs:'select * from jobs where document_id=$1 order by id',runs:'select * from extraction_runs where document_id=$1 order by id',corrections:'select * from corrections where run_id in(select id from extraction_runs where document_id=$1) order by id',approvals:'select * from approvals where run_id in(select id from extraction_runs where document_id=$1) order by id',usage:'select * from usage_ledger where document_id=$1 order by id',
 }))result[name]=(await adminPool.query(query,[f.documentId])).rows;
 result.bytes=objects.get(`${f.account.workspace.id}/${f.documentId}`);return result;
}
async function pagesCharged(f:Fixture){return (await adminPool.query('select coalesce(sum(pages),0)::int pages from usage_ledger where workspace_id=$1',[f.account.workspace.id])).rows[0].pages;}
async function split(f:Fixture,options:PdfSplitSpec,requestId=randomUUID(),sourceId=f.documentId,sourceSha256=f.sha256){const response=await request(f.account,'POST',`/api/documents/${sourceId}/pdf-splits`,{requestId,sourceSha256,options});assert.equal(response.statusCode,202,response.body);return response.json();}
async function assertSourceAndExports(f:Fixture,snapshot:unknown,saved:Array<{url:string;bytes:Buffer}>){assert.deepEqual(await originalSnapshot(f),snapshot);for(const item of saved){const response=await request(f.account,'GET',item.url);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.rawPayload,item.bytes);}assert.equal(fetches,0);}

before(async()=>{
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;
  if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}
  else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
  const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,url?5432:55432);if(!url)assert.equal(row.address,null);
 }
 verified=true;setStorageForTests(storage);globalThis.fetch=async()=>{fetches++;throw new Error('No external requests in stored-PDF workflow acceptance');};app=await buildApp();
});
after(async()=>{setStorageForTests(undefined);globalThis.fetch=originalFetch;try{await app?.close();if(verified){for(const a of accounts){await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);await adminPool.query('delete from users where id=$1',[a.user.id]);}}assert.equal(fetches,0);}finally{objects.clear();await closeDatabase();}});

test('stored six-page PDF splits into reviewed and exported children while preserving the approved source and saved exports',async()=>{
 const f=await fixture('whole-workflow');await approve(f);const saved=[];for(const format of ['csv','xlsx','json'] as const)saved.push(await exported(f,[f.documentId],format));const before=await originalSnapshot(f),requestId=randomUUID();assert.equal(await pagesCharged(f),6);
 const receipt=await split(f,{mode:'every',pagesPerDocument:2},requestId);assert.equal(receipt.split.childCount,3);assert.equal(receipt.split.selectedPages,6);assert.deepEqual(receipt.documents.map((d:any)=>[d.originalPageStart,d.originalPageEnd]),[[1,2],[3,4],[5,6]]);assert.equal(await pagesCharged(f),12);
 for(const [index,child] of receipt.documents.entries()){
  const original=await request(f.account,'GET',`/api/documents/${child.id}/original`);assert.equal(original.statusCode,200);const decoded=await inspectSource(original.rawPayload,'child.pdf');assert.equal(decoded.pageCount,2);assert.match(decoded.pages[0].text,new RegExp(`Original page ${index*2+1}`));assert.match(decoded.pages[1].text,new RegExp(`Original page ${index*2+2}`));
  assert.equal(await processOneCoreJob(child.jobId),true);await approve(f,child.id,{...finalValues,reference:`CHILD-${index+1}`});
 }
 for(const format of ['csv','xlsx','json'] as const){const result=await exported(f,receipt.documents.map((d:any)=>d.id),format);
  if(format==='csv'){const text=result.bytes.toString();for(const ref of ['CHILD-1','CHILD-2','CHILD-3'])assert.match(text,new RegExp(ref));assert.match(text,/42.5/);}
  if(format==='json'){const parsed=JSON.parse(result.bytes.toString());assert.equal(parsed.version,1);const rows=parsed.documents;assert.equal(rows.length,3);assert.deepEqual(rows.map((row:any)=>row.values.reference).sort(),['CHILD-1','CHILD-2','CHILD-3']);assert.ok(rows.every((row:any)=>row.values.amount===42.5&&row.values.count===0&&row.values.enabled===false));}
  if(format==='xlsx'){const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(result.bytes as any);const sheet=workbook.worksheets[0];assert.equal(sheet.rowCount,4);assert.deepEqual([2,3,4].map(row=>sheet.getCell(`A${row}`).value).sort(),['CHILD-1','CHILD-2','CHILD-3']);for(const row of [2,3,4]){assert.equal(sheet.getCell(`B${row}`).value,42.5);assert.equal(sheet.getCell(`C${row}`).value,0);assert.equal(sheet.getCell(`D${row}`).value,false);}}
 }
 const replay=await split(f,{mode:'every',pagesPerDocument:2},requestId);assert.equal(replay.replayed,true);assert.equal(replay.split.id,receipt.split.id);assert.equal(await pagesCharged(f),12);await assertSourceAndExports(f,before,saved);
 const recovered=await request(f.account,'GET',`/api/parsers/${f.parserId}/pdf-splits/requests/${requestId}`);assert.equal(recovered.statusCode,200);assert.equal(recovered.json().split.id,receipt.split.id);
});

test('undo removes only one stored-source batch and its mixed exports, retaining sibling batches, source history and all charged pages',async()=>{
 const f=await fixture('undo-isolation');await approve(f);const saved=[await exported(f,[f.documentId],'csv'),await exported(f,[f.documentId],'xlsx'),await exported(f,[f.documentId],'json')],beforeSplits=await originalSnapshot(f);
 const firstId=randomUUID(),first=await split(f,{mode:'every',pagesPerDocument:2},firstId),second=await split(f,{mode:'ranges',ranges:[{start:2,end:3},{start:6,end:6}]});assert.equal(await pagesCharged(f),15);
 await assertSourceAndExports(f,beforeSplits,saved);
 const child=first.documents[0];await processOneCoreJob(child.jobId);await approve(f,child.id,{...finalValues,reference:'REMOVED-CHILD'});const mixed=await exported(f,[f.documentId,child.id],'json');
 // Explicitly exporting the original again updates its export timestamp; undo must preserve this new baseline.
 const before=await originalSnapshot(f);
 const undone=await request(f.account,'POST',`/api/pdf-splits/${first.split.id}/undo`,{});assert.equal(undone.statusCode,200,undone.body);
 for(const d of first.documents){assert.equal((await request(f.account,'GET',`/api/documents/${d.id}`)).statusCode,404);assert.equal(await processOneCoreJob(d.jobId),false);}
 assert.equal((await request(f.account,'GET',mixed.url)).statusCode,404);for(const d of second.documents)assert.equal((await request(f.account,'GET',`/api/documents/${d.id}`)).statusCode,200);
 assert.equal((await request(f.account,'POST',`/api/pdf-splits/${first.split.id}/undo`,{})).statusCode,200);const replay=await split(f,{mode:'every',pagesPerDocument:2},firstId);assert.equal(replay.replayed,true);assert.ok(replay.documents.every((d:any)=>!d.available));assert.equal(await pagesCharged(f),15);await assertSourceAndExports(f,before,saved);
});

test('native marker and nested stored-child splitting preserve actual page content after the ancestor batch is undone',async()=>{
 const f=await fixture('nested-marker');await approve(f);const saved=[await exported(f,[f.documentId],'json')],before=await originalSnapshot(f);
 const parent=await split(f,{mode:'marker',marker:'SECTION START',ranges:[{start:1,end:2},{start:3,end:4},{start:5,end:6}]}),source=parent.documents[1],sourceBytes=objects.get(`${f.account.workspace.id}/${source.id}`)!;
 const childBatch=await split(f,{mode:'every',pagesPerDocument:1},randomUUID(),source.id,hash(sourceBytes));assert.equal(childBatch.documents.length,2);assert.equal(await pagesCharged(f),14);
 for(const [index,child] of childBatch.documents.entries()){
  assert.deepEqual([child.originalPageStart,child.originalPageEnd],[index+1,index+1]);
  assert.deepEqual(child.root,{kind:'document',id:f.documentId,sha256:f.sha256,pageCount:6,pageStart:index+3,pageEnd:index+3});
  const detail=await request(f.account,'GET',`/api/documents/${child.id}`);assert.equal(detail.statusCode,200);assert.deepEqual(detail.json().split.root,child.root);
  const response=await request(f.account,'GET',`/api/documents/${child.id}/original`);assert.equal(response.statusCode,200);const decoded=await inspectSource(response.rawPayload,'nested.pdf');assert.equal(decoded.pageCount,1);assert.match(decoded.pages[0].text,new RegExp(`Original page ${index+3}`));
 }
 assert.equal((await request(f.account,'POST',`/api/pdf-splits/${parent.split.id}/undo`,{})).statusCode,200);
 for(const child of childBatch.documents){assert.equal((await request(f.account,'GET',`/api/documents/${child.id}`)).statusCode,200);const retained=await request(f.account,'GET',`/api/documents/${child.id}/bundle-original`);assert.equal(retained.statusCode,200);assert.deepEqual(retained.rawPayload,sourceBytes);}
 assert.equal(await pagesCharged(f),14);await assertSourceAndExports(f,before,saved);
});
