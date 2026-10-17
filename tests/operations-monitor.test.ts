import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {advance,initialState,lanes,seal,unseal,probe,sendNotice,message,main,deliverPending,drillNotices,validateCheckpoint,type Snapshot,type Notice} from '../scripts/operations-monitor.js';

const origin='https://owned-folio.example.test',incidentId='314c0e27-6df6-44a2-b881-11947e17e7fb';
const healthy=(minute:number):Snapshot=>({at:new Date(Date.UTC(2026,8,20,0,minute)).toISOString(),health:true,ready:true,diagnostics:true,queues:Object.fromEntries(lanes.map(lane=>[lane,{failed:0,expiredLeases:0,oldestDueSeconds:null}])) as NonNullable<Snapshot['queues']>});
const options={id:()=>incidentId};

test('monitor requires three failing polls and emits one incident plus one actual recovery',()=>{
  let state=initialState(origin);
  for(let i=0;i<2;i++){state=advance(state,{...healthy(i*5),ready:false},options);assert.equal(state.pending.length,0);}
  state=advance(state,{...healthy(10),ready:false},options);assert.equal(state.pending.length,1);assert.equal(state.pending[0].kind,'incident');
  state=advance(state,{...healthy(15),ready:false},options);assert.equal(state.pending.length,1);
  state=advance(state,healthy(20),options);assert.equal(state.incident,null);assert.deepEqual(state.pending.map(x=>x.kind),['incident','recovery']);assert.deepEqual(state.pending.map(x=>x.messageVersion),[2,2]);
  state=advance(state,healthy(25),options);assert.equal(state.pending.length,2);
});

test('transient failure resets without email; an open queue incident cannot recover through an unavailable probe',()=>{
  let state=advance(initialState(origin),{...healthy(0),health:false},options);state=advance(state,healthy(5),options);assert.equal(state.consecutiveFailures,0);assert.equal(state.pending.length,0);
  const delayed=healthy(10);delayed.queues!.extraction.oldestDueSeconds=301;state=advance(state,delayed,options);assert.ok(state.incident);
  state=advance(state,{...healthy(15),diagnostics:false,queues:null},options);assert.ok(state.incident);assert.equal(state.pending.length,1);
});

test('failed rows establish a historical baseline and alert on new failures after old counts decrease',()=>{
  const baseline=healthy(0);baseline.queues!.deliveries.failed=5;let state=advance(initialState(origin),baseline,options);assert.equal(state.pending.length,0);
  const increased=healthy(5);increased.queues!.deliveries.failed=6;state=advance(state,increased,options);assert.deepEqual(state.incident?.reasons,['queue_failed:deliveries']);
  const unchanged={...increased,at:healthy(10).at};state=advance(state,unchanged,options);assert.equal(state.pending.length,2);assert.equal(state.incident,null);
  state=advance(state,healthy(15),options);const newFailure=healthy(20);newFailure.queues!.deliveries.failed=1;state=advance(state,newFailure,options);assert.equal(state.pending.length,3);assert.deepEqual(state.incident?.reasons,['queue_failed:deliveries']);
});

test('expired lease alert needs three observed consecutive polls and a missing diagnostic breaks the sequence',()=>{
  let state=initialState(origin);for(let i=0;i<2;i++){const s=healthy(i*5);s.queues!.extraction.expiredLeases=1;state=advance(state,s,options);}assert.equal(state.pending.length,0);
  state=advance(state,{...healthy(10),diagnostics:false,queues:null},options);
  for(let i=3;i<5;i++){const s=healthy(i*5);s.queues!.extraction.expiredLeases=1;state=advance(state,s,options);}assert.equal(state.pending.length,0);
  const third=healthy(25);third.queues!.extraction.expiredLeases=1;state=advance(state,third,options);assert.deepEqual(state.incident?.reasons,['queue_lease:extraction']);
});

test('missed monitoring interval is identified separately from application outage and times must increase',()=>{
  const state=advance(initialState(origin),healthy(0),options);const gap=advance(state,healthy(21),options);assert.deepEqual(gap.incident?.reasons,['monitor_gap']);
  assert.throws(()=>advance(gap,healthy(21)),/non_monotonic/);assert.equal(advance(gap,healthy(26)).pending[1].kind,'recovery');
});

