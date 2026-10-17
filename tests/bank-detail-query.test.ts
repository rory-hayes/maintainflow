import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {environmentManager,focusManager,QueryClient,QueryObserver,type QueryObserverOptions} from '@tanstack/react-query';
import {ApiError,dataQueryOptions} from '../src/lib/api';

const interval=20;
type Request={path:string;workspace:string|null};
function harness(t:TestContext,respond:(request:Request,index:number)=>Response|Promise<Response>){
  const previousServer=environmentManager.isServer(),previousFocus=focusManager.isFocused(),previousFetch=globalThis.fetch,previousStorage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  let workspace='synthetic-workspace-a';
  const requests:Request[]=[],stops:(()=>void)[]=[];
  const client=new QueryClient({defaultOptions:{queries:{retry:1,retryDelay:0,staleTime:0,gcTime:Infinity,refetchOnWindowFocus:false}}});
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>workspace}});
  globalThis.fetch=async(path,options)=>{const request={path:String(path),workspace:new Headers(options?.headers).get('X-Workspace-Id')};requests.push(request);return respond(request,requests.length);};
  // Exercise QueryObserver's real interval scheduling in this isolated Node process.
  environmentManager.setIsServer(()=>false);focusManager.setFocused(true);
  t.after(()=>{stops.forEach(stop=>stop());client.clear();globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'sessionStorage',previousStorage);else Reflect.deleteProperty(globalThis,'sessionStorage');environmentManager.setIsServer(()=>previousServer);focusManager.setFocused(previousFocus);});
  function observe(options:QueryObserverOptions<{id:string}>){const observer=new QueryObserver(client,options);stops.push(observer.subscribe(()=>{}));return observer;}
  return {client,requests,observe,setWorkspace:(id:string)=>{workspace=id;}};
}
const response=(status=200)=>new Response(JSON.stringify(status===200?{id:'synthetic-statement'}:{message:'Bank statement not found.'}),{status,headers:{'Content-Type':'application/json'}});
async function until(check:()=>boolean){const end=Date.now()+1500;while(!check()){if(Date.now()>end)assert.fail('The controlled query did not settle.');await delay(2);}}
const options=(client:QueryClient,path='/api/bank-statements/synthetic-statement',poll:number|false=interval)=>dataQueryOptions<{id:string}>(client,path,poll,false,{stopOnNotFound:true});

test('bank detail 404 settles once; explicit retries settle again and successful retry resumes polling',async t=>{
  let status=404;
  const {client,requests,observe}=harness(t,()=>response(status));
  const observer=observe(options(client));
  await until(()=>observer.getCurrentResult().isError&&observer.getCurrentResult().fetchStatus==='idle');
  await delay(interval*3);
  assert.equal(requests.length,1);assert.equal((observer.getCurrentResult().error as ApiError).status,404);
  await observer.refetch();
  await delay(interval*3);
  assert.equal(requests.length,2);assert.equal(observer.getCurrentResult().fetchStatus,'idle');
  status=200;
  await observer.refetch();
  assert.equal(requests.length,3);assert.deepEqual(observer.getCurrentResult().data,{id:'synthetic-statement'});
  await until(()=>requests.length>=5);
  assert.equal(observer.getCurrentResult().isSuccess,true);
});

test('successful bank details retain interval polling',async t=>{
  const {client,requests,observe}=harness(t,()=>response());
  const observer=observe(options(client));
  await until(()=>requests.length>=3);
  assert.equal(observer.getCurrentResult().isSuccess,true);
});

test('non404 HTTP and network errors retain the configured retry and can recover',async t=>{
  let attempts=0,failure:Error|number=500;
  const {client}=harness(t,()=>{if(++attempts===1){if(failure instanceof Error)throw failure;return response(failure);}return response();});
  for(const error of [500,503,403,new Error('Network failed with text mentioning 404')]){
    attempts=0;failure=error;
    const data=await client.fetchQuery(options(client,`/api/bank-statements/transient-${typeof error==='number'?error:'network'}`,false));
    assert.equal(attempts,2);assert.equal(data.id,'synthetic-statement');
  }
});

test('non404 failures preserve false, numeric and callback key-specific retry settings',async t=>{
  const {client,requests}=harness(t,()=>response(503));
  const cases=[{retry:false,expected:1},{retry:2,expected:3},{retry:(count:number,error:Error)=>error instanceof ApiError&&error.status===503&&count<1,expected:2}];
  for(const [index,item] of cases.entries()){
    const path=`/api/bank-statements/retry-policy-${index}`,before=requests.length;
    client.setQueryDefaults(['synthetic-workspace-a',path],{retry:item.retry});
    await assert.rejects(client.fetchQuery(options(client,path,false)),(error:unknown)=>error instanceof ApiError&&error.status===503);
    assert.equal(requests.length-before,item.expected);
  }
});

test('unmodified shared queries still inherit their normal 404 retry and polling',async t=>{
  const {client,requests,observe}=harness(t,()=>response(404));
  const unchanged=dataQueryOptions<{id:string}>(client,'/api/documents/synthetic-document',interval);
  assert.equal(Object.hasOwn(unchanged,'retry'),false);assert.equal(Object.hasOwn(unchanged,'enabled'),false);assert.equal(unchanged.refetchInterval,interval);
  const observer=observe(unchanged);
  await until(()=>observer.getCurrentResult().isError&&observer.getCurrentResult().fetchStatus==='idle');
  assert.equal(requests.length,2);
  await until(()=>requests.length>=4);
});

test('a new route or workspace starts its own query after a previous 404',async t=>{
  const path='/api/bank-statements/synthetic-statement';
  const {client,requests,observe,setWorkspace}=harness(t,request=>response(request.workspace==='synthetic-workspace-a'&&request.path===path?404:200));
  const observer=observe(options(client,path));
  await until(()=>observer.getCurrentResult().isError);
  assert.equal(requests.length,1);
  observer.setOptions(options(client,'/api/bank-statements/different-statement'));
  await until(()=>observer.getCurrentResult().isSuccess);
  setWorkspace('synthetic-workspace-b');
  observer.setOptions(options(client,path));
  assert.equal(observer.getCurrentResult().data,undefined);
  await until(()=>requests.filter(request=>request.workspace==='synthetic-workspace-b').length>=2);
  assert.equal(observer.getCurrentResult().isSuccess,true);
  assert.equal(client.getQueryState(['synthetic-workspace-a',path])?.status,'error');
  assert.equal(client.getQueryState(['synthetic-workspace-b',path])?.status,'success');
});
