/** Independent monitor. Importing this module performs no IO or provider calls. */
import fs,{constants} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';

export const lanes=['extraction','field_suggestions','split_suggestions','deliveries','provider_events','account_email','invitation_email','object_deletion'] as const;
type Lane=typeof lanes[number];
export type Snapshot={at:string;health:boolean;ready:boolean;diagnostics:boolean;queues:Record<Lane,{failed:number;expiredLeases:number;oldestDueSeconds:number|null}>|null};
type Incident={id:string;openedAt:string;reasons:string[];notified:boolean};
export type MonitorState={version:1;origin:string;checkedAt:string|null;consecutiveFailures:number;expiredPolls:Record<string,number>;failedCounts:Record<string,number>;incident:Incident|null;pending:Notice[]};
export type Notice={id:string;kind:'incident'|'recovery';at:string;openedAt:string;reasons:string[];test:boolean;messageVersion?:2};
export class MonitorError extends Error{readonly code:string;constructor(code:string){super(code);this.code=code;}}
function requireValue(ok:unknown,code:string):asserts ok{if(!ok)throw new MonitorError(code);}
const iso=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value));
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const maximumBytes=128*1024;
const reasonPattern=/^(health_unavailable|readiness_unavailable|diagnostics_unavailable|monitor_gap|queue_(age|lease|failed):(?:extraction|field_suggestions|split_suggestions|deliveries|provider_events|account_email|invitation_email|object_deletion))$/;

export function initialState(origin:string):MonitorState{return {version:1,origin,checkedAt:null,consecutiveFailures:0,expiredPolls:{},failedCounts:{},incident:null,pending:[]};}
export function advance(previous:MonitorState,snapshot:Snapshot,options:{test?:boolean;id?:()=>string}={}):MonitorState{
  const state=structuredClone(previous),reasons:string[]=[];
  requireValue(iso(snapshot.at)&&(!state.checkedAt||Date.parse(snapshot.at)>Date.parse(state.checkedAt)),'non_monotonic_probe');
  if(!snapshot.health)reasons.push('health_unavailable');
  if(!snapshot.ready)reasons.push('readiness_unavailable');
  if(!snapshot.diagnostics)reasons.push('diagnostics_unavailable');
  const unavailable=reasons.length>0;
  state.consecutiveFailures=unavailable?Math.min(3,state.consecutiveFailures+1):0;
  const gap=state.checkedAt!==null&&Date.parse(snapshot.at)-Date.parse(state.checkedAt)>20*60*1000;
  if(gap)reasons.push('monitor_gap');
  if(!snapshot.queues)state.expiredPolls={};
  if(snapshot.queues)for(const lane of lanes){
    const queue=snapshot.queues[lane];
    const priorCount=state.failedCounts[lane];
    if(priorCount!==undefined&&queue.failed>priorCount)reasons.push(`queue_failed:${lane}`);
    state.failedCounts[lane]=queue.failed;
    if(queue.oldestDueSeconds!==null&&queue.oldestDueSeconds>300)reasons.push(`queue_age:${lane}`);
    state.expiredPolls[lane]=queue.expiredLeases>0?Math.min(3,(state.expiredPolls[lane]??0)+1):0;
    if(state.expiredPolls[lane]>=3)reasons.push(`queue_lease:${lane}`);
  }
  // Do not declare recovery while a dependency is still failing below threshold.
  const actionable=state.consecutiveFailures>=3||reasons.some(reason=>!reason.endsWith('_unavailable'));
  if(!state.incident&&actionable){
    const incident={id:(options.id??randomUUID)(),openedAt:snapshot.at,reasons:[...new Set(reasons)],notified:false};
    state.incident=incident;state.pending.push({id:incident.id,kind:'incident',at:snapshot.at,openedAt:incident.openedAt,reasons:incident.reasons,test:options.test??false,messageVersion:2});
  }else if(state.incident&&!unavailable&&!reasons.length){
    const incident=state.incident;state.pending.push({id:incident.id,kind:'recovery',at:snapshot.at,openedAt:incident.openedAt,reasons:incident.reasons,test:options.test??false,messageVersion:2});state.incident=null;
  }
  requireValue(state.pending.length<=16,'notification_backlog_limit');state.checkedAt=snapshot.at;return state;
}

