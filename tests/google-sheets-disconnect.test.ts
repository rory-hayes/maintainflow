import test from 'node:test';
import assert from 'node:assert/strict';
import {googleSheetsRevocation} from '../server/integrations/google-sheets-disconnect.js';

test('disconnect reports the committed local state when old credentials cannot be read',async()=>{
 let requests=0;
 for(const decrypt of [()=>{throw new Error('SYNTHETIC_UNREADABLE_CREDENTIAL');},()=>'{malformed',()=>'{"refresh_token":42}',()=> 'null',()=> '[]']){
  const result=await googleSheetsRevocation('synthetic-old-ciphertext',{decrypt,revoke:async()=>{requests++;return {status:200};}});
  assert.equal(result.disconnected,true);assert.equal(result.providerRevoked,false);
  assert.match(result.reason!,/Google account/);assert.ok(!JSON.stringify(result).includes('SYNTHETIC_'));
 }
 assert.equal(requests,0);
});

test('disconnect revokes the refresh credential first and accepts only a confirmed success',async()=>{
 for(const status of [200,204,400,401,429,500,NaN]){
  const received:string[]=[];
  const result=await googleSheetsRevocation('synthetic-ciphertext',{
   decrypt:()=>JSON.stringify({refresh_token:'SYNTHETIC_REFRESH',access_token:'SYNTHETIC_ACCESS'}),
   revoke:async token=>{received.push(token);return {status};},
  });
  assert.deepEqual(received,['SYNTHETIC_REFRESH']);
  assert.equal(result.providerRevoked,status===200||status===204);
  assert.equal(result.reason===null,result.providerRevoked);
  assert.ok(!JSON.stringify(result).includes('SYNTHETIC_'));
 }
});

test('disconnect preserves truthful fallback after configuration, network or lost-response failure',async()=>{
 const result=await googleSheetsRevocation('synthetic-ciphertext',{
  decrypt:()=>JSON.stringify({access_token:'SYNTHETIC_ACCESS'}),
  revoke:async token=>{assert.equal(token,'SYNTHETIC_ACCESS');throw new Error('SYNTHETIC_TOKEN_IN_PROVIDER_ERROR');},
 });
 assert.deepEqual(result,{disconnected:true,providerRevoked:false,reason:'Local delivery is disabled. Revoke access for this app in your Google account if provider revocation could not complete.'});
});

test('an already disconnected integration makes no credential or provider request',async()=>{
 const forbidden=()=>{throw new Error('Unexpected credential or provider request');};
 assert.equal((await googleSheetsRevocation(null,{decrypt:forbidden,revoke:forbidden})).providerRevoked,false);
});
