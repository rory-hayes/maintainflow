import test from 'node:test';
import assert from 'node:assert/strict';
import {publicProviderError} from '../server/integrations/provider-policy.js';

const privateText='synthetic-refresh-token https://private.example.test/callback?code=synthetic-code';
const generic=(provider='Google Sheets')=>`${provider} operation failed. Check provider configuration and the documented release gates.`;
const expected={
 invalid_grant:'Reconnect Google Sheets in Integrations.',
 invalid_client:"Contact support to check this application's Google connection settings.",
 unauthorized_client:'Contact support to check whether this application is allowed to connect to Google.',
 access_denied:'Check your Google account permissions, then reconnect Google Sheets in Integrations.',
};
function oauthError(code:unknown,status=400){
 return Object.assign(new Error(privateText),{status,code:privateText,response:{status,data:{error:code,error_description:privateText,access_token:privateText,refresh_token:privateText},config:{url:privateText,headers:{Authorization:privateText},body:privateText}}});
}

test('Google OAuth rejection codes give distinct fixed guidance without leaking provider details',()=>{
 const messages=new Set<string>();
 for(const [code,guidance] of Object.entries(expected))for(const provider of ['Google Sheets','Google OAuth'])for(const status of [400,401,403]){
  const error=oauthError(code,status),before=JSON.stringify(error);
  const actual=publicProviderError(provider,error);
  assert.equal(actual,`${provider} authorization failed (${code}). ${guidance}`);
  assert.doesNotMatch(actual,/synthetic-|https:|Authorization/);
  assert.equal(error.status,status,'Classification does not alter retry status.');
  assert.equal(JSON.stringify(error),before,'Classification does not modify the SDK error or credentials.');
  if(provider==='Google Sheets')messages.add(actual);
 }
 assert.equal(messages.size,4);
});

test('unknown and malformed OAuth response codes remain generic without string coercion or body parsing',()=>{
 for(const code of [undefined,null,42,{},['invalid_grant'],new String('invalid_grant'),'INVALID_GRANT',' invalid_grant','invalid_grant\n'+privateText,privateText,'invalid_scope','toString','__proto__', {toString(){throw new Error('Do not stringify provider values.');}}]){
  assert.equal(publicProviderError('Google Sheets',oauthError(code)),generic());
 }
 for(const data of [null,privateText,JSON.stringify({error:'invalid_grant'}),['invalid_grant'],Object.create({error:'invalid_grant'}),{error:{status:'invalid_grant',message:privateText}}]){
  assert.equal(publicProviderError('Google Sheets',{status:400,response:{data}}),generic());
 }
 assert.equal(publicProviderError('Google Sheets',{status:400,code:'invalid_grant',message:'invalid_grant',error:'invalid_grant'}),generic(),'Only the structured SDK OAuth response is authoritative.');
});

test('Google guidance never reads free-text descriptions, response bodies, request URLs or error messages',()=>{
 const forbidden=()=>{throw new Error('Sensitive field must not be inspected.');};
 const error={status:400,response:{data:{error:'invalid_grant',get error_description(){return forbidden();},get access_token(){return forbidden();}},get config(){return forbidden();},get body(){return forbidden();}},get message(){return forbidden();},get code(){return forbidden();}};
 assert.equal(publicProviderError('Google Sheets',error),`Google Sheets authorization failed (invalid_grant). ${expected.invalid_grant}`);
});

test('non-Google errors and non-authorization HTTP failures keep their existing safe messages',()=>{
 for(const provider of ['stripe','resend','Google Drive','google_sheets'])assert.equal(publicProviderError(provider,oauthError('invalid_grant')),generic(provider));
 for(const status of [undefined,200,404,500,502])assert.equal(publicProviderError('Google Sheets',{status,response:{data:{error:'invalid_grant'}}}),generic());
 for(const status of [401,403])assert.equal(publicProviderError('Google Sheets',oauthError(privateText,status)),'Google Sheets authorization failed. Check credentials and permissions.');
 assert.equal(publicProviderError('Google Sheets',oauthError('invalid_grant',429)),'Google Sheets rate limit reached. The worker will retry within its configured limit.');
 assert.equal(publicProviderError('Google OAuth',{statusCode:401,response:{data:{error:'invalid_client'}}}),`Google OAuth authorization failed (invalid_client). ${expected.invalid_client}`);
 for(const error of [null,undefined,privateText,new Error(privateText)])assert.equal(publicProviderError('Google Sheets',error),generic());
});
