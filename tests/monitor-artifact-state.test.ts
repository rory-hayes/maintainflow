import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selectMonitorArtifact,main,type SelectionOptions} from '../scripts/monitor-artifact-state.js';

const repo='rory-hayes/maintainflow',root=`https://api.github.com/repos/${repo}/actions`;
const options:SelectionOptions={token:'synthetic_owned_github_token',runId:30,runNumber:30,runAttempt:1};
const fixtureHead='ab34186f3619dff95b0cbd623352114e6b3a3dab';
const run=(id:number,mode='run',attempt=1)=>({id,run_number:id,run_attempt:attempt,display_title:`Folio monitor: ${mode}`,head_sha:fixtureHead,head_branch:'main',event:'workflow_dispatch',status:id===30?'in_progress':'completed',conclusion:id===30?null:'failure',repository:{full_name:repo},head_repository:{full_name:repo}});
const artifact=(id:number,attempt=1,phase='delivered',extra:Record<string,unknown>={})=>({id,name:`folio-monitor-state-v1-${attempt}-${phase}`,expired:false,size_in_bytes:512,...extra});
function transport(runs:ReturnType<typeof run>[],artifacts:ReturnType<typeof artifact>[],extra:{totalRuns?:number;totalArtifacts?:number;previousConclusion?:string;jobs?:Record<number,unknown>;artifactsByRun?:Record<number,ReturnType<typeof artifact>[]>;sourceOverrides?:Record<string,string>}={}){
  const calls:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);calls.push(url);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),`Bearer ${options.token}`);assert.equal(headers.get('x-github-api-version'),'2022-11-28');
    const attempt=/\/runs\/(\d+)\/attempts\/(\d+)$/.exec(url);
    const jobs=/\/runs\/(\d+)\/attempts\/1\/jobs\?per_page=100$/.exec(url);
    const source=new RegExp(`^https://api.github.com/repos/${repo}/contents/(\\.github/workflows/operations-monitor\\.yml|scripts/monitor-artifact-state\\.ts)\\?ref=[0-9a-f]{40}$`).exec(url);
    assert.ok(url===`${root}/workflows/operations-monitor.yml/runs?branch=main&per_page=30`||new RegExp(`^${root}/runs/[0-9]+/artifacts\\?per_page=100$`).test(url)||attempt||jobs||source);
    if(source){const sourcePath=source[1],bytes=extra.sourceOverrides?.[sourcePath]??await fs.readFile(new URL(`../${sourcePath}`,import.meta.url),'utf8');return Response.json({type:'file',path:sourcePath,encoding:'base64',content:Buffer.from(bytes).toString('base64')});}
    if(attempt)return Response.json({...runs.find(r=>r.id===Number(attempt[1]))!,run_attempt:Number(attempt[2]),status:'completed',conclusion:extra.previousConclusion??'failure'});
    if(jobs)return Response.json(extra.jobs?.[Number(jobs[1])]??{total_count:0,jobs:[]});
    const runId=/\/runs\/(\d+)\/artifacts/.exec(url),items=runId?extra.artifactsByRun?.[Number(runId[1])]??artifacts:artifacts;
    return Response.json(url.includes('/workflows/')?{total_count:extra.totalRuns??runs.length,workflow_runs:runs}:{total_count:extra.totalArtifacts??items.length,artifacts:items});
  };
  return {calls,fetcher};
}

