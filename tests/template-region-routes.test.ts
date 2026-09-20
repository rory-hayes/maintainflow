import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import {canonicalTemplateDefinition,type TemplateDefinition} from '../shared/template-definitions.js';
import {findPdfRegionAnchor,type PdfGeometry,type PdfRegionRule} from '../shared/pdf-regions.js';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,closeDatabase,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {hashToken} from '../server/core/auth.js';
import {addDocument} from '../server/core/intake.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {readPdfGeometry} from '../server/core/source.js';
import {readTemplateRegionSource,previewTemplateDraft,checkSavedTemplates} from '../server/core/template-region-routes.js';
import type {TemplateAuthorization} from '../server/core/template-mutations.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
type Fixture={account:Account;parserId:string;schemaId:string;documentId:string;sourceKey:string;bytes:Buffer;sha256:string;geometry:PdfGeometry};
const accounts:Account[]=[],objects=new Map<string,Buffer>();let app:FastifyInstance,verified=false,calls=0,pdf:Buffer;
const originalFetch=globalThis.fetch;
const hash=(b:Buffer|string)=>createHash('sha256').update(b).digest('hex');
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);if(!bytes)throw Object.assign(new Error('Owned original missing'),{statusCode:404});return Buffer.from(bytes);},async remove(key){objects.delete(key);}};
const actor=(a:Account):Actor=>({userId:a.user.id,workspaceId:a.workspace.id,role:'owner',authType:'session'});
const auth=(f:Fixture):TemplateAuthorization=>({actor:actor(f.account),tokenHash:hashToken(decodeURIComponent(f.account.cookie.match(/folio_session=([^;]+)/)![1]))});
const binding=(f:Fixture)=>({documentId:f.documentId,sourceSha256:f.sha256,baseSchemaId:f.schemaId});
const request=(a:Account,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method,url,payload:payload as any,headers:{origin:config.origin,cookie:a.cookie,...headers}});
const endpoint=(f:Fixture,name:string)=>`/api/parsers/${f.parserId}/templates/${name}`;
function gate<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function reached(promise:Promise<unknown>){let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned region gate was not reached')),5000);})]);}finally{clearTimeout(timer);}}
async function account(){const r=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned native preview',workspaceName:'Owned native preview',email:`region-preview-${randomUUID()}@example.test`,password:'Owned native preview password'}});assert.equal(r.statusCode,201,r.body);const a={...r.json(),cookie:r.cookies.map(c=>`${c.name}=${c.value}`).join('; ')} as Account;accounts.push(a);return a;}
async function fixture(a?:Account):Promise<Fixture>{
 const owner=a??await account(),p=await request(owner,'POST','/api/parsers',{name:'Owned native PDF sample',useCase:'custom',mode:'rules',schema:{fields:[{key:'reference',label:'Reference',type:'string',required:true},{key:'total',label:'Total',type:'currency',required:true}]}});assert.equal(p.statusCode,201,p.body);
 const parserId=p.json().parser.id,source=await addDocument(actor(owner),parserId,pdf,'owned-regions.pdf');
 const row=(await adminPool.query('select storage_key from documents where id=$1',[source.document.id])).rows[0];
 return {account:owner,parserId,schemaId:p.json().schema.id,documentId:source.document.id,sourceKey:row.storage_key,bytes:pdf,sha256:hash(pdf),geometry:await readPdfGeometry(pdf)};
}
function rule(f:Fixture,field:string,label:string,value:string):PdfRegionRule{
 const page=f.geometry.pages[0],anchor=findPdfRegionAnchor(page,label);assert.equal(anchor.matched,true);if(!anchor.matched)throw new Error('Expected owned anchor');
 const item=page.items.find(item=>item.text===value)!;assert.ok(item);const padding=0.002;
 return {field,anchor:label,page:1,reference:{width:page.width,height:page.height,rotation:page.rotation},offset:{x:item.rect.x-padding-anchor.anchor.rect.x,y:item.rect.y-padding-anchor.anchor.rect.y,width:item.rect.width+padding*2,height:item.rect.height+padding*2}};
}
const definition=(f:Fixture):TemplateDefinition=>({kind:'native-pdf-region-v1',name:'Owned exact region',matchText:'',enabled:true,rules:[rule(f,'reference','Reference','NATIVE-42'),rule(f,'total','Total','24.50')]});
const draft=(f:Fixture,def=definition(f))=>({...binding(f),definition:def});
async function footprint(f:Fixture){const r=(await adminPool.query(`select (select count(*)::int from documents where workspace_id=$1) documents,(select count(*)::int from jobs where workspace_id=$1) jobs,(select count(*)::int from usage_ledger where workspace_id=$1) usage,(select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages,(select count(*)::int from extraction_runs where workspace_id=$1) runs,(select count(*)::int from templates where workspace_id=$1) templates`,[f.account.workspace.id])).rows[0];return {...r,keys:[...objects.keys()].filter(key=>key.startsWith(f.account.workspace.id+'/')).sort()};}
before(async()=>{
 assert.equal(databaseSchema,'public');for(const [pool,role]of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){const url=pool.options.connectionString?new URL(pool.options.connectionString):undefined;if(url){assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.port||'5432','5432');assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);}else{assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}}
 verified=true;globalThis.fetch=async()=>{calls++;throw new Error('Unexpected outbound request in owned region preview tests');};setStorageForTests(storage);app=await buildApp();
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),page=doc.addPage([400,600]);
 page.drawText('Reference',{x:40,y:480,size:12,font});page.drawText('NATIVE-42',{x:220,y:480,size:12,font});page.drawText('Total',{x:40,y:430,size:12,font});page.drawText('24.50',{x:220,y:430,size:12,font});doc.addPage([400,600]).drawText('Second page',{x:40,y:480,size:12,font});pdf=Buffer.from(await doc.save());
});
after(async()=>{try{await app?.close();if(verified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);}assert.equal(calls,0);objects.clear();}finally{setStorageForTests(undefined);globalThis.fetch=originalFetch;await closeDatabase();}});

