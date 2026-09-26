import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import type {Pool} from 'pg';
import {createReadinessProbe,probeDatabase,probeNormalizationPolicy,probePrivateStorage,registerOperationalHealth,type OperationalServices} from '../server/core/operations.js';
import {installationConfiguration} from '../server/core/installation.js';
import {registerHostedWorker} from '../server/hosted-worker.js';

const secret='owned-readonly-diagnostics-0123456789abcdef';
const idle=():OperationalServices=>({database:async()=>{},storage:async()=>{},restore:async()=>{},queues:async()=>[]});

test('dedicated monitor bearer permits diagnostics but cannot wake hosted workers',async()=>{
  const monitorSecret='owned-monitor-only-0123456789abcdef';let wakes=0;
  const app=Fastify();registerOperationalHealth(app,{services:idle(),secret:()=>secret,monitorSecret:()=>monitorSecret});
  registerHostedWorker(app,{secret:()=>secret,waitUntil:()=>{},wake:async()=>{wakes++;}});
  try{
    assert.equal((await app.inject({url:'/api/internal/diagnostics',headers:{authorization:`Bearer ${monitorSecret}`}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/internal/worker',headers:{authorization:`Bearer ${monitorSecret}`}})).statusCode,401);
    assert.equal(wakes,0);
  }finally{await app.close();}
});

test('operational routes bypass the actual global database limiter before probes and bearer authentication',async()=>{
  let increments=0,probeCalls=0;
  class UnavailableStore {
    incr(_key:string,callback:(error:Error|null,result?:{current:number;ttl:number})=>void){increments++;callback(new Error('Database counter unavailable'));}
    child(){return this;}
  }
  const app=Fastify();
  await app.register(rateLimit,{global:true,hook:'onRequest',store:UnavailableStore,keyGenerator:()=> 'controlled-monitor'});
  const services=idle();services.database=async()=>{probeCalls++;throw new Error('Database unavailable');};
  registerOperationalHealth(app,{services,secret:()=>secret,cacheMs:0});
  app.get('/ordinary-route',async()=>({ok:true}));
  try{
    const denied=await app.inject('/api/internal/diagnostics');assert.equal(denied.statusCode,401);assert.equal(probeCalls,0);assert.equal(increments,0);
    const ready=await app.inject('/api/ready');assert.equal(ready.statusCode,503);assert.equal(ready.json().checks.database,'unavailable');assert.equal(probeCalls,1);assert.equal(increments,0);
    const diagnostic=await app.inject({url:'/api/internal/diagnostics',headers:{authorization:`Bearer ${secret}`}});assert.equal(diagnostic.statusCode,503);assert.equal(diagnostic.json().dependencies.checks.database,'unavailable');assert.equal(probeCalls,2);assert.equal(increments,0);
    // The exemption is route-scoped: ordinary requests still hit the installed store.
    assert.equal((await app.inject('/ordinary-route')).statusCode,500);assert.equal(increments,1);
  }finally{await app.close();}
});

test('dependency readiness shares an in-flight check, bounds a hung dependency and exposes no underlying errors',async()=>{
  let calls=0;const services=idle();services.database=async()=>{calls++;await new Promise(()=>{});};services.storage=async()=>{throw new Error('private endpoint and credential');};
  const probe=createReadinessProbe(services,{deadlineMs:20,cacheMs:100});
  const first=probe(),second=probe();assert.equal(first,second);
  const value=await first;assert.equal(value.status,'not_ready');assert.equal(value.checks.database,'unavailable');assert.equal(value.checks.storage,'unavailable');assert.equal(value.checks.restore,'ok');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(value),/credential|endpoint|private/);assert.deepEqual(await probe(),value);assert.equal(calls,1);
});

test('readiness recovers after its cache expires and has no effect on worker queues',async()=>{
  let failed=true,queues=0;const services=idle();services.database=async()=>{if(failed)throw new Error('unavailable');};services.queues=async()=>{queues++;return[];};
  const app=Fastify();registerOperationalHealth(app,{services,cacheMs:0,secret:()=>secret});
  try{let r=await app.inject('/api/ready');assert.equal(r.statusCode,503);assert.equal(r.headers['cache-control'],'private, no-store');failed=false;r=await app.inject('/api/ready');assert.equal(r.statusCode,200);assert.equal(r.json().status,'ready');assert.equal(queues,0);}finally{await app.close();}
});

test('private diagnostics authenticates before any dependency work and never treats a quiet queue as a verified heartbeat',async()=>{
  let calls=0;const services=idle();for(const key of ['database','storage','restore'] as const)services[key]=async()=>{calls++;};services.queues=async()=>{calls++;return[{lane:'extraction',queued:2,due:1,processing:0,expiredLeases:0,failed:0,oldestDueSeconds:302}];};
  const app=Fastify();registerOperationalHealth(app,{services,secret:()=>secret});
  try{
    for(const header of [undefined,'Bearer wrong',`Basic ${secret}`,`Bearer ${secret} extra`]){const r=await app.inject({url:'/api/internal/diagnostics',headers:header?{authorization:header}:{}});assert.equal(r.statusCode,401);assert.deepEqual(r.json(),{error:'unauthorized'});}assert.equal(calls,0);
    const r=await app.inject({url:'/api/internal/diagnostics',headers:{authorization:`Bearer ${secret}`}});assert.equal(r.statusCode,200);assert.equal(r.json().worker.heartbeatVerified,false);assert.equal(r.json().worker.queueEligibilityVerified,false);assert.equal(r.json().backup.hostedRecoveryVerified,false);assert.equal(r.json().alerts.deliveryVerified,false);assert.equal(r.json().worker.queues[0].oldestDueSeconds,302);assert.equal(calls,4);assert.equal(r.headers['cache-control'],'private, no-store');
    assert.doesNotMatch(r.body,/workspaceId|documentId|emailAddress|storageKey/);
  }finally{await app.close();}
});

test('diagnostics fails closed without a secret and returns a safe unavailable result for an unreadable queue',async()=>{
  for(const configured of [false,true]){const services=idle();services.queues=async()=>{throw new Error('SQL with private content');};const app=Fastify();registerOperationalHealth(app,{services,secret:()=>configured?secret:''});try{const r=await app.inject({url:'/api/internal/diagnostics',headers:{authorization:`Bearer ${secret}`}});assert.equal(r.statusCode,503);assert.doesNotMatch(r.body,/SQL|private content/);if(configured)assert.equal(r.json().worker.queues,null);else assert.deepEqual(r.json(),{error:'diagnostics_unconfigured'});}finally{await app.close();}}
});

test('database probe releases normal connections and destroys a connection obtained after the deadline',async()=>{
  const queries:string[]=[],released:boolean[]=[];const client={query:async(sql:string)=>{queries.push(sql);return{rows:[]};},release:(destroy=false)=>released.push(destroy)};
  await probeDatabase({connect:async()=>client} as unknown as Pool,'select 1',100);assert.equal(queries[0],'BEGIN READ ONLY');assert.equal(queries.at(-1),'ROLLBACK');assert.deepEqual(released,[false]);
  let finish!:(value:typeof client)=>void;const late=new Promise<typeof client>(resolve=>{finish=resolve;});released.length=0;
  await assert.rejects(probeDatabase({connect:()=>late} as unknown as Pool,'select 1',10),/Probe unavailable/);finish(client);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(released,[true]);
});

test('database probe destroys a hung checked-out connection only once',async()=>{
  const releases:boolean[]=[];const client={query:async()=>new Promise(()=>{}),release:(destroy:boolean)=>releases.push(destroy)};
  await assert.rejects(probeDatabase({connect:async()=>client} as unknown as Pool,'select 1',10));assert.deepEqual(releases,[true]);
});

test('normalization readiness requires the validated current policy constraint without writes or private error details',async()=>{
  const current="CHECK (((normalization_context IS NULL) OR ((normalization_context ->> 'version'::text) = ANY (ARRAY['timestamp-v1'::text, 'regional-v2'::text]))))";
  const scenarios=[
    {rows:[],ready:false},
    {rows:[{convalidated:true,definition:"CHECK ((normalization_context ->> 'version'::text) = 'timestamp-v1'::text)"}],ready:false},
    {rows:[{convalidated:false,definition:current}],ready:false},
    {rows:[{convalidated:true,definition:current.replace('regional-v2','future-v3')}],ready:false},
    {rows:[{convalidated:true,definition:current.replace('regional-v2','timestamp-v1')}],ready:false},
    {rows:[{convalidated:true,definition:current.replace("'regional-v2'::text","'regional-v2'::text, 'future-v3'::text")}],ready:false},
    {rows:[{convalidated:true,definition:current.replace("'version'::text","'locale'::text")}],ready:false},
    {rows:[{convalidated:true,definition:current}],ready:true},
    {rows:[{convalidated:true,definition:current.replace(/::text/g,'').replace(/ /g,'\n  ')}],ready:true},
  ];
  for(const scenario of scenarios){
    const queries:string[]=[],releases:boolean[]=[];
    const pool={connect:async()=>({query:async(sql:string)=>{queries.push(sql);return{rows:sql.includes('pg_catalog.pg_constraint')?scenario.rows:[]};},release:(destroy=false)=>releases.push(destroy)})} as unknown as Pool;
    if(scenario.ready)await probeNormalizationPolicy(pool);else await assert.rejects(probeNormalizationPolicy(pool),{message:'Probe unavailable'});
    assert.equal(queries[0],'BEGIN READ ONLY');assert.equal(queries.at(-1),'ROLLBACK');assert.deepEqual(releases,[false]);
    assert.ok(queries[2].includes("a.attname='normalization_context'"));assert.doesNotMatch(queries.join('\n'),/insert |update |alter |create /i);
  }
});

test('storage readiness checks only a fixed private bucket and rejects public or oversized policy without reading an original',async()=>{
  const env={STORAGE_DRIVER:'supabase',SUPABASE_URL:'https://owned-fixture.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'private-fixture-key'};let requests=0,publicBucket=false,limit=10*1024*1024;
  const transport:typeof fetch=async(input,init)=>{requests++;assert.equal(String(input),'https://owned-fixture.supabase.co/storage/v1/bucket/folio-originals');assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.ok(init?.signal);return new Response(JSON.stringify({id:'folio-originals',public:publicBucket,file_size_limit:limit}));};
  await probePrivateStorage({env,fetch:transport});publicBucket=true;await assert.rejects(probePrivateStorage({env,fetch:transport}));publicBucket=false;limit++;await assert.rejects(probePrivateStorage({env,fetch:transport}));
  await assert.rejects(probePrivateStorage({env:{...env,SUPABASE_URL:'https://owned-fixture.supabase.co.evil.example'},fetch:transport}));assert.equal(requests,3);
});

test('filesystem readiness does not create storage or follow a configured directory symlink',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'folio-readiness-'));try{await probePrivateStorage({env:{STORAGE_DRIVER:'filesystem'},directory:root});await assert.rejects(probePrivateStorage({env:{STORAGE_DRIVER:'filesystem'},directory:path.join(root,'missing')}));assert.deepEqual(await fs.readdir(root),[]);await fs.symlink(root,path.join(root,'alias'));await assert.rejects(probePrivateStorage({env:{STORAGE_DRIVER:'filesystem'},directory:path.join(root,'alias')}));}finally{await fs.rm(root,{recursive:true,force:true});}
});

test('operator configuration defaults honestly missing, accepts verified legacy contact aliases and never guesses policy facts',()=>{
  const empty=installationConfiguration({});assert.equal(empty.publicDetails.configuration,'missing');assert.equal(empty.readiness.configured,false);assert.equal(empty.readiness.missing.length,8);
  const partial=installationConfiguration({FOLIO_OPERATOR_NAME:'',FOLIO_SUPPORT_EMAIL:' ',MAINTAINFLOW_LEGAL_ENTITY_NAME:'  Example Operator  ',MAINTAINFLOW_SUPPORT_CONTACT_EMAIL:'support@example.test',MAINTAINFLOW_PRIVACY_CONTACT_EMAIL:'privacy@example.test',UNRELATED_SECRET:'never public'});
  assert.equal(partial.publicDetails.operatorName,'Example Operator');assert.equal(partial.publicDetails.supportEmail,'support@example.test');assert.equal(partial.publicDetails.configuration,'partial');assert.equal(partial.publicDetails.retentionNotice,null);assert.doesNotMatch(JSON.stringify(partial),/never public|UNRELATED_SECRET/);
});

test('operator contacts and policy URLs reject controls, unsafe schemes and credentials; complete configuration is not legal or production proof',()=>{
  const invalid=installationConfiguration({FOLIO_OPERATOR_NAME:'Private\nHeader',FOLIO_SUPPORT_EMAIL:'x@example.test?body=secret',FOLIO_PRIVACY_URL:'javascript:alert(1)',FOLIO_TERMS_URL:'https://secret:token@example.test/terms'});assert.equal(invalid.publicDetails.configuration,'missing');
  const complete=installationConfiguration({FOLIO_OPERATOR_NAME:'Example Operator',FOLIO_SUPPORT_EMAIL:'support@example.test',FOLIO_PRIVACY_EMAIL:'privacy@example.test',FOLIO_PRIVACY_URL:'https://example.test/privacy',FOLIO_TERMS_URL:'https://example.test/terms',FOLIO_SUBPROCESSORS_URL:'https://example.test/providers',FOLIO_RETENTION_NOTICE:'Operator-supplied retention statement.',FOLIO_DATA_LOCATION_NOTICE:'Operator-supplied location statement.'});
  assert.equal(complete.publicDetails.configuration,'complete');assert.deepEqual(complete.readiness.missing,[]);assert.equal(complete.readiness.legalReviewVerified,false);assert.equal(complete.readiness.productionActivationVerified,false);
});