test('duplicate external ticks resume one durable observation without multiplying failure polls or notices',()=>{
  const tick='2026-09-20T00:02:00.000Z',first={...healthy(2),ready:false};
  const state=advance(initialState(origin),first,{...options,externalTick:tick});
  const resumed=unseal(seal(state,Buffer.alloc(32,7).toString('base64')),Buffer.alloc(32,7).toString('base64'),origin);
  const duplicate=advance(resumed,{...healthy(3),ready:false},{...options,externalTick:tick});
  assert.deepEqual(duplicate,resumed);assert.equal(duplicate.consecutiveFailures,1);assert.equal(duplicate.pending.length,0);
  const second=advance(duplicate,{...healthy(7),ready:false},{...options,externalTick:'2026-09-20T00:07:00.000Z'});
  const third=advance(second,{...healthy(12),ready:false},{...options,externalTick:'2026-09-20T00:12:00.000Z'});
  assert.equal(third.pending.length,1);assert.deepEqual(third.incident?.reasons,['readiness_unavailable']);
  assert.deepEqual(advance(third,{...healthy(13),ready:false},{...options,externalTick:'2026-09-20T00:12:00.000Z'}),third);
  const recovery=advance(third,healthy(17),{...options,externalTick:'2026-09-20T00:17:00.000Z'});
  assert.deepEqual(recovery.pending.map(n=>n.kind),['incident','recovery']);
  assert.deepEqual(advance(recovery,healthy(18),{...options,externalTick:'2026-09-20T00:17:00.000Z'}),recovery);
  assert.throws(()=>advance(state,healthy(7),{externalTick:'invalid'}),/invalid_external_tick/);
  assert.throws(()=>advance(state,healthy(7),{externalTick:'2026-09-20T00:12:00.000Z'}),/invalid_external_tick/);
});

for(const externalFirst of [true,false])test(`overlapping schedulers preserve observation debounce and one outbox identity: ${externalFirst?'external then native':'native then external'}`,()=>{
  let state=initialState(origin),identities=0;
  const sampling={id:()=>{identities++;return incidentId;}};
  const pair=(minute:number,ready:boolean)=>{
    const tick=healthy(minute).at;
    for(const [index,external]of [externalFirst,!externalFirst].entries()){
      const snapshot={...healthy(minute),ready,at:new Date(Date.parse(tick)+(index+1)*10_000).toISOString()};
      snapshot.queues!.extraction.expiredLeases=ready?0:1;
      const previous=structuredClone(state);
      state=advance(state,snapshot,{...sampling,...(external?{externalTick:tick}:{})});
      // A native observation after this tick suppresses the later external one.
      if(external&&!externalFirst)assert.deepEqual(state,previous);
    }
    assert.equal(state.checkedAt,new Date(Date.parse(tick)+(externalFirst?20_000:10_000)).toISOString());
  };
  pair(2,false);
  assert.equal(state.consecutiveFailures,externalFirst?2:1);
  assert.equal(state.expiredPolls.extraction,externalFirst?2:1);
  assert.equal(state.pending.length,0);assert.equal(identities,0);
  pair(7,false);
  assert.equal(state.consecutiveFailures,externalFirst?3:2);
  assert.equal(state.expiredPolls.extraction,externalFirst?3:2);
  assert.equal(state.pending.length,externalFirst?1:0);
  pair(12,false);
  const openedAt=new Date(Date.parse(healthy(externalFirst?7:12).at)+10_000).toISOString();
  assert.equal(identities,1);assert.equal(state.incident?.id,incidentId);
  assert.equal(state.incident?.openedAt,openedAt);
  assert.equal(state.pending.length,1);
  const incident=structuredClone(state.pending[0]);
  assert.deepEqual(incident,{id:incidentId,kind:'incident',at:openedAt,openedAt,reasons:['readiness_unavailable','queue_lease:extraction'],test:false,messageVersion:2});
  pair(17,false);
  assert.equal(identities,1);assert.deepEqual(state.pending,[incident]);assert.equal(state.incident?.openedAt,openedAt);
  pair(22,true);pair(27,true);
  assert.equal(identities,1);assert.equal(state.incident,null);assert.equal(state.consecutiveFailures,0);
  assert.equal(state.expiredPolls.extraction,0);
  assert.deepEqual(state.pending,[incident,{...incident,kind:'recovery',at:new Date(Date.parse(healthy(22).at)+10_000).toISOString()}]);
  assert.deepEqual(state.pending.map(notice=>`${notice.id}/${notice.kind}`),[`${incidentId}/incident`,`${incidentId}/recovery`]);
});

