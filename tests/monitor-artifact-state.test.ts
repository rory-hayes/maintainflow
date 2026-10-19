import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {selectMonitorArtifact,main,ArtifactStateError,type SelectionOptions} from '../scripts/monitor-artifact-state.js';

const repo='rory-hayes/maintainflow',root=`https://api.github.com/repos/${repo}/actions`;
const options:SelectionOptions={token:'synthetic_owned_github_token',runId:30,runNumber:30,runAttempt:1};
const fixtureHead='ab34186f3619dff95b0cbd623352114e6b3a3dab';
const run=(id:number,mode='run',attempt=1)=>({id,run_number:id,run_attempt:attempt,display_title:`Folio monitor: ${mode}`,head_sha:fixtureHead,head_branch:'main',event:'workflow_dispatch',status:id===30?'in_progress':'completed',conclusion:id===30?null:'failure',repository:{full_name:repo},head_repository:{full_name:repo}});
const artifact=(id:number,attempt=1,phase='delivered',extra:Record<string,unknown>={})=>({id,name:`folio-monitor-state-v1-${attempt}-${phase}`,expired:false,size_in_bytes:512,...extra});
function transport(runs:ReturnType<typeof run>[],artifacts:ReturnType<typeof artifact>[],extra:{totalRuns?:number;runPages?:Record<number,{total_count:number;workflow_runs:ReturnType<typeof run>[]}>;totalArtifacts?:number;previousConclusion?:string;attempts?:Record<string,unknown>;jobs?:Record<number,unknown>;artifactsByRun?:Record<number,ReturnType<typeof artifact>[]>;sourceOverrides?:Record<string,string>;checkRuns?:Record<number,unknown>;annotations?:Record<number,unknown>}={}){
  const calls:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);calls.push(url);assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),`Bearer ${options.token}`);assert.equal(headers.get('x-github-api-version'),'2022-11-28');
    const attempt=/\/runs\/(\d+)\/attempts\/(\d+)$/.exec(url);
    const jobs=/\/runs\/(\d+)\/attempts\/1\/jobs\?per_page=100$/.exec(url);
    const source=new RegExp(`^https://api.github.com/repos/${repo}/contents/(\\.github/workflows/operations-monitor\\.yml|scripts/monitor-artifact-state\\.ts)\\?ref=[0-9a-f]{40}$`).exec(url);
    const check=new RegExp(`^https://api.github.com/repos/${repo}/check-runs/([1-9][0-9]*)(/annotations\\?per_page=100)?$`).exec(url);
    const page=new RegExp(`^${root}/workflows/operations-monitor\\.yml/runs\\?branch=main&per_page=30&page=([1-9][0-9]*)$`).exec(url);
    assert.ok(url===`${root}/workflows/operations-monitor.yml/runs?branch=main&per_page=30`||page||new RegExp(`^${root}/runs/[0-9]+/artifacts\\?per_page=100$`).test(url)||attempt||jobs||source||check);
    if(page){const value=extra.runPages?.[Number(page[1])];assert.ok(value,'unexpected history page');return Response.json(value);}
    if(check)return Response.json(check[2]?extra.annotations?.[Number(check[1])]??[]:extra.checkRuns?.[Number(check[1])]??{});
    if(source){const sourcePath=source[1],bytes=extra.sourceOverrides?.[sourcePath]??await fs.readFile(new URL(`../${sourcePath}`,import.meta.url),'utf8');return Response.json({type:'file',path:sourcePath,encoding:'base64',content:Buffer.from(bytes).toString('base64')});}
    if(attempt){const key=`${attempt[1]}/${attempt[2]}`;return Response.json(extra.attempts&&Object.hasOwn(extra.attempts,key)?extra.attempts[key]:{...runs.find(r=>r.id===Number(attempt[1]))!,run_attempt:Number(attempt[2]),status:'completed',conclusion:extra.previousConclusion??'failure'});}
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

const supersededJob=(runId:number)=>{
  const value=selectorFailedJob(runId),job=value.jobs[0];
  job.conclusion='success';job.steps[3].conclusion='success';
  return {total_count:1,jobs:[{...job,id:1000+runId}]};
};

test('selects latest stateful main run by run number and ignores newer probes or drills',async()=>{
  const {fetcher,calls}=transport([run(28,'probe'),run(30),run(26),run(29,'delivery-drill'),run(27)], [artifact(101)]);
  assert.deepEqual(await selectMonitorArtifact(options,fetcher),{artifactId:101,runId:27,name:'folio-monitor-state-v1-1-delivered'});
  assert.ok(calls[1].includes('/runs/27/'));assert.equal(calls.length,2);
});

