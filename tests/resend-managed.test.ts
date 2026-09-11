import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Resend} from 'resend';
import {closeDatabase} from '../server/core/db.js';
import {receivingStatus} from '../server/integrations/providers.js';
import {managedReceivingProbe,verifiedManagedReceivingProbe} from '../server/integrations/provider-policy.js';

const domain='controlled-fixture.resend.app';
function fixture(){
 const environment:Record<string,string|undefined>={RESEND_RECEIVING_MODE:'managed',RESEND_API_KEY:'re_controlled_fixture',RESEND_WEBHOOK_SECRET:'whsec_controlled_fixture',RESEND_INBOUND_ENABLED:'true',RESEND_INBOUND_DOMAIN:domain,RESEND_MANAGED_PROBE_EMAIL_ID:randomUUID(),RESEND_MANAGED_PROBE_RECIPIENT:`folio-probe-${randomBytes(16).toString('hex')}@${domain}`,RESEND_MANAGED_PROBE_NONCE:randomBytes(24).toString('hex')};
 const probe=managedReceivingProbe(environment)!;
 const email={object:'email',id:probe.emailId,received_for:[probe.recipient],subject:`Folio receiving probe ${probe.nonce}`,text:`Folio receiving probe ${probe.nonce}\r\n`,to:['untrusted@example.test']};
 const calls:{kind:string;id:string;options?:unknown}[]=[];
 let response:unknown=email;
 const client={emails:{receiving:{get:async(id:string,options:unknown)=>{calls.push({kind:'email',id,options});return {data:response,error:null};}}},domains:{get:async(id:string)=>{calls.push({kind:'domain',id});return {data:response,error:null};}}} as unknown as Pick<Resend,'domains'|'emails'>;
 return {environment,probe,email,client,calls,setResponse:(next:unknown)=>{response=next;}};
}
after(closeDatabase);

test('managed probe configuration accepts only a complete dedicated one-label Resend inbox challenge',()=>{
 const {environment}=fixture();assert.ok(managedReceivingProbe(environment));
 for(const badDomain of ['resend.app','a.b.resend.app','a.resend.app.attacker.test','-bad.resend.app','bad-.resend.app','https://fixture.resend.app','fixture.resend.app:443','fixture_resend.resend.app','a'.repeat(64)+'.resend.app']){
  assert.equal(managedReceivingProbe({...environment,RESEND_INBOUND_DOMAIN:badDomain,RESEND_MANAGED_PROBE_RECIPIENT:`folio-probe-${'a'.repeat(32)}@${badDomain}`}),null,badDomain);
 }
 for(const key of ['RESEND_INBOUND_DOMAIN','RESEND_MANAGED_PROBE_EMAIL_ID','RESEND_MANAGED_PROBE_RECIPIENT','RESEND_MANAGED_PROBE_NONCE'])assert.equal(managedReceivingProbe({...environment,[key]:undefined}),null,key);
 for(const override of [{RESEND_MANAGED_PROBE_EMAIL_ID:'sent_123'},{RESEND_MANAGED_PROBE_RECIPIENT:`anything@${domain}`},{RESEND_MANAGED_PROBE_RECIPIENT:`folio-probe-${'a'.repeat(32)}@other.resend.app`},{RESEND_MANAGED_PROBE_NONCE:'short'},{RESEND_MANAGED_PROBE_NONCE:'g'.repeat(32)}])assert.equal(managedReceivingProbe({...environment,...override}),null);
});

test('a managed inbox probe must match ID, exact recipient, subject and plain-text nonce together',()=>{
 const {probe,email}=fixture();assert.equal(verifiedManagedReceivingProbe(email,probe),true);
 for(const change of [{id:randomUUID()},{received_for:[]},{received_for:['other@controlled-fixture.resend.app']},{received_for:[probe.recipient,'another@example.test']},{subject:'Folio receiving probe wrong'},{subject:`Re: ${email.subject}`},{text:'Different body'},{text:null,html:`<p>${email.text}</p>`},{text:email.text+'unexpected payload'},{object:'sent-email'}])assert.equal(verifiedManagedReceivingProbe({...email,...change},probe),false,JSON.stringify(change));
 for(const malformed of [null,{},'invalid',{...email,received_for:null}])assert.equal(verifiedManagedReceivingProbe(malformed,probe),false);
 assert.equal(verifiedManagedReceivingProbe({...email,received_for:[],to:[probe.recipient]},probe),false,'To cannot replace received_for');
});