// Synthetic GitHub metadata reproduces the hosted selector-only failure shape.
const selectorFailedJob=(runId:number)=>({total_count:1,jobs:[{run_id:runId,run_attempt:1,head_sha:fixtureHead,name:'monitor',status:'completed',conclusion:'failure',steps:[
  ['Set up job','success'],
  ['Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683','success'],
  ['Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020','success'],
  ['Select the authoritative encrypted checkpoint','failure'],
  ['Download exactly the selected encrypted artifact','skipped'],
  ['Validate exact downloaded file shape and authenticate state','skipped'],
  ['Preserve the resumed checkpoint before retrying pending notices','skipped'],
  ['Retry previously checkpointed pending notices','skipped'],
  ['Observe current health and prepare the next encrypted state','skipped'],
  ['Commit prepared notices before sending new mail','skipped'],
  ['Deliver newly checkpointed incident or recovery notices','skipped'],
  ['Commit the delivered checkpoint','skipped'],
  ['Read dependencies without incident state or email','skipped'],
  ['Deliver approved test notices with a frozen identity and timestamp','skipped'],
  ['Post Run actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020','skipped'],
  ['Post Run actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683','success'],
  ['Complete job','success'],
].map(([name,conclusion],index)=>({number:index<14?index+1:index+13,name,status:'completed',conclusion}))}]});

test('selects latest stateful main run by run number and ignores newer probes or drills',async()=>{
  const {fetcher,calls}=transport([run(28,'probe'),run(30),run(26),run(29,'delivery-drill'),run(27)], [artifact(101)]);
  assert.deepEqual(await selectMonitorArtifact(options,fetcher),{artifactId:101,runId:27,name:'folio-monitor-state-v1-1-delivered'});
  assert.ok(calls[1].includes('/runs/27/'));assert.equal(calls.length,2);
});

test('highest attempt wins before delivered then prepared then resumed phase order',async()=>{
  for(const [artifacts,expected]of [[ [artifact(1,1,'delivered'),artifact(2,2,'resumed')],2],[[artifact(1,2,'prepared'),artifact(2,2,'delivered'),artifact(3,2,'resumed')],2],[[artifact(1,2,'resumed'),artifact(2,2,'prepared')],2]] as const){
    const fixture=transport([run(30),run(29,'run',2)],[...artifacts]);assert.equal((await selectMonitorArtifact(options,fixture.fetcher))?.artifactId,expected);
  }
});

test('rerun resumes highest available earlier attempt in the same run only',async()=>{
  const fixture=transport([run(30,'run',4),run(29)],[artifact(101,1),artifact(102,2,'prepared')]);
  assert.deepEqual(await selectMonitorArtifact({...options,runAttempt:4},fixture.fetcher),{artifactId:102,runId:30,name:'folio-monitor-state-v1-2-prepared'});
  assert.ok(fixture.calls[1].endsWith('/runs/30/attempts/3'));assert.ok(fixture.calls[2].includes('/runs/30/artifacts'));
});

test('successful prior run requires its latest-attempt delivered checkpoint',async()=>{
  for(const artifacts of [[artifact(1,1,'delivered')],[artifact(1,2,'prepared')],[artifact(1,2,'resumed')]]){
    const fixture=transport([run(30),{...run(29,'run',2),conclusion:'success'}],artifacts);
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/successful_monitor_checkpoint_missing/);
  }
  const fixture=transport([run(30),{...run(29,'run',2),conclusion:'success'}],[artifact(1,2,'delivered')]);assert.equal((await selectMonitorArtifact(options,fixture.fetcher))?.artifactId,1);
});

test('rerun checks prior attempt conclusion so a deleted successful checkpoint cannot roll back',async()=>{
  const fixture=transport([run(30,'run',3),run(29)],[artifact(1,1),artifact(2,2,'prepared')],{previousConclusion:'success'});
  await assert.rejects(selectMonitorArtifact({...options,runAttempt:3},fixture.fetcher),/successful_monitor_checkpoint_missing/);
  const valid=transport([run(30,'run',3),run(29)],[artifact(1,2)],{previousConclusion:'success'});assert.equal((await selectMonitorArtifact({...options,runAttempt:3},valid.fetcher))?.artifactId,1);
});

test('a historical rerun cannot roll back a newer stateful run',async()=>{
  const fixture=transport([run(31),run(30,'run',2)],[artifact(101)]);
  await assert.rejects(selectMonitorArtifact({...options,runAttempt:2},fixture.fetcher),/monitor_run_superseded/);assert.equal(fixture.calls.length,1);
});

