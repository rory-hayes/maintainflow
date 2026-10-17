import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../server/app.js';
import {closeDatabase} from '../server/core/db.js';

const fixture={FOLIO_PREVIEW_MODE:'true',FOLIO_PREVIEW_STRIPE_TEST:'true',FOLIO_BILLING_MOCK:'false',FOLIO_PREVIEW_INVITE_CODE:'owned-runtime-preview-invite-'.repeat(2),STRIPE_MODE:'test',APP_ORIGIN:'https://private-billing.example.test',STRIPE_SECRET_KEY:'sk_test_runtime_owned_fixture',STRIPE_ACCOUNT_ID:'acct_RuntimeFixture',STRIPE_PRICE_STANDARD:'price_runtime_standard',STRIPE_PRICE_TEAM:'price_runtime_team',STRIPE_PORTAL_CONFIGURATION_ID:'bpc_RuntimeFixture',STRIPE_WEBHOOK_SECRET:'whsec_runtime_owned_fixture'};
const original=Object.fromEntries(Object.keys(fixture).map(key=>[key,process.env[key]]));
after(async()=>{for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await closeDatabase();});

test('the full app exposes only derived preview billing metadata and keeps private health and invitation flags',async()=>{
  for(const mode of ['mock','stripe_test'] as const){
    Object.assign(process.env,fixture,{FOLIO_PREVIEW_STRIPE_TEST:mode==='stripe_test'?'true':'false',FOLIO_BILLING_MOCK:mode==='mock'?'true':'false'});
    const app=await buildApp();
    try{
      const response=await app.inject({method:'GET',url:'/api/config'});
      assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'private, no-store');
      const configuration=response.json();
      assert.equal(configuration.preview,true);assert.equal(configuration.inviteRequired,true);assert.equal(configuration.previewBillingMode,mode);
      for(const key of ['FOLIO_PREVIEW_INVITE_CODE','STRIPE_SECRET_KEY','STRIPE_ACCOUNT_ID','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','STRIPE_PORTAL_CONFIGURATION_ID','STRIPE_WEBHOOK_SECRET'] as const)assert.equal(response.body.includes(fixture[key]),false,key);
      const health=await app.inject({method:'GET',url:'/api/health'});
      assert.equal(health.statusCode,200);assert.equal(health.json().environment,'preview');
    }finally{await app.close();}
  }
});

test('the full app refuses invalid private TEST configuration before registering routes',async()=>{
  for(const patch of [{STRIPE_PORTAL_CONFIGURATION_ID:''},{FOLIO_PREVIEW_MODE:'false'},{STRIPE_MODE:'live'},{FOLIO_PREVIEW_STRIPE_TEST:'yes'}]){
    Object.assign(process.env,fixture,patch);
    await assert.rejects(buildApp(),/Preview/);
  }
});
