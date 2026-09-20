import test from 'node:test';
import assert from 'node:assert/strict';
import {readStoredPdfSplit,saveStoredPdfSplit,clearStoredPdfSplit,findStoredPdfSplit,submitStoredPdfSplit,type StoredPendingPdfSplit} from '../src/lib/stored-pdf-split.js';
import {readPendingPdfSplit,savePendingPdfSplit,confirmPdfSplitReceipt,prepareTiffSplitPreview,readTiffSplitPreview,pdfSha256,uploadPdfSplit} from '../src/lib/pdf-split.js';

class MemoryStorage implements Storage{
 values=new Map<string,string>();get length(){return this.values.size;}key(index:number){return [...this.values.keys()][index]??null;}
 getItem(key:string){return this.values.get(key)??null;}setItem(key:string,value:string){this.values.set(key,value);}removeItem(key:string){this.values.delete(key);}clear(){this.values.clear();}
}
const base:StoredPendingPdfSplit={version:1,userId:'11111111-1111-4111-8111-111111111111',workspaceId:'22222222-2222-4222-8222-222222222222',parserId:'33333333-3333-4333-8333-333333333333',sourceDocumentId:'44444444-4444-4444-8444-444444444444',requestId:'55555555-5555-4555-8555-555555555555',sha256:'a'.repeat(64),savedAt:Date.now(),options:{mode:'ranges',ranges:[{start:1,end:2}]}};
function environment(){const local=new MemoryStorage(),session=new MemoryStorage(),previous={local:Object.getOwnPropertyDescriptor(globalThis,'localStorage'),session:Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch:globalThis.fetch};Object.defineProperty(globalThis,'localStorage',{configurable:true,value:local});Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:session});return{local,session,restore(){for(const [name,descriptor]of [['localStorage',previous.local],['sessionStorage',previous.session]]as const){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}globalThis.fetch=previous.fetch;}};}
function receiptId(value:Awaited<ReturnType<typeof submitStoredPdfSplit>>){assert.ok('split'in value);return value.split.id;}
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
const actor={user:{id:base.userId},workspace:{id:base.workspaceId,role:'owner'}};
const receipt={split:{id:'66666666-6666-4666-8666-666666666666',requestId:base.requestId,parserId:base.parserId,sourceName:'source.pdf',sourcePageCount:2,selectedPages:2,childCount:1,sourceAvailable:true,createdAt:new Date().toISOString(),origin:'stored',sourceDocumentId:base.sourceDocumentId,sourceDocumentAvailable:true,sourceSha256:base.sha256,undoneAt:null},documents:[{id:'77777777-7777-4777-8777-777777777777',jobId:'88888888-8888-4888-8888-888888888888',name:'child.pdf',pageCount:2,originalPageStart:1,originalPageEnd:2,index:1,available:true}],replayed:true};

test('stored recovery serializes only scoped binding and cannot overwrite or clear another unresolved request',()=>{const env=environment();try{
 saveStoredPdfSplit({...base,name:'never persist',bytes:'never persist',url:'never persist'}as StoredPendingPdfSplit);
 const stored=JSON.parse(env.local.getItem(env.local.key(0)!)!);assert.deepEqual(Object.keys(stored).sort(),['version','userId','workspaceId','parserId','sourceDocumentId','requestId','sha256','savedAt','options'].sort());assert.deepEqual(readStoredPdfSplit(base,base.sourceDocumentId),base);
 assert.equal(readStoredPdfSplit({...base,userId:'99999999-9999-4999-8999-999999999999'},base.sourceDocumentId),null);assert.equal(readStoredPdfSplit(base,'99999999-9999-4999-8999-999999999999'),null);
 const replacement={...base,requestId:'99999999-9999-4999-8999-999999999999'};assert.throws(()=>saveStoredPdfSplit(replacement),/Another saved split/);assert.throws(()=>clearStoredPdfSplit(base,base.sourceDocumentId,replacement.requestId),/newer saved split/);assert.deepEqual(readStoredPdfSplit(base,base.sourceDocumentId),base);
 clearStoredPdfSplit(base,base.sourceDocumentId,base.requestId);assert.equal(env.local.length,0);
 }finally{env.restore();}});