test('actual PDF geometry and exact unsaved values are private, source-bound and unmetered',async()=>{
 const f=await fixture(),before=await footprint(f),g=await request(f.account,'POST',endpoint(f,'geometry'),binding(f));assert.equal(g.statusCode,200,g.body);assert.equal(g.headers['cache-control'],'private, no-store');assert.equal(g.headers['x-content-type-options'],'nosniff');
 assert.deepEqual(g.json().source,{documentId:f.documentId,sha256:f.sha256,mimeType:'application/pdf',pageCount:2,size:pdf.length,name:'owned-regions.pdf'});assert.deepEqual(g.json().geometry,f.geometry);assert.equal(g.body.includes(f.sourceKey),false);
 const def=definition(f),preview=await request(f.account,'POST',endpoint(f,'preview'),draft(f,def));assert.equal(preview.statusCode,200,preview.body);
 const value=preview.json();assert.equal(value.definitionDigest,hash(canonicalTemplateDefinition(def)));assert.equal(value.evaluatedWhileDisabled,false);assert.equal(value.selection.outcome,'template');assert.deepEqual(value.result.rawValues,{reference:'NATIVE-42',total:'24.50'});assert.deepEqual(value.result.normalizedValues,{reference:'NATIVE-42',total:24.5});assert.equal(value.result.evidence.reference[0].source,'matched-region');assert.equal(value.result.evidence.reference[0].region.sourceSha256,f.sha256);
 assert.deepEqual(await footprint(f),before);assert.equal(calls,0);
});

