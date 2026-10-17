import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {calculateEconomics,economicsInputSchema,requestCostUsd,type EconomicsInput} from '../scripts/unit-economics.js';
import {PLANS} from '../shared/plans.js';

const example=()=>JSON.parse(readFileSync(new URL('../docs/unit-economics.example.json',import.meta.url),'utf8')) as EconomicsInput;
const close=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
function isolated(){
 const c=example();
 c.scenarios=[c.scenarios[0]];
 Object.assign(c.financial.values,{eurPerUsd:1,providerInvoiceMultiplier:1,paymentFraction:0,paymentFixedEur:0,billingFraction:0,refundAndDisputeReserveFraction:0,salesTaxFraction:0,storageEurPerGiBMonth:0,egressEurPerGiB:0,emailEurPerMessage:0,supportEurPerHour:0});
 c.portfolio.values.fixedMonthlyEur={};c.portfolio.values.freeWorkspacesPerPayingWorkspace=0;
 Object.assign(c.scenarios[0].paid,{allowanceUtilization:1,aiShare:1,pagesPerJob:1,uncreditedAiJobsPerCreditedAiJob:0,attemptsPerExtraction:3,extractionTokens:{input:1000,cachedInput:0,output:100},suggestionUtilization:1,fieldSuggestionShare:0.4,attemptsPerSuggestion:1,fieldSuggestionTokens:{input:1000,cachedInput:0,output:100},splitSuggestionTokens:{input:2000,cachedInput:0,output:50},extractionOperatingEurPerAttempt:0,suggestionOperatingEurPerAttempt:0});
 return c;
}
const standard=(c:EconomicsInput)=>calculateEconomics(c).scenarios[0].plans.find(p=>p.planId==='standard')!;

test('economics uses current catalogue prices, pages and shared suggestion allowances',()=>{
 const result=calculateEconomics(example());
 for(const plan of PLANS){const row=result.scenarios[0].plans.find(p=>p.planId===plan.id)!;assert.equal(row.monthlyPriceEur,plan.monthlyPrice);assert.equal(row.monthlyPageAllowance,plan.monthlyPages);}
 assert.equal(result.scenarios[0].plans.find(p=>p.planId==='team')!.monthlySharedSuggestionAllowance,20);
 assert.equal(result.status,'planning_model_requires_operator_review');
 assert.equal(result.missingEvidence.length,8);
 assert.equal(result.scenarios[0].quota.headroom,null);
});

test('one million input/cache/output tokens price separately without double counting cached or reasoning tokens',()=>{
 const rates=example().rates;
 close(requestCostUsd({input:1e6,cachedInput:0,output:0},rates),0.75);
 close(requestCostUsd({input:1e6,cachedInput:1e6,output:0},rates),0.075);
 close(requestCostUsd({input:0,cachedInput:0,output:1e6},rates),4.5);
 close(requestCostUsd({input:1000,cachedInput:400,output:100},rates),0.00093);
});

test('hand-calculated all-attempt extraction plus both suggestion types preserves page credits',()=>{
 const row=standard(isolated());
 assert.equal(row.consumption.pages,300);
 assert.equal(row.consumption.extractionRequests,900);
 assert.equal(row.consumption.fieldRequests,2);
 assert.equal(row.consumption.splitRequests,3);
 close(row.consumption.aiUsd.extraction,1.08);
 close(row.consumption.aiUsd.fieldSuggestions,0.0024);
 close(row.consumption.aiUsd.splitSuggestions,0.005175);
 close(row.contributionEur,19-1.087575);
});

test('AI share, pages per job and explicit uncredited jobs do not multiply already credited pages',()=>{
 const c=isolated();Object.assign(c.scenarios[0].paid,{aiShare:0.5,pagesPerJob:2,attemptsPerExtraction:2,uncreditedAiJobsPerCreditedAiJob:0.2});
 const row=standard(c);assert.equal(row.consumption.creditedJobs,150);assert.equal(row.consumption.uncreditedAiJobs,15);assert.equal(row.consumption.extractionRequests,180);assert.equal(row.consumption.pages,300);
});

test('free-user cost remains negative for Explore and is allocated once per paid account',()=>{
 const c=example();c.portfolio.values.freeWorkspacesPerPayingWorkspace=0;
 const baseline=standard(c).contributionEur;
 c.portfolio.values.freeWorkspacesPerPayingWorkspace=2;
 const result=calculateEconomics(c),free=result.scenarios[0].plans.find(p=>p.planId==='explore')!,paid=result.scenarios[0].plans.find(p=>p.planId==='standard')!;
 assert.equal(free.paymentEur,0);assert.equal(free.contributionFraction,null);assert.ok(free.contributionEur<0);
 close(paid.freeSubsidyEur,-2*free.contributionEur);
 close(baseline-paid.contributionEur,paid.freeSubsidyEur);
});

test('FX, provider invoice uplift, card/Billing fees, reserves and gross-inclusive tax stay distinct',()=>{
 const c=isolated();Object.assign(c.financial.values,{eurPerUsd:0.9,providerInvoiceMultiplier:1.1,paymentFraction:0.015,billingFraction:0.007,paymentFixedEur:0.25,refundAndDisputeReserveFraction:0.01,salesTaxFraction:0.23});
 const row=standard(c);close(row.paymentEur,0.668);close(row.reserveEur,0.19);close(row.revenueExcludingSalesTaxEur,19/1.23);close(row.consumption.costsEur.ai,1.087575*0.9*1.1);
 close(row.contributionEur,19/1.23-0.668-0.19-1.087575*0.9*1.1);
});

