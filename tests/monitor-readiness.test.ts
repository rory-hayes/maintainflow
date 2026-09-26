import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkMonitorReadiness,main} from '../scripts/monitor-readiness.js';

// Configuration fixtures are synthetic. No installed credentials are read.
const fixture=():NodeJS.ProcessEnv=>({
  FOLIO_MONITOR_ORIGIN:'https://maintainflow.io',
  FOLIO_MONITOR_ENABLED:'false',
  FOLIO_MONITOR_SECRET:'synthetic_diagnostics_only_0123456789abcdef',
  FOLIO_MONITOR_STATE_KEY:Buffer.alloc(32,7).toString('base64'),
  FOLIO_MONITOR_EMAIL_API_KEY:'re_synthetic_sender_only_0123456789',
  FOLIO_MONITOR_EMAIL_FROM:'no-reply@maintainflow.io',
  FOLIO_MONITOR_EMAIL_TO:'synthetic-operator@example.test',
  FOLIO_MONITOR_STATE_FILE:'.monitor/state.enc',
});
const blocked=(env:NodeJS.ProcessEnv)=>checkMonitorReadiness(env).checks.filter(check=>check.status==='blocked').map(check=>check.id);

test('valid local configuration never certifies approval, remote installation, activation or inbox delivery',()=>{
  const report=checkMonitorReadiness(fixture());
  assert.equal(report.configurationReady,true);
  assert.equal(report.hostedActivationVerified,false);
  assert.deepEqual([report.networkCalls,report.stateReads,report.stateWrites],[0,0,0]);
  assert.ok(report.externalChecks.every(check=>check.status==='unverified'));
  for(const id of ['authorization','scoped_credentials','mail_sender','workflow_configuration','probe','delivery_drill','initialize','scheduled_run','external_stale_run_monitor'])assert.ok(report.externalChecks.some(check=>check.id===id));
  assert.equal(main(['--check'],fixture(),()=>{}),0);
});

test('empty input lists all missing configuration without silently choosing the production defaults',()=>{
  const report=checkMonitorReadiness({});
  assert.equal(report.configurationReady,false);
  for(const id of ['canonical_origin','diagnostics_credential_shape','state_key_shape','state_key_distinct','sending_key_shape','sender_matches_workflow','recipient_shape'])assert.ok(blocked({}).includes(id));
  assert.equal(main([],{},()=>{}),1);
});

test('preparation refuses active or ambiguous schedule flags and exposed worker credentials',()=>{
  for(const value of ['true','TRUE','False',' true ','1'])assert.ok(blocked({...fixture(),FOLIO_MONITOR_ENABLED:value}).includes('automatic_schedule_disabled'));
  for(const value of [undefined,'','false'])assert.equal(blocked({...fixture(),FOLIO_MONITOR_ENABLED:value}).includes('automatic_schedule_disabled'),false);
  for(const worker of ['synthetic_worker_credential',fixture().FOLIO_MONITOR_SECRET])assert.ok(blocked({...fixture(),FOLIO_WORKER_SECRET:worker}).includes('worker_credential_absent'));
});

