import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import {stripeCustomerPointer,verifyStripePayload,type StripeMode} from '../server/integrations/provider-policy.js';

const secret='whsec_owned_event_routing_fixture';
function signed(type:string,{live=false,customer='cus_owned',account}:{live?:boolean;customer?:unknown;account?:string}={}) {
 const raw=Buffer.from(JSON.stringify({id:'evt_owned',type,created:123,livemode:live,...(account?{account}:{}),data:{object:{customer,metadata:{folio_workspace:'untrusted',plan:'team'},status:'untrusted'}}}));
 return {raw,signature:Stripe.webhooks.generateTestHeaderString({payload:raw.toString(),secret})};
}
function pointer(type:string,options:Parameters<typeof signed>[1]={},mode:StripeMode='test') {
 const {raw,signature}=signed(type,options);
 return stripeCustomerPointer(verifyStripePayload(raw,signature,secret,mode));
}

test('dedicated paused and resumed notifications reach entitlement reconciliation as bounded customer pointers',()=>{
 for(const type of ['customer.subscription.paused','customer.subscription.resumed']) {
  assert.deepEqual(pointer(type),{id:'evt_owned',type,created:123,customerId:'cus_owned',mode:'test'});
  assert.deepEqual(pointer(type,{live:true,customer:{id:'cus_owned',metadata:{plan:'team'}}},'live'),{id:'evt_owned',type,created:123,customerId:'cus_owned',mode:'live'});
 }
});

test('existing subscription, checkout and invoice notifications retain customer-only routing',()=>{
 for(const type of ['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed','invoice.payment_action_required']) {
  assert.equal(pointer(type)?.customerId,'cus_owned');
 }
 for(const type of ['customer.created','invoice.created','payment_intent.succeeded'])assert.equal(pointer(type),null);
 for(const customer of [null,'',{}])assert.equal(pointer('customer.subscription.paused',{customer}),null);
});

test('pause and resume routing retains signature, billing-mode and connected-account rejection',()=>{
 for(const type of ['customer.subscription.paused','customer.subscription.resumed']) {
  assert.throws(()=>pointer(type,{live:true}),/mode/);
  assert.throws(()=>pointer(type,{account:'acct_untrusted'}),/Connected-account/);
  const {raw,signature}=signed(type);
  assert.throws(()=>verifyStripePayload(Buffer.from(raw.toString().replace('cus_owned','cus_changed')),signature,secret),/signature/i);
 }
});