test('missing latest checkpoint refuses fallback to an older run, including initialize',async()=>{
  for(const initialize of [false,true]){const fixture=transport([run(30),run(29),run(28)],[]);await assert.rejects(selectMonitorArtifact({...options,initialize},fixture.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(fixture.calls.length,3);assert.ok(fixture.calls[1].includes('/runs/29/'));assert.ok(fixture.calls[2].includes('/runs/29/attempts/1/jobs'));}
});

test('a chain of proven selector-only failures resumes the latest untouched encrypted checkpoint',async()=>{
  const skipped:number[]=[],fixture=transport([run(30),run(29),run(28),{...run(27),conclusion:'success'}],[],{
    jobs:{29:selectorFailedJob(29),28:selectorFailedJob(28)},artifactsByRun:{27:[artifact(101)]},
  });
  assert.deepEqual(await selectMonitorArtifact({...options,onSkippedRun:id=>skipped.push(id)},fixture.fetcher),{artifactId:101,runId:27,name:'folio-monitor-state-v1-1-delivered'});
  assert.deepEqual(skipped,[29,28]);assert.equal(fixture.calls.length,8);assert.ok(fixture.calls[7].includes('/runs/27/artifacts'));
  assert.equal(fixture.calls.filter(url=>url.includes('/contents/')).length,2);
});

test('the observed eighteen-failure cascade remains within the bounded history and uses one source proof',async()=>{
  const failed=Array.from({length:18},(_,index)=>29-index),skipped:number[]=[],jobs=Object.fromEntries(failed.map(id=>[id,selectorFailedJob(id)]));
  const fixture=transport([run(30),...failed.map(id=>run(id)),{...run(11),conclusion:'success'}],[],{jobs,artifactsByRun:{11:[artifact(101)]}});
  assert.equal((await selectMonitorArtifact({...options,onSkippedRun:id=>skipped.push(id)},fixture.fetcher))?.runId,11);
  assert.deepEqual(skipped,failed);assert.equal(fixture.calls.length,40);assert.equal(fixture.calls.filter(url=>url.includes('/contents/')).length,2);
});

test('a valid latest checkpoint does not inspect irrelevant older unrecognized modes',async()=>{
  const fixture=transport([run(30),run(29),run(28,'unrecognized')],[artifact(101)]);
  assert.equal((await selectMonitorArtifact(options,fixture.fetcher))?.runId,29);assert.equal(fixture.calls.length,2);
});

test('familiar step names cannot bypass drifted immutable workflow or selector commands',async()=>{
  for(const sourcePath of ['.github/workflows/operations-monitor.yml','scripts/monitor-artifact-state.ts']){
    const fixture=transport([run(30),run(29),run(28)],[],{jobs:{29:selectorFailedJob(29)},artifactsByRun:{28:[artifact(101)]},sourceOverrides:{[sourcePath]:'// synthetic modified command: send alerts before selector failure'}});
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/artifact_selector_source_untrusted/);
    assert.ok(!fixture.calls.some(url=>url.includes('/runs/28/')));
  }
});

test('source proof is cached per immutable commit, not across different run heads',async()=>{
  const otherHead='a'.repeat(40),olderJob=selectorFailedJob(28);olderJob.jobs[0].head_sha=otherHead;
  const fixture=transport([run(30),run(29),{...run(28),head_sha:otherHead},{...run(27),conclusion:'success'}],[],{jobs:{29:selectorFailedJob(29),28:olderJob},artifactsByRun:{27:[artifact(101)]}});
  assert.equal((await selectMonitorArtifact(options,fixture.fetcher))?.runId,27);
  assert.equal(fixture.calls.filter(url=>url.includes('/contents/')).length,4);
});

test('selector-only failure exemption never initializes or searches beyond bounded history',async()=>{
  for(const initialize of [false,true]){
    const fixture=transport([run(30),run(29)],[],{jobs:{29:selectorFailedJob(29)}});
    await assert.rejects(selectMonitorArtifact({...options,initialize},fixture.fetcher),/latest_monitor_checkpoint_missing/);
    const incomplete=transport([run(30),run(29)],[],{jobs:{29:selectorFailedJob(29)},totalRuns:31});
    await assert.rejects(selectMonitorArtifact({...options,initialize},incomplete.fetcher),/artifact_history_incomplete/);
  }
});

test('deleted checkpoints cannot fall through once download, state work or delivery began',async()=>{
  for(const index of [4,5,6,7,8,9,10,11]){
    const metadata=selectorFailedJob(29);metadata.jobs[0].steps[index].conclusion='success';
    const fixture=transport([run(30),run(29),run(28)],[],{jobs:{29:metadata},artifactsByRun:{28:[artifact(101)]}});
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);
    assert.equal(fixture.calls.length,3);assert.ok(!fixture.calls.some(url=>url.includes('/runs/28/')));
  }
});

