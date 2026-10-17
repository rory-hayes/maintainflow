/** Offline planning model. No environment, database or provider access. Not a billing ledger. */
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {PLANS} from '../shared/plans.js';
import {monthlyAiSuggestionLimit} from '../shared/ai-suggestion-allowances.js';

const nonnegative=z.number().finite().nonnegative();
const positive=z.number().finite().positive();
const fraction=nonnegative.max(1);
const source=z.string().trim().min(1);
const assumptions=<T extends z.ZodType>(values:T)=>z.object({basis:z.enum(['assumed','measured']),source,values}).strict();
const tokens=z.object({input:nonnegative,cachedInput:nonnegative,output:nonnegative}).strict()
 .refine(v=>v.cachedInput<=v.input,{message:'Cached input is a subset of input tokens'});
const financialValues=z.object({
 eurPerUsd:positive,providerInvoiceMultiplier:positive,
 paymentFraction:fraction,paymentFixedEur:nonnegative,billingFraction:fraction,
 refundAndDisputeReserveFraction:fraction,salesTaxFraction:fraction,
 storageEurPerGiBMonth:nonnegative,egressEurPerGiB:nonnegative,emailEurPerMessage:nonnegative,
 supportEurPerHour:nonnegative,
}).strict();
const workload=z.object({
 allowanceUtilization:fraction,aiShare:fraction,pagesPerJob:positive.min(1).max(30),
 // Manual reprocessing already consumes credits. This is ONLY additional jobs not represented by page credits.
 uncreditedAiJobsPerCreditedAiJob:nonnegative,attemptsPerExtraction:positive.min(1),
 extractionTokens:tokens,suggestionUtilization:fraction,fieldSuggestionShare:fraction,
 attemptsPerSuggestion:positive.min(1),fieldSuggestionTokens:tokens,splitSuggestionTokens:tokens,
 sourceMiBPerOriginal:nonnegative,newOriginalsPerCreditedJob:fraction,newOriginalsPerUncreditedAiJob:fraction,
 storedCopies:positive,retentionMonths:positive,downloadsPerOriginal:nonnegative,
 emailsPerWorkspace:nonnegative,emailsPerJob:nonnegative,supportMinutes:nonnegative,
 extractionOperatingEurPerAttempt:nonnegative,suggestionOperatingEurPerAttempt:nonnegative,
}).strict();

export const economicsInputSchema=z.object({
 version:z.literal(1),
 rates:z.object({basis:z.literal('official_public_rate'),source,verifiedOn:source,model:source,
  inputUsdPerMillion:nonnegative,cachedInputUsdPerMillion:nonnegative,outputUsdPerMillion:nonnegative,
 }).strict(),
 financial:assumptions(financialValues),
 portfolio:assumptions(z.object({
  payingWorkspaces:z.number().int().positive(),freeWorkspacesPerPayingWorkspace:nonnegative,
  fixedMonthlyEur:z.record(z.string(),nonnegative),
 }).strict()),
 decision:assumptions(z.object({targetContributionFraction:fraction}).strict()),
 scenarios:z.array(z.object({id:source,label:source,basis:z.enum(['assumed','measured']),source,
  paid:workload,free:workload,
  // Burst estimates must cover *all* simultaneous tenants and all AI lanes, not one account.
  peakRequestsPerMinute:nonnegative,peakInputTokensPerMinute:nonnegative,peakOutputTokensPerMinute:nonnegative,
  financialOverrides:financialValues.partial().optional(),
 }).strict()).min(1).max(20).refine(a=>new Set(a.map(s=>s.id)).size===a.length,{message:'Scenario IDs must be unique'}),
 capacity:z.object({basis:z.literal('owner_verified_project_limit'),source,
  requestsPerMinute:positive.nullable(),inputTokensPerMinute:positive.nullable(),outputTokensPerMinute:positive.nullable(),
  totalTokensPerMinute:positive.nullable(),
 }).strict().refine(v=>[v.requestsPerMinute,v.inputTokensPerMinute,v.outputTokensPerMinute,v.totalTokensPerMinute].some(n=>n!==null),{message:'Supply at least one identified project limit'}).nullable(),
 // These are evidence references supplied by the operator; the tool cannot verify their contents.
 evidence:z.object({providerProject:source.nullable(),utcBillingWindow:source.nullable(),
  reconciledAllAttemptBill:source.nullable(),netReceiptsAndFx:source.nullable(),
  measuredWorkload:source.nullable(),operatingCosts:source.nullable(),
  adoptedOfferReserveBudget:source.nullable(),sustainedHostedCapacity:source.nullable(),
 }).strict(),
}).strict();
export type EconomicsInput=z.infer<typeof economicsInputSchema>;
type Tokens=z.infer<typeof tokens>;
type Workload=z.infer<typeof workload>;
type FinancialValues=z.infer<typeof financialValues>;