test('unavailable browser storage refuses before a recoverable binding can be claimed',()=>{const env=environment();try{env.local.setItem=()=>{throw new Error('blocked');};assert.throws(()=>saveStoredPdfSplit(base),/Recovery information could not be saved/);assert.equal(readStoredPdfSplit(base,base.sourceDocumentId),null);}finally{env.restore();}});

test('old unresolved identity retries the same request and a known receipt is recovered without another POST',async()=>{const env=environment();try{const value={...base,savedAt:Date.now()-31*24*60*60*1000};saveStoredPdfSplit(value);const writes:string[]=[];let found=false;globalThis.fetch=async(input,init)=>{const path=String(input);if(init?.method==='POST'){writes.push(path);assert.equal(JSON.parse(String(init.body)).requestId,base.requestId);return json(receipt);}return path==='/api/auth/me'?json(actor):found?json(receipt):json({message:'not found'},404);};assert.equal(receiptId(await submitStoredPdfSplit(value,()=>true)),receipt.split.id);assert.deepEqual(writes,[`/api/documents/${base.sourceDocumentId}/pdf-splits`]);assert.equal(readStoredPdfSplit(base,base.sourceDocumentId)?.requestId,base.requestId);found=true;assert.equal(receiptId(await submitStoredPdfSplit(value,()=>true)),receipt.split.id);assert.equal(writes.length,1);}finally{env.restore();}});

test('account, workspace and late scope changes prevent stored-source mutation',async()=>{const env=environment();try{let writes=0;globalThis.fetch=async(_input,init)=>{if(init?.method==='POST')writes++;return json({...actor,user:{id:'99999999-9999-4999-8999-999999999999'}});};await assert.rejects(submitStoredPdfSplit(base,()=>true),/account or permissions changed/);assert.equal(writes,0);
 env.session.setItem('folio.workspace','99999999-9999-4999-8999-999999999999');await assert.rejects(submitStoredPdfSplit(base,()=>true),/original workspace/);assert.equal(writes,0);env.session.clear();
 let current=true;globalThis.fetch=async()=>{current=false;return json(actor);};await assert.rejects(submitStoredPdfSplit(base,()=>current),/document view changed/);assert.equal(writes,0);
 }finally{env.restore();}});

test('a receipt with the wrong source digest or source ID cannot consume the saved request',async()=>{const env=environment();try{saveStoredPdfSplit(base);for(const mutation of[{sourceSha256:'b'.repeat(64)},{sourceDocumentId:'99999999-9999-4999-8999-999999999999'}]){globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json({...receipt,split:{...receipt.split,...mutation}});await assert.rejects(findStoredPdfSplit(base,()=>true),/does not match the saved source/);assert.deepEqual(readStoredPdfSplit(base,base.sourceDocumentId),base);}}finally{env.restore();}});


test('only a fully bound authoritative rejection resolves a stored request; ordinary errors remain unknown',async()=>{const env=environment();try{saveStoredPdfSplit(base);const rejected={id:receipt.split.id,requestId:base.requestId,parserId:base.parserId,sourceDocumentId:base.sourceDocumentId,sourceSha256:base.sha256,options:base.options,code:'rejected',reason:'format_not_allowed',message:'PDF is not allowed by this parser.'};globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json({rejected});const found=await findStoredPdfSplit(base,()=>true);assert.ok(found&&'rejected'in found);assert.equal(found.rejected.requestId,base.requestId);
 for(const mutation of[{sourceSha256:'b'.repeat(64)},{requestId:'99999999-9999-4999-8999-999999999999'},{options:{mode:'ranges',ranges:[{start:2,end:2}]}}]){globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json({rejected:{...rejected,...mutation}});await assert.rejects(findStoredPdfSplit(base,()=>true),/does not match/);}
 globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json({message:'PDF not allowed'},415);await assert.rejects(findStoredPdfSplit(base,()=>true),/PDF not allowed/);globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json({message:'not found'},404);assert.equal(await findStoredPdfSplit(base,()=>true),null);assert.deepEqual(readStoredPdfSplit(base,base.sourceDocumentId),base);
 }finally{env.restore();}});

