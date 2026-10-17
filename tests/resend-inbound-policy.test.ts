import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Webhook} from 'svix';
import type {GetReceivingEmailResponseSuccess} from 'resend';
import {emailAddress,deliveredRecipients,receivedEmailMatchesId,receivedEmailBody,verifyResendPayload} from '../server/integrations/provider-policy.js';

test('inbound sender normalization accepts one complete mailbox and rejects hidden trailing addresses or header injection',()=>{
 assert.equal(emailAddress('Supplier <Supplier@Example.test>'),'supplier@example.test');
 assert.equal(emailAddress('  supplier@example.test  '),'supplier@example.test');
 assert.equal(emailAddress('"Supplier, Accounts" <supplier@example.test>'),'supplier@example.test');
 for(const value of [
  'Supplier <supplier@example.test>, Attacker <attacker@example.test>',
  'attacker@example.test, Supplier <supplier@example.test>',
  'Attacker <attacker@example.test>, supplier@example.test',
  'Supplier <supplier@example.test> attacker@example.test',
  'Supplier <supplier@example.test><attacker@example.test>',
  'Supplier <supplier@example.test> (attacker@example.test)',
  'Supplier <supplier@example.test>\r\nFrom: attacker@example.test',
  'Supplier\u0000 <supplier@example.test>',
  'Supplier\t <supplier@example.test>',
  '<supplier@example.test',
  'supplier@example.test>',
  'supplier@example.test,attacker@example.test',
 ])assert.equal(emailAddress(value),null,JSON.stringify(value));
});

test('delivery recipients cannot be authorized by a partial mailbox match or visible To headers',()=>{
 const recipient='owned@example.test';
 const email={received_for:[recipient],to:[recipient]} as Pick<GetReceivingEmailResponseSuccess,'received_for'>;
 assert.deepEqual(deliveredRecipients([recipient.toUpperCase()],email),[recipient]);
 assert.deepEqual(deliveredRecipients([`Owned <${recipient}> trailing@example.test`],email),[]);
 assert.deepEqual(deliveredRecipients([recipient],{...email,received_for:[`Owned <${recipient}>,other@example.test`]}),[]);
 assert.deepEqual(deliveredRecipients([recipient],{...email,received_for:[]}),[]);
});

test('retrieved email identity binds content to its signed pointer and fails closed for another or malformed ID',()=>{
 const id=randomUUID();
 assert.equal(receivedEmailMatchesId(id,{id}),true);
 assert.equal(receivedEmailMatchesId(id.toUpperCase(),{id}),true);
 for(const email of [{id:randomUUID()},{id:'not-an-email-id'},{id:null},{},null,'invalid'])assert.equal(receivedEmailMatchesId(id,email),false);
 assert.equal(receivedEmailMatchesId('not-an-email-id',{id:'not-an-email-id'}),false);
});

test('signed inbound pointers reject raw mutation, forged or stale signatures and malformed pointer shapes',()=>{
 const secret=`whsec_${randomBytes(32).toString('base64')}`,id=`msg_owned_${randomUUID()}`,emailId=randomUUID(),date=new Date();
 const raw=JSON.stringify({type:'email.received',data:{email_id:emailId,received_for:['owned@example.test'],subject:'SYNTHETIC PRIVATE SUBJECT'}});
 const sign=(body:string,timestamp:Date=date)=>({'svix-id':id,'svix-timestamp':String(Math.floor(timestamp.getTime()/1000)),'svix-signature':new Webhook(secret).sign(id,timestamp,body)});
 assert.deepEqual(verifyResendPayload(Buffer.from(raw),sign(raw),secret),{type:'email.received',data:{email_id:emailId,received_for:['owned@example.test']}});
 assert.throws(()=>verifyResendPayload(Buffer.from(raw+' '),sign(raw),secret));
 assert.throws(()=>verifyResendPayload(Buffer.from(raw),{...sign(raw),'svix-id':`${id}_forged`},secret));
 assert.throws(()=>verifyResendPayload(Buffer.from(raw),sign(raw,new Date(0)),secret));
 for(const data of [{email_id:'invalid',received_for:[]},{email_id:emailId,received_for:'owned@example.test'},{email_id:emailId,received_for:Array(51).fill('owned@example.test')}]){
  const invalid=JSON.stringify({type:'email.received',data});assert.throws(()=>verifyResendPayload(Buffer.from(invalid),sign(invalid),secret));
 }
});

test('received body preserves text or HTML bytes within its limit and neutralizes header controls',async()=>{
 const email={id:randomUUID(),from:'Supplier <supplier@example.test>\r\nBcc: injected@example.test',received_for:['owned@example.test'],subject:'Owned\r\nInjected: bad',text:'SYNTHETIC BODY\nReference: 000042',html:null} as GetReceivingEmailResponseSuccess;
 const body=await receivedEmailBody(email,4096);
 assert.match(body.toString(),/Content-Type: text\/plain; charset=utf-8/);
 assert.ok(body.toString().endsWith(email.text!));
 assert.doesNotMatch(body.toString(),/\r\n(?:Bcc|Injected):/);
 const html='<p>SYNTHETIC HTML <b>000042</b></p>';
 const htmlBody=await receivedEmailBody({...email,text:null,html},4096);
 assert.match(htmlBody.toString(),/Content-Type: text\/html; charset=utf-8/);assert.ok(htmlBody.toString().endsWith(html));
 await assert.rejects(receivedEmailBody(email,Buffer.byteLength(email.text!)-1),/byte limit/);
 await assert.rejects(receivedEmailBody(email,Buffer.byteLength(email.text!)),/byte limit/,'Generated EML headers also count against the document limit');
});