test('managed status retrieves its exact probe without a custom domain ID or MX lookup',async()=>{
 const f=fixture(),status=await receivingStatus(true,f);
 assert.equal(status.configured,true);assert.equal(status.verified,true);assert.equal(status.mode,'managed');assert.equal(status.verification,'managed-probe');assert.equal(status.deliveryVerified,false);assert.equal(status.providerDomainId,`managed:${domain}`);
 assert.match(status.reason!,/probe is verified/);assert.doesNotMatch(status.reason!,/MX/);
 assert.deepEqual(f.calls,[{kind:'email',id:f.probe.emailId,options:{html_format:'cid'}}]);
});

test('managed status requires explicit enablement, complete credentials, valid proof settings and a valid mode before lookup',async()=>{
 const f=fixture();
 for(const override of [{RESEND_INBOUND_ENABLED:'false'},{RESEND_API_KEY:undefined},{RESEND_WEBHOOK_SECRET:undefined},{RESEND_MANAGED_PROBE_EMAIL_ID:undefined},{RESEND_INBOUND_DOMAIN:'example.com'},{RESEND_RECEIVING_MODE:'typo'}]){
  const status=await receivingStatus(true,{...f,environment:{...f.environment,...override}});assert.equal(status.configured,false);assert.equal(status.verified,false);
 }
 assert.equal(f.calls.length,0);
 // Omitting managed mode keeps the existing custom-domain requirements.
 assert.equal((await receivingStatus(true,{...f,environment:{...f.environment,RESEND_RECEIVING_MODE:undefined}})).mode,'custom');assert.equal(f.calls.length,0);
});

test('a changed probe or API credential cannot inherit a cached successful managed verification',async()=>{
 const f=fixture();assert.equal((await receivingStatus(true,f)).verified,true);
 assert.equal((await receivingStatus(false,f)).verified,true);assert.equal(f.calls.length,1);
 f.environment.RESEND_MANAGED_PROBE_NONCE=randomBytes(24).toString('hex');
 assert.equal((await receivingStatus(false,f)).verified,false);assert.equal(f.calls.length,2);
 f.environment.RESEND_MANAGED_PROBE_NONCE=f.probe.nonce;
 f.environment.RESEND_API_KEY='re_rotated_controlled_fixture';f.setResponse(null);
 assert.equal((await receivingStatus(false,f)).verified,false);assert.equal(f.calls.length,3);
});

test('managed lookup failures stay blocked and never expose provider error details',async()=>{
 const f=fixture();
 assert.equal((await receivingStatus(true,f)).verified,true);
 f.setResponse(null);assert.equal((await receivingStatus(true,f)).verified,false);
 assert.equal((await receivingStatus(false,f)).verified,false,'A failed forced check must invalidate a prior successful cache');
 f.setResponse({...f.email,id:randomUUID()});assert.equal((await receivingStatus(true,f)).verified,false);
 f.setResponse(null);assert.equal((await receivingStatus(true,f)).verified,false);
 const client={...f.client,emails:{receiving:{get:async()=>{throw new Error('sensitive provider response');}}}} as unknown as Pick<Resend,'domains'|'emails'>;
 const failed=await receivingStatus(true,{...f,client});assert.equal(failed.configured,true);assert.equal(failed.verified,false);assert.doesNotMatch(failed.reason!,/sensitive/);
});

test('custom receiving still uses the exact domain ID, enabled receiving and verified MX',async()=>{
 const f=fixture();f.environment.RESEND_RECEIVING_MODE='custom';f.environment.RESEND_INBOUND_DOMAIN='in.example.test';f.environment.RESEND_DOMAIN_ID=randomUUID();
 const domainResponse={name:'in.example.test',capabilities:{receiving:'enabled'},records:[{record:'Receiving',type:'MX',status:'verified'}]};f.setResponse(domainResponse);
 const status=await receivingStatus(true,f);assert.equal(status.verified,true);assert.equal(status.verification,'custom-mx');assert.equal(status.providerDomainId,f.environment.RESEND_DOMAIN_ID);assert.deepEqual(f.calls,[{kind:'domain',id:f.environment.RESEND_DOMAIN_ID}]);
 f.setResponse({...domainResponse,records:[]});assert.equal((await receivingStatus(true,f)).verified,false);
 f.setResponse({...domainResponse,capabilities:{receiving:'disabled'}});assert.equal((await receivingStatus(true,f)).verified,false);
});