test('public artifact payload is encrypted and bound to the key and exact configured origin',()=>{
  const key=randomBytes(32).toString('base64'),state=advance(initialState(origin),healthy(0),options),ciphertext=seal(state,key);
  assert.deepEqual(unseal(ciphertext,key,origin),state);assert.equal(ciphertext.includes(Buffer.from('failedCounts')),false);
  assert.throws(()=>unseal(ciphertext,randomBytes(32).toString('base64'),origin),/authentication/);
  assert.throws(()=>unseal(ciphertext,key,'https://other.example.test'),/authentication/);
  const corrupt=Buffer.from(ciphertext);corrupt[corrupt.length-1]^=1;assert.throws(()=>unseal(corrupt,key,origin),/authentication/);
  assert.throws(()=>unseal(ciphertext.subarray(0,30),key,origin),/envelope/);
});

test('restored checkpoint accepts only one bounded authenticated regular file before any delivery',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-checkpoint-')),directory=path.join(root,'state');
  const key=randomBytes(32).toString('base64'),filename=path.join(directory,'state.enc'),bytes=seal(initialState(origin),key);
  try{
    await fs.mkdir(directory);await fs.writeFile(filename,bytes);
    await validateCheckpoint(filename,key,origin);
    await fs.writeFile(path.join(directory,'unexpected'),Buffer.alloc(0));
    await assert.rejects(validateCheckpoint(filename,key,origin),/contents_invalid/);
    await fs.rm(path.join(directory,'unexpected'));await fs.rm(filename);
    const target=path.join(root,'external');await fs.writeFile(target,bytes);await fs.symlink(target,filename);
    await assert.rejects(validateCheckpoint(filename,key,origin),/contents_invalid/);
    await fs.rm(filename);await fs.writeFile(filename,Buffer.alloc(128*1024+1));
    await assert.rejects(validateCheckpoint(filename,key,origin),/state_file_invalid/);
    await fs.writeFile(filename,bytes);
    await assert.rejects(validateCheckpoint(filename,randomBytes(32).toString('base64'),origin),/authentication/);
    await assert.rejects(validateCheckpoint(filename,key,'https://other.example.test'),/authentication/);
    const alias=path.join(root,'alias');await fs.symlink(directory,alias);
    await assert.rejects(validateCheckpoint(path.join(alias,'state.enc'),key,origin),/directory_invalid/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

function diagnostic(){return {status:'available',dependencies:{status:'ready',checks:{database:'ok',storage:'ok',restore:'ok'}},worker:{queues:lanes.map(lane=>({lane,failed:0,expiredLeases:0,oldestDueSeconds:null}))}};}
test('probes only fixed GET routes, sends the monitor bearer only to diagnostics and never follows redirects',async()=>{
  const calls:string[]=[],secret='owned-monitor-secret-0123456789abcdef';
  const transport:typeof fetch=async(input,init)=>{const url=String(input);calls.push(url);assert.ok(url.startsWith(origin+'/api/'));assert.equal(init?.method,undefined);assert.equal(init?.redirect,'error');assert.ok(init?.signal);const headers=new Headers(init?.headers);assert.equal(headers.get('authorization'),url.endsWith('/diagnostics')?'Bearer '+secret:null);return Response.json(url.endsWith('/health')?{name:'Folio',status:'ok'}:url.endsWith('/ready')?{status:'ready',checks:{database:'ok',storage:'ok',restore:'ok'}}:diagnostic());};
  const result=await probe(origin,secret,transport,()=>healthy(0).at);assert.equal(result.health&&result.ready&&result.diagnostics,true);assert.equal(calls.length,3);
});

test('malformed diagnostic queues fail closed and raw response content never enters the observation',async()=>{
  for(const rows of [[],[...diagnostic().worker.queues.slice(1),diagnostic().worker.queues[1]],diagnostic().worker.queues.map(q=>({...q,failed:-1}))]){
    const result=await probe(origin,'secret',async()=>Response.json({...diagnostic(),worker:{queues:rows},privatePayload:'secret customer data'}),()=>healthy(0).at);
    assert.equal(result.diagnostics,false);assert.equal(result.queues,null);assert.doesNotMatch(JSON.stringify(result),/customer/);
  }
  const oversized=await probe(origin,'secret',async()=>new Response('x'.repeat(128*1024+1)),()=>healthy(0).at);assert.equal(oversized.health,false);
});

test('transport errors are redacted and a never-successful probe does not claim readiness',async()=>{
  const result=await probe(origin,'secret',async()=>{throw new Error('credential and endpoint');},()=>healthy(0).at);assert.deepEqual(result,{...healthy(0),health:false,ready:false,diagnostics:false,queues:null});
});

test('incident and recovery use different stable idempotency keys, approved recipient only, and explicit test labels',async()=>{
  const notice=drillNotices(origin,incidentId,healthy(0).at)[0],keys:string[]=[],messages:any[]=[];
  const transport:typeof fetch=async(input,init)=>{assert.equal(String(input),'https://api.resend.com/emails');assert.equal(init?.redirect,'error');keys.push(new Headers(init?.headers).get('idempotency-key')!);messages.push(JSON.parse(String(init?.body)));return Response.json({id:incidentId});};
  const config={origin,to:'operator@example.test',from:'monitor@example.test',apiKey:'re_owned_fixture_only'};
  await sendNotice(notice,config,transport);await sendNotice(notice,config,transport);await sendNotice({...notice,kind:'recovery'},config,transport);
  assert.equal(keys[0],`folio-monitor/${incidentId}/incident`);assert.equal(keys[0],keys[1]);assert.equal(keys[2],`folio-monitor/${incidentId}/recovery`);assert.deepEqual(messages[0],messages[1]);assert.deepEqual(messages[0].to,[config.to]);
  assert.equal(messages[0].from,'MaintainFlow monitor <monitor@example.test>');assert.equal(messages[0].subject,'[MaintainFlow monitor] [TEST] Action required');assert.equal(messages[2].subject,'[MaintainFlow monitor] [TEST] Recovered');
  assert.match(messages[0].text,/approved MaintainFlow synthetic monitoring drill/);assert.match(message(notice,origin).text,/No production outage/);assert.match(message({...notice,test:false},origin).text,/^MaintainFlow operational monitoring notification\./);
  await assert.rejects(sendNotice(notice,{...config,to:'victim@example.test\nBcc:other@example.test'},transport),/invalid_email/);
  await assert.rejects(sendNotice(notice,config,async()=>new Response('provider secret',{status:503})),/alert_delivery_failed/);
});

test('unversioned encrypted pending notices retain their exact original payload and retry key',async()=>{
  const configuration={origin,to:'operator@example.test',from:'monitor@example.test',apiKey:'re_owned_fixture_only'},key=randomBytes(32).toString('base64');
  for(const kind of ['incident','recovery'] as const)for(const test of [false,true]){
    const notice:Notice={id:incidentId,kind,at:healthy(0).at,openedAt:healthy(0).at,reasons:['readiness_unavailable'],test},state=initialState(origin),requests:{body:string;key:string}[]=[];state.pending.push(notice);
    const transport:typeof fetch=async(_input,init)=>{requests.push({body:String(init?.body),key:new Headers(init?.headers).get('idempotency-key')!});if(requests.length===1)throw new Error('uncertain transport');return Response.json({id:incidentId});};
    await assert.rejects(deliverPending(state,configuration,async()=>{},transport,()=>Date.parse(healthy(1).at)),/uncertain transport/);
    const restored=unseal(seal(state,key),key,origin);assert.deepEqual(restored.pending,[notice]);
    assert.equal(await deliverPending(restored,configuration,async()=>{},transport,()=>Date.parse(healthy(2).at)),1);assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].key,`folio-monitor/${incidentId}/${kind}`);
    const title=kind==='incident'?'Action required':'Recovered';
    assert.deepEqual(JSON.parse(requests[0].body),{from:'Folio monitor <monitor@example.test>',to:[configuration.to],subject:`[Folio monitor]${test?' [TEST]':''} ${title}`,text:[test?'This is an approved synthetic monitoring drill. No production outage was caused.':'Folio operational monitoring notification.',`${title}: ${origin}`,`Observed at: ${notice.at}`,`Incident began: ${notice.openedAt}`,'Checks: readiness_unavailable',kind==='recovery'?'All monitored conditions are healthy again. A retained failure-count increase does not imply failed work was replayed or cleared.':'Inspect readiness, the operator diagnostics and provider logs. This monitor never wakes workers, retries jobs or changes customer data.'].join('\n\n')});
  }
  const unsupported=initialState(origin);unsupported.pending.push({...drillNotices(origin,incidentId,healthy(0).at)[0],messageVersion:3} as unknown as Notice);assert.throws(()=>seal(unsupported,key),/invalid_monitor_state/);
});

test('CLI refuses unknown actions without loading secrets or making a network request',async()=>{await assert.rejects(main(['--send-anything'],{}),/invalid_arguments/);});

test('full pending backlog remains drainable before recording another transition',async()=>{
  let state=initialState(origin);for(let i=0;i<16;i++){const s=healthy(i);if(i%2===0)s.queues!.extraction.oldestDueSeconds=301;state=advance(state,s,{id:()=>incidentId});}assert.equal(state.pending.length,16);
  let checkpoints=0;const configuration={origin,to:'operator@example.test',from:'monitor@example.test',apiKey:'re_owned_fixture_only'};
  assert.equal(await deliverPending(state,configuration,async()=>{checkpoints++;},async()=>Response.json({id:incidentId}),()=>Date.parse(healthy(16).at)),16);
  assert.equal(checkpoints,16);assert.equal(state.pending.length,0);const next=healthy(17);next.queues!.extraction.oldestDueSeconds=301;assert.equal(advance(state,next,options).pending.length,1);
});

test('an uncertain delivery keeps the exact pending notice and retry key; expired sends require reconciliation',async()=>{
  const state=initialState(origin),notice=drillNotices(origin,incidentId,healthy(0).at)[0];state.pending.push(notice);const configuration={origin,to:'operator@example.test',from:'monitor@example.test',apiKey:'re_owned_fixture_only'};let saved=0;
  await assert.rejects(deliverPending(state,configuration,async()=>{saved++;},async()=>{throw new Error('uncertain transport');},()=>Date.parse(healthy(1).at)));assert.deepEqual(state.pending,[notice]);assert.equal(saved,0);
  await assert.rejects(deliverPending(state,configuration,async()=>{},async()=>{throw new Error('must not send');},()=>Date.parse(healthy(0).at)+24*60*60*1000),/old_pending/);
});

for(const interruption of ['lost acknowledgment','crash before checkpoint'] as const)test(`encrypted checkpoint recovers real incident and recovery after ${interruption} without duplicate acceptance`,async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-monitor-accepted-')),filename=path.join(directory,'state.enc'),key=randomBytes(32).toString('base64');
  const configuration={origin,to:'operator@example.test',from:'monitor@example.test',apiKey:'re_owned_fixture_only'};
  const requests:{key:string;body:string}[]=[],accepted=new Map<string,string>();
  const transport:typeof fetch=async(input,init)=>{
    assert.equal(String(input),'https://api.resend.com/emails');assert.equal(init?.method,'POST');
    const request={key:new Headers(init?.headers).get('idempotency-key')!,body:String(init?.body)};requests.push(request);
    // The fake provider retains acceptance independently of the monitor process.
    if(accepted.has(request.key))assert.equal(request.body,accepted.get(request.key));
    else{accepted.set(request.key,request.body);if(interruption==='lost acknowledgment')throw new Error('accepted_but_acknowledgment_lost');}
    return Response.json({id:incidentId});
  };
  const checkpoint=async(state:Parameters<typeof seal>[0])=>{await fs.writeFile(filename,seal(state,key));};
  const restore=async()=>{await validateCheckpoint(filename,key,origin);return unseal(await fs.readFile(filename),key,origin);};
  try{
    let state=initialState(origin);
    for(let i=0;i<3;i++)state=advance(state,{...healthy(i*5),ready:false},options);
    assert.deepEqual(state.incident,{id:incidentId,openedAt:healthy(10).at,reasons:['readiness_unavailable'],notified:false});
    for(const kind of ['incident','recovery'] as const){
      if(kind==='recovery'){state=advance(state,healthy(15),options);assert.equal(state.incident,null);}
      const notice=structuredClone(state.pending[0]);assert.equal(notice.kind,kind);assert.equal(notice.test,false);assert.equal(notice.messageVersion,2);
      assert.equal(notice.openedAt,healthy(10).at);assert.deepEqual(notice.reasons,['readiness_unavailable']);
      await checkpoint(state);const before=await fs.readFile(filename);
      await assert.rejects(deliverPending(state,configuration,async()=>{throw new Error('accepted_but_checkpoint_not_written');},transport,()=>Date.parse(healthy(kind==='incident'?11:16).at)),interruption==='lost acknowledgment'?/acknowledgment_lost/:/checkpoint_not_written/);
      assert.deepEqual(await fs.readFile(filename),before);
      assert.equal(state.pending.length,interruption==='lost acknowledgment'?1:0);
      state=await restore();assert.deepEqual(state.pending,[notice]);
      if(kind==='incident')assert.equal(state.incident?.notified,false);
      assert.equal(await deliverPending(state,configuration,checkpoint,transport,()=>Date.parse(healthy(kind==='incident'?12:17).at)),1);
      state=await restore();assert.deepEqual(state.pending,[]);
      if(kind==='incident')assert.equal(state.incident?.notified,true);else assert.equal(state.incident,null);
      const attempts=requests.filter(request=>request.key===`folio-monitor/${incidentId}/${kind}`);
      assert.equal(attempts.length,2);assert.deepEqual(attempts[0],attempts[1]);
      const payload=JSON.parse(attempts[0].body);
      assert.equal(payload.subject,`[MaintainFlow monitor] ${kind==='incident'?'Action required':'Recovered'}`);
      assert.deepEqual(payload.to,[configuration.to]);assert.match(payload.text,/^MaintainFlow operational monitoring notification\./);assert.doesNotMatch(payload.text,/synthetic|\[TEST\]/);
      assert.equal(accepted.size,kind==='incident'?1:2);
    }
    assert.deepEqual([...accepted.keys()],[`folio-monitor/${incidentId}/incident`,`folio-monitor/${incidentId}/recovery`]);
    const routes:string[]=[],snapshot=await probe(origin,'owned-monitor-secret',async(input,init)=>{const url=String(input);routes.push(url);assert.equal(init?.method,undefined);return Response.json(url.endsWith('/health')?{name:'Folio',status:'ok'}:url.endsWith('/ready')?{status:'ready',checks:{database:'ok',storage:'ok',restore:'ok'}}:diagnostic());},()=>healthy(20).at);
    assert.deepEqual(snapshot,healthy(20));assert.deepEqual(routes,[origin+'/api/health',origin+'/api/ready',origin+'/api/internal/diagnostics']);
    state=advance(state,snapshot,options);assert.equal(state.incident,null);assert.deepEqual(state.pending,[]);await checkpoint(state);
    assert.equal(await deliverPending(await restore(),configuration,checkpoint,transport,()=>Date.parse(healthy(21).at)),0);
    assert.equal(requests.length,4);assert.equal(accepted.size,2);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('a repeated drill has byte-identical bodies under each fixed idempotency key',()=>{
  const first=drillNotices(origin,incidentId,healthy(0).at),retry=drillNotices(origin,incidentId,healthy(0).at);assert.deepEqual(first,retry);assert.deepEqual(first.map(n=>message(n,origin)),retry.map(n=>message(n,origin)));
  assert.throws(()=>drillNotices(origin,incidentId,''),/drill_identity/);
});