test('an empty external tick title still requires exact pre-state failure proof before recovery',async()=>{
  const fixture=transport([run(30),run(29,'external-run'),{...run(28),conclusion:'success'}],[],{
    jobs:{29:selectorFailedJob(29)},artifactsByRun:{28:[artifact(101)]},
  });
  assert.equal((await selectMonitorArtifact(options,fixture.fetcher))?.runId,28);
  const unproven=transport([run(30),run(29,'external-run'),run(28)],[]);
  await assert.rejects(selectMonitorArtifact(options,unproven.fetcher),/latest_monitor_checkpoint_missing/);
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

test('a proven successful superseded first attempt resumes the previous untouched checkpoint',async()=>{
  const skipped:Array<[number,string]>=[];
  const fixture=transport([run(30),{...run(29),conclusion:'success'},{...run(28),conclusion:'success'}],[],{
    jobs:{29:supersededJob(29)},artifactsByRun:{28:[artifact(101)]},
  });
  assert.deepEqual(await selectMonitorArtifact({...options,onSkippedRun:(id,reason)=>skipped.push([id,reason])},fixture.fetcher),
    {artifactId:101,runId:28,name:'folio-monitor-state-v1-1-delivered'});
  assert.deepEqual(skipped,[[29,'run_superseded_before_state']]);
  assert.equal(fixture.calls.filter(url=>url.includes('/contents/')).length,2);
});

test('success without a checkpoint never bypasses state work, ambiguous metadata or a missing prior checkpoint',async()=>{
  const mutations:Array<(value:ReturnType<typeof supersededJob>)=>void>=[
    value=>{value.total_count=2;},value=>{value.jobs[0].run_id=28;},value=>{value.jobs[0].run_attempt=2;},
    value=>{value.jobs[0].head_sha='a'.repeat(40);},value=>{value.jobs[0].steps[3].conclusion='skipped';},
    value=>{value.jobs[0].steps.pop();},value=>{value.jobs[0].steps[4].name='unrecognized';},
    ...Array.from({length:10},(_,index)=>(value:ReturnType<typeof supersededJob>)=>{value.jobs[0].steps[index+4].conclusion='success';}),
  ];
  for(const mutate of mutations){
    const jobs=supersededJob(29);mutate(jobs);
    const fixture=transport([run(30),{...run(29),conclusion:'success'},run(28)],[],{jobs:{29:jobs},artifactsByRun:{28:[artifact(101)]}});
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);
    assert.ok(!fixture.calls.some(url=>url.includes('/runs/28/')));
  }
  const missing=transport([run(30),{...run(29),conclusion:'success'},{...run(28),conclusion:'success'}],[],{jobs:{29:supersededJob(29)}});
  await assert.rejects(selectMonitorArtifact({...options,initialize:true},missing.fetcher),/latest_monitor_checkpoint_missing/);
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

test('more than thirty proven harmless failures resume the latest checkpoint across complete history pages',async()=>{
  const current={...run(80),status:'in_progress',conclusion:null};
  const failed=Array.from({length:35},(_,index)=>79-index),jobs=Object.fromEntries(failed.map(id=>[id,selectorFailedJob(id)]));
  for(const phase of ['delivered','prepared']){
    const checkpoint={...run(44),conclusion:phase==='delivered'?'success':'failure'};
    const all=[current,...failed.map(id=>run(id)),checkpoint,{...run(43),conclusion:'success'}],skipped:number[]=[];
    const fixture=transport(all.slice(0,30),[],{totalRuns:all.length,runPages:{2:{total_count:all.length,workflow_runs:all.slice(30)}},jobs,
      artifactsByRun:{44:[artifact(101,1,phase)],43:[artifact(102)]}});
    assert.deepEqual(await selectMonitorArtifact({...options,runId:80,runNumber:80,onSkippedRun:id=>skipped.push(id)},fixture.fetcher),
      {artifactId:101,runId:44,name:`folio-monitor-state-v1-1-${phase}`});
    assert.deepEqual(skipped,failed);assert.equal(fixture.calls.filter(url=>url.includes('/contents/')).length,2);
    const secondPage=fixture.calls.findIndex(url=>url.endsWith('&page=2'));
    assert.ok(secondPage>fixture.calls.findIndex(url=>url.includes('/runs/51/attempts/1/jobs')));
    assert.ok(secondPage<fixture.calls.findIndex(url=>url.includes('/runs/50/artifacts')));
    assert.ok(!fixture.calls.some(url=>url.includes('/runs/43/')));
  }
});

test('pagination never crosses an unproven stateful failure or a missing authoritative checkpoint',async()=>{
  const current={...run(80),status:'in_progress',conclusion:null},failed=Array.from({length:29},(_,index)=>79-index);
  const jobs=Object.fromEntries(failed.map(id=>[id,selectorFailedJob(id)])),first=[current,...failed.map(id=>run(id))];
  for(const firstPageFailure of [true,false]){
    const fixture=transport(first,[],{totalRuns:32,runPages:{2:{total_count:32,workflow_runs:[{...run(50),conclusion:'success'},run(49)]}},
      jobs:{...jobs,...(firstPageFailure?{51:{total_count:0,jobs:[]}}:{})},artifactsByRun:{49:[artifact(102)]}});
    await assert.rejects(selectMonitorArtifact({...options,runId:80,runNumber:80,initialize:true},fixture.fetcher),/latest_monitor_checkpoint_missing/);
    assert.equal(fixture.calls.some(url=>url.endsWith('&page=2')),!firstPageFailure);
    assert.ok(!fixture.calls.some(url=>url.includes('/runs/49/')));
  }
});

test('changed totals, incomplete pages, cross-page duplicate identities and newer run order fail closed',async()=>{
  const current={...run(80),status:'in_progress',conclusion:null},failed=Array.from({length:29},(_,index)=>79-index);
  const first=[current,...failed.map(id=>run(id))],older=Array.from({length:6},(_,index)=>run(50-index));
  const jobs=Object.fromEntries(failed.map(id=>[id,selectorFailedJob(id)]));
  const cases=[
    {total_count:37,workflow_runs:older},
    {total_count:35,workflow_runs:older},
    {total_count:36,workflow_runs:older.slice(0,5)},
    {total_count:36,workflow_runs:[]},
    {total_count:36,workflow_runs:[{...older[0],id:51},...older.slice(1)]},
    {total_count:36,workflow_runs:[{...older[0],run_number:51},...older.slice(1)]},
    {total_count:36,workflow_runs:[{...older[0],id:90,run_number:90},...older.slice(1)]},
  ];
  for(const page of cases){
    const fixture=transport(first,[],{totalRuns:36,runPages:{2:page},jobs,artifactsByRun:{50:[artifact(101)]}});
    await assert.rejects(selectMonitorArtifact({...options,runId:80,runNumber:80},fixture.fetcher),/artifact_(history_incomplete|runs_ambiguous|runs_invalid)/);
    assert.ok(fixture.calls.at(-1)?.endsWith('&page=2'));assert.ok(!fixture.calls.some(url=>url.includes('/runs/50/')));
  }
});

test('the ten-page three-hundred-run cap refuses hidden state instead of initializing or requesting page eleven',async()=>{
  const all=Array.from({length:301},(_,index)=>index===0?{...run(400,'initialize'),status:'in_progress',conclusion:null}:run(400-index,'probe'));
  all[300]=run(100);
  const runPages=Object.fromEntries(Array.from({length:10},(_,index)=>[index+2,{total_count:all.length,workflow_runs:all.slice((index+1)*30,(index+2)*30)}]));
  const fixture=transport(all.slice(0,30),[],{totalRuns:all.length,runPages});
  await assert.rejects(selectMonitorArtifact({...options,runId:400,runNumber:400,initialize:true},fixture.fetcher),/artifact_history_incomplete/);
  assert.equal(fixture.calls.length,10);assert.ok(fixture.calls.at(-1)?.endsWith('&page=10'));
  assert.ok(!fixture.calls.some(url=>url.endsWith('&page=11')||url.includes('/artifacts')));
});

test('pagination shares the original deadline and late pages cannot continue checkpoint selection',async()=>{
  const current={...run(80),status:'in_progress',conclusion:null},failed=Array.from({length:29},(_,index)=>79-index);
  const jobs=Object.fromEntries(failed.map(id=>[id,selectorFailedJob(id)]));
  const fixture=transport([current,...failed.map(id=>run(id))],[],{totalRuns:31,jobs,artifactsByRun:{50:[artifact(101)]}});
  let release!:(response:Response)=>void,pages=0;const held=new Promise<Response>(resolve=>{release=resolve;});
  const fetcher:typeof fetch=async(input,init)=>{if(String(input).endsWith('&page=2')){pages++;return held;}return fixture.fetcher(input,init);};
  await assert.rejects(selectMonitorArtifact({...options,runId:80,runNumber:80,timeoutMs:500},fetcher),/artifact_api_timeout/);
  assert.equal(pages,1);release(Response.json({total_count:31,workflow_runs:[{...run(50),conclusion:'success'}]}));
  await new Promise(resolve=>setImmediate(resolve));assert.ok(!fixture.calls.some(url=>url.includes('/runs/50/')));
});

test('natural and external monitor triggers share one authoritative checkpoint pipeline in either direction',async()=>{
  const title='Folio monitor: external-run 2026-10-17T14:22:00.000Z';
  for(const externalCurrent of [true,false]){
    const current={...run(30),event:externalCurrent?'workflow_dispatch':'schedule',display_title:externalCurrent?title:'Folio monitor: run'};
    const prior={...run(29),event:externalCurrent?'schedule':'workflow_dispatch',display_title:externalCurrent?'Folio monitor: run':title,conclusion:'success'};
    const fixture=transport([current,prior],[artifact(101)]);
    assert.deepEqual(await selectMonitorArtifact(options,fixture.fetcher),{artifactId:101,runId:29,name:'folio-monitor-state-v1-1-delivered'});
  }
  const superseded=transport([{...run(31),display_title:title},run(30)],[artifact(101)]);
  await assert.rejects(selectMonitorArtifact(options,superseded.fetcher),/monitor_run_superseded/);
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
  const runningRun={...run(29),status:'in_progress',conclusion:null};
  const running=transport([run(30),runningRun,run(28)],[],{jobs:{29:selectorFailedJob(29)},attempts:{'29/1':runningRun}});
  await assert.rejects(selectMonitorArtifact(options,running.fetcher),/prior_monitor_run_incomplete/);assert.equal(running.calls.length,2);
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
  const prior={...run(29),status:'in_progress'};
  const fixture=transport([run(30),prior],[artifact(1)],{attempts:{'29/1':prior}});await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/prior_monitor_run_incomplete/);
});

test('a stale prior first-attempt list status refreshes once and still requires its delivered checkpoint',async()=>{
  const prior={...run(29),status:'in_progress',conclusion:null};
  const fresh={...prior,status:'completed',conclusion:'success'};
  const fixture=transport([run(30),prior],[artifact(101)],{attempts:{'29/1':fresh}});
  assert.deepEqual(await selectMonitorArtifact(options,fixture.fetcher),{artifactId:101,runId:29,name:'folio-monitor-state-v1-1-delivered'});
  assert.deepEqual(fixture.calls,[`${root}/workflows/operations-monitor.yml/runs?branch=main&per_page=30`,`${root}/runs/29/attempts/1`,`${root}/runs/29/artifacts?per_page=100`]);
  for(const artifacts of [[artifact(101,1,'prepared')],[artifact(101,1,'delivered',{expired:true})]]){
    const refused=transport([run(30),prior],artifacts,{attempts:{'29/1':fresh}});
    await assert.rejects(selectMonitorArtifact(options,refused.fetcher),/successful_monitor_checkpoint_missing|latest_monitor_checkpoint_expired/);
    assert.equal(refused.calls.length,3);
  }
});

test('a refreshed completed failure crosses no checkpoint boundary without exact pre-state proof',async()=>{
  const prior={...run(29),status:'queued',conclusion:null},fresh={...prior,status:'completed',conclusion:'failure'};
  const fixture=transport([run(30),prior,{...run(28),conclusion:'success'}],[],{attempts:{'29/1':fresh},jobs:{29:selectorFailedJob(29)},artifactsByRun:{28:[artifact(101)]}});
  assert.equal((await selectMonitorArtifact(options,fixture.fetcher))?.runId,28);
  assert.equal(fixture.calls.filter(url=>url===`${root}/runs/29/attempts/1`).length,1);
  assert.ok(fixture.calls.indexOf(`${root}/runs/29/attempts/1/jobs?per_page=100`)<fixture.calls.indexOf(`${root}/runs/28/artifacts?per_page=100`));
  const refused=transport([run(30),prior,run(28)],[],{attempts:{'29/1':fresh},artifactsByRun:{28:[artifact(101)]}});
  await assert.rejects(selectMonitorArtifact(options,refused.fetcher),/latest_monitor_checkpoint_missing/);
  assert.ok(!refused.calls.some(url=>url.includes('/runs/28/')));
});

test('a still incomplete exact prior run refuses all state access and reports only bounded identity and status',async()=>{
  for(const status of ['queued','in_progress','waiting','pending','requested','completed','private-token-status']){
    const prior={...run(29),status:'in_progress',conclusion:null},fresh={...prior,status};
    const fixture=transport([run(30),prior,run(28)],[artifact(101)],{attempts:{'29/1':fresh}});
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),error=>{
      assert.ok(error instanceof ArtifactStateError);assert.equal(error.code,'prior_monitor_run_incomplete');
      assert.deepEqual(error.priorRun,{priorRunId:29,priorRunAttempt:1,priorRunStatus:status==='private-token-status'?'unrecognized':status});
      const serialized=JSON.stringify(error);assert.ok(!serialized.includes('private-token')&&!serialized.includes(fixtureHead)&&!serialized.includes(options.token)&&!serialized.includes('Folio monitor'));
      return true;
    });
    assert.equal(fixture.calls.length,2);assert.ok(fixture.calls[1].endsWith('/runs/29/attempts/1'));
  }
});

