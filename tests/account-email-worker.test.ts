import test from 'node:test';
import assert from 'node:assert/strict';
import {runAccountEmailWorker} from '../server/core/account-email-worker.js';

test('local account-mail lane drains its queue and cancellation interrupts idle polling',async()=>{
  const controller=new AbortController();let calls=0;
  const finished=runAccountEmailWorker(controller.signal,{idleMs:1000,async processOne(budget){
    assert.equal(budget.signal,controller.signal);calls++;
    if(calls===3)controller.abort();
    return calls<3;
  }});
  await finished;assert.equal(calls,3);
  const idle=new AbortController();let entered!:()=>void;
  const waiting=new Promise<void>(resolve=>{entered=resolve;});
  const loop=runAccountEmailWorker(idle.signal,{async processOne(){entered();return false;}});
  await waiting;idle.abort();await loop;
});

test('local account-mail lane retries a reported failure without exposing provider errors',async()=>{
  const controller=new AbortController();let attempts=0,errors=0;
  await runAccountEmailWorker(controller.signal,{idleMs:1,onError:()=>{errors++;},async processOne(){
    if(++attempts===1)throw new Error('PRIVATE provider response');
    controller.abort();return false;
  }});
  assert.equal(attempts,2);assert.equal(errors,1);
});