export function requestCostUsd(t:Tokens,r:EconomicsInput['rates']):number{
 // Output already includes reasoning. Input already includes cached input.
 return ((t.input-t.cachedInput)*r.inputUsdPerMillion+t.cachedInput*r.cachedInputUsdPerMillion+t.output*r.outputUsdPerMillion)/1e6;
}

function consumption(plan:typeof PLANS[number],w:Workload,c:EconomicsInput,f:FinancialValues){
 const pages=plan.monthlyPages*w.allowanceUtilization;
 const creditedJobs=pages/w.pagesPerJob;
 const creditedAiJobs=creditedJobs*w.aiShare;
 const uncreditedAiJobs=creditedAiJobs*w.uncreditedAiJobsPerCreditedAiJob;
 const extractionRequests=(creditedAiJobs+uncreditedAiJobs)*w.attemptsPerExtraction;
 const suggestions=monthlyAiSuggestionLimit(plan.id)*w.suggestionUtilization;
 const fieldRequests=suggestions*w.fieldSuggestionShare*w.attemptsPerSuggestion;
 const splitRequests=suggestions*(1-w.fieldSuggestionShare)*w.attemptsPerSuggestion;
 const extractionUsd=extractionRequests*requestCostUsd(w.extractionTokens,c.rates);
 const fieldUsd=fieldRequests*requestCostUsd(w.fieldSuggestionTokens,c.rates);
 const splitUsd=splitRequests*requestCostUsd(w.splitSuggestionTokens,c.rates);
 const allJobs=creditedJobs+uncreditedAiJobs;
 const newOriginals=creditedJobs*w.newOriginalsPerCreditedJob+uncreditedAiJobs*w.newOriginalsPerUncreditedAiJob;
 // Steady-state originals/derivatives. Reprocessing/duplicate reuse is explicit in the new-original ratios.
 const storedGiB=newOriginals*w.sourceMiBPerOriginal*w.storedCopies*w.retentionMonths/1024;
 const egressGiB=newOriginals*w.sourceMiBPerOriginal*w.downloadsPerOriginal/1024;
 const costs={
  ai:(extractionUsd+fieldUsd+splitUsd)*f.eurPerUsd*f.providerInvoiceMultiplier,
  storage:storedGiB*f.storageEurPerGiBMonth,egress:egressGiB*f.egressEurPerGiB,
  email:(w.emailsPerWorkspace+allJobs*w.emailsPerJob)*f.emailEurPerMessage,
  support:w.supportMinutes/60*f.supportEurPerHour,
  extractionOperations:(creditedJobs*(1-w.aiShare)+extractionRequests)*w.extractionOperatingEurPerAttempt,
  // Includes suggestion source staging/read/render/egress costs even without credited extraction pages.
  suggestionOperations:(fieldRequests+splitRequests)*w.suggestionOperatingEurPerAttempt,
 };
 return {pages,creditedJobs,uncreditedAiJobs,extractionRequests,fieldRequests,splitRequests,
  totalRequests:extractionRequests+fieldRequests+splitRequests,
  inputTokens:extractionRequests*w.extractionTokens.input+fieldRequests*w.fieldSuggestionTokens.input+splitRequests*w.splitSuggestionTokens.input,
  outputTokens:extractionRequests*w.extractionTokens.output+fieldRequests*w.fieldSuggestionTokens.output+splitRequests*w.splitSuggestionTokens.output,
  aiUsd:{extraction:extractionUsd,fieldSuggestions:fieldUsd,splitSuggestions:splitUsd,total:extractionUsd+fieldUsd+splitUsd},
  newOriginals,storedGiB,egressGiB,costsEur:costs,totalVariableCostEur:Object.values(costs).reduce((a,b)=>a+b,0),
 };
}