test('selector-only recovery requires exact complete single-job scope and step order',async()=>{
  const mutations:Array<(value:ReturnType<typeof selectorFailedJob>)=>void>=[
    value=>{value.total_count=2;},
    value=>{value.jobs.push(structuredClone(value.jobs[0]));},
    value=>{value.jobs[0].run_id=28;},
    value=>{value.jobs[0].run_attempt=2;},
    value=>{value.jobs[0].head_sha='a'.repeat(40);},
    value=>{value.jobs[0].name='other';},
    value=>{value.jobs[0].status='in_progress';},
    value=>{value.jobs[0].conclusion='success';},
    value=>{value.jobs[0].steps.pop();},
    value=>{value.jobs[0].steps[4].name='Unknown state step';},
    value=>{[value.jobs[0].steps[5],value.jobs[0].steps[6]]=[value.jobs[0].steps[6],value.jobs[0].steps[5]];},
    value=>{value.jobs[0].steps[4].number=4;},
    value=>{value.jobs[0].steps[3].conclusion='success';},
    value=>{value.jobs[0].steps[4].status='in_progress';},
  ];
  for(const mutate of mutations){
    const metadata=selectorFailedJob(29);mutate(metadata);
    const fixture=transport([run(30),run(29),run(28)],[],{jobs:{29:metadata},artifactsByRun:{28:[artifact(101)]}});
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(fixture.calls.length,3);
  }
});

