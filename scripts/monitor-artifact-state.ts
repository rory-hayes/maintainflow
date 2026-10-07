/** Select an authoritative encrypted checkpoint. This module never downloads state or sends alerts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const repository='rory-hayes/maintainflow';
const workflow='operations-monitor.yml';
const api=`https://api.github.com/repos/${repository}/actions`;
const prefix='folio-monitor-state-v1-';
const responseLimit=1024*1024;
const runLimit=30;
const artifactLimit=100;
const phases={resumed:0,prepared:1,delivered:2} as const;
type Phase=keyof typeof phases;
type Run={id:number;run_number:number;run_attempt:number;display_title:string;head_sha:string;head_branch:string;event:string;status:string;conclusion:string|null;repository:{full_name:string};head_repository:{full_name:string}};
type Artifact={id:number;name:string;expired:boolean;size_in_bytes:number;workflow_run?:{id:number;head_branch:string}};
export type ArtifactSelection={artifactId:number;runId:number;name:string};
export type SkippedRunReason='selector_failed_before_state'|'hosted_runner_not_acquired';
export type SelectionOptions={token:string;runId:number;runAttempt:number;runNumber:number;initialize?:boolean;timeoutMs?:number;onSkippedRun?:(runId:number,reason:SkippedRunReason)=>void};
export class ArtifactStateError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;}}
function requireValue(value:unknown,code:string):asserts value{if(!value)throw new ArtifactStateError(code);}
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0;
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);

async function json(url:string,token:string,transport:typeof fetch,signal:AbortSignal):Promise<unknown>{
  let response:Response|undefined;
  try{
    signal.throwIfAborted();
    response=await transport(url,{method:'GET',redirect:'error',signal,headers:{accept:'application/vnd.github+json',authorization:`Bearer ${token}`,'x-github-api-version':'2022-11-28'}});
    signal.throwIfAborted();
    requireValue(response.status===200,'artifact_api_unavailable');
    const declared=response.headers.get('content-length');
    if(declared!==null)requireValue(/^\d+$/.test(declared)&&Number(declared)<=responseLimit,'artifact_response_limit');
    const reader=response.body?.getReader();requireValue(reader,'artifact_response_invalid');
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done)break;size+=part.value.byteLength;requireValue(size<=responseLimit,'artifact_response_limit');chunks.push(part.value);}}
    finally{void reader.cancel().catch(()=>{});}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new ArtifactStateError('artifact_response_invalid');}
  }finally{if(response&&!response.bodyUsed)void response.body?.cancel().catch(()=>{});}
}

function runsResponse(value:unknown):{runs:Run[];total:number}{
  requireValue(object(value)&&count(value.total_count)&&Array.isArray(value.workflow_runs)&&value.workflow_runs.length<=runLimit&&value.total_count>=value.workflow_runs.length,'artifact_runs_invalid');
  const runs:Run[]=value.workflow_runs.map((entry:unknown)=>{
    requireValue(object(entry)&&positive(entry.id)&&positive(entry.run_number)&&positive(entry.run_attempt)&&typeof entry.display_title==='string'&&typeof entry.head_sha==='string'&&/^[0-9a-f]{40}$/.test(entry.head_sha)&&entry.head_branch==='main'&&typeof entry.event==='string'&&typeof entry.status==='string'&&(entry.conclusion===null||typeof entry.conclusion==='string')&&object(entry.repository)&&entry.repository.full_name===repository&&object(entry.head_repository)&&entry.head_repository.full_name===repository,'artifact_runs_invalid');
    return entry as unknown as Run;
  });
  requireValue(new Set(runs.map(run=>run.id)).size===runs.length&&new Set(runs.map(run=>run.run_number)).size===runs.length,'artifact_runs_ambiguous');
  return {runs,total:value.total_count};
}
function isStateful(run:Run):boolean{
  // The workflow derives "disabled" from the same predicate that skips its only job.
  if(['Folio monitor: probe','Folio monitor: delivery-drill','Folio monitor: disabled'].includes(run.display_title))return false;
  requireValue(['Folio monitor: run','Folio monitor: initialize'].includes(run.display_title)&&['schedule','workflow_dispatch'].includes(run.event),'artifact_run_unrecognized');
  return true;
}

function artifactResponse(value:unknown,run:Run,maximumAttempt:number):ArtifactSelection{
  requireValue(object(value)&&count(value.total_count)&&Array.isArray(value.artifacts)&&value.artifacts.length<=artifactLimit&&value.total_count===value.artifacts.length,'artifact_history_incomplete');
  const candidates:Array<{artifact:Artifact;attempt:number;phase:Phase}>=[];
  const ids=new Set<number>(),generations=new Set<string>();
  for(const entry of value.artifacts){
    requireValue(object(entry)&&positive(entry.id)&&typeof entry.name==='string'&&typeof entry.expired==='boolean'&&count(entry.size_in_bytes),'artifact_metadata_invalid');
    requireValue(!ids.has(entry.id),'artifact_generation_ambiguous');ids.add(entry.id);
    if(!entry.name.startsWith(prefix))continue;
    const match=/^folio-monitor-state-v1-([1-9][0-9]*)-(resumed|prepared|delivered)$/.exec(entry.name);
    requireValue(match&&positive(Number(match[1])),'artifact_generation_invalid');
    const attempt=Number(match[1]),phase=match[2] as Phase;
    requireValue(attempt<=run.run_attempt,'artifact_generation_invalid');
    if(entry.workflow_run!==undefined)requireValue(object(entry.workflow_run)&&entry.workflow_run.id===run.id&&entry.workflow_run.head_branch==='main','artifact_scope_invalid');
    requireValue(!generations.has(`${attempt}:${phase}`),'artifact_generation_ambiguous');generations.add(`${attempt}:${phase}`);
    // A rerun may read only a prior attempt, never its own incomplete checkpoint.
    if(attempt<=maximumAttempt)candidates.push({artifact:entry as unknown as Artifact,attempt,phase});
  }
  candidates.sort((a,b)=>b.attempt-a.attempt||phases[b.phase]-phases[a.phase]);
  const selected=candidates[0];requireValue(selected,'latest_monitor_checkpoint_missing');
  // A successful attempt must have completed the workflow's final delivered upload.
  // Its disappearance is not permission to select an older phase or attempt.
  if(run.conclusion==='success')requireValue(selected.attempt===maximumAttempt&&selected.phase==='delivered','successful_monitor_checkpoint_missing');
  requireValue(!selected.artifact.expired,'latest_monitor_checkpoint_expired');
  requireValue(selected.artifact.size_in_bytes>0&&selected.artifact.size_in_bytes<=responseLimit,'artifact_payload_limit');
  return {artifactId:selected.artifact.id,runId:run.id,name:selected.artifact.name};
}

// These names bind the exemption to the existing, read-only selector and fixed workflow.
// A run that reached state download or any delivery step remains authoritative even if
// its artifacts later disappear. Unknown workflow steps are never safe to skip.
const selectorOnlySteps=[
  'Set up job',
  'Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  'Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'Select the authoritative encrypted checkpoint',
  'Download exactly the selected encrypted artifact',
  'Validate exact downloaded file shape and authenticate state',
  'Preserve the resumed checkpoint before retrying pending notices',
  'Retry previously checkpointed pending notices',
  'Observe current health and prepare the next encrypted state',
  'Commit prepared notices before sending new mail',
  'Deliver newly checkpointed incident or recovery notices',
  'Commit the delivered checkpoint',
  'Read dependencies without incident state or email',
  'Deliver approved test notices with a frozen identity and timestamp',
  'Post Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  'Post Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
  'Complete job',
] as const;
function failedBeforeState(value:unknown,run:Run):boolean{
  if(run.run_attempt!==1||run.conclusion!=='failure'||!object(value)||value.total_count!==1||!Array.isArray(value.jobs)||value.jobs.length!==1)return false;
  const job=value.jobs[0];
  if(!object(job)||job.run_id!==run.id||job.run_attempt!==1||job.head_sha!==run.head_sha||job.name!=='monitor'||job.status!=='completed'||job.conclusion!=='failure'||!Array.isArray(job.steps)||job.steps.length!==selectorOnlySteps.length)return false;
  let previousNumber=0;
  return job.steps.every((step:unknown,index:number)=>{
    if(!object(step)||!positive(step.number)||step.number<=previousNumber||step.name!==selectorOnlySteps[index]||step.status!=='completed')return false;
    previousNumber=step.number;
    if(index<3)return step.conclusion==='success';
    if(index===3)return step.conclusion==='failure';
    if(index<15)return step.conclusion==='skipped';
    return step.conclusion==='success';
  });
}


// Empty steps or unassigned runner fields alone do not prove non-execution.
// Accept only the provider-owned check attached to this exact attempt's single job.
function neverAcquiredCheckId(value:unknown,run:Run):number|null{
  if(run.run_attempt!==1||run.conclusion!=='failure'||!object(value)||value.total_count!==1||!Array.isArray(value.jobs)||value.jobs.length!==1)return null;
  const job=value.jobs[0];
  if(!object(job)||!positive(job.id)||job.run_id!==run.id||job.run_attempt!==1||job.head_sha!==run.head_sha||job.name!=='monitor'||job.status!=='completed'||job.conclusion!=='cancelled'||!Array.isArray(job.steps)||job.steps.length!==0||job.runner_id!==0||job.runner_name!==''||job.runner_group_id!==0||job.runner_group_name!==''||typeof job.check_run_url!=='string')return null;
  const checkPrefix=`https://api.github.com/repos/${repository}/check-runs/`;
  if(!job.check_run_url.startsWith(checkPrefix))return null;
  const suffix=job.check_run_url.slice(checkPrefix.length);
  if(!/^[1-9][0-9]*$/.test(suffix)||!positive(Number(suffix)))return null;
  return Number(suffix);
}
async function proveNeverAcquired(checkId:number,run:Run,token:string,transport:typeof fetch,signal:AbortSignal):Promise<boolean>{
  const check=await json(`https://api.github.com/repos/${repository}/check-runs/${checkId}`,token,transport,signal);
  if(!object(check)||check.id!==checkId||check.head_sha!==run.head_sha||check.name!=='monitor'||check.status!=='completed'||check.conclusion!=='cancelled'||!object(check.app)||check.app.id!==15368||check.app.slug!=='github-actions'||!object(check.output)||check.output.annotations_count!==1)return false;
  const annotations=await json(`https://api.github.com/repos/${repository}/check-runs/${checkId}/annotations?per_page=100`,token,transport,signal);
  if(!Array.isArray(annotations)||annotations.length!==1)return false;
  const annotation=annotations[0];
  if(!object(annotation)||annotation.annotation_level!=='failure'||typeof annotation.message!=='string')return false;
  // Normalize presentation only; no substring, other error, or user text is trusted.
  const message=annotation.message.replace(/\s+/g,' ').trim().replace(/\.+$/,'').toLowerCase();
  return message==='the job was not acquired by runner of type hosted even after multiple attempts';
}

const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
// The original selector was independently checked at the released PR71 commit.
// It could not read state or send notices before its failed selection step.
const originalSelectorDigest='36d48bfae9039bc891147c7d06ec659a15ac69a3b2574525d6113a967eba95ad';
// These released PR79 bytes were independently checked before this recovery change.
const releasedSelectorDigest='ecaacf7b935d187b4957c33823b142a205e427b8838bd74a2879b863df563daa';
const releasedWorkflowDigest='b04ebabb35917e47b0ecb7756a838596ca27747a98d4b15fabfb20e31dbb6047';
async function verifySelectorOnlySource(run:Run,token:string,transport:typeof fetch,signal:AbortSignal):Promise<void>{
  const paths=['.github/workflows/operations-monitor.yml','scripts/monitor-artifact-state.ts'] as const;
  const local=[await fs.readFile(new URL('../.github/workflows/operations-monitor.yml',import.meta.url)),await fs.readFile(new URL(import.meta.url))];
  for(const [index,sourcePath] of paths.entries()){
    const value=await json(`https://api.github.com/repos/${repository}/contents/${sourcePath}?ref=${run.head_sha}`,token,transport,signal);
    requireValue(object(value)&&value.type==='file'&&value.path===sourcePath&&value.encoding==='base64'&&typeof value.content==='string','artifact_selector_source_untrusted');
    const encoded=value.content.replace(/\n/g,'');
    requireValue(encoded.length>0&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded),'artifact_selector_source_untrusted');
    const source=Buffer.from(encoded,'base64'),actual=digest(source);
    requireValue(source.byteLength<=responseLimit&&(actual===digest(local[index]!)||index===0&&actual===releasedWorkflowDigest||index===1&&(actual===originalSelectorDigest||actual===releasedSelectorDigest)),'artifact_selector_source_untrusted');
  }
}

/** A null result is permitted only for explicit first-ever initialization with complete history. */
export async function selectMonitorArtifact(options:SelectionOptions,transport:typeof fetch=fetch):Promise<ArtifactSelection|null>{
  requireValue(typeof options.token==='string'&&options.token.length>=16,'artifact_token_missing');
  requireValue(positive(options.runId)&&positive(options.runAttempt)&&positive(options.runNumber),'artifact_current_run_invalid');
  const milliseconds=options.timeoutMs??20_000;requireValue(positive(milliseconds)&&milliseconds<=30_000,'artifact_timeout_invalid');
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const work=(async()=>{
    const {runs,total}=runsResponse(await json(`${api}/workflows/${workflow}/runs?branch=main&per_page=${runLimit}`,options.token,transport,controller.signal));
    const current=runs.find(run=>run.id===options.runId);
    requireValue(current&&current.run_number===options.runNumber&&current.run_attempt===options.runAttempt&&isStateful(current),'artifact_current_run_invalid');
    requireValue(!runs.some(run=>run.run_number>options.runNumber&&isStateful(run)),'monitor_run_superseded');
    const previous=runs.filter(run=>run.run_number<options.runNumber).sort((a,b)=>b.run_number-a.run_number);
    let selected=options.runAttempt>1?current:previous.find(isStateful);
    if(!selected){
      requireValue(total===runs.length,'artifact_history_incomplete');
      requireValue(options.initialize===true,'monitor_state_missing_requires_reconciliation');
      return null;
    }
    const maximumAttempt=selected.id===options.runId?options.runAttempt-1:selected.run_attempt;
    if(selected.id===options.runId){
      const priorAttempt=runsResponse({total_count:1,workflow_runs:[await json(`${api}/runs/${selected.id}/attempts/${maximumAttempt}`,options.token,transport,controller.signal)]}).runs[0]!;
      requireValue(priorAttempt.id===selected.id&&priorAttempt.run_number===selected.run_number&&priorAttempt.run_attempt===maximumAttempt&&isStateful(priorAttempt),'artifact_attempt_invalid');
      selected=priorAttempt;
    }
    const candidates=selected.id===options.runId?[selected]:previous,verifiedSources=new Set<string>();
    for(const candidate of candidates){
      if(!isStateful(candidate))continue;
      requireValue(candidate.status==='completed'&&candidate.conclusion!==null,'prior_monitor_run_incomplete');
      const artifacts=await json(`${api}/runs/${candidate.id}/artifacts?per_page=${artifactLimit}`,options.token,transport,controller.signal);
      try{return artifactResponse(artifacts,candidate,candidate.id===options.runId?maximumAttempt:candidate.run_attempt);}
      catch(error){
        if(!(error instanceof ArtifactStateError)||error.code!=='latest_monitor_checkpoint_missing'||candidate.id===options.runId||candidate.run_attempt!==1||candidate.conclusion!=='failure')throw error;
        requireValue(object(artifacts)&&artifacts.total_count===0&&Array.isArray(artifacts.artifacts)&&artifacts.artifacts.length===0,'latest_monitor_checkpoint_missing');
        const jobs=await json(`${api}/runs/${candidate.id}/attempts/1/jobs?per_page=100`,options.token,transport,controller.signal);
        const selectorFailed=failedBeforeState(jobs,candidate),checkId=selectorFailed?null:neverAcquiredCheckId(jobs,candidate);
        requireValue(selectorFailed||checkId!==null,'latest_monitor_checkpoint_missing');
        if(!verifiedSources.has(candidate.head_sha)){
          await verifySelectorOnlySource(candidate,options.token,transport,controller.signal);
          verifiedSources.add(candidate.head_sha);
        }
        if(!selectorFailed)requireValue(await proveNeverAcquired(checkId!,candidate,options.token,transport,controller.signal),'latest_monitor_checkpoint_missing');
        options.onSkippedRun?.(candidate.id,selectorFailed?'selector_failed_before_state':'hosted_runner_not_acquired');
      }
    }
    // Selector-only failures do not authorize first-ever initialization or hide a
    // checkpoint beyond the bounded history window.
    requireValue(total===runs.length,'artifact_history_incomplete');
    throw new ArtifactStateError('latest_monitor_checkpoint_missing');
  })();
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new ArtifactStateError('artifact_api_timeout'));},milliseconds);})]);}
  catch(error){if(error instanceof ArtifactStateError)throw error;throw new ArtifactStateError('artifact_api_unavailable');}
  finally{clearTimeout(timer);controller.abort();}
}

