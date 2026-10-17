import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {blankLaunchManifest,checkLaunchPreflight,launchRequirements,main,type LaunchManifest,type PreflightContext} from '../scripts/launch-preflight.js';

const commit='1'.repeat(40),tree='2'.repeat(40),head='3'.repeat(40),base='4'.repeat(40),oldCommit='5'.repeat(40),oldTree='6'.repeat(40);
const host='maintainflow-new123-rorys-projects-accf0d71.vercel.app',oldHost='maintainflow-old123-rorys-projects-accf0d71.vercel.app';
const now=new Date('2026-10-17T16:00:00Z');
/** Complete invented evidence only to exercise the validator; never an operational acceptance receipt. */
function fixture(){
  const files=new Map<string,Uint8Array>(),manifest=blankLaunchManifest(commit,tree);
  const pin=(name:string,value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)),filename=`/synthetic-launch-preflight/${name}`;files.set(filename,bytes);return {path:filename,sha256:createHash('sha256').update(bytes).digest('hex')};};
  const context:PreflightContext={now,expectedCommit:commit,expectedTree:tree,repository:{commit,tree,branch:'main',clean:true},read:async filename=>{const bytes=files.get(filename);if(!bytes)throw new Error('missing');return bytes;}};
  manifest.scope.frozenLedger=pin('scope.md',{fixture:true});
  manifest.acceptance=launchRequirements.map(({id,tiers})=>({id,status:'accepted',evidenceTier:tiers[0],reviewedAgainstTree:tree,reviewedBy:'synthetic-reviewer',reviewedAtUTC:'2026-10-17T15:00:00Z',receipt:pin(`${id}.json`,{fixture:true,id}),remaining:[]}));
  manifest.acceptance.find(item=>item.id==='commercial_plan_eligibility')!.receipt=pin('hosting-plan.json',{teamId:'team_0TBtz8vO6Cqygx11eRM5tg9D',billingPlan:'pro',billingStatus:'active',observedAtUTC:'2026-10-17T15:00:00Z'});
  const ci={acceptance:true,headTree:tree,head,base,headBound:true,runId:123,jobId:456,runURL:'https://github.com/rory-hayes/maintainflow/actions/runs/123',pullRequestURL:'https://github.com/rory-hayes/maintainflow/pull/100',sourcePins:{'synthetic-a.ts':'a'.repeat(64),'synthetic-b.ts':'b'.repeat(64),'synthetic-c.ts':'c'.repeat(64)},status:'completed',conclusion:'success',capturedAtUTC:'2026-10-17T15:00:00Z',testSummary:{tests:1500,pass:1500,fail:0,cancelled:0,skipped:0,todo:0},expectedMainTests:1500,namedNewCases:[{name:'invented focused case',matches:1,passed:true}],allChecks:7,checksSucceeded:true,checks:['Test and build','Analyze (actions)','Analyze (javascript-typescript)','Analyze (python)','CodeQL','Vercel','Vercel Preview Comments'].map(name=>({name,success:true})),node24RuntimeEvidence:{matched:true},groups:{runtime:{passGroups:17},filesystemSyntheticRestore:{passGroups:11},managedSyntheticRestore:{passGroups:17}},expectedGroupCountsMatched:true,requiredSteps:Object.fromEntries(['Create restricted application database role','Apply database migrations','Run tests with controlled provider fixtures','Typecheck and package the hosted application','Verify the isolated function runtime and document decoders','Restore and activate an independently encrypted synthetic backup','Capture and restore a managed database with controlled private object storage'].map(name=>[name,{status:'completed',conclusion:'success'}]))};
  const deployment={id:'dpl_syntheticCurrent',url:host,readyState:'READY',target:'production',source:'git',alias:['maintainflow.io','www.maintainflow.io'],aliasError:null,project:{id:'prj_9995IQ0H1GERFJseqQ9bqnOI7b02'},meta:{githubCommitRef:'main',githubCommitSha:commit,githubRepo:'maintainflow',githubOrg:'rory-hayes'}};
  const rule={id:'rule_folio_retire_unapproved_deployment_hosts_oMTcgI',action:{mitigate:{action:'deny'}},active:true,conditionGroup:[{conditions:[{op:'ninc',type:'host',value:['maintainflow.io','www.maintainflow.io',oldHost]}]}],name:'synthetic rule',description:'synthetic description',valid:true,validationErrors:null};
  const before={active:{version:32,updatedAt:'2026-10-17T14:00:00Z',projectKey:'prj_9995IQ0H1GERFJseqQ9bqnOI7b02#active',firewallEnabled:true,rules:[rule],crs:{xss:{active:true,action:'log'}},ips:[],changes:[]},draft:null,versions:[]};
  const live=structuredClone(before);live.active.version=33;live.active.updatedAt='2026-10-17T15:42:00Z';live.active.rules[0].conditionGroup[0].conditions[0].value[2]=host;
  const changedRule={action:live.active.rules[0].action,active:true,conditionGroup:live.active.rules[0].conditionGroup,name:rule.name,description:rule.description};
  const draft={...structuredClone(before),draft:{...structuredClone(live.active),projectKey:'prj_9995IQ0H1GERFJseqQ9bqnOI7b02#draft',updatedAt:'2026-10-17T15:35:00Z',changes:[{action:'rules.update',id:rule.id,value:changedRule,createdAt:'2026-10-17T15:35:00Z',userId:'synthetic-user',username:'synthetic-user'}]}};
  const canonical={at:'2026-10-17T15:45:00Z',revision:commit,pass:true,requests:Object.entries({'/api/health':{status:'ok',environment:'preview',revision:commit},'/api/ready':{status:'ready',checks:{restore:'ok',database:'ok',storage:'ok'}},'/api/config':{preview:true,inviteRequired:true,previewBillingMode:'mock'},'/api/auth/signup-terms':{enabled:false,policy:null}}).map(([route,data])=>({path:route,status:200,data,cacheControl:'private, no-store',pass:true}))};
  manifest.release.ci=pin('ci.json',ci);manifest.release.deployment=pin('deployment.json',deployment);manifest.release.canonical=pin('canonical.json',canonical);manifest.release.wafBefore=pin('before.json',before);manifest.release.wafLive=pin('live.json',live);manifest.release.wafDraft=pin('draft.json',draft);
  const stage={approved:true,merge:commit,testedTree:tree,deploymentId:deployment.id,newHost:host,atUTC:'2026-10-17T15:40:00Z',ciReceiptSHA256:manifest.release.ci.sha256,draftSHA256:manifest.release.wafDraft.sha256,baselineSHA256:manifest.release.wafBefore.sha256,activeVersion:32,draftVersion:33,activeAndHistoryExactlyUnchanged:true,fullNonTargetConfigurationExactlyUnchanged:true};
  manifest.release.stageReview=pin('stage.json',stage);
  manifest.release.publishOutcome=pin('publish-outcome.json',{completed:true,output:''});manifest.release.publishReservation=pin('publish-reservation.json',{at:'2026-10-17T15:41:00Z'});
  const bindings:[keyof LaunchManifest['release'],string][]=[['deployment','DEPLOYMENT-READY.json'],['canonical','canonical-after-publish.json'],['wafBefore','firewall-before.json'],['wafLive','firewall-live.json'],['stageReview','STAGE-REVIEW.json'],['wafDraft','firewall-draft.json'],['publishOutcome','firewall-publish-command.json'],['publishReservation','firewall-publish-reserved.json']];
  const review={approved:true,blockingFindings:[],merge:commit,tree,head,base,ciReceiptSHA256:manifest.release.ci.sha256,deploymentId:deployment.id,host,sourcePinsMatched:3,liveWafVersion:33,noDraft:true,fullNonTargetProtectionAndHistoryEqual:true,atUTC:'2026-10-17T15:50:00Z',inputs:Object.fromEntries(bindings.map(([key,name])=>[name,{sha256:manifest.release[key]!.sha256}]))};
  manifest.release.review=pin('review.json',review);
  manifest.rollback={commit:oldCommit,tree:oldTree,deploymentId:'dpl_syntheticPrevious',host:oldHost,schemaCompatible:true,receipt:pin('rollback.json',{status:'verified',commit:oldCommit,tree:oldTree,deploymentId:'dpl_syntheticPrevious',host:oldHost,schemaCompatible:true,evidenceTier:'hosted',isolatedRoutingRehearsal:true,sourceDataUnchanged:true,outboundFenced:true,reviewedBy:'synthetic-reviewer',verifiedAtUTC:'2026-10-17T15:00:00Z'})};
  const replace=(key:keyof LaunchManifest['release'],value:unknown)=>{manifest.release[key]=pin(`${key}-changed.json`,value);};
  return {manifest,context,files,pin,replace,ci,deployment,before,live,draft,canonical,stage,review};
}
const blocked=async(f:ReturnType<typeof fixture>,id:string)=>{const report=await checkLaunchPreflight(f.manifest,f.context);assert.equal(report.decision,'BLOCKED');assert.equal(report.checks.find(check=>check.id===id)?.status,'blocked',JSON.stringify(report));return report;};