function validateState(value:unknown,origin:string):asserts value is MonitorState{
  requireValue(value&&typeof value==='object','invalid_monitor_state');const s=value as MonitorState;
  requireValue(s.version===1&&s.origin===origin&&(s.checkedAt===null||iso(s.checkedAt))&&integer(s.consecutiveFailures)&&s.consecutiveFailures<=3&&s.expiredPolls&&s.failedCounts&&Array.isArray(s.pending)&&s.pending.length<=16,'invalid_monitor_state');
  for(const [key,count]of Object.entries(s.expiredPolls))requireValue(lanes.includes(key as Lane)&&integer(count)&&count<=3,'invalid_monitor_state');
  for(const [key,count]of Object.entries(s.failedCounts))requireValue(lanes.includes(key as Lane)&&integer(count),'invalid_monitor_state');
  const incident=(n:Incident|Notice)=>requireValue(n&&/^[a-f0-9-]{36}$/.test(n.id)&&iso(n.openedAt)&&Array.isArray(n.reasons)&&n.reasons.length<=32&&n.reasons.every(r=>reasonPattern.test(r)),'invalid_monitor_state');
  if(s.incident){incident(s.incident);requireValue(typeof s.incident.notified==='boolean','invalid_monitor_state');}
  for(const n of s.pending){incident(n);requireValue(['incident','recovery'].includes(n.kind)&&iso(n.at)&&typeof n.test==='boolean'&&(n.messageVersion===undefined||n.messageVersion===2),'invalid_monitor_state');}
}
function encryptionKey(value:string){requireValue(/^[A-Za-z0-9+/]{43}=$/.test(value),'invalid_state_key');const key=Buffer.from(value,'base64');requireValue(key.length===32,'invalid_state_key');return key;}
export function seal(state:MonitorState,key:string):Buffer{
  validateState(state,state.origin);const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(key),nonce);cipher.setAAD(Buffer.from('folio-monitor:v1:'+state.origin));
  const payload=Buffer.concat([cipher.update(JSON.stringify(state),'utf8'),cipher.final()]);return Buffer.concat([Buffer.from('FMON1'),nonce,cipher.getAuthTag(),payload]);
}
export function unseal(data:Buffer,key:string,origin:string):MonitorState{
  requireValue(data.length>=34&&data.length<=maximumBytes&&data.subarray(0,5).toString()==='FMON1','invalid_state_envelope');
  try{const decipher=createDecipheriv('aes-256-gcm',encryptionKey(key),data.subarray(5,17));decipher.setAAD(Buffer.from('folio-monitor:v1:'+origin));decipher.setAuthTag(data.subarray(17,33));const state=JSON.parse(Buffer.concat([decipher.update(data.subarray(33)),decipher.final()]).toString());validateState(state,origin);return state;}
  catch(error){if(error instanceof MonitorError)throw error;throw new MonitorError('state_authentication_failed');}
}
export async function boundedJSON(response:Response){
  const reader=response.body?.getReader();requireValue(reader,'empty_response');let size=0;const chunks:Buffer[]=[];
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;requireValue(size<=maximumBytes,'response_limit');chunks.push(Buffer.from(part.value));}return JSON.parse(Buffer.concat(chunks).toString()) as any;}
  finally{await reader.cancel().catch(()=>{});}
}
export async function probe(origin:string,secret:string,transport:typeof fetch=fetch,now=()=>new Date().toISOString()):Promise<Snapshot>{
  const one=async(route:string,authenticate=false)=>{try{const response=await transport(origin+route,{headers:{'cache-control':'no-cache',...(authenticate?{authorization:'Bearer '+secret}:{})},redirect:'error',signal:AbortSignal.timeout(12_000)});if(response.status!==200){await response.body?.cancel();return null;}return await boundedJSON(response);}catch{return null;}};
  const [health,ready,diagnostic]=await Promise.all([one('/api/health'),one('/api/ready'),one('/api/internal/diagnostics',true)]);
  const readyShape=(body:any)=>body?.status==='ready'&&['database','storage','restore'].every(name=>body.checks?.[name]==='ok');
  let queues:Snapshot['queues']=null;
  if(diagnostic?.status==='available'&&readyShape(diagnostic.dependencies)&&Array.isArray(diagnostic.worker?.queues)&&diagnostic.worker.queues.length===lanes.length){
    const rows=diagnostic.worker.queues;
    if(lanes.every(lane=>rows.filter((row:any)=>row?.lane===lane).length===1)&&rows.every((row:any)=>integer(row.failed)&&integer(row.expiredLeases)&&(row.oldestDueSeconds===null||typeof row.oldestDueSeconds==='number'&&Number.isFinite(row.oldestDueSeconds)&&row.oldestDueSeconds>=0)))queues=Object.fromEntries(rows.map((r:any)=>[r.lane,{failed:r.failed,expiredLeases:r.expiredLeases,oldestDueSeconds:r.oldestDueSeconds}])) as Snapshot['queues'];
  }
  return {at:now(),health:health?.name==='Folio'&&health.status==='ok',ready:readyShape(ready),diagnostics:queues!==null,queues};
}
// Keep unversioned queued notices byte-compatible with their original idempotency key.
function noticeBrand(notice:Notice){return notice.messageVersion===2?'MaintainFlow':'Folio';}
export function message(notice:Notice,origin:string){
  const title=notice.kind==='incident'?'Action required':'Recovered';
  const brand=noticeBrand(notice);
  return {subject:`[${brand} monitor]${notice.test?' [TEST]':''} ${title}`,text:[notice.test?`This is an approved ${notice.messageVersion===2?'MaintainFlow ':''}synthetic monitoring drill. No production outage was caused.`:`${brand} operational monitoring notification.`,`${title}: ${origin}`,`Observed at: ${notice.at}`,`Incident began: ${notice.openedAt}`,`Checks: ${notice.reasons.join(', ')}`,notice.kind==='recovery'?'All monitored conditions are healthy again. A retained failure-count increase does not imply failed work was replayed or cleared.':'Inspect readiness, the operator diagnostics and provider logs. This monitor never wakes workers, retries jobs or changes customer data.'].join('\n\n')};
}
export async function sendNotice(notice:Notice,configuration:{origin:string;to:string;from:string;apiKey:string},transport:typeof fetch=fetch){
  requireValue(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(configuration.to)&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(configuration.from),'invalid_email_configuration');
  const body={from:`${noticeBrand(notice)} monitor <${configuration.from}>`,to:[configuration.to],...message(notice,configuration.origin)};
  const response=await transport('https://api.resend.com/emails',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+configuration.apiKey,'content-type':'application/json','idempotency-key':`folio-monitor/${notice.id}/${notice.kind}`},body:JSON.stringify(body),signal:AbortSignal.timeout(12_000)});
  if(!response.ok){await response.body?.cancel();throw new MonitorError('alert_delivery_failed');}const result=await boundedJSON(response);requireValue(typeof result?.id==='string'&&/^[a-f0-9-]{36}$/.test(result.id),'alert_acceptance_invalid');return {id:result.id,accepted:true};
}
async function persist(filename:string,state:MonitorState,key:string){const directory=path.dirname(filename);await fs.mkdir(directory,{recursive:true,mode:0o700});const stat=await fs.lstat(directory);requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'state_directory_invalid');const temporary=filename+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,seal(state,key),{mode:0o600,flag:'wx'});await fs.rename(temporary,filename);}finally{await fs.rm(temporary,{force:true});}}
async function load(filename:string,key:string,origin:string){let handle;try{handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();requireValue(stat.isFile()&&stat.size<=maximumBytes,'state_file_invalid');return unseal(await handle.readFile(),key,origin);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}finally{await handle?.close();}}

