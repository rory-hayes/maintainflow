import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Resend} from 'resend';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {processResendEvent,type ResendDependencies} from '../server/integrations/providers.js';

after(closeDatabase);

test('a retrieved message with another identity cannot reach route lookup, attachment download or intake',async()=>{
 const emailId=randomUUID(),original=adminPool.query;let reads=0;
 const forbidden=async()=>{throw new Error('Unexpected database/download/intake request');};
 const dependencies:ResendDependencies={
  client:{emails:{receiving:{get:async(id:string)=>{
   assert.equal(id,emailId);reads++;return {data:{id:randomUUID(),received_for:['owned@example.test'],from:'allowed@example.test',attachments:[]},error:null};
  }}}} as unknown as Resend,
  download:forbidden,intake:forbidden,
 };
 try{
  adminPool.query=forbidden as typeof original;
  await assert.rejects(processResendEvent(`resend:${randomUUID()}`,{emailId,recipients:['owned@example.test']},dependencies),/signed message identity/);
  assert.equal(reads,1);
 }finally{adminPool.query=original;}
});

test('a matching message passes the identity guard before the ordinary route lookup',async()=>{
 const emailId=randomUUID(),original=adminPool.query,routeLookup=new Error('Synthetic route lookup reached');let lookups=0;
 const dependencies:ResendDependencies={
  client:{emails:{receiving:{get:async()=>({data:{id:emailId,received_for:['owned@example.test'],from:'allowed@example.test',attachments:[]},error:null})}}} as unknown as Resend,
  download:async()=>{throw new Error('Unexpected download');},intake:async()=>{throw new Error('Unexpected intake');},
 };
 try{
  adminPool.query=(async(sql:string,values:unknown[])=>{
   assert.match(sql,/select r\.\*,p\.archived from email_routes/);assert.deepEqual(values,[['owned@example.test']]);lookups++;throw routeLookup;
  }) as typeof original;
  await assert.rejects(processResendEvent(`resend:${randomUUID()}`,{emailId,recipients:['owned@example.test']},dependencies),error=>error===routeLookup);
  assert.equal(lookups,1);
 }finally{adminPool.query=original;}
});
