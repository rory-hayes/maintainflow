import test from 'node:test';
import assert from 'node:assert/strict';
import {stripeConfiguration,assertStripeCustomerTestClock} from '../server/integrations/provider-policy.js';

const environment={STRIPE_MODE:'test',STRIPE_SECRET_KEY:'sk_test_controlled',STRIPE_WEBHOOK_SECRET:'whsec_controlled',STRIPE_PRICE_STANDARD:'price_standard',STRIPE_PRICE_TEAM:'price_team'};
const clock='clock_OwnedSandbox123';

test('sandbox clock configuration is optional, bounded and unavailable in live billing',()=>{
 for(const value of [undefined,''])assert.equal(Object.hasOwn(stripeConfiguration({...environment,STRIPE_TEST_CLOCK_ID:value}),'testClockId'),false);
 assert.equal(stripeConfiguration({...environment,STRIPE_TEST_CLOCK_ID:clock}).testClockId,clock);
 assert.equal(stripeConfiguration({...environment,STRIPE_TEST_CLOCK_ID:`clock_${'a'.repeat(194)}`}).testClockId?.length,200);
 for(const value of ['clock_','clock_with_underscore','clock_with-dash',' clock_123','clock_123 ','clock_123\n','clock_123/else','clock_123?x=1','clock_é',`clock_${'a'.repeat(195)}`]){
  assert.throws(()=>stripeConfiguration({...environment,STRIPE_TEST_CLOCK_ID:value}),/test clock/i);
 }
 assert.throws(()=>stripeConfiguration({...environment,STRIPE_MODE:'live',STRIPE_SECRET_KEY:'sk_live_controlled',STRIPE_ACCOUNT_ID:'acct_owned',STRIPE_PORTAL_CONFIGURATION_ID:'bpc_owned',STRIPE_TEST_CLOCK_ID:clock},'https://billing.example.test'),/test clock/i);
});

test('configured customer clocks must match an exact returned ID without fallback or rebinding',()=>{
 for(const value of [clock,{id:clock}])assert.doesNotThrow(()=>assertStripeCustomerTestClock({test_clock:value},clock));
 for(const value of [undefined,null,'clock_other','',{},[],[clock],{id:'clock_other'},{id:123},{clock}])assert.throws(()=>assertStripeCustomerTestClock({test_clock:value},clock),/test clock/i);
 // Unconfigured installations retain their previous behavior for existing customers.
 for(const value of [undefined,null,'clock_other',{id:'clock_other'}])assert.doesNotThrow(()=>assertStripeCustomerTestClock({test_clock:value}));
});
