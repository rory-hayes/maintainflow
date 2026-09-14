import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {acceptsWorkerBearer,createHostedWorker,registerHostedWorker,workerRoute,type HostedWorkerServices} from '../server/hosted-worker.js';

const secret='controlled-worker-secret-0123456789abcdef';
const idle=():HostedWorkerServices=>({enqueue:async()=>{},core:async()=>false,suggestion:async()=>false,delivery:async()=>false,provider:async()=>false,deletion:async()=>false,email:async()=>false,maintenance:async()=>{}});

test('worker endpoint rejects unauthorized wakes and acknowledges before platform-owned work completes',async()=>{
  const app=Fastify();let calls=0,done!:()=>void;
  const pending=new Promise<void>(resolve=>{done=resolve;});
  const attached:Promise<unknown>[]=[];
  registerHostedWorker(app,{secret:()=>secret,waitUntil:work=>attached.push(work),wake:()=>{calls++;return pending;}});
  try{
    for(const authorization of [undefined,'Bearer wrong',`Basic ${secret}`,`Bearer ${secret} extra`]){
      const response=await app.inject({method:'POST',url:workerRoute,headers:authorization?{authorization}:{},payload:{}});
      assert.equal(response.statusCode,401);assert.equal(calls,0);
    }
    const response=await app.inject({method:'POST',url:workerRoute,headers:{authorization:`Bearer ${secret}`},payload:{}});
    assert.equal(response.statusCode,202);assert.deepEqual(response.json(),{accepted:true});assert.equal(calls,1);assert.equal(attached[0],pending);
    assert.equal((await app.inject({method:'GET',url:workerRoute,headers:{authorization:`Bearer ${secret}`}})).statusCode,404);
    done();await Promise.all(attached);
  }finally{done();await app.close();}
});

test('missing or short worker secret fails closed',async()=>{
  const app=Fastify();let called=false;
  registerHostedWorker(app,{secret:()=>'',waitUntil:()=>{called=true;},wake:async()=>{called=true;}});
  try{assert.equal((await app.inject({method:'POST',url:workerRoute})).statusCode,503);assert.equal(called,false);}
  finally{await app.close();}
  assert.equal(acceptsWorkerBearer(`Bearer ${secret}`,secret),true);
  assert.equal(acceptsWorkerBearer(`Bearer ${secret.slice(0,-1)}x`,secret),false);
  assert.equal(acceptsWorkerBearer('Bearer tiny','tiny'),false);
});

test('one warm instance shares in-flight work, drains every lane, then stops without idle polling',async()=>{
  let unblock!:()=>void;
  const gate=new Promise<void>(resolve=>{unblock=resolve;});
  let enqueued=0,maintenance=0;
  const remaining={core:2,suggestion:2,delivery:1,provider:1,deletion:1,email:1};
  const services=idle();services.enqueue=async()=>{enqueued++;await gate;};services.maintenance=async()=>{maintenance++;};
  for(const lane of ['core','suggestion','delivery','provider','deletion','email'] as const)services[lane]=async()=>remaining[lane]-->0;
  const wake=createHostedWorker(services);
  const first=wake(),second=wake();assert.equal(first,second);unblock();
  assert.deepEqual(await first,{core:2,suggestion:2,delivery:1,provider:1,deletion:1,email:1,stopped:'idle',errors:0});
  assert.equal(enqueued,1);assert.equal(maintenance,1);
  assert.notEqual(wake(),first);await wake();
});

