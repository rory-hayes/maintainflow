import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import Fastify from 'fastify';
import rateLimit,{type FastifyRateLimitStore} from '@fastify/rate-limit';
import type {Pool} from 'pg';
import {adminPool,appPool,closeDatabase} from '../server/core/db.js';
import {requestRateLimitOptions,requestRateLimitKey,createPostgresRateLimitStore,authenticationRateLimit} from '../server/core/rate-limit.js';

const suiteNamespace=`rate-test:${randomUUID()}`;
const ownedKeys=new Set<string>();
const cleanupCounts:number[]=[];
const database={query:async(sql:string,values?:any[])=>{
 const result=await adminPool.query(sql,values);
 if(sql.startsWith('WITH instant')&&values?.[0])ownedKeys.add(values[0]);
 if(sql.startsWith('DELETE FROM request_rate_limits WHERE bucket_key IN'))cleanupCounts.push(result.rowCount??0);
 return result;
}} as Pick<Pool,'query'>;
const ip='192.0.2.211';
const key=requestRateLimitKey({ip});
const increment=(store:FastifyRateLimitStore,input=key,window=60_000,max=5)=>new Promise<{current:number;ttl:number}>((resolve,reject)=>{
 (store.incr as (key:string,callback:(error:Error|null,result?:{current:number;ttl:number})=>void,window:number,max:number)=>void)(input,(error,result)=>error?reject(error):resolve(result!),window,max);
});
function newStore(label:string){
 const Store=createPostgresRateLimitStore({database,namespace:`${suiteNamespace}:${label}`});
 return new Store({});
}
async function testApp(label:string,max=2){
 const app=Fastify({logger:false});
 await app.register(rateLimit,requestRateLimitOptions({database,namespace:`${suiteNamespace}:${label}`,max,timeWindow:60_000}));
 return app;
}
after(async()=>{
 try{if(ownedKeys.size)await adminPool.query('delete from request_rate_limits where bucket_key=any($1::text[])',[[...ownedKeys]]);}
 finally{await closeDatabase();}
});

test('IP keys hide raw addresses, normalize aliases and share one IPv6 /64 budget',()=>{
 assert.match(key,/^[a-f0-9]{64}$/);assert.ok(!key.includes(ip));
 assert.equal(key,requestRateLimitKey({ip:`::ffff:${ip}`}));
 assert.notEqual(key,requestRateLimitKey({ip:'192.0.2.212'}));
 const first=requestRateLimitKey({ip:'2001:db8:abcd:1234::1'});
 assert.equal(first,requestRateLimitKey({ip:'2001:0db8:abcd:1234:ffff:abcd:dead:beef'}));
 assert.notEqual(first,requestRateLimitKey({ip:'2001:db8:abcd:1235::1'}));
 assert.throws(()=>requestRateLimitKey({ip:'not-an-ip'}),(error:any)=>error.statusCode===503);
});

test('atomic shared increments across independent store instances allow exactly max concurrent requests',async()=>{
 const before=new Set(ownedKeys);
 const first=newStore('concurrent'),second=newStore('concurrent');
 const results=await Promise.all(Array.from({length:24},(_,i)=>increment(i%2?first:second)));
 assert.equal(results.filter(result=>result.current<=5).length,5);
 assert.equal(results.filter(result=>result.current===6).length,19);
 assert.deepEqual(results.filter(result=>result.current<=5).map(result=>result.current).sort(),[1,2,3,4,5]);
 assert.ok(results.every(result=>result.ttl>0&&result.ttl<=60_000));
 const created=[...ownedKeys].filter(value=>!before.has(value));assert.equal(created.length,1);
 const row=(await adminPool.query('select * from request_rate_limits where bucket_key=$1',[created[0]])).rows[0];
 assert.equal(row.hits,6);assert.deepEqual(Object.keys(row).sort(),['bucket_key','expires_at','hits']);
 const expires=row.expires_at.getTime();
 assert.equal((await increment(second)).current,6);
 assert.equal((await adminPool.query('select expires_at from request_rate_limits where bucket_key=$1',[created[0]])).rows[0].expires_at.getTime(),expires);
});

test('an expired database window resets without process-clock mutation or an application restart',async()=>{
 const before=new Set(ownedKeys),store=newStore('reset');
 assert.equal((await increment(store)).current,1);
 const bucket=[...ownedKeys].find(value=>!before.has(value))!;
 await adminPool.query("update request_rate_limits set hits=6,expires_at=clock_timestamp()-interval '1 millisecond' where bucket_key=$1",[bucket]);
 const reset=await increment(newStore('reset'));
 assert.equal(reset.current,1);assert.ok(reset.ttl>59_000&&reset.ttl<=60_000);
 assert.equal((await adminPool.query('select expires_at>clock_timestamp() future from request_rate_limits where bucket_key=$1',[bucket])).rows[0].future,true);
});

test('independent Fastify instances share the limit and reject before authentication queries or handler work',async()=>{
 const first=await testApp('apps'),second=await testApp('apps');
 let authenticationReads=0,handlerCalls=0;
 for(const app of [first,second]){
  app.addHook('preHandler',async()=>{authenticationReads++;await adminPool.query('select 1 as owned_rate_limit_authentication_probe');});
  app.get('/private',async()=>{handlerCalls++;return {ok:true};});
 }
 try{
  assert.equal((await first.inject({url:'/private',remoteAddress:ip})).statusCode,200);
  assert.equal((await second.inject({url:'/private',remoteAddress:ip})).statusCode,200);
  const blocked=await first.inject({url:'/private',remoteAddress:ip});
  assert.equal(blocked.statusCode,429);assert.equal(blocked.headers['x-ratelimit-remaining'],'0');
  assert.ok(Number(blocked.headers['retry-after'])>=1);
  assert.deepEqual({authenticationReads,handlerCalls},{authenticationReads:2,handlerCalls:2});
  assert.equal((await second.inject({url:'/private',remoteAddress:'192.0.2.212'})).statusCode,200);
 }finally{await first.close();await second.close();}
});