test('TIFF pending binds accepted and terminal-rejected MIME while legacy PDF records remain valid',async()=>{const env=environment();try{
 const value={...base,sourceMimeType:'image/tiff' as const};saveStoredPdfSplit(value);assert.equal(readStoredPdfSplit(base,base.sourceDocumentId)?.sourceMimeType,'image/tiff');
 assert.throws(()=>saveStoredPdfSplit(base),/Another saved split/);
 savePendingPdfSplit(value);assert.equal(readPendingPdfSplit(base.workspaceId,base.parserId,base.userId)?.sourceMimeType,'image/tiff');assert.equal(readPendingPdfSplit(base.workspaceId,base.parserId,'99999999-9999-4999-8999-999999999999'),null);savePendingPdfSplit({...value,userId:'99999999-9999-4999-8999-999999999999'});assert.equal(readPendingPdfSplit(base.workspaceId,base.parserId,base.userId)?.requestId,base.requestId);
 const tiffReceipt={...receipt,split:{...receipt.split,sourceMimeType:'image/tiff'}};
 globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json(tiffReceipt);assert.equal(receiptId(await submitStoredPdfSplit(value,()=>true)),receipt.split.id);
 globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json(receipt);await assert.rejects(findStoredPdfSplit(value,()=>true),/could not be confirmed/);
 const rejected={id:receipt.split.id,requestId:base.requestId,parserId:base.parserId,sourceDocumentId:base.sourceDocumentId,sourceSha256:base.sha256,sourceMimeType:'image/tiff',options:base.options,code:'parser_format_not_allowed',reason:'tiff',message:'TIFF is not allowed.'};
 globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json({rejected});assert.ok('rejected'in (await findStoredPdfSplit(value,()=>true))!);
 globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):json({rejected:{...rejected,sourceMimeType:undefined}});await assert.rejects(findStoredPdfSplit(value,()=>true),/does not match/);
 assert.equal(confirmPdfSplitReceipt(base,receipt as any).split.id,receipt.split.id);
 }finally{env.restore();}});

test('TIFF preview requires exact source, page, bounded page count and JPEG MIME',async()=>{const env=environment();try{
 const headers={'content-type':'image/jpeg','X-Folio-Source-Sha256':base.sha256,'X-Folio-Preview-Page':'2','X-Folio-Page-Count':'3'};
 globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):new Response(new Uint8Array([255,216,255]),{headers});
 const result=await readTiffSplitPreview(base,2,()=>true,new AbortController().signal,undefined,base.sourceDocumentId,3);assert.equal(result.pageCount,3);assert.equal(result.blob.type,'image/jpeg');
 for(const change of[{'X-Folio-Source-Sha256':'b'.repeat(64)},{'X-Folio-Preview-Page':'1'},{'X-Folio-Page-Count':'4'},{'X-Folio-Page-Count':'31'},{'content-type':'image/tiff'}]){
  globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):new Response(new Uint8Array([255,216,255]),{headers:{...headers,...change}});
  await assert.rejects(readTiffSplitPreview(base,2,()=>true,new AbortController().signal,undefined,base.sourceDocumentId,3),/preview/);
 }
 globalThis.fetch=async(input)=>String(input)==='/api/auth/me'?json(actor):new Response(new Uint8Array(2*1024*1024+1),{headers});await assert.rejects(readTiffSplitPreview(base,2,()=>true,new AbortController().signal,undefined,base.sourceDocumentId,3),/could not be previewed/);
 }finally{env.restore();}});

