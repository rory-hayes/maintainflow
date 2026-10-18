import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {MemoryRouter} from 'react-router-dom';

const hook=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const Usage=await import('../src/features/settings/Usage').then(module=>module.default).finally(()=>hook.deregister());
const empty={knownEstimatedCostUsd:0,recordedAttempts:0,pricedObservationAttempts:0,successfulFallbackAttempts:0,unknownObservationAttempts:0,unpricedObservationAttempts:0,unknownCostAttempts:0,legacySuccessfulResults:0,legacyEstimatedResults:0,legacyUnknownCostResults:0,legacyEstimatedCostUsd:0};
function render(coverage?:Record<string,unknown>){
 const storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage'),fetch=globalThis.fetch;
 let calls=0;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=> 'cost-coverage-fixture'}});
 globalThis.fetch=(async()=>{calls++;throw Error('Network forbidden in usage rendering fixture');}) as typeof fetch;
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 client.setQueryData(['cost-coverage-fixture','/api/workspace/usage'],{
  plan:{name:'Explore',monthlyPages:50,maxConcurrent:1,maxParsers:1},
  usage:{pages:3,events:3,documents:2,needsReview:2,processed:0,failed:0,costUsd:9,schemaSuggestions:1,schemaSuggestionCostUsd:0.03,...(coverage?{aiCostCoverage:coverage}:{})},ledger:[],billingRule:'Fixture page rule remains unchanged.',
 });
 try{
  const html=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,null,createElement(Usage))));
  assert.equal(calls,0);return html;
 }finally{client.clear();globalThis.fetch=fetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}
function coverage(values:Record<string,unknown>={}){
 return {...empty,period:'utc_month_to_date',completeness:'partial',byKind:[
  {...empty,kind:'extraction',knownEstimatedCostUsd:0.45},
  {...empty,kind:'schema_suggestion',knownEstimatedCostUsd:0.26},
  {...empty,kind:'split_suggestion',knownEstimatedCostUsd:0.47},
 ],...values};
}
test('Usage renders all three AI cost lanes with unknown and legacy coverage instead of a complete bill claim',()=>{
 const html=render(coverage({knownEstimatedCostUsd:1.18,recordedAttempts:5,unknownCostAttempts:1,unknownObservationAttempts:2,unpricedObservationAttempts:1,successfulFallbackAttempts:2,legacySuccessfulResults:4,legacyUnknownCostResults:1}));
 assert.match(html,/\$1\.1800/);assert.doesNotMatch(html,/\$9\.0000/);
 assert.match(html,/Extraction: \$0\.4500 · Field suggestions: \$0\.2600 · Split suggestions: \$0\.4700/);
 assert.match(html,/5 recorded AI attempts this month/);
 assert.match(html,/4 legacy successful results included · 1 without a known estimate/);
 assert.match(html,/Usage not reported: 2. Usage without a usable price: 1/);
 assert.match(html,/Saved-result fallback estimates: 2/);
 assert.match(html,/Historical failed attempts are unavailable/);
 assert.match(html,/not the provider’s bill/);
 assert.match(html,/new attempts use their start date; legacy results use their saved result date/);
 const visibleSummary=html.split('<details>')[0];
 assert.match(visibleSummary,/Unknown estimates: 1 recorded attempt and 1 legacy result/);
 assert.match(visibleSummary,/Extraction: \$0\.4500 · Field suggestions: \$0\.2600 · Split suggestions: \$0\.4700/);
 assert.match(html,/<details><summary>Estimate details<\/summary>/);
 assert.doesNotMatch(visibleSummary,/Usage not reported|Saved-result fallback|legacy successful results included/);
 assert.match(html,/aria-valuenow="3"/);assert.match(html,/Fixture page rule remains unchanged/);
});
test('zero known model estimates remain qualified when an attempt cost is unknown',()=>{
 const html=render(coverage({recordedAttempts:1,unknownCostAttempts:1,unknownObservationAttempts:1,byKind:[{...empty,kind:'extraction',recordedAttempts:1,unknownCostAttempts:1,unknownObservationAttempts:1},{...empty,kind:'schema_suggestion'},{...empty,kind:'split_suggestion'}]}));
 assert.match(html,/\$0\.0000/);assert.match(html,/Unknown estimates: 1 recorded attempt and 0 legacy results/);
 assert.match(html,/can exclude charges with unknown usage/);assert.doesNotMatch(html,/no AI cost|free AI|fully reconciled/i);
});
test('Usage keeps the qualified legacy display when an older API has no attempt coverage',()=>{
 const html=render();assert.match(html,/Estimated model cost/);assert.match(html,/\$9\.0000/);
 assert.match(html,/recorded successful extractions and field suggestions/);
 assert.match(html,/failed or canceled attempts may not be included/);assert.doesNotMatch(html,/AI cost coverage|recorded AI attempts/);
});
