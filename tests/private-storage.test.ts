import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createSupabaseStorage,readBoundedResponse,validateStorageKey,safeDownloadName,ORIGINALS_BUCKET,storageDiagnostic} from '../server/core/storage.js';
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
test('storage diagnostics identify upstream operation/status without retaining provider secrets',async()=>{
 for(const stage of ['bucket-read','upload-sign'] as const)for(const status of [401,403,500]){
  const client=storage(endpoint=>stage==='upload-sign'&&endpoint.pathname.includes('/bucket/')?json(bucket):json({message:'PRIVATE provider body',url:'https://private.example/?token=PRIVATE'},status));
  await assert.rejects(client.signUpload!(key),(error:any)=>{
   assert.equal(error.statusCode,503);assert.deepEqual(storageDiagnostic(error),{storageCode:'STORAGE_UPSTREAM_HTTP',storageOperation:stage,upstreamStatus:status,storageProviderCode:'unclassified',credentialJwtPayloadParseable:false});
   assert.ok(!JSON.stringify(error).includes('PRIVATE'));assert.ok(!String(error).includes('PRIVATE'));return true;
  });
 }
 const missing=storage(()=>json({statusCode:'404'},400));
 await assert.rejects(missing.read(key),(error:any)=>{assert.equal(error.statusCode,404);assert.deepEqual(storageDiagnostic(error),{storageCode:'STORAGE_UPSTREAM_HTTP',storageOperation:'bucket-read',upstreamStatus:400,storageProviderCode:'unclassified',credentialJwtPayloadParseable:false});return true;});
});
test('storage diagnostics distinguish transport, bucket, JSON and signed-URL failures',async()=>{
 const cases=[
  {client:storage(()=>{throw new Error('PRIVATE transport details');}),diagnostic:{storageCode:'STORAGE_UPSTREAM_NETWORK',storageOperation:'bucket-read'}},
  {client:storage(()=>json({...bucket,public:true})),diagnostic:{storageCode:'STORAGE_BUCKET_POLICY',storageOperation:'bucket-read',upstreamStatus:200}},
  {client:storage(()=>new Response('PRIVATE invalid JSON')),diagnostic:{storageCode:'STORAGE_RESPONSE_INVALID',storageOperation:'bucket-read',upstreamStatus:200}},
  {client:storage(endpoint=>endpoint.pathname.includes('/bucket/')?json(bucket):new Response('PRIVATE invalid JSON')),diagnostic:{storageCode:'STORAGE_RESPONSE_INVALID',storageOperation:'upload-sign',upstreamStatus:200}},
  {client:storage(endpoint=>endpoint.pathname.includes('/bucket/')?json(bucket):json({url:'https://private.example/?token=PRIVATE'})),diagnostic:{storageCode:'STORAGE_SIGNED_URL',storageOperation:'upload-sign'}},
  {client:storage(endpoint=>endpoint.pathname.includes('/bucket/')?json(bucket):json(null)),diagnostic:{storageCode:'STORAGE_SIGNED_URL',storageOperation:'upload-sign'}},
 ];
 for(const {client,diagnostic} of cases)await assert.rejects(client.signUpload!(key),(error:any)=>{assert.equal(error.statusCode,503);assert.deepEqual(storageDiagnostic(error),diagnostic);assert.ok(!String(error).includes('PRIVATE'));return true;});
});
test('diagnostic allowlist rejects forged properties and never copies credential configuration',()=>{
 assert.equal(storageDiagnostic(Object.assign(new Error('PRIVATE'),{storageCode:'PRIVATE',storageOperation:'PRIVATE',upstreamStatus:401})),undefined);
 for(const [configuration,code] of [[{url:'PRIVATE invalid URL',serviceRoleKey:'PRIVATE'},'STORAGE_CONFIG_URL'],[{url,serviceRoleKey:''},'STORAGE_CONFIG_CREDENTIALS']] as const){
  assert.throws(()=>createSupabaseStorage(configuration),(error:any)=>{assert.equal(error.statusCode,503);assert.deepEqual(storageDiagnostic(error),{storageCode:code});assert.equal(Object.isFrozen(storageDiagnostic(error)),true);assert.ok(!String(error).includes('PRIVATE'));return true;});
 }
});
test('upstream diagnostics recognize only exact published codes from code or error fields',async()=>{
 for(const [body,expected] of [
  [{code:'InvalidJWT',message:'PRIVATE'},'InvalidJWT'],
  [{error:'AccessDenied',message:'PRIVATE'},'AccessDenied'],
  [{code:'PRIVATE arbitrary value',error:'InvalidRequest'},'InvalidRequest'],
  [{code:'InvalidJWT PRIVATE',error:{code:'InvalidJWT'},message:'PRIVATE'},'unclassified'],
  [{code:'constructor',error:'toString'},'unclassified'],
  [null,'unclassified'],
 ] as const){
  await assert.rejects(storage(()=>json(body,400)).signUpload!(key),(error:any)=>{
   assert.equal(error.statusCode,503);assert.equal(storageDiagnostic(error)?.storageProviderCode,expected);
   assert.ok(!JSON.stringify(storageDiagnostic(error)).includes('PRIVATE'));return true;
  });
 }
});
test('credential diagnostics report only unverified project-match and expiration booleans',async()=>{
 const jwt=(payload:unknown)=>Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(payload)).toString('base64url')+'.synthetic-signature';
 const examples=[
  {credential:jwt({ref:'storage-fixture',exp:Math.floor(Date.now()/1000)+3600,secret:'PRIVATE'}),expected:{credentialJwtPayloadParseable:true,credentialProjectMatches:true,credentialExpired:false}},
  {credential:jwt({ref:'PRIVATE-other-project',exp:1}),expected:{credentialJwtPayloadParseable:true,credentialProjectMatches:false,credentialExpired:true}},
  {credential:jwt({ref:42,exp:'PRIVATE'}),expected:{credentialJwtPayloadParseable:true}},
  {credential:jwt(null),expected:{credentialJwtPayloadParseable:false}},
  {credential:'PRIVATE opaque key',expected:{credentialJwtPayloadParseable:false}},
  {credential:'aaa.not-json.bbb',expected:{credentialJwtPayloadParseable:false}},
  {credential:'a'.repeat(16_385),expected:{credentialJwtPayloadParseable:false}},
 ];
 for(const {credential,expected} of examples){
  const client=createSupabaseStorage({url,serviceRoleKey:credential,fetch:async()=>json({code:'InvalidJWT',message:'PRIVATE'},400)});
  await assert.rejects(client.signUpload!(key),(error:any)=>{
   assert.deepEqual(storageDiagnostic(error),{storageCode:'STORAGE_UPSTREAM_HTTP',storageOperation:'bucket-read',upstreamStatus:400,storageProviderCode:'InvalidJWT',...expected});
   assert.ok(!JSON.stringify(storageDiagnostic(error)).includes('PRIVATE'));assert.ok(!String(error).includes(credential));return true;
  });
 }
});