test('configuration rejects alternate origins, injected recipients, invalid key encodings and state-key reuse',()=>{
  for(const origin of ['http://maintainflow.io','https://maintainflow.io/','https://maintainflow.io/path','https://user:secret@maintainflow.io','https://another.example.test'])assert.ok(blocked({...fixture(),FOLIO_MONITOR_ORIGIN:origin}).includes('canonical_origin'));
  for(const recipient of ['', 'a@example.test,b@example.test','a@example.test\nBcc:other@example.test','Operator <a@example.test>'])assert.ok(blocked({...fixture(),FOLIO_MONITOR_EMAIL_TO:recipient}).includes('recipient_shape'));
  for(const key of ['',Buffer.alloc(31).toString('base64'),Buffer.alloc(33).toString('base64'),fixture().FOLIO_MONITOR_STATE_KEY!.slice(0,-2)+'d='])assert.ok(blocked({...fixture(),FOLIO_MONITOR_STATE_KEY:key}).includes('state_key_shape'));
  const shared=fixture().FOLIO_MONITOR_STATE_KEY!;
  assert.ok(blocked({...fixture(),FOLIO_MONITOR_SECRET:shared}).includes('state_key_distinct'));
  assert.ok(blocked({...fixture(),FOLIO_MONITOR_EMAIL_API_KEY:shared}).includes('state_key_distinct'));
  assert.ok(blocked({...fixture(),FOLIO_MONITOR_SECRET:'short'}).includes('diagnostics_credential_shape'));
  assert.ok(blocked({...fixture(),FOLIO_MONITOR_SECRET:'x'.repeat(40)+'\n'}).includes('diagnostics_credential_shape'));
  assert.ok(blocked({...fixture(),FOLIO_MONITOR_EMAIL_API_KEY:'invalid'}).includes('sending_key_shape'));
  assert.ok(blocked({...fixture(),FOLIO_MONITOR_EMAIL_FROM:'another@example.test'}).includes('sender_matches_workflow'));
  assert.ok(blocked({...fixture(),FOLIO_MONITOR_STATE_FILE:'/private/arbitrary-state'}).includes('state_path_matches_workflow'));
});

test('reports never echo values, recipient, credentials, arguments or their hashes',()=>{
  const values=Object.fromEntries(Object.keys(fixture()).map(key=>[key,`PRIVATE_SENTINEL_${key}`]));
  values.FOLIO_WORKER_SECRET='PRIVATE_SENTINEL_WORKER';
  const output:string[]=[];
  assert.equal(main(['--check'],values,value=>output.push(value)),1);
  assert.equal(main(['--unexpected_PRIVATE_SENTINEL_ARGUMENT'],values,value=>output.push(value)),2);
  assert.equal(main(['--check','--check'],values,value=>output.push(value)),2);
  assert.equal(output.join('\n').includes('PRIVATE_SENTINEL'),false);
  const valid=JSON.stringify(checkMonitorReadiness(fixture()));
  for(const name of ['FOLIO_MONITOR_SECRET','FOLIO_MONITOR_STATE_KEY','FOLIO_MONITOR_EMAIL_API_KEY','FOLIO_MONITOR_EMAIL_TO'])assert.equal(valid.includes(fixture()[name]!),false);
});

test('actual CLI ignores .env files, makes no network calls and leaves local state byte-identical',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'maintainflow-monitor-readiness-'));
  const script=path.resolve('scripts/monitor-readiness.ts');
  try{
    await fs.mkdir(path.join(directory,'.monitor'));
    const original=Buffer.from('synthetic encrypted-state sentinel');
    await fs.writeFile(path.join(directory,'.monitor/state.enc'),original);
    const dotenv=Object.entries(fixture()).map(([key,value])=>`${key}=${value}`).join('\n');
    await fs.writeFile(path.join(directory,'.env'),dotenv);
    await fs.writeFile(path.join(directory,'.env.local'),dotenv);
    const guard=path.join(directory,'guard.mjs');
    await fs.writeFile(guard,"globalThis.fetch = () => { throw new Error('network access forbidden'); };\n");
    const execute=(env:NodeJS.ProcessEnv)=>spawnSync(process.execPath,['--import',guard,script,'--check'],{cwd:directory,env,encoding:'utf8',timeout:10000});
    const empty=execute({});
    assert.equal(empty.status,1,empty.stderr);
    assert.equal(empty.stderr,'');
    assert.equal(JSON.parse(empty.stdout).configurationReady,false);
    const configured=execute(fixture());
    assert.equal(configured.status,0,configured.stderr);
    assert.equal(JSON.parse(configured.stdout).configurationReady,true);
    assert.deepEqual(await fs.readFile(path.join(directory,'.monitor/state.enc')),original);
    assert.deepEqual((await fs.readdir(directory)).sort(),['.env','.env.local','.monitor','guard.mjs']);
    assert.deepEqual(await fs.readdir(path.join(directory,'.monitor')),['state.enc']);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
