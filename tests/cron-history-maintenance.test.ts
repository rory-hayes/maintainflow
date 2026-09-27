import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {databaseConfig} from '../server/core/config.js';
import {secureDatabaseConfig} from '../server/core/db.js';
import {cronHistoryInventorySql,cronHistoryApplySql,cronHistoryVerifySql,parseCronHistorySnapshot,type CronHistorySnapshot} from '../scripts/prepare-cron-history-maintenance.js';

// Disposable surrogate tables model pg_cron's documented columns. These tests do
// not install pg_cron, exercise hosted extension ACLs, or operate a real scheduler.
const schema=`cron_history_qa_${randomUUID().replaceAll('-','')}`;
const connection=process.env.DATABASE_ADMIN_URL?secureDatabaseConfig({connectionString:process.env.DATABASE_ADMIN_URL}):{...databaseConfig,user:process.env.PGADMINUSER||'folio_admin'};
const client=new pg.Client(connection);
const policy={successBefore:'2020-02-01T00:00:00Z',failureBefore:'2020-01-01T00:00:00Z',limit:1000};
let owner:string,database:string;
before(async()=>{
 await client.connect();
 ({owner,database}=(await client.query('SELECT current_user owner,current_database() database')).rows[0]);
 await client.query(`CREATE SCHEMA ${schema};
 CREATE TABLE ${schema}.job(jobid bigint PRIMARY KEY,jobname text,username text,database text,schedule text,active boolean,command text,nodename text,nodeport int);
 CREATE TABLE ${schema}.job_run_details(jobid bigint,runid bigint PRIMARY KEY,job_pid int,database text,username text,command text,status text,return_message text,start_time timestamptz,end_time timestamptz);`);
});
after(async()=>{await client.query('ROLLBACK');await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await client.end();});
async function reset(){
 await client.query(`TRUNCATE ${schema}.job_run_details,${schema}.job`);
 await client.query(`INSERT INTO ${schema}.job VALUES(1,'folio-worker-watchdog',$1,$2,'* * * * *',true,'SYNTHETIC_COMMAND_NEVER_OUTPUT','localhost',5432),
 (2,'unrelated',$1,$2,'* * * * *',true,'unrelated','localhost',5432);`,[owner,database]);
 const old='2019-12-01T00:00:00.123456Z',recent='2020-02-01T00:00:00Z';
 const rows=[
  [1,1,'succeeded',old,old,owner,database], [1,2,'failed',old,old,owner,database],
  [1,3,'succeeded',recent,recent,owner,database], [1,4,'running',old,old,owner,database],
  [1,5,'succeeded',old,null,owner,database], [2,6,'succeeded',old,old,owner,database],
  [1,7,'succeeded',old,old,'other_owner',database], [1,8,'succeeded',old,old,owner,'other_database'],
  [1,9,'succeeded','2099-01-01T00:00:00Z','2099-01-01T00:00:00Z',owner,database],
  [1,10,'cancelled',old,old,owner,database], [1,11,'succeeded',recent,old,owner,database],
  [1,12,'succeeded',null,old,owner,database], [1,13,'failed','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z',owner,database],
 ];
 for(const row of rows)await client.query(`INSERT INTO ${schema}.job_run_details(jobid,runid,status,start_time,end_time,username,database,command,return_message) VALUES($1,$2,$3,$4,$5,$6,$7,'SYNTHETIC_COMMAND_NEVER_OUTPUT','SYNTHETIC_ERROR_NEVER_OUTPUT')`,row);
}
async function json(sql:string,column:string){
 const result=await client.query(sql),results=Array.isArray(result)?result:[result];
 const row=results.flatMap(item=>item.rows).find(item=>item[column]);assert.ok(row);return row[column];
}
async function inventory(limit=1000):Promise<CronHistorySnapshot>{return parseCronHistorySnapshot(await json(cronHistoryInventorySql({...policy,limit},schema),'cron_history_inventory'));}
async function state(){return (await client.query(`SELECT (SELECT jsonb_agg(j ORDER BY jobid) FROM ${schema}.job j) jobs,(SELECT jsonb_agg(r ORDER BY runid) FROM ${schema}.job_run_details r) rows`)).rows[0];}
async function rejects(sql:string,pattern:RegExp){try{await assert.rejects(client.query(sql),pattern);}finally{await client.query('ROLLBACK');}}