test('steady-state originals/derivatives and download egress account for retention and additional jobs',()=>{
 const c=isolated();Object.assign(c.scenarios[0].paid,{sourceMiBPerOriginal:10,storedCopies:2,retentionMonths:12,downloadsPerOriginal:5,uncreditedAiJobsPerCreditedAiJob:0.1});
 const row=standard(c);close(row.consumption.storedGiB,330*10*2*12/1024);close(row.consumption.egressGiB,330*10*5/1024);
});

test('target headroom and homogeneous fixed-cost break-even follow explicit budget, not page revenue ratios',()=>{
 const c=isolated();c.portfolio.values.fixedMonthlyEur={hosting:100};c.portfolio.values.payingWorkspaces=10;
 const row=standard(c),preFixed=19-1.087575;
 close(row.contributionEur,preFixed-10);assert.equal(row.minimumPayingWorkspacesForFixedCosts,Math.ceil(100/preFixed));
 close(row.targetHeadroomEur,row.contributionEur-19*0.7);
 close(row.maxOwnAiUsdPerCreditedPageForTarget!,(19-10-19*0.7)/300);
 assert.equal(row.minimumPayingWorkspacesForTarget,Math.ceil(100/(preFixed-19*0.7)));
 assert.ok(row.maxOwnAiUsdPerCreditedPageForTarget!<0);
});

test('adverse all-attempt/output/storage/FX scenario shows loss without calling it a hard ceiling',()=>{
 const result=calculateEconomics(example());
 const stress=result.scenarios.find(s=>s.id==='retry_output_storage_fx_stress')!;
 assert.ok(stress.plans.filter(p=>p.monthlyPriceEur>0).every(p=>p.contributionEur<0));
 assert.equal(stress.financial.eurPerUsd,1.05);assert.equal(stress.financial.paymentFraction,0.0515);assert.equal(stress.basis,'assumed');assert.equal(stress.quota.headroom,null);
});

test('quota headroom may be negative and supplied evidence never authorizes launch or spend',()=>{
 const c=example();c.capacity={basis:'owner_verified_project_limit',source:'Synthetic test limits, not a real project',requestsPerMinute:20,inputTokensPerMinute:null,outputTokensPerMinute:null,totalTokensPerMinute:200000};
 for(const key of Object.keys(c.evidence) as (keyof typeof c.evidence)[])c.evidence[key]='Synthetic supplied reference';
 const result=calculateEconomics(c);assert.equal(result.missingEvidence.length,0);assert.equal(result.status,'planning_model_requires_operator_review');assert.equal(result.scenarios[0].quota.headroom!.requestsPerMinute,-10);assert.equal(result.scenarios[0].quota.headroom!.inputTokensPerMinute,null);assert.equal(result.scenarios[0].quota.headroom!.totalTokensPerMinute,-40000);
});

test('invalid costs, cached subsets, fractions, duplicate IDs and unknown fields fail closed',()=>{
 const invalid=[
  (c:EconomicsInput)=>{c.scenarios[0].paid.extractionTokens.cachedInput=7000;},
  (c:EconomicsInput)=>{c.financial.values.eurPerUsd=0;},
  (c:EconomicsInput)=>{c.scenarios[0].paid.aiShare=1.1;},
  (c:EconomicsInput)=>{c.scenarios[0].paid.attemptsPerExtraction=0;},
  (c:EconomicsInput)=>{c.scenarios[0].paid.pagesPerJob=0.5;},
  (c:EconomicsInput)=>{c.portfolio.values.payingWorkspaces=0;},
  (c:EconomicsInput)=>{c.financial.values.supportEurPerHour=-1;},
  (c:EconomicsInput)=>{c.scenarios[1].id=c.scenarios[0].id;},
  (c:EconomicsInput)=>{c.rates.inputUsdPerMillion=Infinity;},
  (c:EconomicsInput)=>{c.financial.source=' ';},
  (c:EconomicsInput)=>{Object.assign(c.scenarios[0].paid.extractionTokens,{reasoningTokens:100});},
 ];
 for(const change of invalid){const c=example();change(c);assert.equal(economicsInputSchema.safeParse(c).success,false);}
});

test('suggestions without page credits retain their independent all-attempt operating costs',()=>{
 const c=isolated();Object.assign(c.scenarios[0].paid,{allowanceUtilization:0,attemptsPerSuggestion:3,suggestionOperatingEurPerAttempt:0.02});
 const row=standard(c);assert.equal(row.consumption.pages,0);assert.equal(row.consumption.totalRequests,15);close(row.consumption.costsEur.suggestionOperations,0.3);assert.ok(row.consumption.aiUsd.total>0);assert.equal(row.maxOwnAiUsdPerCreditedPageForTarget,null);
});

test('reprocessing credits do not force new retained originals and extraction operations scale with attempts',()=>{
 const c=isolated();Object.assign(c.scenarios[0].paid,{newOriginalsPerCreditedJob:0.5,extractionOperatingEurPerAttempt:0.01});
 const row=standard(c);assert.equal(row.consumption.creditedJobs,300);assert.equal(row.consumption.newOriginals,150);close(row.consumption.costsEur.extractionOperations,9);
});

test('finite inputs that overflow arithmetic are rejected rather than serialized as unknown null costs',()=>{
 const c=example();c.scenarios[0].paid.sourceMiBPerOriginal=1e308;
 assert.equal(economicsInputSchema.safeParse(c).success,true);assert.throws(()=>calculateEconomics(c),/finite numeric bounds/);
});

test('zero fixed costs with contribution exactly at target has an already-covered mathematical threshold',()=>{
 const c=isolated();Object.assign(c.rates,{inputUsdPerMillion:0,cachedInputUsdPerMillion:0,outputUsdPerMillion:0});c.decision.values.targetContributionFraction=1;
 const row=standard(c);assert.equal(row.targetHeadroomEur,0);assert.equal(row.minimumPayingWorkspacesForTarget,0);
});