test('exact status refresh rejects changed immutable identity, later attempts and malformed responses before artifacts',async()=>{
  const prior={...run(29),status:'in_progress',conclusion:null},fresh={...prior,status:'completed',conclusion:'success'};
  const conflicts=[{id:28},{run_number:28},{run_attempt:2},{head_sha:'c'.repeat(40)},{head_branch:'foreign'},{display_title:'Folio monitor: probe'},{event:'schedule'},{repository:{full_name:'foreign/repo'}},{head_repository:{full_name:'foreign/repo'}}];
  const malformed=[null,[],{}, {...fresh,id:'29'}, {...fresh,run_number:0}, {...fresh,head_sha:null}, {...fresh,status:null}, {...fresh,conclusion:42}, {...fresh,repository:null}, {...fresh,head_repository:null}];
  for(const response of [...conflicts.map(patch=>({...fresh,...patch})),...malformed]){
    const fixture=transport([run(30),prior,run(28)],[artifact(101)],{attempts:{'29/1':response}});
    await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/artifact_run_refresh_conflict|artifact_runs_invalid/);
    assert.equal(fixture.calls.length,2);
  }
});

test('exact status refresh API errors and the shared deadline refuse late artifact continuation',async()=>{
  const prior={...run(29),status:'in_progress',conclusion:null};
  for(const response of [new Response('private token',{status:503}),new Response('{private token'),new Response('x'.repeat(1024*1024+1))]){
    const fixture=transport([run(30),prior],[artifact(101)]);let refreshes=0;
    const fetcher:typeof fetch=async(input,init)=>{if(String(input).endsWith('/runs/29/attempts/1')){refreshes++;return response;}return fixture.fetcher(input,init);};
    await assert.rejects(selectMonitorArtifact(options,fetcher),error=>error instanceof Error&&/^artifact_/.test(error.message)&&!error.message.includes('private'));
    assert.equal(refreshes,1);assert.equal(fixture.calls.length,1);
  }
  const fixture=transport([run(30),prior],[artifact(101)]);let release!:(value:Response)=>void,refreshes=0,signal:AbortSignal|undefined;
  const held=new Promise<Response>(resolve=>{release=resolve;});
  const fetcher:typeof fetch=async(input,init)=>{if(String(input).endsWith('/runs/29/attempts/1')){refreshes++;signal=init?.signal??undefined;return held;}return fixture.fetcher(input,init);};
  await assert.rejects(selectMonitorArtifact({...options,timeoutMs:25},fetcher),/artifact_api_timeout/);
  assert.equal(refreshes,1);assert.equal(signal?.aborted,true);
  release(Response.json({...prior,status:'completed',conclusion:'success'}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fixture.calls.length,1);
});

test('completed list fast paths and current rerun historical-attempt policy do not gain a refresh',async()=>{
  const completed=transport([run(30),{...run(29),conclusion:'success'}],[artifact(101)]);
  assert.equal((await selectMonitorArtifact(options,completed.fetcher))?.runId,29);assert.equal(completed.calls.length,2);
  const prior={...run(29,'run',2),status:'in_progress',conclusion:null};
  const laterAttempt=transport([run(30),prior],[artifact(101,2)]);
  await assert.rejects(selectMonitorArtifact(options,laterAttempt.fetcher),/prior_monitor_run_incomplete/);assert.equal(laterAttempt.calls.length,1);
  const historical={...run(30),status:'in_progress',conclusion:null};
  const rerun=transport([run(30,'run',2),run(29)],[artifact(101)],{attempts:{'30/1':historical}});
  await assert.rejects(selectMonitorArtifact({...options,runAttempt:2},rerun.fetcher),/prior_monitor_run_incomplete/);
  assert.deepEqual(rerun.calls,[`${root}/workflows/operations-monitor.yml/runs?branch=main&per_page=30`,`${root}/runs/30/attempts/1`]);
});

test('CLI incomplete-run refusal retains sanitized diagnostics without writing output',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-prior-status-')),output=path.join(directory,'output'),original=globalThis.fetch;
  const prior={...run(29),status:'in_progress',conclusion:null};
  globalThis.fetch=transport([run(30),prior],[artifact(101)],{attempts:{'29/1':prior}}).fetcher;
  const env={GH_TOKEN:options.token,GITHUB_REPOSITORY:repo,GITHUB_REF:'refs/heads/main',GITHUB_OUTPUT:output,GITHUB_RUN_ID:'30',GITHUB_RUN_NUMBER:'30',GITHUB_RUN_ATTEMPT:'1'};
  try{
    await assert.rejects(main([],env),error=>{assert.ok(error instanceof ArtifactStateError);assert.deepEqual(error.priorRun,{priorRunId:29,priorRunAttempt:1,priorRunStatus:'in_progress'});return true;});
    await assert.rejects(fs.access(output),{code:'ENOENT'});
  }finally{globalThis.fetch=original;await fs.rm(directory,{recursive:true,force:true});}
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
  try{await main([],env);assert.equal(await fs.readFile(output,'utf8'),'artifact_id=101\nrun_id=29\nartifact_name=folio-monitor-state-v1-1-delivered\nsuperseded=false\n');assert.equal(fixture.calls.length,2);await assert.rejects(main([],{...env,GITHUB_REF:'refs/heads/foreign'}),/artifact_environment_invalid/);await assert.rejects(main(['--anything'],env),/artifact_arguments_invalid/);assert.equal(fixture.calls.length,2);}
  finally{globalThis.fetch=original;await fs.rm(directory,{recursive:true,force:true});}
});

