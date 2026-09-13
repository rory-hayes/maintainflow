import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import type {FastifyInstance} from 'fastify';
import type {Actor} from '../shared/types.js';
import {buildApp} from '../server/app.js';
import {adminPool,withWorkspace,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {ParserFormatNotAllowedError} from '../server/core/intake-policy.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {reconcileExpiredDirectUploads} from '../server/core/upload-routes.js';
import {deleteStoredFile} from '../server/core/retention.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
const suffix=randomUUID(),accounts:Account[]=[],objects=new Map<string,Buffer>();
let app:FastifyInstance,owner:Account,other:Account,viewer:Account,pdf:Buffer;
let writeGate:(()=>Promise<void>)|undefined;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));if(writeGate){const gate=writeGate;writeGate=undefined;await gate();}},async read(key){const bytes=objects.get(key);if(!bytes)throw new Error('Missing owned fixture');return Buffer.from(bytes);},async remove(key){objects.delete(key);},async signUpload(key){return `https://owned-fixture.supabase.co/upload/${key}`;}};
const actor=():Actor=>({userId:owner.user.id,workspaceId:owner.workspace.id,role:'owner',authType:'session'});
async function request(method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown,account=owner){return app.inject({method,url,payload:payload as any,headers:{cookie:account.cookie,origin:config.origin}});}
async function signup(label:string){const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned policy '+label,workspaceName:'Owned format '+label,email:`formats-${label}-${suffix}@example.test`,password:'Owned format policy password'}});assert.equal(response.statusCode,201,response.body);const body=response.json();const account={...body,cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};accounts.push(account);return account as Account;}
async function parser(allowedFormats?:string[]|null){const response=await request('POST','/api/parsers',{name:'Owned format policy',useCase:'custom',...(allowedFormats===undefined?{}:{allowedFormats})});assert.equal(response.statusCode,201,response.body);return response.json().parser;}
async function upload(parserId:string,files:{name:string;bytes:Buffer;mime?:string}[]){const boundary='owned-'+randomUUID();const payload=Buffer.concat(files.flatMap(file=>[Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mime||'application/octet-stream'}\r\n\r\n`),file.bytes,Buffer.from('\r\n')]).concat(Buffer.from(`--${boundary}--\r\n`)));return app.inject({method:'POST',url:`/api/parsers/${parserId}/documents`,payload,headers:{cookie:owner.cookie,origin:config.origin,'content-type':`multipart/form-data; boundary=${boundary}`}});}
async function footprint(){const result:Record<string,number|string[]>={};for(const table of ['documents','jobs','usage_ledger','intake_files','file_deletions'])result[table]=(await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`,[owner.workspace.id])).rows[0].n;result.originals=[...objects.keys()].sort();return result;}
const denied=(error:unknown)=>error instanceof ParserFormatNotAllowedError&&error.statusCode===415&&error.code==='parser_format_not_allowed';
before(async()=>{const options=adminPool.options;assert.ok(!options.connectionString&&options.host?.startsWith('/'),'Fixtures require the local socket database');setStorageForTests(storage);app=await buildApp();owner=await signup('owner');other=await signup('other');viewer=await signup('viewer');await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{maxParsers}','20'),'{monthlyPages}','1000') where id=$1",[owner.workspace.id]);await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[owner.workspace.id,viewer.user.id]);await adminPool.query('update sessions set workspace_id=$2 where user_id=$1',[viewer.user.id,owner.workspace.id]);pdf=await fs.readFile('fixtures/generated/invoice-multipage.pdf');});
after(async()=>{setStorageForTests(undefined);await app?.close();for(const account of accounts)await adminPool.query('delete from workspaces where id=$1',[account.workspace.id]);for(const account of accounts)await adminPool.query('delete from users where id=$1',[account.user.id]);await closeDatabase();});

test('policy create, partial update, reset and read preserve defaults and enforce role/tenant/format validation',async()=>{
 const legacy=await parser();assert.equal(legacy.allowedFormats,null);const restricted=await parser(['pdf','png']);assert.deepEqual(restricted.allowedFormats,['pdf','png']);
 assert.equal((await request('PATCH',`/api/parsers/${restricted.id}`,{name:'Renamed only'})).statusCode,200);
 assert.deepEqual((await request('GET',`/api/parsers/${restricted.id}`)).json().parser.allowedFormats,['pdf','png']);
 assert.deepEqual((await request('GET','/api/parsers')).json().parsers.find((p:any)=>p.id===restricted.id).allowedFormats,['pdf','png']);
 for(const allowedFormats of [[],['pdf','pdf'],['exe'],'pdf',[null]])assert.equal((await request('PATCH',`/api/parsers/${restricted.id}`,{allowedFormats})).statusCode,400);
 assert.equal((await request('PATCH',`/api/parsers/${restricted.id}`,{allowedFormats:null},viewer)).statusCode,403);
 assert.equal((await request('PATCH',`/api/parsers/${restricted.id}`,{allowedFormats:null},other)).statusCode,404);
 const reset=await request('PATCH',`/api/parsers/${restricted.id}`,{allowedFormats:null});assert.equal(reset.statusCode,200);assert.equal(reset.json().parser.allowedFormats,null);
 assert.equal((await addDocument(actor(),legacy.id,Buffer.from('Owned legacy-compatible text'),'owned.txt')).document.mimeType,'text/plain');
});

test('disallowed multipart and sample intake audit a bounded reason without accepted documents, jobs, usage or originals',async()=>{
 const p=await parser(['pdf']),before=await footprint();
 const response=await upload(p.id,[{name:'PRIVATE-FILENAME.txt',bytes:Buffer.from('PRIVATE OWNED CONTENT'),mime:'application/pdf'}]);assert.equal(response.statusCode,415,response.body);assert.match(response.json().message,/does not accept Text files/);assert.deepEqual(await footprint(),before);
 const sample=await request('POST',`/api/parsers/${p.id}/sample`,{});assert.equal(sample.statusCode,415,sample.body);assert.deepEqual(await footprint(),before);
 const audits=(await adminPool.query("select * from audit_events where workspace_id=$1 and action='document.rejected' and metadata->>'parserId'=$2",[owner.workspace.id,p.id])).rows;assert.equal(audits.length,2);
 for(const event of audits){assert.equal(event.entity_id,null);assert.equal(event.metadata.format,'txt');assert.deepEqual(Object.keys(event.metadata).sort(),['format','parserId','reason']);assert.ok(!JSON.stringify(event).includes('PRIVATE'));}
 assert.equal((await withWorkspace(other.workspace.id,c=>c.query("select id from audit_events where action='document.rejected' and metadata->>'parserId'=$1",[p.id]))).rowCount,0);
});

test('mixed upload uses inspected PDF bytes despite a text filename and rejects text despite a PDF MIME claim',async()=>{
 const p=await parser(['pdf']);const response=await upload(p.id,[{name:'actual-pdf.txt',bytes:pdf,mime:'text/plain'},{name:'blocked.txt',bytes:Buffer.from('Owned blocked batch text'),mime:'application/pdf'}]);assert.equal(response.statusCode,202,response.body);const results=response.json().results;assert.equal(results.length,2);assert.equal(results[0].document.mimeType,'application/pdf');assert.match(results[1].error,/does not accept Text/);
 assert.equal((await adminPool.query('select count(*)::int n from documents where parser_id=$1',[p.id])).rows[0].n,1);
 assert.equal((await adminPool.query('select count(*)::int n from usage_ledger where document_id=$1',[results[0].document.id])).rows[0].n,1);
 const textOnly=await parser(['txt']),before=await footprint();await assert.rejects(addDocument(actor(),textOnly.id,pdf,'disguised.txt','text/plain'),error=>denied(error)&&(error as ParserFormatNotAllowedError).format==='pdf');assert.deepEqual(await footprint(),before);
});

test('committed duplicate/idempotency replays survive policy changes and deleted accepted receipts remain gone',async()=>{
 const p=await parser(),bytes=Buffer.from('Owned accepted replay '+suffix),key='accepted-'+suffix;const accepted=await addDocument(actor(),p.id,bytes,'owned.txt',undefined,key);await request('PATCH',`/api/parsers/${p.id}`,{allowedFormats:['pdf']});const before=await footprint();
 for(const retryKey of [key,undefined,'another-'+key]){const retry=await addDocument(actor(),p.id,bytes,'owned.txt',undefined,retryKey);assert.equal(retry.duplicate,true);assert.equal(retry.document.id,accepted.document.id);}assert.deepEqual(await footprint(),before);
 const removed=await request('DELETE',`/api/documents/${accepted.document.id}`);assert.equal(removed.statusCode,200,removed.body);await assert.rejects(addDocument(actor(),p.id,bytes,'owned.txt',undefined,key),(error:any)=>error.statusCode===410);
});

test('rejected receipts commit with one audit, survive policy expansion, and bind their key to exact parser/bytes',async()=>{
 const p=await parser(['pdf']),bytes=Buffer.from('Owned durable rejection '+suffix),key='rejected-'+suffix,before=await footprint();await assert.rejects(addDocument(actor(),p.id,bytes,'owned.txt',undefined,key),denied);assert.deepEqual(await footprint(),before);
 const receipt=(await adminPool.query('select * from intake_events where workspace_id=$1 and idempotency_key=$2',[owner.workspace.id,key])).rows[0];assert.equal(receipt.document_id,null);assert.equal(receipt.rejection_code,'parser_format_not_allowed');assert.equal(receipt.rejection_format,'txt');assert.equal(receipt.rejected_parser_id,p.id);assert.equal(receipt.rejection_sha256,createHash('sha256').update(bytes).digest('hex'));
 await request('PATCH',`/api/parsers/${p.id}`,{allowedFormats:null});await assert.rejects(addDocument(actor(),p.id,bytes,'owned.txt',undefined,key),denied);assert.equal((await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='document.rejected' and metadata->>'parserId'=$2",[owner.workspace.id,p.id])).rows[0].n,1);
 await assert.rejects(addDocument(actor(),p.id,Buffer.from('Different owned bytes'),'owned.txt',undefined,key),(error:any)=>error.statusCode===409);const otherParser=await parser();await assert.rejects(addDocument(actor(),otherParser.id,bytes,'owned.txt',undefined,key),(error:any)=>error.statusCode===409);
 assert.equal((await withWorkspace(other.workspace.id,c=>c.query('select id from intake_events where id=$1',[receipt.id]))).rowCount,0);assert.equal((await addDocument(actor(),p.id,bytes,'owned.txt',undefined,'fresh-'+key)).duplicate,false);
});

test('policy changes during original staging take effect before the intake transaction accepts a file',async()=>{
 const p=await parser(),before=await footprint();let release!:()=>void,started!:()=>void;const staged=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});writeGate=async()=>{started();await gate;};
 const pending=addDocument(actor(),p.id,Buffer.from('Owned policy race'),'race.txt');const outcome=pending.then(()=>{throw new Error('Expected a policy rejection');},error=>{assert.ok(denied(error));});try{await staged;const patch=await request('PATCH',`/api/parsers/${p.id}`,{allowedFormats:['pdf']});assert.equal(patch.statusCode,200,patch.body);}finally{release();}await outcome;assert.deepEqual(await footprint(),before);
});

test('direct finalization enforces latest policy and terminates rejected reservations without accepted usage',async()=>{
 const p=await parser(),bytes=Buffer.from('Owned direct format policy'),before=await footprint();const reserved=await request('POST',`/api/parsers/${p.id}/uploads`,{filename:'owned.txt',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});assert.equal(reserved.statusCode,201,reserved.body);const id=reserved.json().uploadId,row=(await adminPool.query('select * from direct_uploads where id=$1',[id])).rows[0];objects.set(row.storage_key,bytes);
 await request('PATCH',`/api/parsers/${p.id}`,{allowedFormats:['pdf']});const finalized=await request('POST',`/api/uploads/${id}/finalize`,{});assert.equal(finalized.statusCode,415,finalized.body);assert.equal((await adminPool.query('select state from direct_uploads where id=$1',[id])).rows[0].state,'failed');const rejected=await footprint();assert.deepEqual({...rejected,originals:before.originals},before);assert.deepEqual(rejected.originals,[...(before.originals as string[]),row.storage_key].sort());assert.equal((await request('POST',`/api/uploads/${id}/finalize`,{})).statusCode,410);
 // A rejected signed staging capability must still expire before deletion.
 assert.ok(new Date(row.cleanup_after).getTime()>Date.now()+2*60*60*1000);assert.equal(await reconcileExpiredDirectUploads(owner.workspace.id),0);await adminPool.query("update direct_uploads set cleanup_after=now()-interval '1 second',expires_at=now()-interval '3 hours' where id=$1",[id]);assert.equal(await reconcileExpiredDirectUploads(owner.workspace.id),1);await deleteStoredFile(owner.workspace.id,row.storage_key);assert.deepEqual(await footprint(),before);
});