test('complete synthetic launch evidence only prepares coordinator review and never authorizes or performs activation',async()=>{
  const f=fixture(),report=await checkLaunchPreflight(f.manifest,f.context);
  assert.equal(report.decision,'READY_FOR_COORDINATOR_REVIEW',JSON.stringify(report.checks.filter(item=>item.status==='blocked')));
  assert.equal(report.productionReady,false);assert.equal(report.activationAuthorized,false);assert.equal(report.activationPerformed,false);assert.equal(report.providerCalls,0);assert.equal(report.writes,0);
});
test('all original scope inventories remain explicit, including six optional extensions',async()=>{
  const f=fixture();assert.equal(f.manifest.scope.launchIds.length,26);assert.equal(f.manifest.scope.capabilityIds.length,47);assert.equal(f.manifest.scope.optionalIds.length,6);
  for(const key of ['launchIds','capabilityIds','optionalIds'] as const){const changed=fixture();changed.manifest.scope[key].pop();await blocked(changed,'scope_inventory');}
});
test('every required remaining acceptance blocks individually when missing; no lane completed label closes it',async()=>{
  for(const required of launchRequirements){const f=fixture();f.manifest.acceptance=f.manifest.acceptance.filter(item=>item.id!==required.id);await blocked(f,'acceptance_inventory');await blocked(f,`lane${required.lane}_${required.id}`);}
});
test('local fixtures, source-only preparation, unresolved criteria, stale review and another tree cannot satisfy hosted acceptance',async()=>{
  for(const patch of [{evidenceTier:'local_fixture' as const},{evidenceTier:'source_only' as const},{remaining:['unmet original acceptance']},{reviewedAgainstTree:oldTree},{reviewedBy:''},{reviewedAtUTC:'2026-10-01T00:00:00Z'},{reviewedAtUTC:'2026-10-18T00:00:00Z'}]){const f=fixture();Object.assign(f.manifest.acceptance.find(item=>item.id==='actual_inbound_email')!,patch);await blocked(f,'lane08_actual_inbound_email');}
  const f=fixture();f.manifest.acceptance.find(item=>item.id==='billing_checkout')!.evidenceTier='hosted';await blocked(f,'lane01_billing_checkout');
});
test('accepted labels cannot turn the actual Hobby hosting plan into commercial eligibility',async()=>{
  for(const patch of [{billingPlan:'hobby'},{billingStatus:'canceled'},{teamId:'different-team'},{observedAtUTC:'2026-10-15T00:00:00Z'}]){
    const f=fixture();f.manifest.acceptance.find(item=>item.id==='commercial_plan_eligibility')!.receipt=f.pin('hosting-plan-negative.json',{teamId:'team_0TBtz8vO6Cqygx11eRM5tg9D',billingPlan:'pro',billingStatus:'active',observedAtUTC:'2026-10-17T15:00:00Z',...patch});await blocked(f,'commercial_hosting_eligibility');
  }
});
test('missing, altered, unreadable, oversized or secret-shaped receipt references fail closed without echoing their content',async()=>{
  for(const mode of ['missing','tampered','unreadable','oversized','secret']){const f=fixture(),proof=f.manifest.acceptance[0];
    if(mode==='missing')proof.receipt=null;
    if(mode==='tampered')f.files.set(proof.receipt!.path,Buffer.from('sk_live_DO_NOT_ECHO'));
    if(mode==='unreadable')f.files.delete(proof.receipt!.path);
    if(mode==='oversized')f.files.set(proof.receipt!.path,Buffer.alloc(2*1024*1024+1));
    if(mode==='secret')proof.receipt={path:'/synthetic-launch-preflight/.env.production',sha256:'a'.repeat(64)};
    const report=await blocked(f,'evidence_billing_checkout');assert.equal(JSON.stringify(report).includes('sk_live_DO_NOT_ECHO'),false);
  }
});
test('duplicates and malformed or unknown manifest fields are rejected',async()=>{
  const f=fixture();f.manifest.acceptance.push(f.manifest.acceptance[0]);await blocked(f,'acceptance_inventory');
  for(const value of [null,{}, {...fixture().manifest,activate:true},{...fixture().manifest,phase:'public'}]){const report=await checkLaunchPreflight(value,fixture().context);assert.equal(report.checks[0].id,'manifest_schema');assert.equal(report.decision,'BLOCKED');}
});
test('repeated evidence paths still require each separately reviewed digest to match',async()=>{
  const f=fixture();f.manifest.acceptance[1].receipt={...f.manifest.acceptance[0].receipt!,sha256:'f'.repeat(64)};await blocked(f,'evidence_billing_renewal');
});
test('independent target pin and clean main cannot be replaced by the manifest target',async()=>{
  for(const patch of [{expectedCommit:oldCommit},{expectedTree:oldTree}]){const f=fixture();Object.assign(f.context,patch);await blocked(f,'target_identity');}
  for(const patch of [{branch:'codex/lane'},{clean:false},{commit:oldCommit},{tree:oldTree}]){const f=fixture();Object.assign(f.context.repository,patch);await blocked(f,'clean_main');}
});
test('skipped tests, absent named cases, failed checks and missing restore steps do not pass aggregate CI labels',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.ci.testSummary.skipped=1;},(f:ReturnType<typeof fixture>)=>{f.ci.namedNewCases=[];},(f:ReturnType<typeof fixture>)=>{f.ci.expectedMainTests=1499;}]){const f=fixture();mutate(f);f.replace('ci',f.ci);await blocked(f,'ci_tests');}
  const check=fixture();check.ci.checks[1].success=false;check.replace('ci',check.ci);await blocked(check,'ci_checks');
  const step=fixture();delete step.ci.requiredSteps['Apply database migrations'];step.replace('ci',step.ci);await blocked(step,'ci_runtime_restore');
  const treeMismatch=fixture();treeMismatch.ci.headTree=oldTree;treeMismatch.replace('ci',treeMismatch.ci);await blocked(treeMismatch,'exact_ci');
  const duplicate=fixture();duplicate.ci.namedNewCases.push({...duplicate.ci.namedNewCases[0]});duplicate.replace('ci',duplicate.ci);await blocked(duplicate,'ci_tests');
});
test('missing head/base in both receipts and forged repository run references cannot compare equal into acceptance',async()=>{
  for(const key of ['head','base']){const f=fixture();delete (f.ci as unknown as Record<string,unknown>)[key];delete (f.review as unknown as Record<string,unknown>)[key];f.replace('ci',f.ci);f.review.ciReceiptSHA256=f.manifest.release.ci!.sha256;f.replace('review',f.review);await blocked(f,'exact_ci');}
  const f=fixture();f.ci.runURL='https://github.com/another/repository/actions/runs/123';f.replace('ci',f.ci);await blocked(f,'exact_ci');
});
test('wrong commit, project, deployment type, immutable host or canonical alias blocks READY deployment',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.deployment.meta.githubCommitSha=oldCommit;},(f:ReturnType<typeof fixture>)=>{f.deployment.project.id='wrong-project';},(f:ReturnType<typeof fixture>)=>{f.deployment.source='cli';},(f:ReturnType<typeof fixture>)=>{f.deployment.url='*.vercel.app';},(f:ReturnType<typeof fixture>)=>{f.deployment.alias=['maintainflow.io'];}]){const f=fixture();mutate(f);f.replace('deployment',f.deployment);await blocked(f,'git_production_deployment');}
});
test('stale release guards, early public signup/billing and stale review digest block preparation',async()=>{
  const stale=fixture();stale.context.now=new Date('2026-10-17T18:00:00Z');await blocked(stale,'fresh_release_window');
  const guard=fixture();guard.canonical.requests.find(item=>item.path==='/api/config')!.data={preview:false,inviteRequired:false,previewBillingMode:'mock'};guard.replace('canonical',guard.canonical);await blocked(guard,'private_canonical_guards');
  const receipt=fixture();receipt.review.inputs['firewall-live.json'].sha256='a'.repeat(64);receipt.replace('review',receipt.review);await blocked(receipt,'independent_release_review');
});
test('complete WAF comparison rejects unrelated drift, wildcard/retired hosts, disabled protections, draft and history changes',async()=>{
  for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.live.active.crs.xss.active=false;},(f:ReturnType<typeof fixture>)=>{f.live.active.rules[0].conditionGroup[0].conditions[0].value.push('*.vercel.app');},(f:ReturnType<typeof fixture>)=>{f.live.active.rules[0].conditionGroup[0].conditions[0].value[2]=oldHost;},(f:ReturnType<typeof fixture>)=>{f.live.active.firewallEnabled=false;},(f:ReturnType<typeof fixture>)=>{(f.live as unknown as {draft:unknown}).draft={pending:true};},(f:ReturnType<typeof fixture>)=>{(f.live.versions as unknown[]).push({version:1});}]){const f=fixture();mutate(f);f.replace('wafLive',f.live);await blocked(f,'complete_waf_preservation');}
});
test('staged projection, independent hash binding and stage-before-publish order are mandatory',async()=>{
  const drift=fixture();drift.draft.draft.firewallEnabled=false;drift.replace('wafDraft',drift.draft);await blocked(drift,'complete_staged_waf');
  const binding=fixture();binding.stage.draftSHA256='a'.repeat(64);binding.replace('stageReview',binding.stage);await blocked(binding,'reviewed_stage_then_publish');
  const order=fixture();order.stage.atUTC='2026-10-17T15:46:00Z';order.replace('stageReview',order.stage);await blocked(order,'reviewed_stage_then_publish');
  for(const value of ['2026-10-17T15:49:00Z','2026-10-17T15:35:00Z','not-a-time']){const publication=fixture();publication.live.active.updatedAt=value;publication.replace('wafLive',publication.live);await blocked(publication,'reviewed_stage_then_publish');}
  const uncertain=fixture();uncertain.replace('publishOutcome',{completed:false});await blocked(uncertain,'reviewed_stage_then_publish');
});
test('rollback needs a distinct compatible exact target and actual bounded rehearsal receipt',async()=>{
  for(const patch of [{commit},{deploymentId:'dpl_syntheticCurrent'},{host},{schemaCompatible:false},{tree:null}]){const f=fixture();Object.assign(f.manifest.rollback,patch);await blocked(f,'rollback_identity');}
  const f=fixture();f.manifest.rollback.receipt=f.pin('bad-rollback.json',{status:'verified',evidenceTier:'local_fixture'});await blocked(f,'rollback_rehearsal_binding');
});
test('blank template blocks all actual acceptance and CLI refuses action flags without reading application configuration',async()=>{
  const f=fixture(),report=await checkLaunchPreflight(blankLaunchManifest(commit,tree),f.context);assert.equal(report.decision,'BLOCKED');assert.equal(report.activationPerformed,false);
  const outputs:string[]=[];assert.equal(await main(['--activate'],value=>outputs.push(value)),2);assert.equal(JSON.parse(outputs[0]).activationAuthorized,false);
  const templates:string[]=[];assert.equal(await main(['--template'],value=>templates.push(value)),0);assert.equal(JSON.parse(templates[0]).acceptance.length,launchRequirements.length);
});
