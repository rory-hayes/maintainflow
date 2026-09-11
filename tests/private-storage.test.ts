import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSupabaseStorage,readBoundedResponse,validateStorageKey,safeDownloadName,ORIGINALS_BUCKET} from '../server/core/storage.js';
const workspace=randomUUID(),key=`${workspace}/${randomUUID()}`,url='https://storage-fixture.supabase.co';
const bucket={id:ORIGINALS_BUCKET,public:false,file_size_limit:10485760};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function storage(handler:(url:URL,init:RequestInit)=>Promise<Response>|Response){return createSupabaseStorage({url,serviceRoleKey:'owned synthetic storage credential',fetch:async(input,init)=>handler(new URL(String(input)),init!)});}

test('private storage accepts only two UUID key segments and an exact workspace',()=>{
 assert.equal(validateStorageKey(key,workspace),key);
 for(const invalid of ['../secret',`${workspace}/../secret`,`${workspace}/${randomUUID()}/extra`,`https://elsewhere.test/object`,`${randomUUID()}/${randomUUID()}`])assert.throws(()=>validateStorageKey(invalid,workspace));
 assert.equal(safeDownloadName('../invoice\r\nInjected.txt'),'invoiceInjected.txt');
 assert.throws(()=>createSupabaseStorage({url:'http://127.0.0.1',serviceRoleKey:'fixture'}));
});
test('bounded response rejects excessive declared and streaming sizes without retaining the full object',async()=>{
 await assert.rejects(readBoundedResponse(new Response('tiny',{headers:{'Content-Length':'100'}}),16),(error:any)=>error.statusCode===413);
 let canceled=false;
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(10));controller.enqueue(new Uint8Array(10));},cancel(){canceled=true;}}));
 await assert.rejects(readBoundedResponse(response,16),(error:any)=>error.statusCode===413);assert.equal(canceled,true);
 assert.equal((await readBoundedResponse(new Response('fixture'),16)).toString(),'fixture');
});
test('signed uploads require a private capped bucket before creating capabilities',async()=>{
 for(const configuration of [{...bucket,public:true},{...bucket,file_size_limit:null},{...bucket,file_size_limit:20*1024*1024}]){
  let calls=0;const client=storage(()=>{calls++;return json(configuration);});
  await assert.rejects(client.signUpload!(key),/private with a 10 MB file limit/);assert.equal(calls,1);
 }
});
test('signed upload is restricted to the reserved key with overwrite disabled and redirects rejected',async()=>{
 const calls:{url:URL;init:RequestInit}[]=[];
 const client=storage((endpoint,init)=>{calls.push({url:endpoint,init});if(endpoint.pathname.includes('/bucket/'))return json(bucket);return json({url:`/object/upload/sign/${ORIGINALS_BUCKET}/${key}?token=controlled-upload-token`});});
 const signed=await client.signUpload!(key);assert.equal(new URL(signed).pathname,`/storage/v1/object/upload/sign/${ORIGINALS_BUCKET}/${key}`);
 assert.equal(calls.length,2);assert.equal(calls[1].init.method,'POST');assert.equal(calls[1].init.body,'{}');assert.equal(calls[1].init.redirect,'error');assert.notEqual(new Headers(calls[1].init.headers).get('x-upsert'),'true');
 const bad=storage(endpoint=>endpoint.pathname.includes('/bucket/')?json(bucket):json({url:'https://untrusted.example/object?token=fixture'}));
 await assert.rejects(bad.signUpload!(key),/unexpected signed URL/);
});
test('remote reads/writes/deletes use only fixed bucket paths and expose generic errors',async()=>{
 const calls:{url:URL;init:RequestInit}[]=[];
 const client=storage((endpoint,init)=>{calls.push({url:endpoint,init});if(endpoint.pathname.includes('/bucket/'))return json(bucket);if(init.method==='POST')return json({Key:key});if(init.method==='DELETE')return json([]);return new Response('owned bytes');});
 await client.write(key,Buffer.from('owned bytes'));assert.equal(new Headers(calls[1].init.headers).get('Content-Type'),'application/octet-stream');assert.equal(new Headers(calls[1].init.headers).get('x-upsert'),'false');
 assert.equal((await client.read(key)).toString(),'owned bytes');assert.equal(calls[2].url.pathname,`/storage/v1/object/authenticated/${ORIGINALS_BUCKET}/${key}`);
 await client.remove(key);assert.deepEqual(JSON.parse(String(calls[3].init.body)),{prefixes:[key]});
 const failed=storage(()=>json({message:'private provider diagnostics and secret-like material'},500));
 await assert.rejects(failed.read(key),(error:any)=>error.statusCode===503&&!error.message.includes('diagnostics'));
});
test('download links expire after 60 seconds and sanitize Content-Disposition filenames',async()=>{
 let expiry=0;
 const client=storage((endpoint,init)=>{if(endpoint.pathname.includes('/bucket/'))return json(bucket);expiry=JSON.parse(String(init.body)).expiresIn;return json({signedURL:`/object/sign/${ORIGINALS_BUCKET}/${key}?token=controlled-download-token`});});
 const signed=new URL(await client.signDownload!(key,'../../invoice\r\n".pdf'));
 assert.equal(expiry,60);assert.equal(signed.origin,url);assert.equal(signed.searchParams.get('download'),'invoice".pdf');assert.ok(!signed.toString().includes('%0D'));assert.ok(!signed.toString().includes('%0A'));
});