test('CLI first-ever initialize emits empty identifiers without concealing missing normal state',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-initialize-')),output=path.join(directory,'output');const original=globalThis.fetch;
  globalThis.fetch=transport([run(30,'initialize')],[]).fetcher;
  const env={GH_TOKEN:options.token,GITHUB_REPOSITORY:repo,GITHUB_REF:'refs/heads/main',GITHUB_OUTPUT:output,GITHUB_RUN_ID:'30',GITHUB_RUN_NUMBER:'30',GITHUB_RUN_ATTEMPT:'1'};
  try{await assert.rejects(main([],env),/monitor_state_missing_requires_reconciliation/);await main(['--initialize'],env);assert.equal(await fs.readFile(output,'utf8'),'artifact_id=\nrun_id=\nartifact_name=\nsuperseded=false\n');}
  finally{globalThis.fetch=original;await fs.rm(directory,{recursive:true,force:true});}
});

test('CLI superseded first attempt is an explicit state-free no-op while reruns and real errors still fail',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-superseded-')),output=path.join(directory,'output');
  const original=globalThis.fetch,originalLog=console.log,logs:string[]=[];
  const env={GH_TOKEN:options.token,GITHUB_REPOSITORY:repo,GITHUB_REF:'refs/heads/main',GITHUB_OUTPUT:output,GITHUB_RUN_ID:'30',GITHUB_RUN_NUMBER:'30',GITHUB_RUN_ATTEMPT:'1'};
  console.log=(value:unknown)=>logs.push(String(value));
  try{
    const newer=transport([run(31),run(30)],[]);globalThis.fetch=newer.fetcher;
    await main([],env);
    assert.equal(await fs.readFile(output,'utf8'),'artifact_id=\nrun_id=\nartifact_name=\nsuperseded=true\n');
    assert.deepEqual(logs.map(value=>JSON.parse(value)),[{monitorState:'superseded',code:'monitor_run_superseded'}]);
    assert.equal(newer.calls.length,1);
    await fs.unlink(output);globalThis.fetch=transport([run(31),run(30,'run',2)],[]).fetcher;
    await assert.rejects(main([],{...env,GITHUB_RUN_ATTEMPT:'2'}),/monitor_run_superseded/);
    globalThis.fetch=transport([run(30),{...run(29),conclusion:'success'}],[]).fetcher;
    await assert.rejects(main([],env),/latest_monitor_checkpoint_missing/);
    globalThis.fetch=transport([run(30),run(29)],[artifact(1,1,'delivered',{workflow_run:{id:28,head_branch:'main'}})]).fetcher;
    await assert.rejects(main([],env),/artifact_scope_invalid/);
    await assert.rejects(fs.access(output),{code:'ENOENT'});
  }finally{globalThis.fetch=original;console.log=originalLog;await fs.rm(directory,{recursive:true,force:true});}
});

test('workflow requires an explicit non-superseded selection before every state or delivery operation',async()=>{
  const workflow=await fs.readFile(new URL('../.github/workflows/operations-monitor.yml',import.meta.url),'utf8');
  const steps=workflow.split('      - name: ').slice(1);
  const stateSteps=steps.filter(step=>!step.startsWith('Select the authoritative')&&!step.startsWith('Read dependencies')&&!step.startsWith('Deliver approved test'));
  assert.equal(stateSteps.length,8);
  for(const step of stateSteps)assert.match(step,/\n        if: steps\.state\.outputs\.superseded == 'false' && /);
  assert.match(workflow,/cron: '2-59\/5 \* \* \* \*'/);
  assert.match(workflow,/group: folio-operational-monitor\s+cancel-in-progress: false/);
});


// Clearly labelled synthetic GitHub records reproduce the independently captured
// cancelled job and GitHub-owned acquisition failure; these do not read a provider.
const neverAcquiredJob=(runId:number)=>({total_count:1,jobs:[{id:1000+runId,run_id:runId,run_attempt:1,head_sha:fixtureHead,name:'monitor',status:'completed',conclusion:'cancelled',steps:[] as unknown[],runner_id:0,runner_name:'',runner_group_id:0,runner_group_name:'',check_run_url:`https://api.github.com/repos/${repo}/check-runs/${1000+runId}`}]});
const acquisitionCheck=(runId:number)=>({id:1000+runId,head_sha:fixtureHead,name:'monitor',status:'completed',conclusion:'cancelled',app:{id:15368,slug:'github-actions'},output:{annotations_count:1}});
const acquisitionAnnotation=()=>({annotation_level:'failure',message:'The job was not acquired by Runner of type hosted even after multiple attempts.'});
const acquisitionFixture=(job:unknown=neverAcquiredJob(29),check:unknown=acquisitionCheck(29),annotations:unknown=[acquisitionAnnotation()])=>transport([run(30),run(29),{...run(28),conclusion:'success'}],[],{jobs:{29:job},checkRuns:{1029:check},annotations:{1029:annotations},artifactsByRun:{28:[artifact(101)]}});

test('seven proven selector failures and one provider-proven unacquired job preserve the latest checkpoint and distinct audit reasons',async()=>{
  const failed=Array.from({length:7},(_,index)=>29-index),jobs:Record<number,unknown>=Object.fromEntries(failed.map(id=>[id,selectorFailedJob(id)]));jobs[22]=neverAcquiredJob(22);
  const fixture=transport([run(30),...failed.map(id=>run(id)),run(22),{...run(21),conclusion:'success'}],[],{jobs,checkRuns:{1022:acquisitionCheck(22)},annotations:{1022:[acquisitionAnnotation()]},artifactsByRun:{21:[artifact(101)]}});
  const skipped:Array<[number,string]>=[];
  assert.deepEqual(await selectMonitorArtifact({...options,onSkippedRun:(id,reason)=>skipped.push([id,reason])},fixture.fetcher),{artifactId:101,runId:21,name:'folio-monitor-state-v1-1-delivered'});
  assert.deepEqual(skipped,[...failed.map(id=>[id,'selector_failed_before_state']),[22,'hosted_runner_not_acquired']]);
  assert.equal(fixture.calls.filter(url=>url.includes('/contents/')).length,2);
  assert.equal(fixture.calls.filter(url=>url.includes('/check-runs/')).length,2);
  assert.ok(fixture.calls.at(-1)?.includes('/runs/21/artifacts'));
  assert.equal(fixture.calls.length,22);
});

