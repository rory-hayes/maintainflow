import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {z} from 'zod';

// Offline SQL preparation only. No runtime config, environment loading or database client.
const fail=()=>{throw new Error('Invalid cron-history maintenance input.');};
const literal=(value:string)=>`E'${value.replaceAll('\\','\\\\').replaceAll("'","''")}'`;
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function utc(value:string){
 const match=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?Z$/.exec(value);
 if(!match||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==match[1])return fail();
 return `${match[1]}.${(match[2]??'').padEnd(6,'0')}Z`;
}
const timestamp=z.string().max(32).transform(utc);
const bigint=z.string().regex(/^[1-9][0-9]{0,18}$/).refine(value=>BigInt(value)<=9223372036854775807n);
const hash=z.string().regex(/^[a-f0-9]{64}$/);
// Never allow a snapshot label to terminate the enclosing dollar-quoted DO body.
const label=z.string().min(1).max(63).regex(/^[^\u0000-\u001f\u007f$]+$/);
const policySchema=z.object({successBefore:timestamp,failureBefore:timestamp,limit:z.number().int().min(1).max(1000)}).strict()
 .refine(value=>value.failureBefore<=value.successBefore);
export type CronHistoryPolicy=z.input<typeof policySchema>;
const snapshotSchema=z.object({
 version:z.literal(1),observedAt:timestamp,policy:policySchema,database:label,
 job:z.object({jobId:bigint,name:z.literal('folio-worker-watchdog'),username:label,database:label,
  schedule:z.literal('* * * * *'),active:z.literal(true),configSha256:hash}).strict(),
 tableBytes:z.string().regex(/^[0-9]{1,20}$/),moreEligible:z.boolean(),
 candidates:z.array(z.object({runId:bigint,status:z.enum(['succeeded','failed']),startTime:timestamp,endTime:timestamp,rowSha256:hash}).strict()).max(1000),
}).strict();
export type CronHistorySnapshot=z.output<typeof snapshotSchema>;
export function parseCronHistorySnapshot(value:unknown):CronHistorySnapshot{
 const s=snapshotSchema.parse(value);
 if(s.database!==s.job.database||s.candidates.length>s.policy.limit||new Set(s.candidates.map(row=>row.runId)).size!==s.candidates.length)return fail();
 for(const row of s.candidates){
  if(row.startTime>row.endTime||row.endTime>=(row.status==='succeeded'?s.policy.successBefore:s.policy.failureBefore))return fail();
 }
 return s;
}
// A deliberately narrow seam for disposable surrogate tables, never a CLI option.
function relation(schema:string){
 if(schema!=='cron'&&!/^cron_history_qa_[a-f0-9]{32}$/.test(schema))return fail();
 return `"${schema}"`;
}
const rowHash=(alias:string)=>`encode(sha256(convert_to(to_jsonb(${alias})::text,'UTF8')),'hex')`;
const stamp=(value:string)=>`to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const settings=`SET LOCAL search_path=pg_catalog;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle='ISO, YMD';
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';`;
function eligible(p:z.output<typeof policySchema>,alias='r'){
 return `${alias}.start_time IS NOT NULL AND ${alias}.end_time IS NOT NULL AND ${alias}.start_time<=${alias}.end_time
 AND ((${alias}.status='succeeded' AND ${alias}.end_time<${literal(p.successBefore)}::timestamptz)
 OR (${alias}.status='failed' AND ${alias}.end_time<${literal(p.failureBefore)}::timestamptz))`;
}
function cutoffGuard(p:z.output<typeof policySchema>){
 return `IF ${literal(p.successBefore)}::timestamptz>transaction_timestamp()-interval '30 days'
 OR ${literal(p.failureBefore)}::timestamptz>transaction_timestamp()-interval '90 days' THEN
 RAISE EXCEPTION 'Cron history minimum retention is 30 days for success and 90 days for failure.'; END IF;`;
}
export function cronHistoryInventorySql(policy:CronHistoryPolicy,schema='cron'){
 const p=policySchema.parse(policy),s=relation(schema);
 return `-- Read-only candidate inventory. Save the single JSON value privately for review.
BEGIN READ ONLY;
${settings}
DO $cron_history_guard$ BEGIN
 ${cutoffGuard(p)}
 IF (SELECT count(*) FROM ${s}.job WHERE jobname='folio-worker-watchdog')<>1
 OR NOT EXISTS(SELECT 1 FROM ${s}.job WHERE jobname='folio-worker-watchdog'
 AND username=current_user AND database=current_database() AND schedule='* * * * *' AND active) THEN
 RAISE EXCEPTION 'Expected one active owned minutely watchdog in this database.'; END IF;
END $cron_history_guard$;
WITH selected_job AS MATERIALIZED (SELECT j.* FROM ${s}.job j WHERE jobname='folio-worker-watchdog'),
eligible_rows AS MATERIALIZED (
 SELECT r.* FROM ${s}.job_run_details r JOIN selected_job j ON r.jobid=j.jobid
 AND r.username=j.username AND r.database=j.database
 WHERE ${eligible(p)} ORDER BY r.end_time,r.runid LIMIT ${p.limit+1}
), candidates AS (SELECT * FROM eligible_rows ORDER BY end_time,runid LIMIT ${p.limit})
SELECT jsonb_build_object('version',1,'observedAt',${stamp('clock_timestamp()')},'database',current_database(),
 'policy',${literal(JSON.stringify(p))}::jsonb,
 'job',(SELECT jsonb_build_object('jobId',j.jobid::text,'name',j.jobname,'username',j.username,'database',j.database,
  'schedule',j.schedule,'active',j.active,'configSha256',${rowHash('j')}) FROM selected_job j),
 'tableBytes',pg_total_relation_size(${literal(`${schema}.job_run_details`)}::regclass)::text,
 'moreEligible',(SELECT count(*)>${p.limit} FROM eligible_rows),
 'candidates',coalesce((SELECT jsonb_agg(jsonb_build_object('runId',r.runid::text,'status',r.status,
  'startTime',${stamp('r.start_time')},'endTime',${stamp('r.end_time')},'rowSha256',${rowHash('r')}) ORDER BY r.end_time,r.runid) FROM candidates r),'[]'::jsonb)
) AS cron_history_inventory;
ROLLBACK;
`;
}
export function cronHistoryApplySql(value:unknown,schema='cron'){
 const snapshot=parseCronHistorySnapshot(value),s=relation(schema),p=snapshot.policy,j=snapshot.job;
 if(!snapshot.candidates.length)return fail();
 const ids=snapshot.candidates.map(row=>row.runId).join(','),expected=literal(JSON.stringify(snapshot.candidates));
 return `-- Explicitly reviewed terminal IDs only. Require successful COMMIT; never retry blindly.
BEGIN;
${settings}
DO $cron_history_apply$
DECLARE job_row ${s}.job%ROWTYPE; matched integer; deleted integer;
BEGIN
 ${cutoffGuard(p)}
 IF current_database()<>${literal(snapshot.database)} OR current_user<>${literal(j.username)} THEN
 RAISE EXCEPTION 'Cron history database or owner differs from review.'; END IF;
 IF ${literal(snapshot.observedAt)}::timestamptz>clock_timestamp()
 OR ${literal(snapshot.observedAt)}::timestamptz<clock_timestamp()-interval '24 hours' THEN
 RAISE EXCEPTION 'Cron history review has expired or is future-dated.'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('maintainflow:cron-history:'||current_database(),0)) THEN
 RAISE EXCEPTION 'Another cron history maintenance transaction is active.'; END IF;
 SELECT * INTO job_row FROM ${s}.job WHERE jobid=${j.jobId} FOR SHARE;
 IF NOT FOUND OR ${rowHash('job_row')}<>${literal(j.configSha256)}
 OR job_row.jobname<>'folio-worker-watchdog' OR job_row.username<>current_user
 OR job_row.database<>current_database() OR job_row.schedule<>'* * * * *' OR NOT job_row.active THEN
 RAISE EXCEPTION 'Cron watchdog configuration differs from review.'; END IF;
 PERFORM r.runid FROM ${s}.job_run_details r WHERE r.runid IN (${ids}) ORDER BY r.runid FOR UPDATE;
 SELECT count(*) INTO matched FROM ${s}.job_run_details r
 JOIN jsonb_to_recordset(${expected}::jsonb) expected("runId" text,"rowSha256" text,status text,"startTime" text,"endTime" text)
 ON r.runid=expected."runId"::bigint AND ${rowHash('r')}=expected."rowSha256"
 AND r.status=expected.status AND r.start_time=expected."startTime"::timestamptz AND r.end_time=expected."endTime"::timestamptz
 WHERE r.jobid=job_row.jobid AND r.username=job_row.username AND r.database=job_row.database AND ${eligible(p)};
 IF matched<>${snapshot.candidates.length} THEN RAISE EXCEPTION 'Reviewed cron history rows changed or are missing.'; END IF;
 DELETE FROM ${s}.job_run_details WHERE runid IN (${ids});
 GET DIAGNOSTICS deleted=ROW_COUNT;
 IF deleted<>${snapshot.candidates.length} THEN RAISE EXCEPTION 'Cron history deletion count mismatch.'; END IF;
END $cron_history_apply$;
SELECT jsonb_build_object('reviewSha256',${literal(digest(JSON.stringify(snapshot)))},
 'jobId',${literal(j.jobId)},'deletedRowsInTransaction',${snapshot.candidates.length},
 'observedAt',${stamp('clock_timestamp()')}) AS cron_history_applied;
COMMIT;
`;
}
export function cronHistoryVerifySql(value:unknown,schema='cron'){
 const snapshot=parseCronHistorySnapshot(value),s=relation(schema);
 if(!snapshot.candidates.length)return fail();
 return `BEGIN READ ONLY;
${settings}
SELECT jsonb_build_object('databaseMatches',current_database()=${literal(snapshot.database)},
 'ownerMatches',current_user=${literal(snapshot.job.username)},
 'watchdogUnchanged',coalesce((SELECT ${rowHash('j')}=${literal(snapshot.job.configSha256)} FROM ${s}.job j WHERE jobid=${snapshot.job.jobId}),false),
 'reviewedIdsRemaining',(SELECT count(*) FROM ${s}.job_run_details WHERE runid IN (${snapshot.candidates.map(row=>row.runId).join(',')}))) AS cron_history_verification;
ROLLBACK;
`;
}
async function readSnapshot(file:string){
 const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();if(!stat.isFile()||stat.size>512*1024)return fail();
  const bytes=Buffer.alloc(512*1024+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);
  if(bytesRead>512*1024)return fail();
  return JSON.parse(bytes.subarray(0,bytesRead).toString('utf8')) as unknown;
 }finally{await handle.close();}
}
async function main(args:string[]){
 const [mode,...rest]=args,allowed=mode==='inventory'?['--success-before','--failure-before','--limit','--out']:['--snapshot','--out'];
 if(!['inventory','prepare-apply'].includes(mode)||rest.length%2)return fail();
 const options:Record<string,string>={};
 for(let i=0;i<rest.length;i+=2){if(!allowed.includes(rest[i])||options[rest[i]]!==undefined||!rest[i+1])return fail();options[rest[i]]=rest[i+1];}
 if(!options['--out'])return fail();
 const files:Record<string,string>={};
 if(mode==='inventory')files['inventory.sql']=cronHistoryInventorySql({successBefore:options['--success-before'],failureBefore:options['--failure-before'],limit:options['--limit']===undefined?1000:Number(options['--limit'])});
 else{
  if(!options['--snapshot'])return fail();
  const snapshot=parseCronHistorySnapshot(await readSnapshot(options['--snapshot']));
  files['reviewed-snapshot.json']=JSON.stringify(snapshot,null,2)+'\n';
  files['apply.sql']=cronHistoryApplySql(snapshot);files['verify.sql']=cronHistoryVerifySql(snapshot);
 }
 const directory=path.resolve(options['--out']);
 await fs.mkdir(directory,{mode:0o700}); // Exclusive new directory: preserve previous preparations.
 for(const [name,contents] of Object.entries(files))await fs.writeFile(path.join(directory,name),contents,{flag:'wx',mode:0o600});
 await fs.writeFile(path.join(directory,'preparation.json'),JSON.stringify({version:1,mode,offlineOnly:true,databaseConnections:0,
  preparedAt:new Date().toISOString(),files:Object.fromEntries(Object.entries(files).map(([name,contents])=>[name,digest(contents)]))},null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write('Prepared offline cron-history SQL; nothing was executed.\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 main(process.argv.slice(2)).catch(()=>{process.stderr.write('Cron-history preparation failed. Check arguments, snapshot and a new output directory.\n');process.exitCode=1;});
}