export function calculateEconomics(raw:unknown){
 const c=economicsInputSchema.parse(raw);
 const p=c.portfolio.values;
 const fixedMonthlyEur=Object.values(p.fixedMonthlyEur).reduce((a,b)=>a+b,0);
 const fixedEurPerPayingWorkspace=fixedMonthlyEur/p.payingWorkspaces;
 const result={
  modelVersion:1,
  status:'planning_model_requires_operator_review',
  warning:'Scenario estimates are not reconciled provider charges, profitability evidence, a spending cap or upgrade authorization.',
  inputProvenance:{rates:c.rates,financial:c.financial,portfolio:c.portfolio,decision:c.decision,
   scenarios:c.scenarios,capacity:c.capacity},
  evidence:c.evidence,missingEvidence:Object.entries(c.evidence).filter(([,v])=>v===null).map(([k])=>k),
  fixedMonthlyEur,fixedEurPerPayingWorkspace,
  scenarios:c.scenarios.map(s=>{
   const f={...c.financial.values,...s.financialOverrides};
   const explore=PLANS.find(p=>p.id==='explore')!;
   const free=consumption(explore,s.free,c,f);
   const freeSubsidyEur=free.totalVariableCostEur*p.freeWorkspacesPerPayingWorkspace;
   return {id:s.id,label:s.label,basis:s.basis,financial:f,
    quota:snapshotHeadroom(s,c.capacity),
    plans:PLANS.map(plan=>{
     const use=plan.id==='explore'?free:consumption(plan,s.paid,c,f);
     const gross=plan.monthlyPrice;
     const revenue=gross/(1+f.salesTaxFraction);
     // Fees/reserves apply to the charged gross amount; fixed fee only on paid invoices.
     const paymentEur=gross>0?gross*(f.paymentFraction+f.billingFraction)+f.paymentFixedEur:0;
     const reserveEur=gross*f.refundAndDisputeReserveFraction;
     const subsidy=plan.id==='explore'?0:freeSubsidyEur;
     const allocation=plan.id==='explore'?0:fixedEurPerPayingWorkspace;
     const otherCostsEur=use.totalVariableCostEur-use.costsEur.ai+paymentEur+reserveEur+subsidy+allocation;
     const contributionEur=revenue-otherCostsEur-use.costsEur.ai;
     const targetEur=revenue*c.decision.values.targetContributionFraction;
     const aiBudgetEur=revenue-otherCostsEur-targetEur;
     const preFixedContributionEur=contributionEur+allocation;
     return {planId:plan.id,monthlyPriceEur:gross,monthlyPageAllowance:plan.monthlyPages,
      monthlySharedSuggestionAllowance:monthlyAiSuggestionLimit(plan.id),consumption:use,
      revenueExcludingSalesTaxEur:revenue,paymentEur,reserveEur,freeSubsidyEur:subsidy,fixedAllocationEur:allocation,
      contributionEur,contributionFraction:revenue>0?contributionEur/revenue:null,
      targetContributionFraction:c.decision.values.targetContributionFraction,
      targetHeadroomEur:contributionEur-targetEur,
      // Includes extraction, all attempts, suggestions and provider invoice adjustments.
      maxOwnAiUsdPerCreditedPageForTarget:use.pages>0?aiBudgetEur/(f.eurPerUsd*f.providerInvoiceMultiplier)/use.pages:null,
      minimumPayingWorkspacesForFixedCosts:plan.id==='explore'?null:payerThreshold(fixedMonthlyEur,preFixedContributionEur),
      minimumPayingWorkspacesForTarget:plan.id==='explore'?null:payerThreshold(fixedMonthlyEur,preFixedContributionEur-targetEur),
     };
    }),
   };
  }),
 };
 assertFiniteOutput(result);
 return result;
}

function payerThreshold(fixed:number,perPayer:number):number|null{
 if(fixed===0&&perPayer>=0)return 0;
 return perPayer>0?Math.ceil(fixed/perPayer):null;
}

function snapshotHeadroom(s:EconomicsInput['scenarios'][number],limits:EconomicsInput['capacity']){
 const required={requestsPerMinute:s.peakRequestsPerMinute,inputTokensPerMinute:s.peakInputTokensPerMinute,outputTokensPerMinute:s.peakOutputTokensPerMinute,totalTokensPerMinute:s.peakInputTokensPerMinute+s.peakOutputTokensPerMinute};
 return {required,basis:s.basis,source:s.source,
  headroom:limits?{
   requestsPerMinute:limits.requestsPerMinute===null?null:limits.requestsPerMinute-required.requestsPerMinute,
   inputTokensPerMinute:limits.inputTokensPerMinute===null?null:limits.inputTokensPerMinute-required.inputTokensPerMinute,
   outputTokensPerMinute:limits.outputTokensPerMinute===null?null:limits.outputTokensPerMinute-required.outputTokensPerMinute,
   totalTokensPerMinute:limits.totalTokensPerMinute===null?null:limits.totalTokensPerMinute-required.totalTokensPerMinute,
  }:null,
  warning:'No throughput or hosted acceptance is inferred. Use the identified project limits/accounting basis across all tenants/lanes; admission estimates may reserve more tokens than eventual usage.',
 };
}

function assertFiniteOutput(value:unknown):void{
 if(typeof value==='number'&&!Number.isFinite(value))throw new Error('Model arithmetic exceeds finite numeric bounds');
 if(value&&typeof value==='object')for(const child of Object.values(value))assertFiniteOutput(child);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  if(process.argv.length!==3)throw new Error('Usage: node --import tsx scripts/unit-economics.ts <input.json>');
  const input=JSON.parse(await readFile(process.argv[2],'utf8'));
  process.stdout.write(`${JSON.stringify(calculateEconomics(input),null,2)}\n`);
 }catch{
  // Do not echo arbitrary input paths/content into shared logs.
  process.stderr.write('Invalid economics input or command. See docs/UNIT-ECONOMICS.md for the required schema.\n');
  process.exitCode=1;
 }
}
