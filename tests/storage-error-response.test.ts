import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../server/app.js';
import {createSupabaseStorage} from '../server/core/storage.js';

test('HTTP storage failures keep generic user errors and log only trusted diagnostic fields',async()=>{
 const client=createSupabaseStorage({url:'https://storage-fixture.supabase.co',serviceRoleKey:'PRIVATE synthetic credential',fetch:async()=>new Response(JSON.stringify({code:'InvalidJWT',message:'PRIVATE vendor body',url:'https://private.example/?token=PRIVATE'}),{status:400})});
 let failure:unknown;
 try{await client.signUpload!(randomUUID()+'/'+randomUUID());}catch(error){failure=error;}
 assert.ok(failure instanceof Error);
 const app=await buildApp(),logs:unknown[]=[];
 app.addHook('onRequest',async request=>{request.log.error=((fields:unknown)=>{logs.push(fields);}) as typeof request.log.error;});
 app.get('/__test_storage_error',async()=>{throw failure;});
 try{
  const first=await app.inject({method:'GET',url:'/__test_storage_error'});
  assert.equal(first.statusCode,503);
  assert.deepEqual(first.json(),{error:'server_error',message:'The request could not be completed. Check the server status and try again.'});
  assert.deepEqual(logs[0],{errorName:'Error',route:'/__test_storage_error',storageCode:'STORAGE_UPSTREAM_HTTP',storageOperation:'bucket-read',upstreamStatus:400,storageProviderCode:'InvalidJWT',credentialJwtPayloadParseable:false});
  assert.ok(!JSON.stringify(logs).includes('PRIVATE'));assert.ok(!first.body.includes('storageCode'));
  failure=Object.assign(new Error('PRIVATE unrelated failure'),{statusCode:503,storageCode:'PRIVATE',storageOperation:'PRIVATE',upstreamStatus:401});
  const second=await app.inject({method:'GET',url:'/__test_storage_error'});
  assert.deepEqual(second.json(),first.json());
  assert.deepEqual(logs[1],{errorName:'Error',route:'/__test_storage_error'});
 }finally{await app.close();}
});
