/** Select an authoritative encrypted checkpoint. This module never downloads state or sends alerts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const repository='rory-hayes/maintainflow';
const workflow='operations-monitor.yml';
const api=`https://api.github.com/repos/${repository}/actions`;
const prefix='folio-monitor-state-v1-';
const responseLimit=1024*1024;
const runLimit=30;
const artifactLimit=100;
const phases={resumed:0,prepared:1,delivered:2} as const;
type Phase=keyof typeof phases;
type Run={id:number;run_number:number;run_attempt:number;display_title:string;head_branch:string;event:string;status:string;conclusion:string|null;repository:{full_name:string};head_repository:{full_name:string}};
type Artifact={id:number;name:string;expired:boolean;size_in_bytes:number;workflow_run?:{id:number;head_branch:string}};
export type ArtifactSelection={artifactId:number;runId:number;name:string};
export type SelectionOptions={token:string;runId:number;runAttempt:number;runNumber:number;initialize?:boolean;timeoutMs?:number};
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
    requireValue(object(entry)&&positive(entry.id)&&positive(entry.run_number)&&positive(entry.run_attempt)&&typeof entry.display_title==='string'&&entry.head_branch==='main'&&typeof entry.event==='string'&&typeof entry.status==='string'&&(entry.conclusion===null||typeof entry.conclusion==='string')&&object(entry.repository)&&entry.repository.full_name===repository&&object(entry.head_repository)&&entry.head_repository.full_name===repository,'artifact_runs_invalid');
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
    requireValue(selected.status==='completed'&&selected.conclusion!==null,'prior_monitor_run_incomplete');
    return artifactResponse(await json(`${api}/runs/${selected.id}/artifacts?per_page=${artifactLimit}`,options.token,transport,controller.signal),selected,maximumAttempt);
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
  const result=await selectMonitorArtifact({token:env.GH_TOKEN??'',runId:parse(env.GITHUB_RUN_ID),runAttempt:parse(env.GITHUB_RUN_ATTEMPT),runNumber:parse(env.GITHUB_RUN_NUMBER),initialize:args[0]==='--initialize'});
  await fs.appendFile(env.GITHUB_OUTPUT,`artifact_id=${result?.artifactId??''}\nrun_id=${result?.runId??''}\nartifact_name=${result?.name??''}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({monitorState:'unavailable',code:error instanceof ArtifactStateError?error.code:'artifact_selector_failed'}));process.exitCode=1;});