/** Authenticate exactly one bounded checkpoint before any restored notice is sent. */
export async function validateCheckpoint(filename:string,key:string,origin:string):Promise<void>{
  const directory=path.dirname(filename),stat=await fs.lstat(directory);
  requireValue(stat.isDirectory()&&!stat.isSymbolicLink(),'state_directory_invalid');
  const entries=await fs.readdir(directory,{withFileTypes:true});
  requireValue(path.basename(filename)==='state.enc'&&entries.length===1&&entries[0].name==='state.enc'&&entries[0].isFile()&&!entries[0].isSymbolicLink(),'state_directory_contents_invalid');
  requireValue(await load(filename,key,origin),'monitor_state_missing_requires_reconciliation');
}

export async function deliverPending(state:MonitorState,configuration:Parameters<typeof sendNotice>[1],checkpoint:(state:MonitorState)=>Promise<void>,transport:typeof fetch=fetch,now=Date.now){
  let delivered=0;
  while(state.pending.length){
    const notice=state.pending[0];
    // The caller must durably checkpoint these exact notices before entering.
    requireValue(now()-Date.parse(notice.at)<23*60*60*1000,'old_pending_alert_requires_reconciliation');
    await sendNotice(notice,configuration,transport);state.pending.shift();if(state.incident?.id===notice.id&&notice.kind==='incident')state.incident.notified=true;await checkpoint(state);delivered++;
  }
  return delivered;
}