export async function main(args=process.argv.slice(2),env=process.env){
  requireValue(args.length===0||args.length===1&&args[0]==='--initialize','artifact_arguments_invalid');
  requireValue(env.GITHUB_REPOSITORY===repository&&env.GITHUB_REF==='refs/heads/main','artifact_environment_invalid');
  requireValue(typeof env.GITHUB_OUTPUT==='string'&&path.isAbsolute(env.GITHUB_OUTPUT),'artifact_output_missing');
  const parse=(value:string|undefined)=>value&&/^[1-9][0-9]*$/.test(value)?Number(value):NaN;
  const result=await selectMonitorArtifact({token:env.GH_TOKEN??'',runId:parse(env.GITHUB_RUN_ID),runAttempt:parse(env.GITHUB_RUN_ATTEMPT),runNumber:parse(env.GITHUB_RUN_NUMBER),initialize:args[0]==='--initialize',onSkippedRun:(runId,reason)=>console.error(JSON.stringify({monitorState:'checkpoint_not_created',runId,code:reason}))});
  await fs.appendFile(env.GITHUB_OUTPUT,`artifact_id=${result?.artifactId??''}\nrun_id=${result?.runId??''}\nartifact_name=${result?.name??''}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({monitorState:'unavailable',code:error instanceof ArtifactStateError?error.code:'artifact_selector_failed'}));process.exitCode=1;});