test('onRequest limiting rejects malformed JSON before parsing or protected work',async()=>{
 const app=await testApp('body',1);let handlerCalls=0,parsedCalls=0;
 app.addHook('preValidation',async()=>{parsedCalls++;});
 app.post('/protected',async()=>{handlerCalls++;return {ok:true};});
 try{
  assert.equal((await app.inject({method:'POST',url:'/protected',remoteAddress:ip,payload:{valid:true}})).statusCode,200);
  const blocked=await app.inject({method:'POST',url:'/protected',remoteAddress:ip,headers:{'content-type':'application/json'},payload:'{"broken":'});
  assert.equal(blocked.statusCode,429);assert.deepEqual({handlerCalls,parsedCalls},{handlerCalls:1,parsedCalls:1});
 }finally{await app.close();}
});

test('authentication child stores share 30 attempts across login, registration and password routes',async()=>{
 const app=await testApp('authentication',300);let handlerCalls=0;
 const routes=['/api/auth/login','/api/auth/register','/api/auth/password'];
 for(const url of routes)app.post(url,{config:{rateLimit:authenticationRateLimit}},async()=>{handlerCalls++;return {ok:true};});
 app.get('/ordinary',async()=>({ok:true}));
 try{
  for(let i=0;i<30;i++)assert.equal((await app.inject({method:'POST',url:routes[i%3],remoteAddress:ip,payload:{}})).statusCode,200);
  const blocked=await app.inject({method:'POST',url:routes[0],remoteAddress:ip,payload:{}});
  assert.equal(blocked.statusCode,429);assert.equal(blocked.headers['x-ratelimit-limit'],'30');
  assert.ok(Number(blocked.headers['retry-after'])>800);assert.equal(handlerCalls,30);
  assert.equal((await app.inject({url:'/ordinary',remoteAddress:ip})).statusCode,200);
 }finally{await app.close();}
});

test('store failure fails closed with a sanitized 503 and never reaches the handler',async()=>{
 const privateMarker='PRIVATE_DATABASE_CONNECTION_DETAILS';let storeCalls=0,handlerCalls=0;
 const unavailable={query:async()=>{storeCalls++;throw new Error(privateMarker);}} as unknown as Pick<Pool,'query'>;
 const app=Fastify({logger:false});
 await app.register(rateLimit,requestRateLimitOptions({database:unavailable,namespace:`suite:${randomUUID()}`}));
 app.get('/private',async()=>{handlerCalls++;return {ok:true};});
 try{
  const response=await app.inject({url:'/private',remoteAddress:ip});
  assert.equal(response.statusCode,503);assert.match(response.json().message,/protection.*unavailable.*try again/i);
  assert.ok(!response.body.includes(privateMarker));assert.deepEqual({storeCalls,handlerCalls},{storeCalls:1,handlerCalls:0});
 }finally{await app.close();}
});

test('cleanup removes at most 100 expired counters per pass and preserves live counters',async()=>{
 const expired=Array.from({length:130},()=>createHash('sha256').update(randomUUID()).digest('hex'));
 const live=createHash('sha256').update(randomUUID()).digest('hex');
 for(const item of [...expired,live])ownedKeys.add(item);
 await adminPool.query("insert into request_rate_limits(bucket_key,hits,expires_at) select k,1,'2000-01-01'::timestamptz from unnest($1::text[]) k",[expired]);
 await adminPool.query("insert into request_rate_limits(bucket_key,hits,expires_at) values($1,1,clock_timestamp()+interval '1 hour')",[live]);
 const cleanupBefore=cleanupCounts.length;
 const store=newStore('cleanup');await increment(store);
 assert.equal(cleanupCounts.length,cleanupBefore+1);assert.equal(cleanupCounts.at(-1),100);
 assert.equal(Number((await adminPool.query('select count(*) n from request_rate_limits where bucket_key=any($1::text[])',[expired])).rows[0].n),30);
 assert.equal((await adminPool.query('select 1 from request_rate_limits where bucket_key=$1',[live])).rowCount,1);
 // Cleanup also follows volume, so a stream of new clients cannot outgrow a
 // timer-only 100-row/minute deletion budget. Rejected increments count too.
 for(let i=0;i<49;i++)await increment(store);
 assert.equal(cleanupCounts.length,cleanupBefore+1);
 await increment(store);
 assert.equal(cleanupCounts.length,cleanupBefore+2);assert.ok(cleanupCounts.at(-1)!<=100);
 assert.equal(Number((await adminPool.query('select count(*) n from request_rate_limits where bucket_key=any($1::text[])',[expired])).rows[0].n),0);
});

test('request counters force RLS and are inaccessible to the tenant role',async()=>{
 const {rows:[flags]}=await adminPool.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='request_rate_limits'::regclass");
 assert.equal(flags.relrowsecurity,true);assert.equal(flags.relforcerowsecurity,true);
 await assert.rejects(appPool.query('select bucket_key from request_rate_limits limit 1'),(error:any)=>error.code==='42501');
});
