import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptsPreviewInvite,previewConfigured,validatePreviewConfiguration} from '../server/core/preview.js';

const configured={NODE_ENV:'production',FOLIO_PREVIEW_MODE:'true',FOLIO_BILLING_MOCK:'true',FOLIO_PREVIEW_INVITE_CODE:'owned-preview-fixture-'.repeat(3)};
const stripeTest={...configured,FOLIO_PREVIEW_STRIPE_TEST:'true',FOLIO_BILLING_MOCK:'false',STRIPE_MODE:'test',APP_ORIGIN:'https://private-billing.example.test',STRIPE_SECRET_KEY:'sk_test_owned_fixture',STRIPE_ACCOUNT_ID:'acct_OwnedFixture',STRIPE_PRICE_STANDARD:'price_owned_standard',STRIPE_PRICE_TEAM:'price_owned_team',STRIPE_PORTAL_CONFIGURATION_ID:'bpc_OwnedFixture',STRIPE_WEBHOOK_SECRET:'whsec_owned_fixture'};

test('hosted preview requires an explicit mock-only configuration and a private invite',()=>{
  assert.equal(previewConfigured(configured),true);
  assert.doesNotThrow(()=>validatePreviewConfiguration(configured));
  assert.equal(acceptsPreviewInvite(configured.FOLIO_PREVIEW_INVITE_CODE,configured),true);
  for(const value of [undefined,'',configured.FOLIO_PREVIEW_INVITE_CODE+'x',42,'a'.repeat(257)])assert.equal(acceptsPreviewInvite(value,configured),false);
  for(const override of [{FOLIO_BILLING_MOCK:'false'},{FOLIO_PREVIEW_INVITE_CODE:''}]){
    const invalid={...configured,...override};
    assert.throws(()=>validatePreviewConfiguration(invalid),/Preview mode requires/);
    assert.equal(acceptsPreviewInvite(configured.FOLIO_PREVIEW_INVITE_CODE,invalid),false);
  }
  assert.equal(acceptsPreviewInvite(undefined,{}),true);
});

test('explicit private Stripe TEST configuration preserves the invitation gate',()=>{
  assert.equal(previewConfigured(stripeTest),true);
  assert.doesNotThrow(()=>validatePreviewConfiguration(stripeTest));
  assert.equal(acceptsPreviewInvite(stripeTest.FOLIO_PREVIEW_INVITE_CODE,stripeTest),true);
  for(const value of [undefined,'',stripeTest.FOLIO_PREVIEW_INVITE_CODE+'x',42,'a'.repeat(257)])assert.equal(acceptsPreviewInvite(value,stripeTest),false);
});

test('private Stripe TEST refuses incomplete or contradictory bindings without using implicit mode defaults',()=>{
  const changes:NodeJS.ProcessEnv[]=[
    {FOLIO_PREVIEW_STRIPE_TEST:undefined},{FOLIO_PREVIEW_STRIPE_TEST:'false'},{FOLIO_PREVIEW_STRIPE_TEST:'yes'},
    {FOLIO_PREVIEW_MODE:'false'},{FOLIO_BILLING_MOCK:'true'},{FOLIO_BILLING_MOCK:undefined},
    {FOLIO_PREVIEW_INVITE_CODE:'short'},{STRIPE_MODE:undefined},{STRIPE_MODE:'live'},{STRIPE_MODE:'sandbox'},
    {STRIPE_SECRET_KEY:undefined},{STRIPE_SECRET_KEY:'sk_live_owned_fixture'},
    {STRIPE_ACCOUNT_ID:undefined},{STRIPE_ACCOUNT_ID:'other'},
    {STRIPE_PRICE_STANDARD:undefined},{STRIPE_PRICE_TEAM:undefined},{STRIPE_PRICE_TEAM:stripeTest.STRIPE_PRICE_STANDARD},{STRIPE_PRICE_TEAM:'not_a_price'},
    {STRIPE_PORTAL_CONFIGURATION_ID:undefined},{STRIPE_PORTAL_CONFIGURATION_ID:'other'},
    {STRIPE_WEBHOOK_SECRET:undefined},{STRIPE_WEBHOOK_SECRET:'whsec_'},{STRIPE_WEBHOOK_SECRET:'other'},
    {STRIPE_TEST_CLOCK_ID:'clock_has_underscores'},
  ];
  for(const change of changes){
    const invalid={...stripeTest,...change};
    assert.throws(()=>validatePreviewConfiguration(invalid),/Preview/,JSON.stringify(Object.keys(change)));
    assert.equal(previewConfigured(invalid),false);
    assert.equal(acceptsPreviewInvite(stripeTest.FOLIO_PREVIEW_INVITE_CODE,invalid),false);
  }
  for(const origin of [undefined,'','not a URL','http://billing.example.test','https://localhost','https://127.0.0.1','https://[::1]','https://user:pass@billing.example.test','https://billing.example.test/path','https://billing.example.test?query=1','https://billing.example.test#fragment']){
    const invalid={...stripeTest,APP_ORIGIN:origin};
    assert.throws(()=>validatePreviewConfiguration(invalid),/Preview/);
    assert.equal(acceptsPreviewInvite(stripeTest.FOLIO_PREVIEW_INVITE_CODE,invalid),false);
  }
  assert.doesNotThrow(()=>validatePreviewConfiguration({...stripeTest,STRIPE_TEST_CLOCK_ID:'clock_OwnedFixture'}));
});

test('the new opt-in is never inferred from credentials and malformed flags fail closed',()=>{
  for(const flag of [undefined,'false']){
    assert.doesNotThrow(()=>validatePreviewConfiguration({...configured,FOLIO_PREVIEW_STRIPE_TEST:flag}));
    assert.equal(previewConfigured({...configured,FOLIO_PREVIEW_STRIPE_TEST:flag}),true);
    assert.doesNotThrow(()=>validatePreviewConfiguration({FOLIO_PREVIEW_STRIPE_TEST:flag}));
    assert.equal(acceptsPreviewInvite(undefined,{FOLIO_PREVIEW_STRIPE_TEST:flag}),true);
  }
  for(const flag of ['true','','yes','TRUE']){
    assert.throws(()=>validatePreviewConfiguration({FOLIO_PREVIEW_STRIPE_TEST:flag}),/Preview/);
    assert.equal(acceptsPreviewInvite(undefined,{FOLIO_PREVIEW_STRIPE_TEST:flag}),false);
  }
});