test('inventory is read-only, bounded, UTC and excludes incomplete, other-owner/job/database and retained rows',async()=>{
 await reset();await client.query("SET TIME ZONE 'Pacific/Auckland'");const before=await state();
 const snapshot=await inventory(1);
 assert.deepEqual(snapshot.candidates.map(row=>row.runId),['1']);assert.equal(snapshot.moreEligible,true);
 assert.equal(snapshot.candidates[0].endTime,'2019-12-01T00:00:00.123456Z');assert.deepEqual(await state(),before);
 const text=JSON.stringify(snapshot);assert.ok(!text.includes('SYNTHETIC_COMMAND'));assert.ok(!text.includes('SYNTHETIC_ERROR'));
 const all=await inventory();assert.deepEqual(all.candidates.map(row=>row.runId),['1','2']);assert.equal(all.moreEligible,false);
 assert.equal((await client.query('SHOW TimeZone')).rows[0].TimeZone,'Pacific/Auckland');
 await client.query("SET TIME ZONE 'UTC'");
});
test('apply deletes only reviewed IDs, preserves newly eligible rows and watchdog, verifies and refuses replay',async()=>{
 await reset();const snapshot=await inventory(1),before=await state();
 await client.query(`INSERT INTO ${schema}.job_run_details SELECT jobid,100,job_pid,database,username,command,status,return_message,start_time,end_time FROM ${schema}.job_run_details WHERE runid=1`);
 const result=await json(cronHistoryApplySql(snapshot,schema),'cron_history_applied');assert.equal(result.deletedRowsInTransaction,1);
 const after=await state();assert.deepEqual(after.jobs,before.jobs);assert.equal(after.rows.length,13);
 assert.ok(after.rows.some((row:{runid:number})=>row.runid===100));assert.ok(!after.rows.some((row:{runid:number})=>row.runid===1));
 assert.deepEqual(await json(cronHistoryVerifySql(snapshot,schema),'cron_history_verification'),{databaseMatches:true,ownerMatches:true,watchdogUnchanged:true,reviewedIdsRemaining:0});
 await rejects(cronHistoryApplySql(snapshot,schema),/changed or are missing/);assert.deepEqual(await state(),after);
});
test('changed or missing rows and altered review metadata fail atomically',async()=>{
 for(const mutation of ['message','missing','status','review']){
  await reset();const snapshot=await inventory();
  if(mutation==='message')await client.query(`UPDATE ${schema}.job_run_details SET return_message='changed' WHERE runid=2`);
  if(mutation==='missing')await client.query(`DELETE FROM ${schema}.job_run_details WHERE runid=2`);
  if(mutation==='status')await client.query(`UPDATE ${schema}.job_run_details SET status='running' WHERE runid=2`);
  if(mutation==='review')snapshot.candidates[0].startTime='2019-11-01T00:00:00.000000Z';
  const before=await state();await rejects(cronHistoryApplySql(snapshot,schema),/changed or are missing/);assert.deepEqual(await state(),before,mutation);
 }
});
test('a large history still prepares and deletes at most one thousand exact reviewed rows',async()=>{
 await reset();
 await client.query(`INSERT INTO ${schema}.job_run_details SELECT jobid,n,job_pid,database,username,command,status,return_message,start_time,end_time FROM ${schema}.job_run_details CROSS JOIN generate_series(100,1100) n WHERE runid=1`);
 const snapshot=await inventory();assert.equal(snapshot.candidates.length,1000);assert.equal(snapshot.moreEligible,true);
 const before=await state();await json(cronHistoryApplySql(snapshot,schema),'cron_history_applied');const after=await state();
 const reviewed=new Set(snapshot.candidates.map(row=>row.runId));
 assert.deepEqual(after.rows,before.rows.filter((row:{runid:number})=>!reviewed.has(String(row.runid))));assert.deepEqual(after.jobs,before.jobs);
});
test('watchdog config drift and wrong review owner/database fail before deletion',async()=>{
 for(const change of ["active=false","schedule='*/2 * * * *'","command='changed'","nodename='otherhost'"]){
  await reset();const snapshot=await inventory();await client.query(`UPDATE ${schema}.job SET ${change} WHERE jobid=1`);
  const before=await state();await rejects(cronHistoryApplySql(snapshot,schema),/configuration differs/);assert.deepEqual(await state(),before);
 }
 await reset();const snapshot=await inventory(),before=await state();snapshot.job.username='another_owner';
 await rejects(cronHistoryApplySql(snapshot,schema),/database or owner differs/);
 snapshot.job.username=owner;snapshot.database=snapshot.job.database='another_database';
 await rejects(cronHistoryApplySql(snapshot,schema),/database or owner differs/);assert.deepEqual(await state(),before);
});
test('deletion count mismatch rolls back the whole batch',async()=>{
 await reset();const snapshot=await inventory(),before=await state();
 await client.query(`CREATE FUNCTION ${schema}.skip_one() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF OLD.runid=2 THEN RETURN NULL; END IF; RETURN OLD; END$$;
 CREATE TRIGGER skip_one BEFORE DELETE ON ${schema}.job_run_details FOR EACH ROW EXECUTE FUNCTION ${schema}.skip_one()`);
 try{await rejects(cronHistoryApplySql(snapshot,schema),/count mismatch/);assert.deepEqual(await state(),before);}
 finally{await client.query(`DROP TRIGGER skip_one ON ${schema}.job_run_details; DROP FUNCTION ${schema}.skip_one()`);}
});
test('maintenance coalesces via advisory lock and held candidate locks time out without partial deletion',async()=>{
 await reset();const snapshot=await inventory(),before=await state(),peer=new pg.Client(connection);await peer.connect();
 try{
  await peer.query("BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('maintainflow:cron-history:'||current_database(),0))");
  await rejects(cronHistoryApplySql(snapshot,schema),/Another cron history/);await peer.query('ROLLBACK');
  await peer.query(`BEGIN; SELECT runid FROM ${schema}.job_run_details WHERE runid=2 FOR UPDATE`);
  await rejects(cronHistoryApplySql(snapshot,schema),/lock timeout/);assert.deepEqual(await state(),before);
 }finally{await peer.query('ROLLBACK');await peer.end();}
});
test('minimum retention and stale/future reviews fail closed',async()=>{
 await reset();const snapshot=await inventory(),before=await state();
 await rejects(cronHistoryInventorySql({...policy,successBefore:new Date().toISOString()},schema),/minimum retention/);
 for(const timestamp of ['2000-01-01T00:00:00Z','2099-01-01T00:00:00Z']){
  snapshot.observedAt=timestamp;await rejects(cronHistoryApplySql(snapshot,schema),/expired or is future-dated/);
 }
 assert.deepEqual(await state(),before);
});
test('quoted and backslash review labels stay literal with nondefault string parsing',async()=>{
 await reset();const snapshot=await inventory(),before=await state();
 snapshot.database=snapshot.job.database="other'database\\name";snapshot.job.username="other'owner\\name";
 await client.query('SET standard_conforming_strings=off');
 try{
  await rejects(cronHistoryApplySql(snapshot,schema),/database or owner differs/);
  const result=await json(cronHistoryVerifySql(snapshot,schema),'cron_history_verification');
  assert.equal(result.databaseMatches,false);assert.equal(result.ownerMatches,false);assert.equal(result.reviewedIdsRemaining,2);
  assert.deepEqual(await state(),before);
 }finally{await client.query('SET standard_conforming_strings=on');}
});
test('strict offline input rejects malformed dates, bounds, identifiers, duplicate IDs and empty apply',async()=>{
 await reset();const snapshot=await inventory();
 for(const invalid of ['2020-02-30T00:00:00Z','2020-01-01T00:00:00+00:00',"2020';DELETE",'2020-01-01T24:00:00Z'])assert.throws(()=>cronHistoryInventorySql({...policy,successBefore:invalid}));
 for(const limit of [0,1001,1.5])assert.throws(()=>cronHistoryInventorySql({...policy,limit}));
 assert.throws(()=>cronHistoryInventorySql(policy,'public'));
 for(const mutate of [
  (s:CronHistorySnapshot)=>s.candidates.push(s.candidates[0]),
  (s:CronHistorySnapshot)=>{s.candidates[0].runId='9223372036854775808';},
  (s:CronHistorySnapshot)=>{s.candidates[0].status='running' as 'failed';},
  (s:CronHistorySnapshot)=>{s.job.username='x$cron_history_apply$';},
  (s:CronHistorySnapshot)=>{s.candidates=[];},
 ]){const copy=structuredClone(snapshot);mutate(copy);assert.throws(()=>cronHistoryApplySql(copy));}
 assert.throws(()=>parseCronHistorySnapshot({...snapshot,unexpected:'not accepted'}));
});
test('CLI only prepares private new files; malformed input is fixed-error and cannot overwrite preparation',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'cron-history-cli-')),script=path.resolve('scripts/prepare-cron-history-maintenance.ts');
 const run=(args:string[])=>spawnSync(process.execPath,['--import','tsx',script,...args],{cwd:process.cwd(),encoding:'utf8',timeout:20_000,
  env:{PATH:process.env.PATH,PGHOST:'192.0.2.1',DATABASE_ADMIN_URL:'SYNTHETIC_NEVER_OUTPUT',NODE_ENV:'test'}});
 try{
  const output=path.join(directory,'inventory'),args=['inventory','--success-before',policy.successBefore,'--failure-before',policy.failureBefore,'--out',output];
  const prepared=run(args);assert.equal(prepared.status,0,prepared.stderr);assert.match(prepared.stdout,/nothing was executed/);
  const sql=await fs.readFile(path.join(output,'inventory.sql'),'utf8');assert.ok(sql.includes('BEGIN READ ONLY'));assert.ok(!sql.includes('DELETE FROM'));
  assert.equal((await fs.stat(output)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(output,'inventory.sql'))).mode&0o777,0o600);
  assert.equal(run(args).status,1);assert.equal(await fs.readFile(path.join(output,'inventory.sql'),'utf8'),sql);
  const secretLike='SYNTHETIC_NEVER_OUTPUT';const bad=run(['inventory','--success-before',secretLike,'--out',path.join(directory,'bad')]);
  assert.equal(bad.status,1);assert.ok(!`${bad.stdout}${bad.stderr}`.includes(secretLike));
  await assert.rejects(fs.access(path.join(directory,'bad')));
  await reset();const snapshot=await inventory();snapshot.job.username='x$cron_history_apply$';
  const snapshotPath=path.join(directory,'malformed-snapshot.json');await fs.writeFile(snapshotPath,JSON.stringify(snapshot));
  const malformedOutput=path.join(directory,'malformed-apply'),malformed=run(['prepare-apply','--snapshot',snapshotPath,'--out',malformedOutput]);
  assert.equal(malformed.status,1);assert.ok(!`${malformed.stdout}${malformed.stderr}`.includes(snapshot.job.username));
  await assert.rejects(fs.access(malformedOutput));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
