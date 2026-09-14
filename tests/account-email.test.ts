import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AccountEmailError,createAccountEmailSender,trustedAccountOrigin,type AccountEmailMessage} from '../server/integrations/account-email.js';

const environment={NODE_ENV:'test',APP_ORIGIN:'https://owned-folio.example.test',FOLIO_AUTH_EMAIL_ENABLED:'true',FOLIO_AUTH_EMAIL_FROM:'recovery@example.test',FOLIO_AUTH_EMAIL_API_KEY:'re_owned_fixture_only_not_a_key'};
const message=():AccountEmailMessage=>({idempotencyKey:`folio-account-email/${randomUUID()}`,to:'owner@example.test',subject:'Reset your Folio password',text:'Open https://owned-folio.example.test/reset-password#token=owned-fixture'});
const success=()=>new Response(JSON.stringify({id:randomUUID()}),{status:200,headers:{'content-type':'application/json'}});
const fails=(code:string,retryable:boolean)=>(error:unknown)=>error instanceof AccountEmailError&&error.code===code&&error.retryable===retryable&&error.message==='Account email delivery could not be completed.';

test('account sending requires explicit dedicated configuration and a trusted application origin',()=>{
  let calls=0;const fetchImpl=(async()=>{calls++;return success();}) as typeof fetch;
  for(const override of [{FOLIO_AUTH_EMAIL_ENABLED:'false'},{FOLIO_AUTH_EMAIL_API_KEY:''},{FOLIO_AUTH_EMAIL_FROM:'Header\r\nInjected: text'},{APP_ORIGIN:'https://user:secret@example.test'},{APP_ORIGIN:'https://example.test/path'},{APP_ORIGIN:'https://example.test?token=private'},{APP_ORIGIN:'http://example.test'},{NODE_ENV:'production',APP_ORIGIN:'http://localhost:5178'}]){
    assert.equal(createAccountEmailSender({...environment,...override},{fetchImpl}),undefined);
  }
  assert.ok(createAccountEmailSender(environment,{fetchImpl}));assert.equal(calls,0);
  assert.equal(trustedAccountOrigin({...environment,APP_ORIGIN:'http://127.0.0.1:4336'}),'http://127.0.0.1:4336');
  assert.equal(trustedAccountOrigin({...environment,APP_ORIGIN:'https://owned-folio.example.test/'}),'https://owned-folio.example.test');
});

test('account sender uses the fixed HTTPS endpoint and identical plaintext payload/idempotency on retry',async()=>{
  const requests:{url:string;method:unknown;redirect:unknown;headers:Record<string,string>;body:unknown}[]=[];
  const providerId=randomUUID();
  const sender=createAccountEmailSender(environment,{fetchImpl:(async(url,options)=>{
    requests.push({url:String(url),method:options?.method,redirect:options?.redirect,headers:Object.fromEntries(new Headers(options?.headers)),body:JSON.parse(String(options?.body))});
    assert.ok(options?.signal instanceof AbortSignal);
    if(requests.length===1)throw new Error('Uncertain provider acknowledgement with PRIVATE details');
    return new Response(JSON.stringify({id:providerId}));
  }) as typeof fetch})!;
  const payload=message();await assert.rejects(sender.send(payload),fails('temporary_failure',true));
  assert.deepEqual(await sender.send(payload),{providerId});
  assert.deepEqual(requests[0],requests[1]);
  const request=requests[0]!;assert.equal(request.url,'https://api.resend.com/emails');assert.equal(request.method,'POST');assert.equal(request.redirect,'error');
  assert.equal(request.headers['idempotency-key'],payload.idempotencyKey);
  assert.deepEqual(request.body,{from:'Folio <recovery@example.test>',to:[payload.to],subject:payload.subject,text:payload.text});
  assert.ok(!request.url.includes('token'));assert.equal(Object.hasOwn(request.body as object,'html'),false);
});

test('account sender never exposes provider response text and distinguishes finite retry outcomes',async()=>{
  for(const [status,code,retryable] of [[400,'permanent_failure',false],[403,'permanent_failure',false],[409,'temporary_failure',true],[429,'temporary_failure',true],[503,'temporary_failure',true]] as const){
    const sender=createAccountEmailSender(environment,{fetchImpl:(async()=>new Response('PRIVATE reset token and recipient',{status})) as typeof fetch})!;
    await assert.rejects(sender.send(message()),fails(code,retryable));
  }
});

test('successful account email responses are bounded and must contain a valid provider receipt',async()=>{
  const responses=[
    ()=>new Response('PRIVATE malformed body'),
    ()=>new Response(JSON.stringify({id:'PRIVATE arbitrary response'})),
    ()=>new Response('{}',{headers:{'content-length':'20000'}}),
    ()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(16*1024+1));controller.close();}})),
  ];
  for(const response of responses){
    const sender=createAccountEmailSender(environment,{fetchImpl:(async()=>response()) as typeof fetch})!;
    await assert.rejects(sender.send(message()),fails('invalid_response',true));
  }
});

test('account email deadline and cancellation fence transports that ignore AbortSignal',async()=>{
  let calls=0;
  const sender=createAccountEmailSender(environment,{timeoutMs:15,fetchImpl:(async()=>{calls++;return new Promise<Response>(()=>{});}) as typeof fetch})!;
  const controller=new AbortController();controller.abort();
  await assert.rejects(sender.send(message(),{signal:controller.signal}),fails('cancelled',true));assert.equal(calls,0);
  await assert.rejects(sender.send(message(),{deadlineAt:Date.now()-1}),fails('timeout',true));assert.equal(calls,0);
  await assert.rejects(sender.send(message()),fails('timeout',true));assert.equal(calls,1);
  const active=new AbortController();const pending=sender.send(message(),{signal:active.signal});active.abort();
  await assert.rejects(pending,fails('cancelled',true));assert.equal(calls,2);
});

test('oversized or malformed account mail fails before transport',async()=>{
  let calls=0;const sender=createAccountEmailSender(environment,{fetchImpl:(async()=>{calls++;return success();}) as typeof fetch})!;
  for(const override of [{to:'a@example.test\r\nBcc: b@example.test'},{subject:'Untrusted subject'},{text:'x'.repeat(4097)},{idempotencyKey:'caller-controlled'}]){
    await assert.rejects(sender.send({...message(),...override}),fails('invalid_message',false));
  }
  assert.equal(calls,0);
});
