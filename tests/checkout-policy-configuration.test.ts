import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {configuredCheckoutPolicy,checkoutPolicyConfigurationDigest,checkoutPolicyCatalogueMaxBytes,validateCheckoutPolicy,checkoutAgreementMessage,type CheckoutPolicyInput} from '../server/integrations/checkout-policy.js';

// Synthetic content only. No adopted policy, provider call, DB or environment file.
const policy:CheckoutPolicyInput={version:'synthetic-v1',language:'en-IE',title:'Synthetic terms',text:'SYNTHETIC TEST CONTENT\nLiteral second line.',url:'https://policies.example.test/terms/synthetic-v1',agreementText:'I accept these synthetic test terms.'};
function environment(policies:CheckoutPolicyInput[]=[policy],selected=policies[0]){
 return {FOLIO_CHECKOUT_POLICY_ENABLED:'true',FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON:JSON.stringify({policies}),FOLIO_CHECKOUT_POLICY_VERSION:selected.version,FOLIO_CHECKOUT_POLICY_SHA256:checkoutPolicyConfigurationDigest(selected)};
}
function unavailable(input:Record<string,string|undefined>){
 assert.throws(()=>configuredCheckoutPolicy(input),(error:any)=>error.statusCode===503&&error.message==='Checkout terms configuration is unavailable.');
}

test('capture defaults off, explicit false permits staging, and an omitted/invalid enable flag cannot silently bypass a supplied catalogue',()=>{
 assert.equal(configuredCheckoutPolicy({}),null);
 assert.equal(configuredCheckoutPolicy({FOLIO_CHECKOUT_POLICY_ENABLED:'false'}),null);
 assert.equal(configuredCheckoutPolicy({...environment(),FOLIO_CHECKOUT_POLICY_ENABLED:'false',FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON:'unparsed staged value'}),null);
 for(const flag of [undefined,'','TRUE',' true','true ','1'])unavailable({...environment(),FOLIO_CHECKOUT_POLICY_ENABLED:flag});
 for(const key of ['FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON','FOLIO_CHECKOUT_POLICY_VERSION','FOLIO_CHECKOUT_POLICY_SHA256'])unavailable({[key]:'present'});
});

test('explicit complete configuration selects exact version without changing content, origin or legacy contract digest',()=>{
 const later={...policy,version:'synthetic-v2',text:'A second synthetic version.',url:'https://policies.example.test/terms/synthetic-v2'};
 const selected=configuredCheckoutPolicy({...environment([policy,later],later),APP_ORIGIN:'https://separate-qa.example.test'})!;
 assert.deepEqual(selected,later);assert.deepEqual(Object.keys(selected).sort(),Object.keys(later).sort());
 assert.equal(validateCheckoutPolicy(selected).sha256,createHash('sha256').update(later.text,'utf8').digest('hex'),'Existing receipt text-only digest is unchanged');
 assert.equal(checkoutAgreementMessage(selected),`I accept these synthetic test terms\\. [Synthetic terms](${later.url})`);
 selected.text='Mutating a returned object cannot change subsequent reads';assert.deepEqual(configuredCheckoutPolicy(environment([policy,later],later)),later);
});

test('whole-policy configuration digest pins all six displayed fields and preserves literal bytes and property-order independence',()=>{
 const canonical=JSON.stringify({version:policy.version,language:policy.language,title:policy.title,text:policy.text,url:policy.url,agreementText:policy.agreementText});
 assert.equal(checkoutPolicyConfigurationDigest(policy),createHash('sha256').update(canonical).digest('hex'));
 const reversed=Object.fromEntries(Object.entries(policy).reverse()) as CheckoutPolicyInput;
 assert.equal(checkoutPolicyConfigurationDigest(reversed),checkoutPolicyConfigurationDigest(policy));
 assert.deepEqual(configuredCheckoutPolicy({...environment(),FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON:'\n '+JSON.stringify({policies:[reversed]},null,2)+'\n'}),policy);
 for(const key of Object.keys(policy) as (keyof CheckoutPolicyInput)[]){
  const changed={...policy,[key]:policy[key]+(key==='language'?'-test':key==='url'?'?revision=2':' ')};
  const input=environment([changed]);input.FOLIO_CHECKOUT_POLICY_SHA256=checkoutPolicyConfigurationDigest(policy);unavailable(input);
  assert.deepEqual(configuredCheckoutPolicy(environment([changed])),changed);
 }
 const legacyTextDigest=createHash('sha256').update(policy.text).digest('hex');
 unavailable({...environment(),FOLIO_CHECKOUT_POLICY_SHA256:legacyTextDigest});
});

test('enabled but incomplete or mismatched selections fail with fixed503 instead of legacy Checkout',()=>{
 for(const key of Object.keys(environment()).filter(key=>key!=='FOLIO_CHECKOUT_POLICY_ENABLED')){
  for(const value of [undefined,''])unavailable({...environment(),[key]:value});
 }
 for(const value of ['missing','synthetic-v1 ','Synthetic-v1'])unavailable({...environment(),FOLIO_CHECKOUT_POLICY_VERSION:value});
 for(const value of ['a'.repeat(64),'x'.repeat(64),'A'.repeat(64),'a'.repeat(63),checkoutPolicyConfigurationDigest(policy)+'\n'])unavailable({...environment(),FOLIO_CHECKOUT_POLICY_SHA256:value});
});

test('catalogue shape, duplicate versions, unsafe text/links and non-selected invalid policies cannot pass a valid selection',()=>{
 const invalidCatalogues:unknown[]=[null,[],{},policy,{policies:[]},{policies:[policy],unknown:true},{policies:[policy,policy]},{policies:[policy,{...policy,version:'synthetic-v2',url:'javascript:private-value'}]}];
 for(const value of invalidCatalogues)unavailable({...environment(),FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON:JSON.stringify(value)});
 const invalidPolicies=[{unknown:'field'},{text:''},{text:'   '},{title:'\t'},{agreementText:'\n'},{text:'bad\u0000value'},{text:'bad\ud800value'},{text:'bad\udc00value'},{url:'http://example.test/terms'},{url:'https://user:private-value@example.test/terms'},{url:'https://example.test/terms#fragment'},{language:'bad language'},{version:'synthetic\nversion'}];
 for(const patch of invalidPolicies){const invalid={...policy,...patch};unavailable(environment([invalid]));}
 unavailable({...environment(),FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON:'{private invalid JSON'});
});

test('bounded catalogue and final Stripe agreement message reject oversized input before enabling capture',()=>{
 unavailable({...environment(),FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON:' '.repeat(checkoutPolicyCatalogueMaxBytes+1)});
 unavailable(environment(Array.from({length:11},(_,i)=>({...policy,version:`synthetic-${i}`}))));
 unavailable(environment([{...policy,text:'x'.repeat(16001)}]));
 unavailable(environment([{...policy,agreementText:'x'.repeat(1000),url:`https://policies.example.test/${'x'.repeat(500)}`} ]));
 const punctuation={...policy,title:'Terms [link](other)',url:'https://policies.example.test/version(1)',agreementText:'Read *synthetic* terms.'};
 assert.ok(checkoutAgreementMessage(configuredCheckoutPolicy(environment([punctuation]))!).endsWith('(https://policies.example.test/version%281%29)'));
});