for(const first of ['core','suggestion'] as const){
  test(`one wake drains shared-capacity work when ${first} is the older queued item`,async()=>{
    const second=first==='core'?'suggestion':'core';
    const queued:('core'|'suggestion')[]=[first,second],completed:string[]=[],calls={core:0,suggestion:0};
    let active=false;
    const services=idle();
    for(const lane of ['core','suggestion'] as const)services[lane]=async()=>{
      calls[lane]++;
      if(active||queued[0]!==lane)return false;
      active=true;
      // The other lane gets its claim attempt while this oldest item owns
      // the single workspace slot, just as in the database-backed worker.
      await new Promise<void>(resolve=>setImmediate(resolve));
      assert.equal(queued.shift(),lane);completed.push(lane);active=false;
      return true;
    };
    const result=await createHostedWorker(services)();
    assert.deepEqual(completed,[first,second]);assert.deepEqual(queued,[]);
    assert.equal(result.core,1);assert.equal(result.suggestion,1);
    assert.equal(result.stopped,'idle');assert.equal(result.errors,0);
    assert.deepEqual(calls,{core:3,suggestion:3});
  });
}

test('a failed extraction lane is reported once while other lanes finish without idle retries',async()=>{
  const services=idle();let coreCalls=0,suggestions=0,delivered=0;
  services.core=async()=>{coreCalls++;throw new Error('controlled extraction outage');};
  services.suggestion=async()=>suggestions++<2;
  services.delivery=async()=>delivered++<1;
  const reported:string[]=[];
  const result=await createHostedWorker(services,{onError:lane=>reported.push(lane)})();
  assert.equal(coreCalls,1);assert.equal(result.suggestion,2);assert.equal(result.delivery,1);
  assert.equal(result.errors,1);assert.equal(result.stopped,'idle');assert.deepEqual(reported,['core']);
});

test('remaining budget prevents another claim and one failed lane cannot starve others',async()=>{
  let now=0;const services=idle();let coreClaims=0,delivered=0;
  services.core=async()=>{coreClaims++;now+=120_000;return true;};
  services.delivery=async()=>{if(delivered++)return false;return true;};
  services.maintenance=async()=>{throw new Error('controlled maintenance outage');};
  const result=await createHostedWorker(services,{now:()=>now})();
  assert.equal(coreClaims,1);assert.equal(result.core,1);assert.equal(result.delivery,1);assert.equal(result.stopped,'budget');assert.equal(result.errors,1);
});

test('deadline abort reaches the active consumer and no further work is claimed',async()=>{
  const services=idle();let claims=0,aborted=false;
  services.core=async budget=>{
    claims++;
    await new Promise<void>(resolve=>budget.signal!.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));
    return true;
  };
  const result=await createHostedWorker(services,{budgetMs:20,reserveMs:{core:0,suggestion:0,delivery:0,provider:0,deletion:0,email:0}})();
  assert.equal(aborted,true);assert.equal(claims,1);assert.equal(result.stopped,'budget');
});

test('account email progresses while extraction is held and an email outage leaves other queues available',async()=>{
  const services=idle();let release!:()=>void,delivered=0,coreDone=false;
  const held=new Promise<void>(resolve=>{release=resolve;});
  services.core=async()=>{if(coreDone)return false;coreDone=true;await held;return true;};
  services.email=async()=>{if(delivered++)return false;assert.equal(coreDone,true);release();return true;};
  const result=await createHostedWorker(services)();
  assert.equal(result.core,1);assert.equal(result.email,1);
  let errorCount=0;
  const failing=idle();failing.email=async()=>{throw new Error('Controlled mail outage');};failing.delivery=async()=>errorCount++===0;
  const after=await createHostedWorker(failing)();assert.equal(after.email,0);assert.equal(after.delivery,1);assert.equal(after.errors,1);
});

test('approval enqueue work cannot hold up account email and enqueue failure retains existing delivery work',async()=>{
  const services=idle();let release!:()=>void,emails=0,deliveries=0;
  const held=new Promise<void>(resolve=>{release=resolve;});
  services.enqueue=async()=>{await held;throw new Error('Controlled approval enqueue failure');};
  services.email=async()=>{if(emails++)return false;release();return true;};
  services.delivery=async()=>deliveries++===0;
  const result=await createHostedWorker(services)();
  assert.equal(result.email,1);assert.equal(result.delivery,1);assert.equal(result.errors,1);
});