test('signed TIFF preview stages once without options and submit confirms the persisted UUID and selection before finalize',async()=>{const env=environment();try{
 const file=new File([new Uint8Array([73,73,42,0])],'source.tiff',{type:'image/tiff'}),sha256=await pdfSha256(await file.arrayBuffer());
 const value={...base,sha256},uploadId='99999999-9999-4999-8999-999999999999',calls:string[]=[];
 const tiffReceipt={...receipt,split:{...receipt.split,sourceSha256:sha256,sourceMimeType:'image/tiff'}};
 globalThis.fetch=async(input,init)=>{const path=String(input);calls.push(`${init?.method||'GET'} ${path}`);
  if(path==='/api/auth/me')return json(actor);if(path==='/api/uploads/config')return json({strategy:'signed',maxBytes:10*1024*1024});
  if(path.endsWith('/uploads')){assert.deepEqual(JSON.parse(String(init?.body)).pdfSplit,{requestId:base.requestId});return json({uploadId,uploadUrl:'https://controlled.supabase.co/upload'});}
  if(init?.method==='PUT')return new Response(null,{status:200});if(path.includes('/requests/'))return json({message:'Not found'},404);
  if(path.endsWith('/split-confirm')){const pending=readPendingPdfSplit(base.workspaceId,base.parserId,base.userId);assert.equal(pending?.requestId,base.requestId);assert.deepEqual(pending?.options,base.options);assert.deepEqual(JSON.parse(String(init?.body)),{options:base.options});return json({ok:true});}
  if(path.endsWith('/finalize'))return json(tiffReceipt,202);throw new Error('Unexpected controlled request');
 };
 const staged=await prepareTiffSplitPreview({...value,options:undefined},file,()=>true,new AbortController().signal);assert.equal(staged.uploadId,uploadId);assert.ok(!calls.some(call=>call.includes('/finalize')||call.includes('/split-confirm')));
 const pending={...value,sourceMimeType:'image/tiff' as const,uploadId};savePendingPdfSplit(pending);assert.equal((await uploadPdfSplit(pending,file,savePendingPdfSplit,()=>true)).split.id,receipt.split.id);
 assert.equal(calls.filter(call=>call.startsWith('PUT ')).length,1);assert.ok(calls.indexOf(`POST /api/uploads/${uploadId}/split-confirm`)<calls.indexOf(`POST /api/uploads/${uploadId}/finalize`));
 }finally{env.restore();}});

test('TIFF preparation stops before reservation or PUT after account or view changes',async()=>{const env=environment();try{
 const file=new File([new Uint8Array([73,73,42,0])],'source.tiff',{type:'image/tiff'}),value={...base,sha256:await pdfSha256(await file.arrayBuffer())};let current=true,writes=0;
 globalThis.fetch=async(input,init)=>{if(init?.method==='POST'||init?.method==='PUT')writes++;if(String(input)==='/api/auth/me')return json(actor);current=false;return json({strategy:'signed',maxBytes:10*1024*1024});};await assert.rejects(prepareTiffSplitPreview(value,file,()=>current,new AbortController().signal),/view changed/);assert.equal(writes,0);
 current=true;globalThis.fetch=async(input,init)=>{if(init?.method==='PUT')writes++;if(String(input)==='/api/auth/me')return json(actor);if(String(input)==='/api/uploads/config')return json({strategy:'signed',maxBytes:10*1024*1024});current=false;return json({uploadId:'99999999-9999-4999-8999-999999999999',uploadUrl:'https://controlled.supabase.co/upload'});};await assert.rejects(prepareTiffSplitPreview(value,file,()=>current,new AbortController().signal),/view changed/);assert.equal(writes,0);
 }finally{env.restore();}});