test('disabled drafts are explicitly evaluated and partial nonmatches retain captured values while saved checks exclude them',async()=>{
 const f=await fixture(),def=definition(f);def.enabled=false;
 const preview=await request(f.account,'POST',endpoint(f,'preview'),draft(f,def));assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().evaluatedWhileDisabled,true);assert.equal(preview.json().result.rawValues.reference,'NATIVE-42');
 const partial=structuredClone(def);partial.rules[1].anchor='Absent exact anchor';
 const failed=await request(f.account,'POST',endpoint(f,'preview'),draft(f,partial));assert.equal(failed.statusCode,200,failed.body);assert.equal(failed.json().selection.outcome,'failed');assert.equal(failed.json().result.rawValues.reference,'NATIVE-42');assert.equal(failed.json().result.rawValues.total,null);assert.ok(failed.json().candidates[0].reasons.includes('region_missing_anchor'));
 const save=await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,{...def,requestId:randomUUID(),baseSchemaId:f.schemaId});assert.equal(save.statusCode,200,save.body);const before=await footprint(f);
 const check=await request(f.account,'POST',endpoint(f,'check'),{documentId:f.documentId});assert.equal(check.statusCode,200,check.body);assert.equal(check.json().selection.reason,'no_templates');for(const key of ['NATIVE-42','rawValues','normalizedValues','evidence','geometry'])assert.equal(check.body.includes(key),false);assert.deepEqual(await footprint(f),before);
});

test('preview routes enforce same parser, tenant, editor and explicit read/write scopes without requiring document-write',async()=>{
 const f=await fixture(),foreign=await fixture(),other=await account();
 const second=await request(f.account,'POST','/api/parsers',{name:'Owned other parser'});if(second.statusCode===429)await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','2') where id=$1",[f.account.workspace.id]);
 const p=second.statusCode===429?await request(f.account,'POST','/api/parsers',{name:'Owned other parser'}):second;assert.equal(p.statusCode,201,p.body);
 assert.equal((await request(f.account,'POST',`/api/parsers/${p.json().parser.id}/templates/geometry`,binding(f))).statusCode,404);assert.equal((await request(foreign.account,'POST',endpoint(f,'geometry'),binding(f))).statusCode,404);
 await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[f.account.workspace.id,other.user.id]);const viewer={'x-workspace-id':f.account.workspace.id};assert.equal((await request(other,'POST',endpoint(f,'geometry'),binding(f),viewer)).statusCode,403);assert.equal((await request(other,'POST',endpoint(f,'check'),{documentId:f.documentId},viewer)).statusCode,200);
 for(const scopes of [['parsers:write','documents:read'],['parsers:read','parsers:write'],['parsers:read','parsers:write','documents:read']]){
  const k=await request(f.account,'POST','/api/workspace/api-keys',{name:'Owned region scope',scopes});assert.equal(k.statusCode,200,k.body);const response=await request(f.account,'POST',endpoint(f,'geometry'),binding(f),{cookie:'',authorization:`Bearer ${k.json().token}`});assert.equal(response.statusCode,scopes.length===3?200:403,response.body);
 }
 assert.equal((await request(f.account,'POST',endpoint(f,'geometry'),binding(f),{origin:'https://unrelated.example'})).statusCode,403);
});

test('source SHA, size, actual MIME, missing originals and schema identity are checked before native work',async()=>{
 const f=await fixture(),before=await footprint(f);let decodes=0;
 const options={readGeometry:async()=>{decodes++;return f.geometry;}};
 await assert.rejects(readTemplateRegionSource(auth(f),f.parserId,{...binding(f),sourceSha256:'0'.repeat(64)},options),(e:any)=>e.statusCode===409);
 await assert.rejects(readTemplateRegionSource(auth(f),f.parserId,{...binding(f),baseSchemaId:randomUUID()},options),(e:any)=>e.statusCode===409);
 await assert.rejects(readTemplateRegionSource(auth(f),f.parserId,binding(f),{...options,readSource:async()=>Buffer.from('changed')}),(e:any)=>e.statusCode===409);
 const bytes=Buffer.from('This is plain text, despite the supplied MIME.');objects.set(f.sourceKey,bytes);await adminPool.query('update documents set byte_size=$2,sha256=$3 where id=$1',[f.documentId,bytes.length,hash(bytes)]);
 await assert.rejects(readTemplateRegionSource(auth(f),f.parserId,{...binding(f),sourceSha256:hash(bytes)},options),(e:any)=>e.statusCode===415);
 objects.delete(f.sourceKey);await assert.rejects(readTemplateRegionSource(auth(f),f.parserId,{...binding(f),sourceSha256:hash(bytes)},options),(e:any)=>e.statusCode===404);assert.equal(decodes,0);
 assert.equal((await footprint(f)).usage,before.usage);
});

