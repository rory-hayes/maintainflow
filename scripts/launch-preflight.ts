/** Read-only evidence preflight. Never imports app configuration, loads .env, or calls a provider. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';

type Tier='hosted'|'stripe_sandbox'|'provider_readback'|'operator_adoption';
type Requirement={id:string;lane:string;launchIds:string[];tiers:Tier[]};
const requirement=(lane:string,id:string,launchIds:string[],tiers:Tier[]=['hosted']):Requirement=>({id,lane,launchIds,tiers});
/** Required remaining acceptance, not a replacement for the original frozen capability wording. */
export const launchRequirements:readonly Requirement[]=[
  ...['checkout','renewal','plan_changes','cancellation','failed_payment','webhook_replay'].map(id=>requirement('01',`billing_${id}`,['L03','L23'],['stripe_sandbox'])),
  requirement('01','preview_entitlement_disposition',['L23'],['hosted']),
  ...['fresh_customer','own_file_review','approved_downloads','responsive_accessibility','private_signup_denial'].map(id=>requirement('02',id,['L01','L09','L10'])),
  ...['account_recovery','old_session_rejection','invitations_roles','tenant_resource_isolation'].map(id=>requirement('03',id,['L12','L21'])),
  requirement('03','managed_database_permissions',['L21'],['provider_readback']),
  requirement('03','dependency_advisory_disposition',['L21'],['provider_readback']),
  ...['natural_monitor_cadence','incident_recovery_idempotence','independent_missed_run_receiver'].map(id=>requirement('04',id,['L02','L16','L17'])),
  requirement('05','hosted_encrypted_restore',['L18']),
  requirement('05','ongoing_offhost_backups',['L19'],['hosted','operator_adoption']),
  ...['hosted_failure_recovery','sustained_capacity','quota_headroom'].map(id=>requirement('06',id,['L08','L09','L15','L21'])),
  ...['measured_extraction_quality','advertised_formats_limits','exports_repeat_preservation'].map(id=>requirement('07',id,['L09','L10','L11'])),
  requirement('08','actual_inbound_email',['L13']),
  requirement('08','google_restart_disconnect_revocation',['L14']),
  requirement('08','signed_receiver_and_advertised_recipes',['L15']),
  requirement('09','retention_cleanup_and_closure',['L20']),
  requirement('09','adopted_factual_policies',['L22'],['operator_adoption']),
  requirement('09','public_signup_terms_wiring',['L22']),
  requirement('09','support_privacy_incident_operations',['L22'],['operator_adoption','hosted']),
  requirement('10','reconciled_complete_costs',['L24','L25'],['provider_readback']),
  requirement('10','adopted_offer_claims_and_budget',['L24','L25'],['operator_adoption']),
  requirement('10','commercial_plan_eligibility',['L25'],['provider_readback']),
  requirement('10','necessary_tiers_verified',['L25'],['provider_readback']),
  requirement('11','database_migration_compatibility',['L05','L06']),
  requirement('11','routing_rollback_rehearsal',['L07']),
  requirement('11','reviewed_activation_change',['L26'],['operator_adoption']),
];
export const launchIds=Array.from({length:26},(_,i)=>`L${String(i+1).padStart(2,'0')}`);
export const capabilityIds=[...Array.from({length:7},(_,i)=>`W0${i+1}`),...Array.from({length:10},(_,i)=>`C${String(i+1).padStart(2,'0')}`),...['X','E','O'].flatMap(prefix=>Array.from({length:8},(_,i)=>`${prefix}0${i+1}`)),...Array.from({length:6},(_,i)=>`R0${i+1}`)];
export const optionalIds=Array.from({length:6},(_,i)=>`P0${i+1}`);
const sha=z.string().regex(/^[a-f0-9]{40}$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const stamp=z.string().datetime({offset:true});
const refSchema=z.object({path:z.string().min(1),sha256:digest}).strict();
type Ref=z.infer<typeof refSchema>;
const evidenceSchema=z.object({
  id:z.string(),status:z.enum(['accepted','incomplete']),evidenceTier:z.enum(['hosted','stripe_sandbox','provider_readback','operator_adoption','local_fixture','source_only']).nullable(),
  reviewedAgainstTree:sha.nullable(),reviewedBy:z.string().nullable(),reviewedAtUTC:stamp.nullable(),receipt:refSchema.nullable(),remaining:z.array(z.string()),
}).strict();
const manifestSchema=z.object({
  schemaVersion:z.literal(1),phase:z.literal('private_pre_activation'),
  target:z.object({commit:sha,tree:sha}).strict(),
  scope:z.object({launchIds:z.array(z.string()),capabilityIds:z.array(z.string()),optionalIds:z.array(z.string()),frozenLedger:refSchema.nullable()}).strict(),
  release:z.object({ci:refSchema.nullable(),review:refSchema.nullable(),deployment:refSchema.nullable(),canonical:refSchema.nullable(),wafBefore:refSchema.nullable(),wafLive:refSchema.nullable(),stageReview:refSchema.nullable(),wafDraft:refSchema.nullable(),publishOutcome:refSchema.nullable(),publishReservation:refSchema.nullable()}).strict(),
  acceptance:z.array(evidenceSchema),
  rollback:z.object({commit:sha.nullable(),tree:sha.nullable(),deploymentId:z.string().nullable(),host:z.string().nullable(),schemaCompatible:z.boolean(),receipt:refSchema.nullable()}).strict(),
}).strict();
export type LaunchManifest=z.infer<typeof manifestSchema>;
type Check={id:string;status:'pass'|'blocked';requirement:string};
type ObjectValue=Record<string,unknown>;
const object=(value:unknown):ObjectValue=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:{};
const array=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const nested=(value:unknown,...keys:string[]):unknown=>keys.reduce<unknown>((current,key)=>object(current)[key],value);
const sha256=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sameSet=(actual:string[],expected:string[])=>actual.length===expected.length&&new Set(actual).size===actual.length&&expected.every(id=>actual.includes(id));
const fresh=(value:unknown,now:Date,minutes:number)=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=now.getTime()+30_000&&now.getTime()-Date.parse(value)<=minutes*60_000;
const validHost=(value:unknown)=>typeof value==='string'&&/^maintainflow-[a-z0-9]+-rorys-projects-accf0d71\.vercel\.app$/.test(value);
const requiredChecks=['Test and build','Analyze (actions)','Analyze (javascript-typescript)','Analyze (python)','CodeQL','Vercel','Vercel Preview Comments'];
const requiredSteps=['Create restricted application database role','Apply database migrations','Run tests with controlled provider fixtures','Typecheck and package the hosted application','Verify the isolated function runtime and document decoders','Restore and activate an independently encrypted synthetic backup','Capture and restore a managed database with controlled private object storage'];
export type PreflightContext={now:Date;expectedCommit:string;expectedTree:string;repository:{commit:string;tree:string;branch:string;clean:boolean};read:(filename:string)=>Promise<Uint8Array>};
export type PreflightReport={mode:'offline_launch_evidence_preflight';decision:'BLOCKED'|'READY_FOR_COORDINATOR_REVIEW';evidenceComplete:boolean;productionReady:false;activationAuthorized:false;activationPerformed:false;providerCalls:0;writes:0;checks:Check[];limitations:string[]};

export function blankLaunchManifest(commit:string,tree:string):LaunchManifest{
  return {schemaVersion:1,phase:'private_pre_activation',target:{commit,tree},scope:{launchIds:[...launchIds],capabilityIds:[...capabilityIds],optionalIds:[...optionalIds],frozenLedger:null},
    release:{ci:null,review:null,deployment:null,canonical:null,wafBefore:null,wafLive:null,stageReview:null,wafDraft:null,publishOutcome:null,publishReservation:null},
    acceptance:launchRequirements.map(({id})=>({id,status:'incomplete',evidenceTier:null,reviewedAgainstTree:null,reviewedBy:null,reviewedAtUTC:null,receipt:null,remaining:['Actual acceptance and coordinator review are required.']})),
    rollback:{commit:null,tree:null,deploymentId:null,host:null,schemaCompatible:false,receipt:null}};
}

/** Receipt integrity and reviewed assertions are checked; authenticity and semantic sufficiency require coordinator review. */
export async function checkLaunchPreflight(input:unknown,context:PreflightContext):Promise<PreflightReport>{
  const checks:Check[]=[];
  const check=(id:string,passed:boolean,requirement:string)=>checks.push({id,status:passed?'pass':'blocked',requirement});
  const finish=():PreflightReport=>({mode:'offline_launch_evidence_preflight',decision:checks.every(c=>c.status==='pass')?'READY_FOR_COORDINATOR_REVIEW':'BLOCKED',evidenceComplete:checks.every(c=>c.status==='pass'),productionReady:false,activationAuthorized:false,activationPerformed:false,providerCalls:0,writes:0,checks,limitations:[
    'Offline verification of pinned receipts and coordinator assertions only; no fresh hosted/provider observations or independent authentication of evidence producers.',
    'A passing result is preparation for coordinator review, never permission to activate or a production-readiness claim. Final human instruction and post-activation acceptance remain separate.',
    'Provider compare-before-action is not atomic CAS. Re-read live state before each coordinator-owned action; preserve action reservations and uncertain outcomes.',
  ]});
  const parsed=manifestSchema.safeParse(input);
  check('manifest_schema',parsed.success,'Use the strict private pre-activation manifest; missing, malformed or unknown fields block.');
  if(!parsed.success)return finish();
  const manifest=parsed.data,{commit,tree}=manifest.target;
  check('target_identity',commit===context.expectedCommit&&tree===context.expectedTree&&sha.safeParse(context.expectedCommit).success&&sha.safeParse(context.expectedTree).success,'Independently supply the exact intended merged commit and tested tree.');
  check('clean_main',context.repository.clean&&context.repository.branch==='main'&&context.repository.commit===commit&&context.repository.tree===tree,'The executing checkout must be clean main at the exact intended merge and tested tree.');
  check('scope_inventory',sameSet(manifest.scope.launchIds,launchIds)&&sameSet(manifest.scope.capabilityIds,capabilityIds)&&sameSet(manifest.scope.optionalIds,optionalIds),'Retain all 26 launch items, 47 capability IDs and six optional scopes. Optional extensions are not additional prerequisites.');
  const cache=new Map<string,Uint8Array>();
  const pinned=async(ref:Ref|null,id:string):Promise<Uint8Array|null>=>{
    if(!ref){check(id,false,'Supply the exact reviewed evidence file and SHA256; a label or missing receipt is insufficient.');return null;}
    try{
      if(!path.isAbsolute(ref.path)||!(/\.(json|md|txt|log)$/i.test(ref.path))||/(^|[/\\])\.env(?:[./\\]|$)/i.test(ref.path))throw new Error('unsupported evidence path');
      let bytes=cache.get(ref.path);if(!bytes){bytes=await context.read(ref.path);if(bytes.byteLength>2*1024*1024)throw new Error('oversized evidence');cache.set(ref.path,bytes);}
      const ok=sha256(bytes)===ref.sha256;check(id,ok,'Read the explicit bounded evidence file and require its exact reviewed SHA256.');return ok?bytes:null;
    }catch{check(id,false,'The explicit evidence file must be readable, bounded, non-secret evidence with the exact reviewed SHA256.');return null;}
  };
  const json=async(ref:Ref|null,id:string):Promise<ObjectValue>=>{const bytes=await pinned(ref,id);if(!bytes)return {};try{const value=JSON.parse(Buffer.from(bytes).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid receipt');return value;}catch{check(`${id}_json`,false,'The pinned receipt must contain a JSON object.');return {};}};
  await pinned(manifest.scope.frozenLedger,'frozen_scope_receipt');
  const ids=manifest.acceptance.map(item=>item.id);
  check('acceptance_inventory',sameSet(ids,launchRequirements.map(item=>item.id)),'Every named remaining requirement must appear exactly once; extra, missing or duplicate checks block.');
  for(const required of launchRequirements){
    const proof=manifest.acceptance.find(item=>item.id===required.id);
    const accepted=proof?.status==='accepted'&&proof.remaining.length===0&&proof.reviewedAgainstTree===tree&&typeof proof.reviewedBy==='string'&&proof.reviewedBy.trim().length>0&&fresh(proof.reviewedAtUTC,context.now,7*24*60)&&proof.evidenceTier!==null&&required.tiers.includes(proof.evidenceTier as Tier);
    check(`lane${required.lane}_${required.id}`,accepted,`${required.launchIds.join('/')}: require complete ${required.tiers.join(' or ')} evidence reviewed against the final tree; local/source preparation cannot substitute.`);
    if(proof?.status==='accepted'){
      if(required.id==='commercial_plan_eligibility'){
        const plan=await json(proof.receipt,`evidence_${required.id}`);
        check('commercial_hosting_eligibility',plan.teamId==='team_0TBtz8vO6Cqygx11eRM5tg9D'&&['pro','enterprise'].includes(String(plan.billingPlan))&&plan.billingStatus==='active'&&fresh(plan.observedAtUTC,context.now,24*60),'Actual current Vercel team readback must establish an active commercially permitted Pro or Enterprise plan before promotion; Hobby cannot pass from an acceptance label.');
      }else await pinned(proof.receipt,`evidence_${required.id}`);
    }
  }
  const ci=await json(manifest.release.ci,'ci_receipt'),review=await json(manifest.release.review,'release_review'),deployment=await json(manifest.release.deployment,'deployment_receipt');
  const canonical=await json(manifest.release.canonical,'canonical_receipt'),before=await json(manifest.release.wafBefore,'waf_baseline'),live=await json(manifest.release.wafLive,'waf_live');
  const stage=await json(manifest.release.stageReview,'stage_review'),draft=await json(manifest.release.wafDraft,'waf_draft');
  const publish=await json(manifest.release.publishOutcome,'publish_outcome'),reservation=await json(manifest.release.publishReservation,'publish_reservation');
  const tests=object(ci.testSummary),ciChecks=array(ci.checks),steps=object(ci.requiredSteps);
  check('exact_ci',ci.acceptance===true&&ci.headTree===tree&&sha.safeParse(ci.head).success&&sha.safeParse(ci.base).success&&ci.head===review.head&&ci.base===review.base&&ci.headBound===true&&Number.isSafeInteger(ci.runId)&&Number(ci.runId)>0&&Number.isSafeInteger(ci.jobId)&&Number(ci.jobId)>0&&ci.runURL===`https://github.com/rory-hayes/maintainflow/actions/runs/${ci.runId}`&&typeof ci.pullRequestURL==='string'&&/^https:\/\/github\.com\/rory-hayes\/maintainflow\/pull\/[1-9][0-9]*$/.test(ci.pullRequestURL)&&ci.status==='completed'&&ci.conclusion==='success'&&ci.capturedAtUTC!==undefined&&Number.isFinite(Date.parse(String(ci.capturedAtUTC)))&&Date.parse(String(ci.capturedAtUTC))<=context.now.getTime()+30_000,'Accepted terminal CI must bind full candidate head/base SHAs, the intended repository run/job/PR and final tested tree.');
  const namedCases=array(ci.namedNewCases),caseNames=namedCases.map(value=>object(value).name);
  check('ci_tests',Number.isSafeInteger(tests.tests)&&Number(tests.tests)>=1450&&tests.tests===ci.expectedMainTests&&tests.pass===tests.tests&&['fail','cancelled','skipped','todo'].every(key=>tests[key]===0)&&namedCases.length>0&&new Set(caseNames).size===caseNames.length&&namedCases.every(value=>typeof object(value).name==='string'&&String(object(value).name).trim().length>0&&object(value).matches===1&&object(value).passed===true),'Require exact expected full-suite totals, zero failures/skips/cancellations/todo and each unique named new case once. Keep earlier failures.');
  check('ci_checks',ci.checksSucceeded===true&&ci.allChecks===ciChecks.length&&requiredChecks.every(name=>ciChecks.filter(value=>object(value).name===name&&object(value).success===true).length===1)&&ciChecks.every(value=>object(value).success===true),'All seven required release checks, including CodeQL, must pass for the exact source; extra checks must also pass.');
  check('ci_runtime_restore',nested(ci,'node24RuntimeEvidence','matched')===true&&nested(ci,'groups','runtime','passGroups')===17&&nested(ci,'groups','filesystemSyntheticRestore','passGroups')===11&&Number(nested(ci,'groups','managedSyntheticRestore','passGroups'))>=17&&ci.expectedGroupCountsMatched===true&&requiredSteps.every(name=>nested(steps,name,'status')==='completed'&&nested(steps,name,'conclusion')==='success'),'Require Node24, packaged-runtime and both controlled recovery groups plus all completed required steps. These are not hosted restore proof.');
  const host=deployment.url,deploymentId=deployment.id;
  check('git_production_deployment',deployment.readyState==='READY'&&deployment.target==='production'&&deployment.source==='git'&&deployment.aliasError===null&&nested(deployment,'project','id')==='prj_9995IQ0H1GERFJseqQ9bqnOI7b02'&&nested(deployment,'meta','githubCommitRef')==='main'&&nested(deployment,'meta','githubCommitSha')===commit&&nested(deployment,'meta','githubRepo')==='maintainflow'&&nested(deployment,'meta','githubOrg')==='rory-hayes'&&validHost(host)&&typeof deploymentId==='string'&&deploymentId.startsWith('dpl_')&&['maintainflow.io','www.maintainflow.io'].every(alias=>array(deployment.alias).includes(alias)),'Verify the intended project/repository/main/merge, READY Git production deployment, immutable hostname and both canonical aliases.');
  const reviewInputs=object(review.inputs);
  const reviewBindings:[keyof LaunchManifest['release'],string][]=[['deployment','DEPLOYMENT-READY.json'],['canonical','canonical-after-publish.json'],['wafBefore','firewall-before.json'],['wafLive','firewall-live.json'],['stageReview','STAGE-REVIEW.json'],['wafDraft','firewall-draft.json'],['publishOutcome','firewall-publish-command.json'],['publishReservation','firewall-publish-reserved.json']];
  const sourcePins=Object.values(object(ci.sourcePins));
  check('independent_release_review',review.approved===true&&array(review.blockingFindings).length===0&&Array.isArray(review.blockingFindings)&&review.merge===commit&&review.tree===tree&&review.ciReceiptSHA256===manifest.release.ci?.sha256&&review.deploymentId===deploymentId&&review.host===host&&sourcePins.length>0&&sourcePins.every(value=>digest.safeParse(value).success)&&review.sourcePinsMatched===sourcePins.length&&reviewBindings.every(([key,name])=>manifest.release[key]!==null&&nested(reviewInputs,name,'sha256')===manifest.release[key]?.sha256),'Require an independent complete release review pinned to CI, source, deployment, canonical, stage and full firewall evidence.');
  check('fresh_release_window',fresh(review.atUTC,context.now,30)&&fresh(canonical.at,context.now,30),'Final review and private canonical observations expire after 30 minutes; refresh observations and review without replaying historical mutations.');
  const requests=array(canonical.requests);
  const route=(name:string)=>requests.filter(value=>object(value).path===name);
  const data=(name:string)=>object(object(route(name)[0]).data);
  check('private_canonical_guards',canonical.pass===true&&canonical.revision===commit&&requests.length===4&&['/api/health','/api/ready','/api/config','/api/auth/signup-terms'].every(name=>route(name).length===1)&&requests.every(value=>object(value).status===200&&object(value).pass===true&&object(value).cacheControl==='private, no-store')&&data('/api/health').revision===commit&&data('/api/health').environment==='preview'&&data('/api/health').status==='ok'&&data('/api/ready').status==='ready'&&isDeepStrictEqual(data('/api/ready').checks,{restore:'ok',database:'ok',storage:'ok'})&&isDeepStrictEqual(data('/api/config'),{preview:true,inviteRequired:true,previewBillingMode:'mock'})&&isDeepStrictEqual(data('/api/auth/signup-terms'),{enabled:false,policy:null}),'Before activation preserve exact revision, readiness, private invitations, simulated billing and dormant terms metadata. Separate actual signup-POST denial is required.');
  let wafMatches=false;
  try{
    const expected=structuredClone(before),active=object(expected.active),current=object(live.active),rules=array(active.rules);
    const target=rules.filter(value=>object(value).id==='rule_folio_retire_unapproved_deployment_hosts_oMTcgI');
    const rule=object(target[0]),conditions=array(object(array(rule.conditionGroup)[0]).conditions),condition=object(conditions[0]),oldHosts=array(condition.value);
    const newRule=array(current.rules).find(value=>object(value).id===rule.id);
    const baselineSafe=before.draft===null&&live.draft===null&&active.firewallEnabled===true&&target.length===1&&rule.active===true&&nested(rule,'action','mitigate','action')==='deny'&&array(rule.conditionGroup).length===1&&conditions.length===1&&condition.type==='host'&&condition.op==='ninc'&&oldHosts.length===3&&oldHosts[0]==='maintainflow.io'&&oldHosts[1]==='www.maintainflow.io'&&validHost(oldHosts[2])&&oldHosts[2]!==host&&nested(newRule,'active')===true;
    condition.value=['maintainflow.io','www.maintainflow.io',host];active.version=Number(active.version)+1;active.updatedAt=current.updatedAt;
    wafMatches=baselineSafe&&Number.isSafeInteger(active.version)&&isDeepStrictEqual(expected,live)&&review.liveWafVersion===current.version&&review.noDraft===true&&review.fullNonTargetProtectionAndHistoryEqual===true;
  }catch{wafMatches=false;}
  check('complete_waf_preservation',wafMatches,'Compare the complete baseline/live WAF and history: no draft, active deny rule, canonical hosts and exactly one old-to-current immutable-host replacement. Only version/update time may otherwise change.');
  const draftProjection=structuredClone(object(draft.draft)),liveProjection=structuredClone(object(live.active));
  for(const key of ['projectKey','updatedAt','changes']){delete draftProjection[key];delete liveProjection[key];}
  const changes=array(nested(draft,'draft','changes')),change=object(changes[0]),changedRule=structuredClone(object(array(nested(live,'active','rules')).find(value=>object(value).id==='rule_folio_retire_unapproved_deployment_hosts_oMTcgI')));
  for(const key of ['id','valid','validationErrors'])delete changedRule[key];
  check('complete_staged_waf',isDeepStrictEqual(draftProjection,liveProjection)&&nested(draft,'draft','projectKey')==='prj_9995IQ0H1GERFJseqQ9bqnOI7b02#draft'&&nested(live,'active','projectKey')==='prj_9995IQ0H1GERFJseqQ9bqnOI7b02#active'&&changes.length===1&&change.action==='rules.update'&&change.id==='rule_folio_retire_unapproved_deployment_hosts_oMTcgI'&&isDeepStrictEqual(change.value,changedRule)&&Object.keys(change).every(key=>['action','id','value','createdAt','userId','username'].includes(key)),'The entire staged protection projection must match the live result, with one exact rules.update and only reviewed provider audit metadata.');
  const reviewTime=Date.parse(String(review.atUTC)),stageTime=Date.parse(String(stage.atUTC)),canonicalTime=Date.parse(String(canonical.at)),draftTime=Date.parse(String(nested(draft,'draft','updatedAt'))),publishTime=Date.parse(String(nested(live,'active','updatedAt'))),reservedTime=Date.parse(String(reservation.at));
  check('reviewed_stage_then_publish',stage.approved===true&&stage.merge===commit&&stage.testedTree===tree&&stage.deploymentId===deploymentId&&stage.newHost===host&&stage.ciReceiptSHA256===manifest.release.ci?.sha256&&stage.draftSHA256===manifest.release.wafDraft?.sha256&&stage.baselineSHA256===manifest.release.wafBefore?.sha256&&stage.activeVersion===nested(before,'active','version')&&stage.draftVersion===nested(live,'active','version')&&stage.activeAndHistoryExactlyUnchanged===true&&stage.fullNonTargetConfigurationExactlyUnchanged===true&&isDeepStrictEqual(draft.active,before.active)&&isDeepStrictEqual(draft.versions,before.versions)&&publish.completed===true&&draftTime<=stageTime&&stageTime<reservedTime&&reservedTime<=publishTime&&publishTime<=canonicalTime&&canonicalTime<=reviewTime,'Require exact draft creation, independent review, separate publish reservation/completed outcome, actual live publication, final private guards and final review in that order; never replay old helpers.');
  const rollback=manifest.rollback;
  check('rollback_identity',rollback.commit!==null&&rollback.tree!==null&&rollback.commit!==commit&&rollback.deploymentId!==null&&rollback.deploymentId.startsWith('dpl_')&&rollback.deploymentId!==deploymentId&&validHost(rollback.host)&&rollback.host!==host&&rollback.schemaCompatible,'Record a distinct verified previous immutable deployment/source and explicit schema compatibility; application routing rollback cannot reverse migrations.');
  const recovery=await json(rollback.receipt,'rollback_receipt');
  check('rollback_rehearsal_binding',recovery.status==='verified'&&recovery.commit===rollback.commit&&recovery.tree===rollback.tree&&recovery.deploymentId===rollback.deploymentId&&recovery.host===rollback.host&&recovery.schemaCompatible===true&&recovery.evidenceTier==='hosted'&&recovery.isolatedRoutingRehearsal===true&&recovery.sourceDataUnchanged===true&&recovery.outboundFenced===true&&typeof recovery.reviewedBy==='string'&&recovery.reviewedBy.trim().length>0&&fresh(recovery.verifiedAtUTC,context.now,24*60),'Require the exact rollback target, hosted isolated routing rehearsal, source-data preservation, outbound fence and compatibility review within 24 hours.');
  return finish();
}

async function readEvidence(filename:string):Promise<Uint8Array>{
  const maximum=2*1024*1024,handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const stat=await handle.stat();if(!stat.isFile()||stat.size>maximum)throw new Error('unsupported evidence');
    const buffer=Buffer.alloc(maximum+1);let total=0;
    while(total<buffer.length){const {bytesRead}=await handle.read(buffer,total,buffer.length-total,total);if(bytesRead===0)break;total+=bytesRead;}
    if(total>maximum)throw new Error('oversized evidence');return buffer.subarray(0,total);
  }finally{await handle.close();}
}
async function repositoryState(directory:string){
  const git=(args:string[])=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).trim();
  let entries=git(['status','--porcelain','--untracked-files=all']).split('\n').filter(Boolean);
  // Assigned lane worktrees have only this intentionally untracked, shared read-only dependency symlink.
  if(entries.includes('?? node_modules')&&(await lstat(path.join(directory,'node_modules')).catch(()=>null))?.isSymbolicLink())entries=entries.filter(entry=>entry!=='?? node_modules');
  return {commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),branch:git(['symbolic-ref','--short','HEAD']),clean:entries.length===0};
}
export async function main(args=process.argv.slice(2),output:(value:string)=>void=console.log):Promise<number>{
  try{
    const expected=['--manifest','--expected-commit','--expected-tree'];
    if(args[0]==='--template'&&args.length===1){output(JSON.stringify(blankLaunchManifest('0'.repeat(40),'0'.repeat(40)),null,2));return 0;}
    if(args.length!==6||expected.some(flag=>args.filter(value=>value===flag).length!==1))throw new Error('arguments');
    const values=new Map<string,string>();for(let i=0;i<args.length;i+=2){if(!expected.includes(args[i])||args[i+1].startsWith('--'))throw new Error('arguments');values.set(args[i],args[i+1]);}
    const filename=values.get('--manifest')!,expectedCommit=values.get('--expected-commit')!,expectedTree=values.get('--expected-tree')!;
    if(!path.isAbsolute(filename)||!filename.endsWith('.json')||/(^|[/\\])\.env(?:[./\\]|$)/i.test(filename)||!sha.safeParse(expectedCommit).success||!sha.safeParse(expectedTree).success)throw new Error('arguments');
    const manifest=JSON.parse(Buffer.from(await readEvidence(filename)).toString('utf8'));
    const report=await checkLaunchPreflight(manifest,{now:new Date(),expectedCommit,expectedTree,repository:await repositoryState(process.cwd()),read:readEvidence});
    output(JSON.stringify(report,null,2));return report.evidenceComplete?0:1;
  }catch{output(JSON.stringify({mode:'offline_launch_evidence_preflight',decision:'BLOCKED',error:'invalid_arguments_manifest_or_checkout',usage:'--template OR --manifest ABSOLUTE_JSON --expected-commit FULL_SHA --expected-tree FULL_TREE',productionReady:false,activationAuthorized:false,activationPerformed:false,providerCalls:0,writes:0}));return 2;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=await main();