test('unrelated artifacts, reruns and a still-running predecessor remain authoritative',async()=>{
  const unrelated=transport([run(30),run(29),run(28)],[artifact(102,1,'delivered',{name:'other-artifact'})],{jobs:{29:selectorFailedJob(29)}});
  await assert.rejects(selectMonitorArtifact(options,unrelated.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(unrelated.calls.length,2);
  const priorRerun=transport([run(30),run(29,'run',2),run(28)],[],{jobs:{29:selectorFailedJob(29)}});
  await assert.rejects(selectMonitorArtifact(options,priorRerun.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(priorRerun.calls.length,2);
  const currentRerun=transport([run(30,'run',2),run(29)],[],{jobs:{30:selectorFailedJob(30)}});
  await assert.rejects(selectMonitorArtifact({...options,runAttempt:2},currentRerun.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(currentRerun.calls.length,3);
  const running=transport([run(30),{...run(29),status:'in_progress',conclusion:null},run(28)],[],{jobs:{29:selectorFailedJob(29)}});
  await assert.rejects(selectMonitorArtifact(options,running.fetcher),/prior_monitor_run_incomplete/);assert.equal(running.calls.length,1);
});

test('a selector-only failure cannot bypass an expired or deleted successful checkpoint',async()=>{
  for(const items of [[],[artifact(101,1,'delivered',{expired:true})]]){
    const fixture=transport([run(30),run(29),{...run(28),conclusion:'success'},run(27)],[],{jobs:{29:selectorFailedJob(29)},artifactsByRun:{28:items,27:[artifact(102)]}});
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_(missing|expired)/);
    assert.ok(!fixture.calls.some(url=>url.includes('/runs/27/')));
  }
});

test('expired authoritative generation refuses fallback to a valid older phase or attempt',async()=>{
  const fixture=transport([run(30),run(29,'run',2)],[artifact(1,1),artifact(2,2,'prepared'),artifact(3,2,'delivered',{expired:true})]);
  await assert.rejects(selectMonitorArtifact({...options,initialize:true},fixture.fetcher),/latest_monitor_checkpoint_expired/);
});

test('only explicit first-ever initialization accepts completely enumerated empty stateful history',async()=>{
  const fixture=transport([run(30,'initialize'),run(29,'probe'),run(28,'delivery-drill')],[]);
  assert.equal(await selectMonitorArtifact({...options,initialize:true},fixture.fetcher),null);assert.equal(fixture.calls.length,1);
  await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/monitor_state_missing_requires_reconciliation/);
});

test('disabled schedules and disabled manual runs cannot block initial state or replace active history',async()=>{
  const inactive={...run(29,'disabled'),conclusion:'skipped'};
  const first=transport([run(30,'initialize'),inactive],[]);assert.equal(await selectMonitorArtifact({...options,initialize:true},first.fetcher),null);assert.equal(first.calls.length,1);
  const later=transport([run(30),inactive,run(28)],[artifact(101)]);assert.equal((await selectMonitorArtifact(options,later.fetcher))?.runId,28);assert.ok(later.calls[1].includes('/runs/28/'));
});

test('initialize preserves an existing checkpoint instead of replacing it',async()=>{
  const fixture=transport([run(30,'initialize'),run(29)],[artifact(101)]);
  assert.equal((await selectMonitorArtifact({...options,initialize:true},fixture.fetcher))?.artifactId,101);
});

test('bounded history cannot silently hide an older stateful run during initialization',async()=>{
  const fixture=transport([run(30,'initialize'),run(29,'probe')],[],{totalRuns:31});
  await assert.rejects(selectMonitorArtifact({...options,initialize:true},fixture.fetcher),/artifact_history_incomplete/);assert.equal(fixture.calls.length,1);
});

test('duplicate artifact generations and duplicate IDs are ambiguous even if one is expired',async()=>{
  for(const artifacts of [[artifact(1),artifact(2,1,'delivered',{expired:true})],[artifact(1),artifact(1,1,'prepared')]]){
    const fixture=transport([run(30),run(29)],artifacts);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/artifact_generation_ambiguous/);
  }
});

test('truncated artifact listing and invalid checkpoint names never choose a partial result',async()=>{
  const fixture=transport([run(30),run(29)],[artifact(1)],{totalArtifacts:101});await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/artifact_history_incomplete/);
  for(const name of ['folio-monitor-state-v1-0-prepared','folio-monitor-state-v1-1-unknown','folio-monitor-state-v1-01-prepared','folio-monitor-state-v1-9007199254740992-prepared']){
    const broken=transport([run(30),run(29)],[artifact(1,1,'delivered',{name})]);await assert.rejects(selectMonitorArtifact(options,broken.fetcher),/artifact_generation_invalid/);
  }
});

test('artifact generation, payload size and optional run binding are validated',async()=>{
  for(const item of [artifact(1,2),artifact(1,1,'delivered',{size_in_bytes:0}),artifact(1,1,'delivered',{size_in_bytes:1024*1024+1}),artifact(1,1,'delivered',{workflow_run:{id:28,head_branch:'main'}}),artifact(1,1,'delivered',{workflow_run:{id:29,head_branch:'foreign'}})]){
    const fixture=transport([run(30),run(29)],[item]);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/artifact_(generation_invalid|payload_limit|scope_invalid)/);
  }
});

test('duplicate runs, foreign repository or branch and unknown stateful titles fail closed',async()=>{
  for(const runs of [[run(30),run(29),run(29)],[run(30),{...run(29),head_sha:'invalid'}],[run(30),{...run(29),head_branch:'branch'}],[run(30),{...run(29),head_repository:{full_name:'foreign/repo'}}],[run(30),run(29,'unrecognized')]]){
    const fixture=transport(runs,[artifact(1)]);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/artifact_(runs_ambiguous|runs_invalid|run_unrecognized)/);
  }
});