test('held source reads cannot publish after original deletion, policy changes or schema changes',async()=>{
 for(const event of ['delete','policy','schema']){
  const f=await fixture(),entered=gate<void>(),release=gate<Buffer>();
  const pending=readTemplateRegionSource(auth(f),f.parserId,binding(f),{readSource:async()=>{entered.resolve();return release.promise;},readGeometry:async()=>f.geometry});await reached(entered.promise);
  if(event==='delete')assert.equal((await request(f.account,'DELETE',`/api/documents/${f.documentId}`)).statusCode,200);
  if(event==='policy')await adminPool.query("update parsers set allowed_formats=ARRAY['txt']::text[] where id=$1",[f.parserId]);
  if(event==='schema')assert.equal((await request(f.account,'POST',`/api/parsers/${f.parserId}/schema`,{fields:[{key:'changed',label:'Changed',type:'string'}]})).statusCode,200);
  release.resolve(pdf);await assert.rejects(pending,(e:any)=>e.statusCode===(event==='delete'?404:event==='policy'?415:409));
 }
});

test('current membership and credentials are rechecked after slow decode; forged geometry never returns a draft',async()=>{
 for(const event of ['role','credential']){
  const f=await fixture(),entered=gate<void>(),release=gate<PdfGeometry>(),before=await footprint(f);
  const pending=previewTemplateDraft(auth(f),f.parserId,draft(f),{readGeometry:async()=>{entered.resolve();return release.promise;}});await reached(entered.promise);
  if(event==='role')await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2",[f.account.workspace.id,f.account.user.id]);
  else await adminPool.query('delete from sessions where user_id=$1',[f.account.user.id]);
  release.resolve(f.geometry);await assert.rejects(pending,(e:any)=>e.statusCode===(event==='role'?403:401));assert.deepEqual(await footprint(f),before);
 }
 const f=await fixture();await assert.rejects(readTemplateRegionSource(auth(f),f.parserId,binding(f),{readGeometry:async()=>({...f.geometry,sourceSha256:'0'.repeat(64)})}),(e:any)=>e.statusCode===503);
});

test('bounded noncooperative source/decode and abort discard late results without writes',async()=>{
 const f=await fixture(),before=await footprint(f),late=gate<Buffer>();
 await assert.rejects(readTemplateRegionSource(auth(f),f.parserId,binding(f),{timeoutMs:50,readSource:()=>late.promise}),(e:any)=>e.statusCode===503);late.resolve(pdf);
 const entered=gate<void>(),release=gate<PdfGeometry>(),controller=new AbortController();let signal:AbortSignal|undefined;
 const pending=previewTemplateDraft(auth(f),f.parserId,draft(f),{signal:controller.signal,readGeometry:async(_bytes,options)=>{signal=options?.signal;entered.resolve();return release.promise;}});await reached(entered.promise);controller.abort();await assert.rejects(pending,(e:any)=>e.statusCode===503);assert.equal(signal?.aborted,true);release.resolve(f.geometry);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.deepEqual(await footprint(f),before);
});

test('saved native checks read verified originals and suppress operational geometry faults rather than reporting AI fallback',async()=>{
 const f=await fixture(),def=definition(f),saved=await request(f.account,'POST',`/api/parsers/${f.parserId}/templates`,{...def,requestId:randomUUID(),baseSchemaId:f.schemaId});assert.equal(saved.statusCode,200,saved.body);
 const before=await footprint(f),check=await request(f.account,'POST',endpoint(f,'check'),{documentId:f.documentId});assert.equal(check.statusCode,200,check.body);assert.equal(check.json().selection.outcome,'template');assert.equal(check.json().selection.template.kind,'native-pdf-region-v1');assert.equal(check.body.includes('NATIVE-42'),false);
 await adminPool.query("update parsers set mode='ai' where id=$1",[f.parserId]);await assert.rejects(checkSavedTemplates(auth(f),f.parserId,f.documentId,{readGeometry:async()=>{throw new Error('PRIVATE provider diagnostic must not escape');}}),(e:any)=>e.statusCode===503&&!e.message.includes('PRIVATE'));
 assert.deepEqual(await footprint(f),before);assert.equal(calls,0);
});
