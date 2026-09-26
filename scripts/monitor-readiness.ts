/** Offline activation preflight. No .env loading, network calls, state access or writes. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';

type CheckStatus='pass'|'blocked';
export type MonitorReadinessCheck={id:string;status:CheckStatus;requirement:string};
export type MonitorReadinessReport={
  mode:'offline_configuration_preflight';
  configurationReady:boolean;
  hostedActivationVerified:false;
  networkCalls:0;
  stateReads:0;
  stateWrites:0;
  checks:MonitorReadinessCheck[];
  externalChecks:readonly {id:string;status:'unverified';requirement:string}[];
};

const externalChecks=[
  {id:'authorization',status:'unverified',requirement:'Record approval to install the dedicated monitor credential and send incident, recovery and test notices to the selected recipient.'},
  {id:'scoped_credentials',status:'unverified',requirement:'Generate the diagnostics secret and 32-byte state key independently; install the same diagnostics-only secret on the server and in GitHub without copying the worker credential.'},
  {id:'mail_sender',status:'unverified',requirement:'Verify the sender domain and dedicated sending-key permissions with the provider; confirm the approved incident inbox is monitored.'},
  {id:'workflow_configuration',status:'unverified',requirement:'Inspect the deployed main workflow, GitHub secrets, read-only GitHub permissions, disabled repository variable and applicable runner/artifact limits.'},
  {id:'probe',status:'unverified',requirement:'Dispatch probe on main and retain healthy health, readiness and authenticated diagnostics evidence for the intended deployed revision.'},
  {id:'delivery_drill',status:'unverified',requirement:'Send the approved synthetic incident and recovery drill with one frozen UUID and UTC timestamp; record provider acceptance and both inbox observations separately.'},
  {id:'initialize',status:'unverified',requirement:'Initialize through the authoritative artifact selector; preserve existing history and confirm the encrypted delivered checkpoint.'},
  {id:'scheduled_run',status:'unverified',requirement:'After controlled activation, observe a genuine scheduled run restore the exact checkpoint, save its delivered checkpoint and remain quiet when healthy.'},
  {id:'external_stale_run_monitor',status:'unverified',requirement:'Configure and test an independent alert for a missing or failed monitor run, including actual operator receipt; a monitor-gap incident cannot detect permanent stoppage.'},
] as const;

const validMailbox=(value:string)=>/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
const validStateKey=(value:string)=>/^[A-Za-z0-9+/]{43}=$/.test(value)&&Buffer.from(value,'base64').length===32&&Buffer.from(value,'base64').toString('base64')===value;

/** Only returns fixed labels and booleans. Never returns environment values or hashes. */
export function checkMonitorReadiness(env:NodeJS.ProcessEnv):MonitorReadinessReport{
  const checks:MonitorReadinessCheck[]=[];
  const check=(id:string,passed:boolean,requirement:string)=>checks.push({id,status:passed?'pass':'blocked',requirement});
  const secret=env.FOLIO_MONITOR_SECRET??'',key=env.FOLIO_MONITOR_STATE_KEY??'',mailKey=env.FOLIO_MONITOR_EMAIL_API_KEY??'';
  check('canonical_origin',env.FOLIO_MONITOR_ORIGIN==='https://maintainflow.io','Use the exact canonical origin configured in operations-monitor.yml.');
  check('automatic_schedule_disabled',[undefined,'','false'].includes(env.FOLIO_MONITOR_ENABLED),'During preparation, leave FOLIO_MONITOR_ENABLED unset or false; this only checks the supplied local value.');
  check('diagnostics_credential_shape',secret.length>=32&&!/\s/.test(secret),'Provide a dedicated diagnostics credential of at least 32 characters without whitespace.');
  check('worker_credential_absent',!env.FOLIO_WORKER_SECRET,'Keep FOLIO_WORKER_SECRET out of the independent monitor environment.');
  check('state_key_shape',validStateKey(key),'Provide a canonical base64 encoding of exactly 32 independently generated random bytes.');
  check('state_key_distinct',Boolean(key)&&key!==secret&&key!==mailKey,'Use a separate state-encryption key; matching values are refused, but independent generation needs operator verification.');
  check('sending_key_shape',/^re_[A-Za-z0-9_-]{8,250}$/.test(mailKey),'Provide the dedicated verified-domain Resend sending key.');
  check('sender_matches_workflow',env.FOLIO_MONITOR_EMAIL_FROM==='no-reply@maintainflow.io','Use the sender fixed in operations-monitor.yml; provider verification is a separate check.');
  check('recipient_shape',validMailbox(env.FOLIO_MONITOR_EMAIL_TO??''),'Provide one syntactically valid recipient; this cannot establish approval or inbox delivery.');
  check('state_path_matches_workflow',env.FOLIO_MONITOR_STATE_FILE===undefined||env.FOLIO_MONITOR_STATE_FILE==='.monitor/state.enc','Use the workflow state path .monitor/state.enc; this preflight never opens it.');
  return {mode:'offline_configuration_preflight',configurationReady:checks.every(item=>item.status==='pass'),hostedActivationVerified:false,networkCalls:0,stateReads:0,stateWrites:0,checks,externalChecks};
}

export function main(args=process.argv.slice(2),env=process.env,output:(value:string)=>void=console.log):number{
  if(args.length>1||(args.length===1&&args[0]!=='--check')){
    output(JSON.stringify({mode:'offline_configuration_preflight',error:'invalid_arguments',networkCalls:0,stateReads:0,stateWrites:0}));
    return 2;
  }
  const report=checkMonitorReadiness(env);
  output(JSON.stringify(report,null,2));
  return report.configurationReady?0:1;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)process.exitCode=main();