test('requires exact current generation and refuses a still running prior monitor',async()=>{
  for(const patch of [{runId:31},{runAttempt:2},{runNumber:31}]){const fixture=transport([run(30),run(29)],[artifact(1)]);await assert.rejects(selectMonitorArtifact({...options,...patch},fixture.fetcher),/artifact_current_run_invalid/);}
  const fixture=transport([run(30),{...run(29),status:'in_progress'}],[artifact(1)]);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/prior_monitor_run_incomplete/);
});

test('fixed GitHub GET failures, malformed JSON and oversized bodies expose only safe codes',async()=>{
  for(const response of [new Response('private token',{status:302,headers:{location:'https://foreign.test'}}),new Response('private token',{status:401}),new Response('{broken'),new Response('x'.repeat(1024*1024+1)),new Response('{}',{headers:{'content-length':String(1024*1024+1)}})]){
    await assert.rejects(selectMonitorArtifact(options,async()=>response),error=>error instanceof Error&&/^artifact_/.test(error.message)&&!error.message.includes('private'));
  }
  await assert.rejects(selectMonitorArtifact(options,async()=>{throw new Error('private token');}),/artifact_api_unavailable/);
});

test('overall deadline bounds a noncooperative transport and prevents late API continuation',async()=>{
  let release!:(response:Response)=>void,calls=0;const held=new Promise<Response>(resolve=>{release=resolve;});
  const fixture:typeof fetch=async()=>{calls++;return held;};
  await assert.rejects(selectMonitorArtifact({...options,timeoutMs:10},fixture),/artifact_api_timeout/);
  release(Response.json({total_count:2,workflow_runs:[run(30),run(29)]}));await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('CLI emits only exact artifact identifiers and performs no archive download',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-selector-')),output=path.join(directory,'output');const original=globalThis.fetch;
  const fixture=transport([run(30),run(29)],[artifact(101)]);globalThis.fetch=fixture.fetcher;
  const env={GH_TOKEN:options.token,GITHUB_REPOSITORY:repo,GITHUB_REF:'refs/heads/main',GITHUB_OUTPUT:output,GITHUB_RUN_ID:'30',GITHUB_RUN_NUMBER:'30',GITHUB_RUN_ATTEMPT:'1'};
  try{await main([],env);assert.equal(await fs.readFile(output,'utf8'),'artifact_id=101\nrun_id=29\nartifact_name=folio-monitor-state-v1-1-delivered\n');assert.equal(fixture.calls.length,2);await assert.rejects(main([],{...env,GITHUB_REF:'refs/heads/foreign'}),/artifact_environment_invalid/);await assert.rejects(main(['--anything'],env),/artifact_arguments_invalid/);assert.equal(fixture.calls.length,2);}
  finally{globalThis.fetch=original;await fs.rm(directory,{recursive:true,force:true});}
});

test('CLI first-ever initialize emits empty identifiers without concealing missing normal state',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-initialize-')),output=path.join(directory,'output');const original=globalThis.fetch;
  globalThis.fetch=transport([run(30,'initialize')],[]).fetcher;
  const env={GH_TOKEN:options.token,GITHUB_REPOSITORY:repo,GITHUB_REF:'refs/heads/main',GITHUB_OUTPUT:output,GITHUB_RUN_ID:'30',GITHUB_RUN_NUMBER:'30',GITHUB_RUN_ATTEMPT:'1'};
  try{await assert.rejects(main([],env),/monitor_state_missing_requires_reconciliation/);await main(['--initialize'],env);assert.equal(await fs.readFile(output,'utf8'),'artifact_id=\nrun_id=\nartifact_name=\n');}
  finally{globalThis.fetch=original;await fs.rm(directory,{recursive:true,force:true});}
});