export function drillNotices(origin:string,id:string,at:string):Notice[]{
  requireValue(/^[a-f0-9-]{36}$/.test(id)&&iso(at),'drill_identity_and_time_required');
  let state=initialState(origin);const now=Date.parse(at),queues=Object.fromEntries(lanes.map(lane=>[lane,{failed:0,expiredLeases:0,oldestDueSeconds:null}])) as NonNullable<Snapshot['queues']>;
  for(let i=0;i<3;i++)state=advance(state,{at:new Date(now+i).toISOString(),health:false,ready:false,diagnostics:false,queues:null},{test:true,id:()=>id});
  state=advance(state,{at:new Date(now+3).toISOString(),health:true,ready:true,diagnostics:true,queues},{test:true});return state.pending;
}

export async function main(args=process.argv.slice(2),env=process.env){
  if(args.length===0||args.length===1&&args[0]==='--plan'){console.log(JSON.stringify({networkCalls:0,mode:'prepared',cadence:'5 minutes best effort',failureThreshold:3,queueAgeSeconds:300,expiredLeasePolls:3,notifications:'incident and recovery only',mutations:'email and encrypted monitor state only'}));return;}
  requireValue(args.length===1&&['--probe','--run','--prepare','--deliver','--validate-state','--delivery-drill'].includes(args[0]),'invalid_arguments');
  const mode=args[0],origin=env.FOLIO_MONITOR_ORIGIN??'',url=new URL(origin);requireValue(url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password,'invalid_origin');
  const secret=env.FOLIO_MONITOR_SECRET??'';requireValue(secret.length>=32,'monitor_secret_missing');
  if(mode==='--probe'){const s=await probe(origin,secret);console.log(JSON.stringify({at:s.at,health:s.health,ready:s.ready,diagnostics:s.diagnostics}));return;}
  const key=env.FOLIO_MONITOR_STATE_KEY??'';encryptionKey(key);
  const filename=path.resolve(env.FOLIO_MONITOR_STATE_FILE??'.monitor/state.enc');
  if(mode==='--validate-state'){await validateCheckpoint(filename,key,origin);console.log(JSON.stringify({monitor:'checkpoint_authenticated'}));return;}
  const configuration={origin,to:env.FOLIO_MONITOR_EMAIL_TO??'',from:env.FOLIO_MONITOR_EMAIL_FROM??'',apiKey:env.FOLIO_MONITOR_EMAIL_API_KEY??''};
  requireValue(/^re_[A-Za-z0-9_-]{8,250}$/.test(configuration.apiKey),'mail_sender_missing');
  if(mode==='--delivery-drill'){
    // Use isolated state; never replace the real incident state or touch the app.
    const notices=drillNotices(origin,env.FOLIO_MONITOR_DRILL_ID??'',env.FOLIO_MONITOR_DRILL_AT??'');
    requireValue(Date.now()-Date.parse(notices[0].at)>=0&&Date.now()-Date.parse(notices[0].at)<23*60*60*1000,'drill_time_requires_reconciliation');
    const receipts=[];for(const notice of notices)receipts.push({kind:notice.kind,...await sendNotice(notice,configuration)});
    console.log(JSON.stringify({mode:'synthetic_alert_delivery_drill',drillId:env.FOLIO_MONITOR_DRILL_ID,providerAccepted:receipts,mailboxObserved:false,applicationMutations:0}));return;
  }
  let state=await load(filename,key,origin);
  requireValue(state||env.FOLIO_MONITOR_INITIALIZE==='true','monitor_state_missing_requires_reconciliation');
  state??=initialState(origin);
  const checkpoint=(value:MonitorState)=>persist(filename,value,key);
  let delivered=0;
  if(mode==='--deliver'||mode==='--run')delivered=await deliverPending(state,configuration,checkpoint);
  if(mode==='--deliver'){await checkpoint(state);console.log(JSON.stringify({monitor:'delivery_completed',providerAccepted:delivered,stateEncrypted:true}));return;}
  const snapshot=await probe(origin,secret);state=advance(state,snapshot);await checkpoint(state);
  if(mode==='--run')delivered+=await deliverPending(state,configuration,checkpoint);
  console.log(JSON.stringify({at:snapshot.at,monitor:'completed',healthy:snapshot.health&&snapshot.ready&&snapshot.diagnostics,incidentOpen:Boolean(state.incident),providerAccepted:delivered,stateEncrypted:true}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({monitor:'failed',code:error instanceof MonitorError?error.code:'unexpected_monitor_error'}));process.exitCode=1;});