test('unacquired recovery requires exact attempt, single cancelled job, no steps, no runner and fixed repository check binding',async()=>{
  const mutations:Array<(value:ReturnType<typeof neverAcquiredJob>)=>void>=[
    v=>{v.total_count=2;},v=>{v.jobs.push(structuredClone(v.jobs[0]));},
    v=>{v.jobs[0].id=0;},v=>{v.jobs[0].run_id=28;},v=>{v.jobs[0].run_attempt=2;},v=>{v.jobs[0].head_sha='a'.repeat(40);},
    v=>{v.jobs[0].name='other';},v=>{v.jobs[0].status='in_progress';},v=>{v.jobs[0].conclusion='failure';},
    v=>{v.jobs[0].steps=[{name:'Download exactly the selected encrypted artifact',status:'completed',conclusion:'success'}];},
    v=>{v.jobs[0].runner_id=1;},v=>{v.jobs[0].runner_name='assigned';},v=>{v.jobs[0].runner_group_id=1;},v=>{v.jobs[0].runner_group_name='assigned';},
    v=>{v.jobs[0].check_run_url='https://api.github.com/repos/foreign/repo/check-runs/1029';},
    v=>{v.jobs[0].check_run_url='https://api.github.com.example/repos/'+repo+'/check-runs/1029';},
    v=>{v.jobs[0].check_run_url='https://api.github.com/repos/'+repo+'/check-runs/1029?ref=foreign';},
    v=>{v.jobs[0].check_run_url='https://api.github.com/repos/'+repo+'/check-runs/1029#foreign';},
    v=>{v.jobs[0].check_run_url='https://api.github.com/repos/'+repo+'/check-runs/01029';},
    v=>{v.jobs[0].check_run_url='https://api.github.com/repos/'+repo+'/check-runs/9007199254740992';},
  ];
  for(const mutate of mutations){const job=neverAcquiredJob(29);mutate(job);const fixture=acquisitionFixture(job);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(fixture.calls.length,3);}
  for(const patch of [{runner_id:null},{runner_name:null},{runner_group_id:null},{runner_group_name:null},{check_run_url:null}]){
    const job=neverAcquiredJob(29);Object.assign(job.jobs[0],patch);const fixture=acquisitionFixture(job);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(fixture.calls.length,3);
  }
  const rerun=transport([run(30),run(29,'run',2),run(28)],[],{jobs:{29:neverAcquiredJob(29)}});await assert.rejects(selectMonitorArtifact(options,rerun.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(rerun.calls.length,2);
});

test('a GitHub-owned completed cancelled check must match the exact job-linked ID, head, name and single annotation count',async()=>{
  const mutations:Array<(value:ReturnType<typeof acquisitionCheck>)=>void>=[
    v=>{v.id=1028;},v=>{v.head_sha='a'.repeat(40);},v=>{v.name='other';},v=>{v.status='in_progress';},v=>{v.conclusion='failure';},
    v=>{v.app.id=1;},v=>{v.app.slug='other-app';},v=>{v.output.annotations_count=0;},v=>{v.output.annotations_count=2;},
  ];
  for(const mutate of mutations){const check=acquisitionCheck(29);mutate(check);const fixture=acquisitionFixture(undefined,check);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(fixture.calls.length,6);assert.ok(!fixture.calls.some(url=>url.includes('/annotations')));}
  for(const check of [{},{...acquisitionCheck(29),app:null},{...acquisitionCheck(29),output:null},{...acquisitionCheck(29),output:{annotations_count:'1'}}]){
    const fixture=acquisitionFixture(undefined,check);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(fixture.calls.length,6);
  }
});

test('empty steps and runner IDs cannot substitute for the sole recognized platform failure annotation',async()=>{
  for(const annotations of [[],[acquisitionAnnotation(),acquisitionAnnotation()],{},[{}],[{...acquisitionAnnotation(),annotation_level:'warning'}],[{...acquisitionAnnotation(),message:'GitHub Actions has encountered an internal error when running your job.'}],[{...acquisitionAnnotation(),message:'prefix '+acquisitionAnnotation().message}],[{...acquisitionAnnotation(),message:acquisitionAnnotation().message+' State was processed.'}]]){
    const fixture=acquisitionFixture(undefined,undefined,annotations);await assert.rejects(selectMonitorArtifact(options,fixture.fetcher),/latest_monitor_checkpoint_missing/);assert.equal(fixture.calls.length,7);assert.ok(!fixture.calls.some(url=>url.includes('/runs/28/')));
  }
  const presentation=acquisitionFixture(undefined,undefined,[{annotation_level:'failure',message:'  THE JOB WAS NOT ACQUIRED BY Runner of type hosted\n even after multiple attempts.  '}]);assert.equal((await selectMonitorArtifact(options,presentation.fetcher))?.runId,28);
});

test('released selector and workflow remain explicitly trusted after the recovery and checks permission change',async()=>{
  // Frozen public source bytes from released PR79, compressed only to keep this fixture concise.
  const oldSelector=inflateSync(Buffer.from(
    'eNqtO2t327aS3/0rmHtyRDGlKMlvS6F90za9zW6b5Phx9+y6rkKRkMWGIrUE6ViV9N93Bi8CJOU43X6wTOIxGAzmPWD/1SvriiQkLKwgtYKymGd5XARF/EAs'+
    'kob5almQyArnJPy8zOK08KzreUytRRaVCbFS8kByK8q+pEkWRNSiMJNYWW5RksJrkJC8oJ71qr8XL5ZZXlgzas3ybGHZaRaR0Yz2l/AWU0LtsRyyDIq5Pgjf'+
    'q941vl5nP8UJubn8ZasPLPNEGxfmBHD5OaBzYxDbUQbj9sIspYWVk2VG4yLLV76dw29vHqwI7S8C2Cv8zZLsCwzmY79k+Wds8O1sSXKgEbT2FlmK073VIlED'+
    'g2Xsf5oXxZKO+n148e7jYl5OvTBb9NmC/ZfrauFtPwgZrE9y/jIns/jRt2dZEmdyhR4jbu9h2FPr5IQu4YH8Ei/iwh8O9g9f4Y/qLlPeczBQmOVFPIPl5AzV'+
    'sZwHcAo+oEXLBYlGAxeQWAY5PA7diCTAD/i8v7UCarEp471itSTWR5zofyarbGZhA/zjsET/ZZn66zgapeViSvIx4DThj3pLUBRksSxkUxTTZRKsJkVcJGRE'+
    'izxO78dzEkQTOg+M92kepOFcNgE3poV8QXKVVL4BymFSUiCzaNmkZZKMq1MYrWfQMEmDhVxxy5d4cshW7PKNoKu+VW3cmDwuY6TfNMsSEqRjGv9JJnE6ma4K'+
    'QuUEyV8TIMnFSIPU3CouDDCR0431uSjDLv21POp3Ou3ftWFXg6VgfFgytvTXRfaZSLqZUODljXl20PLeON8YuDcOEtjwhdp+ES9IVha/0gs5KkuvPsfLJYku'+
    'ce9dfRHHP3/I4qjCMkwCSqsto1i8zUF4LfJYML3D3oCVgyhLkxWwa0Q0PoCnMoTz7GrtzpqWINOsyRkXoOI8fPTxZ7zd7s3KlJEERO5/SzjJfwdJSboP+Dsq'+
    '088paEBXBzcCDFH3WWzIOp51X7Anp5jn2RfQm19a8Berb6VIItuB3PnmOs6IvVqghTl9/HNOcC+mV8GMvEsLcg9b4et1OrxTvJ4rgQ+zMi3+VtC+gp1N/wAO'+
    '2g38koRZHr3mtHJF/zkcMw544fsomp2O0Cas0fdB6TKodqfz4k2eByvAif0Xy4NGD+gqDS11VH/QLO2CURBn4upc7BYgTRS5aSSWmZEinLs0vk+DZPRmCj1X'+
    '7NkZfeQm6rXEc71nWQmptO/oUjxsyjQCxZ2SaAxDinyFIy2Lw/TYyb+bMdAk6jpj1imB+MGXIAYBlGgh4u56QcAeRyP7X2+vbRf0B3BeWIxsgtxiC2Rd1A4k'+
    'p6N1EIYEBNEOlsskDpl96j+kkbA+3yE9bFeY+D9Z9+jT9wR0fG695DK+/eTajz0+vgeGqwdaH3WmPbL3B/v7veGwt39qb7cC+a/sTJMUuU2Pa2U4zv3BwLWl'+
    'jprAWpMyDR6COAmmCbEFDM5OEQGJh937CorYsndPiq4Ng0Dsi15C0ntwFcRUEDk5T3CUY2DU//236LuXfQ/0b6FGVjytWl77hpXVcJbtkwQ7TJRzhmCF8DSL'+
    'VheI7iXrABrVyIOtbbDjFNg7jkzo4Rx4kY5uwEc5ZTJwe+ff3o2RKdGwoCDiYOTAGaiV8RjU246jEqoGFhYcyFHx8B90AxWxzwNFSpwpNH5mpus7n7UyyfPQ'+
    'hv3CaG9uCgd+A/X4prxlSefdCrqD2hc3A3IVJMlqjaZAIhmCRSRJ14EHEN5uFyzFeosKVO4+J0WZp9Z/XH147wFMSrrfl7MZzgR3ICi6fE3HK7Irpha6dlnM'+
    'Tm3HQS9HyPt4y6Cvn9TcT54c4rOV+ANF5RDQZAaD3FDgN7E/g2927nO7p1mmMqVSE9U17xo7R2BagUuKrAANx/X7FjWUcWhcySoNz6wEf/PYxAlrgZ4WHezp'+
    'DgyFMS2tHpdS4AvhnMpRGvRzf/dEnYOg1ZQP5faKvbbCWQTLbhf0Bfhzkj7++bqpsgQl2EjYi7TGvMGLo2Zb5du29wkv11GmjXcZ3i4aOm6i7Now6f8aI/q/'+
    '3w56Z0Fvdrc+HGylOjMnwHpaA3cjEQjGOPVFmAe9Gwelvat+sVjlX/tc2242xkyjX84GzHQqe5WrrXCumjzlfAOEqrkGouaym3v/KrAnuQv5g6kTBlHTEPgI'+
    '/IZjuGU0+Ag1xhXYKcV88OCfww/ykOMxhe37Got3OrunaCzWNrWOf7CYxvdlVlJb4MXwZ9rA5XqgIXzgZmvuLvh9qOSAWogDSpUjnXgUmX7fup4TFRiDpc6B'+
    '5an1D+BptOPRP3jsXcAgCsTGyDZC14RAUwDWCnx+asXgJzNH/Y9s6u0x031r/4SxryVi3xFMzKbEduvNIjJd9aI8TpKWfoGHfefFyIARobgRU+YcRxBmFiSU'+
    'NA6wgQsAaK5UhTlPr9Xp3No0nBPMnwAUpZtwFGr3+mwmkY55sOAqgSOY3aewWmQcLYQ2ZGyYBTmv3TS44lTdRfAYL8qFGcw5o0Zc+fcaDIlcZSxUizIURsqi'+
    'xVqABLRP1WgG8RyKN8hzmC2W4CcR3WCAeY3iKMBInCH3WsXOav/jWoaCpThGLPexPUffSwGLI+oL+X3NB593HfeepDJjpHq5Ejzn/vKMhX8IgGsXGfhoJPpr'+
    'NsrQwkLh7dDuIkmBA4SM2/JAhfrXsxY6T0KcEgABg6bC1JB9AaTxgGIVdhqEikCG0sIpQRRVU5Rz/6LaEZoliLX/C8KWLk+dOQ4GBXFaEt1tXqB8+f3fd6TV'+
    'urfD3tkd2tO7V06vKzJhG5kH26gsmAN2ljySsFuh0LZftpx2KCKyYM23wztnx/ZbPX7Bfn4dhssY0efv+3doiRhTtqAjQDDPS3dHnoUFEJxvVvelIK5SEa+z'+
    'ky+NKcoe641wrtyMwUNrf5vjoqFNw2xJnmY9Tf4YC356uRbb345erhkRt5+ewY86HOTLdjgcAzCObwAN2ABw3orFLNzMBWDN4iyXh+qKNDozg+BNVEpKz7vL'+
    'Y1DHaGpsp1JiPISqdFibuyL1mitx4KgzzDFc0aBRzEZ0A3cKbvLUE+N7gXzabHi693bqsYe7nngPxLumaCmzIqBhKvC3g7ta1CjGuHaC/aBbuJxOKlpMFjGl'+
    'zH8c7wky0zIMCaXgp0iqWosSVpwHD0BFQc6I+SGSs2zKY0pLybVVLrGM4XGg7+A40H1YLkmArMfTYhkEyyRnCIBxLTKxJyyeZAm4Pzz5bVWnKxwaZOOaD8xR'+
    'tp3W7UvywkjzoDsdNYTLPoBSOwCpqCjxVcqZIlKtLHhD2oOnTkIMaYHXBGdYj/OBtpH2IbtzB8tghQelJ16ka6tlvZvg48jliWWua1yeA28Mw2bmBu9x/xbO'+
    'E5uoNY1TzkOg/RcsOY4cwBvAw8C8IhPzHhNzDhg5AWaBUQIGk7zn7XHlAKqB+cEwCV1CUT+T9TTGRelKObnQTZYwFvUfrdfqwE0EPkO4qEeU12Dh2eUVI3vW'+
    'jdACymlHqDhDlvNoMCOMs8E59/Z0yc3yD7CxKxzv3wLRbXBjQGjQb7ddfAdP0hLFrD7jkqws/jkcTqOT4dlgOJ2So+nw+GAQEhKcHET7J0dnJwfHh+FZMDs+'+
    'PWiCoHCoyx7W7f55eHZ2cECCo/3T0zAgYXB6fLgfDcnpYTCbRgezk+j4dH8w2B9wIKKiiSfz9ZImn/KjJDp5hOXh+FjMInhDmycpy2f9G00OnhmbpU6O4IEn'+
    'MH8eLAk7f0QDFDGPfdgxcwAfgcdJ/kDYcsLl0HCzpgQ8Q+wBHQ78BcoHNCf8B0UUg5wLmmEvxlYPMZgprHgoAACtdcqHKV82LPMc8LLAxCbFnKEqHB6GUUoe'+
    'C23zGuI/ZAsQPjk4ktAlwlQuCs4u8GsiiMw5GVvrWILViyPEBJgegxvG8AbKYkVEq1LZ9WPE/Cp0454B7RgQ+gJuIbBhtYAqUpMmYiAkOSwNUg4KT+0JQYDV'+
    'hlD2T5QyhBIXK0YsrGQBwMVSHGcG0/4WFm5A+ovy9IP0JbiQ3mn1WxUjzoAOJPqenRyL99uDRCP0FzZNcyTBHRxuNqahgzYboZc5sTebF0awuNk0YjkOoq2+'+
    '4wH6VE3BFxHl4ZRG/M6VFozyq/HoaXC8JRrQChAx6YC7iLFOwA1D1WhsDRtlUk2Mla+8E60E7lgYSpu38qQZtitHRPTspJNJAA4ElK4jAcJztf2GbhZdDapg'+
    'fUAqCR5I8EqBGFeBRjOw6nbxRfEAmD7yWFVk1yoOE8TEwYDfCxXuYIMnxm822ttr30RCdnLiNXZzy1a+E6PaiNnYqFXfpra6imcY2NcHcjIb0u6hmVOg56lJ'+
    '8hRr6wyPnlqIl75tI8v4FYTQV9/KWyxRfA9aSBZcq7oQHFR1D6ZrA6PuHx3bjlcuIyXljsdnd+05eURnSiT1wGjeM/9Y+TFfQHXgbrhyLaQGR6NYCPsF2oHC'+
    '+8fLkyG63aCvmavzjtWbE2YleCBk3BSqGw/0YLhOEoujkmL0kAVmgduVQO1Hvn/74Dg6PJ3OAnI2ODibhqdnw+HhSXgSDY5JeHx0FgyPgvD4LDiY7h+dHB7t'+
    'H0XHw+FBcHZ8QqbB2VGAJ1ArIoMkxLPVlc6UWZmHRKZD/99VZaz3MGmSlbhiDs6VLYq2feml0f6OO0fg8Yd5vCxoXyY0pIfCMxteQW1d6cuFkiwMEv+WF/1m'+
    'lBX88FYVy1ffXP7StT2v/3ws+LUrDxNBXpknjuPuhtwYe2dmwLjEu5QR+iMQ5A7TYYwyHgazYNW7jkiH8Rn8jgBfkZX9v+X2lagfY3O15PYiJzP/5VpX8ttP'+
    '/LSrYxYn25ZyqOVFhakDrmBKAshhy0bcGDRWa8sOcGAydKJYQg7k6vjQNm9FeAJ1LaWnp0UE00445AnY1xxiYlJLLbFVICY3IGLdJQmAzfu/pf17127NqoiZ'+
    'wtxgRNf/vXsxun3T+5+g9+egd/Zd/259uHVeNRr3t76/MZsOtr5zURWwGGTn23fDe31R5sXigwTmShoCa4ZFCcwv9B6f0rZB3qMVuGshaafTFaB8CYyJlTBZ'+
    'L8DuSZMx7HTU0Hbt9Q2bZYXf/qtXEEJiqY3FDUmB+QmWmyjQn2Yh6IxdisLbICiKcU6LHk81yWIFE2Xu36qkk0iWs2ub4sZVTSly9H7l8i9TSd2MXxcb1e+P'+
    '7dCKPvutFGGj1MBu6J03Cg4ChljNYxJp5LSNHsmc/vBYoy/reiIZopwYCYulDfQMu9bxRpV123q5B6Ifrgi5WCGnpXy9iJME6AEvEfXVXtSFuYv9wWQwGIzb'+
    '8dUnA0L662v/gM3UycChtmGBeiDPkgScJ3blAU3XD6qt67DLJjg/H10yf+UajuW1OBsIeq456HPzTlR1j9bvMp7qKleSd2mlya1v3GjQlfvLNaj1rWaVXq7l'+
    '87aPsy5EshgzJR2QickyuCdcmzPBBU1ucImm0auNe0K5m1dv+OHxoivsK9LLuSjbBsO06BQBoNMRD1pJ15zOGcccVyUFm/zX6WjFWjHpWWxXTwSyrdFsQdrK'+
    'zuctGJpFYqxryEwhzmMXK8EprGtq6aJLUiYF8FXLiq+bwlTLSVdje4FeIeersVtRMvHcJNv58EJQZiQx4uda7UorOklAwvuoqybk250V+V1FyKbrIJCsSsoA'+
    'Eyu7FWGZaycV2ETMphNMnKRhnMRMr+vgWUjBrjyzpq1RFtPzy77Khzb5+aJJvt6wSqBqHKoo9gQ0RUPJDzEYE4GEIfprLUMwGrrGdZ7RbYtiwA705qq1t32B'+
    'GLabG/4mXXC3dRB5TCa8aD07fRd8zxoWYCH0bkPyDSqmQrIaw3dXBTQh1GfpGkBMrku/VYmHPrPJKFXV5kkmuZWdd0qiXBZGxSTiwdOOGrgeA6i10PWvFlY8'+
    'g8Ko6zs5ol75rWtfOU67ylQlEkDZqn4jN4OC49qMOhNdt7WJsvmhBfV382e1GGNQOeNCM1jG5Ydv4lSJjnYNsnEVRC3pKlRcHanG0dZuiVRj9ett4v4lFhHx'+
    'tiK7rKzOjZ8cbwQ3FE4hDdFlaN6pBOeZjWIX8THh8/V64GbzFPZ6byO3t+PgVTpHXNxnGI3VXtoiPv1OS3UlxbywMqhfh6kGtk+v321BGM+ukOp8iZnQ57Ok'+
    '1JnDPs6rGHM4GPwVXqwRrJl2xlUqDnS+cYfsKwtT0bBif7UpdSVS40fL4uTYmempZOOv7Niy6ijhvYEWlKopW/UkFzS+jvG6+impeVtNX/f7ltwIr0UKNqZW'+
    'lLEcnPwKgDwRFYKAzuOIWIEEaZSlVpmohU4zdPEjGTZCMJlGWOH827yjpy9eP5NDtg63Mbo6ZMcuwk8vx2zHLfoWLi4lo1JWEj3vdiduTlC8MV5hYY9fBTn8'+
    'QrbGBAFGS+yOP9MIX70zjl8/iFjMhnBj6xph3Hjr3HGlaihUvJLzDC2q661nXmFvfoyBi8sL7GFCglzunJGCfUVQ3zvLUbSnDzAqA413T8HfyDChDert/sGj'+
    'SQxHsO+4JH1QPfDsNFIAOFdThJuN2YC5FmgAHw3Ne6+nXc3UvaH8vlxg3s/0h2oZrgfvX++uf775fnL59uOHq3fXHy7/u3b92BjzE66Ykxnto1zz70j1RWFw'+
    'nGcprvvEsupWnoL84eb64821kebAtCHajynNkrIwcOWjddcPzmpZ1kRCffpB1Sdm4tPI6laX+CaLXTSvbsfJNB1Pbl4Yn4GN3gfvtbv4LDMlDE572kh8XcjQ'+
    '/3ly/eE/376/uLBtcVODf7Wh0/jm/eTdj46rfXnYOubN9fXbXz9es4Hig8TWce9vfv3+7aXjVkwy2sk8uhoeMfz8c9xnlhCPSViXfWnCqQjGpLsWaomJ2cjW'+
    'lBMo4QkvzURiq/z7QVul/rh1nPCSCA/47K3j8DtaKrmOtzpSnl5vMID7SZ0/eEMv1/wwLrzqjgwSevtbysuf2gju7fFOBYNdHq3G4KsY8onVovBbIU2eb4d3'+
    'EJWYqX4gqfH9dpcxMUDMkgdSn+043hxEyWHqQn77wsjMte2zya7rMk7lZyjOi8r5HLUkZvnp4IGMlap6jIsf8KPR4RgP6f8Acvjf8A==','base64')).toString('utf8');
  assert.equal(createHash('sha256').update(oldSelector).digest('hex'),'ecaacf7b935d187b4957c33823b142a205e427b8838bd74a2879b863df563daa');
  const oldWorkflow=inflateSync(Buffer.from(
    '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'+
    '/wPgl3Ky','base64')).toString('utf8');
  assert.equal(createHash('sha256').update(oldWorkflow).digest('hex'),'b04ebabb35917e47b0ecb7756a838596ca27747a98d4b15fabfb20e31dbb6047');
  const fixture=transport([run(30),run(29),{...run(28),conclusion:'success'}],[],{jobs:{29:neverAcquiredJob(29)},checkRuns:{1029:acquisitionCheck(29)},annotations:{1029:[acquisitionAnnotation()]},artifactsByRun:{28:[artifact(101)]},sourceOverrides:{'scripts/monitor-artifact-state.ts':oldSelector,'.github/workflows/operations-monitor.yml':oldWorkflow}});
  assert.equal((await selectMonitorArtifact(options,fixture.fetcher))?.runId,28);
  for(const sourcePath of ['scripts/monitor-artifact-state.ts','.github/workflows/operations-monitor.yml']){
    const drift=transport([run(30),run(29),run(28)],[],{jobs:{29:neverAcquiredJob(29)},checkRuns:{1029:acquisitionCheck(29)},annotations:{1029:[acquisitionAnnotation()]},artifactsByRun:{28:[artifact(101)]},sourceOverrides:{[sourcePath]:'// unfamiliar workflow could access state before failure'}});
    await assert.rejects(selectMonitorArtifact(options,drift.fetcher),/artifact_selector_source_untrusted/);assert.ok(!drift.calls.some(url=>url.includes('/check-runs/')));assert.ok(!drift.calls.some(url=>url.includes('/runs/28/')));
  }
  const superseded=transport([run(30),{...run(29),conclusion:'success'},run(28)],[],{jobs:{29:supersededJob(29)},artifactsByRun:{28:[artifact(101)]},sourceOverrides:{'scripts/monitor-artifact-state.ts':oldSelector,'.github/workflows/operations-monitor.yml':oldWorkflow}});
  await assert.rejects(selectMonitorArtifact(options,superseded.fetcher),/artifact_selector_source_untrusted/);
  assert.ok(!superseded.calls.some(url=>url.includes('/runs/28/')));

});

test('unacquired proof cannot bypass an expired or deleted authoritative checkpoint or authorize initialization',async()=>{
  for(const items of [[],[artifact(101,1,'delivered',{expired:true})]]){
    const fixture=transport([run(30),run(29),{...run(28),conclusion:'success'},run(27)],[],{jobs:{29:neverAcquiredJob(29)},checkRuns:{1029:acquisitionCheck(29)},annotations:{1029:[acquisitionAnnotation()]},artifactsByRun:{28:items,27:[artifact(102)]}});
    await assert.rejects(selectMonitorArtifact({...options,initialize:true},fixture.fetcher),/latest_monitor_checkpoint_(missing|expired)/);assert.ok(!fixture.calls.some(url=>url.includes('/runs/27/')));
  }
  for(const totalRuns of [2,31]){
    const fixture=transport([run(30),run(29)],[],{jobs:{29:neverAcquiredJob(29)},checkRuns:{1029:acquisitionCheck(29)},annotations:{1029:[acquisitionAnnotation()]},totalRuns});
    await assert.rejects(selectMonitorArtifact({...options,initialize:true},fixture.fetcher),totalRuns===2?/latest_monitor_checkpoint_missing/:/artifact_history_incomplete/);
  }
});

test('the existing overall deadline also bounds no-execution proof and prevents late authority continuation',async()=>{
  const fixture=acquisitionFixture();let release!:(response:Response)=>void;const held=new Promise<Response>(resolve=>{release=resolve;});let checks=0;
  const fetcher:typeof fetch=async(input,init)=>{if(String(input).endsWith('/check-runs/1029')){checks++;return held;}return fixture.fetcher(input,init);};
  await assert.rejects(selectMonitorArtifact({...options,timeoutMs:100},fetcher),/artifact_api_timeout/);assert.equal(checks,1);
  release(Response.json(acquisitionCheck(29)));await new Promise(resolve=>setImmediate(resolve));assert.ok(!fixture.calls.some(url=>url.includes('/annotations')));assert.ok(!fixture.calls.some(url=>url.includes('/runs/28/')));
});

test('CLI logs provider non-acquisition accurately and exposes no annotation text',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-no-acquisition-')),output=path.join(directory,'output');const originalFetch=globalThis.fetch,originalError=console.error,logs:string[]=[];
  globalThis.fetch=acquisitionFixture().fetcher;console.error=(value:unknown)=>logs.push(String(value));
  const env={GH_TOKEN:options.token,GITHUB_REPOSITORY:repo,GITHUB_REF:'refs/heads/main',GITHUB_OUTPUT:output,GITHUB_RUN_ID:'30',GITHUB_RUN_NUMBER:'30',GITHUB_RUN_ATTEMPT:'1'};
  try{await main([],env);assert.deepEqual(logs.map(value=>JSON.parse(value)),[{monitorState:'checkpoint_not_created',runId:29,code:'hosted_runner_not_acquired'}]);assert.equal(await fs.readFile(output,'utf8'),'artifact_id=101\nrun_id=28\nartifact_name=folio-monitor-state-v1-1-delivered\nsuperseded=false\n');assert.ok(logs.every(value=>!value.includes('The job')));}
  finally{globalThis.fetch=originalFetch;console.error=originalError;await fs.rm(directory,{recursive:true,force:true});}
});


test('released PR114 selector bytes recover proven failures but never authorize a successful no-op exemption',async()=>{
  // Frozen public Git blob from fcab02d, compressed only to retain its exact identity.
  const oldSelector=inflateSync(Buffer.from(
    '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','base64')).toString('utf8');
  assert.equal(createHash('sha256').update(oldSelector).digest('hex'),'cd15e5ff042095c7143dea1d9e283bd02a814a79644c91d0f18281b087f05937');
  const failure=transport([run(30),run(29),{...run(28),conclusion:'success'}],[],{jobs:{29:selectorFailedJob(29)},artifactsByRun:{28:[artifact(101)]},sourceOverrides:{'scripts/monitor-artifact-state.ts':oldSelector}});
  assert.equal((await selectMonitorArtifact(options,failure.fetcher))?.runId,28);
  const success=transport([run(30),{...run(29),conclusion:'success'},run(28)],[],{jobs:{29:supersededJob(29)},artifactsByRun:{28:[artifact(101)]},sourceOverrides:{'scripts/monitor-artifact-state.ts':oldSelector}});
  await assert.rejects(selectMonitorArtifact(options,success.fetcher),/artifact_selector_source_untrusted/);
  assert.ok(!success.calls.some(url=>url.includes('/runs/28/')));
});
