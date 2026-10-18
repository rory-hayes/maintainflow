import test from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {createOpenAIProvider,openAIExtraction} from '../server/core/openai-provider.js';
import {createOpenAISchemaSuggestionProvider} from '../server/core/openai-schema-suggestions.js';
import {createOpenAISplitSuggestionProvider} from '../server/core/openai-split-suggestions.js';
import {openAIUsageObservation} from '../server/core/openai-usage.js';
import type {AIUsageObservation,AIUsageObserver} from '../shared/ai-usage.js';

const id='b0000000-0000-4000-8000-000000000001';
const usage={input_tokens:100,output_tokens:10,input_tokens_details:{cached_tokens:20},output_tokens_details:{reasoning_tokens:2},total_tokens:110};
const pricing={...openAIExtraction,pricingBasis:'OpenAI standard USD token rates, 2026-09-07'};
function payload(output:unknown,overrides:Record<string,unknown>={}){
 return {id:'resp_synthetic_usage',model:openAIExtraction.model,status:'completed',usage,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(output)}]}],...overrides};
}
async function cases(){
 const pdf=await PDFDocument.create();pdf.addPage();const bytes=Buffer.from(await pdf.save());
 const base={bytes:Buffer.from('Identifier: synthetic'),mimeType:'text/plain',pages:[{page:1,text:'Identifier: synthetic'}],locale:'en-IE'};
 return [
  {name:'extraction',output:{rawValues:{identifier:'synthetic'},evidence:[]},run:(fetch:typeof globalThis.fetch,observer:AIUsageObserver,signal?:AbortSignal)=>createOpenAIProvider({apiKey:'synthetic-only',fetch}).extract({...base,schema:{fields:[{key:'identifier',label:'Identifier',type:'string'}]},instructions:'',signal,usageObserver:observer})},
  {name:'schema',output:{fields:[{key:'identifier',label:'Identifier',type:'string',instructions:null,fields:null}]},run:(fetch:typeof globalThis.fetch,observer:AIUsageObserver,signal?:AbortSignal)=>createOpenAISchemaSuggestionProvider({apiKey:'synthetic-only',fetch}).suggest({...base,signal,usageObserver:observer})},
  {name:'split',output:{startPages:[1]},run:(fetch:typeof globalThis.fetch,observer:AIUsageObserver,signal?:AbortSignal)=>createOpenAISplitSuggestionProvider({apiKey:'synthetic-only',fetch}).suggest({...base,bytes,mimeType:'application/pdf',signal,usageObserver:observer})},
 ];
}
function observer(values:AIUsageObservation[],options:{startFailure?:boolean;writeFailure?:boolean}={}):AIUsageObserver{
 return {async start(){if(options.startFailure)throw new Error('Synthetic persistence unavailable');return id;},async observe(value){values.push(value);if(options.writeFailure)throw new Error('Synthetic observation write failure');},async finish(){}};
}

test('all three adapters retain returned usage before output validation and link valid results exactly once',async()=>{
 for(const item of await cases())for(const failure of ['success','incomplete','refusal','malformed','different_model'] as const){
  const values:AIUsageObservation[]=[];let calls=0;
  const extra=failure==='incomplete'?{status:'incomplete'}:failure==='refusal'?{output:[{type:'message',role:'assistant',status:'completed',content:[{type:'refusal',refusal:'PRIVATE response'}]}]}:failure==='malformed'?{output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'not JSON PRIVATE'}]}]}:failure==='different_model'?{model:'unpriced-synthetic-model'}:{};
  const request=(async()=>{calls++;return Response.json(payload(item.output,extra),{headers:{'x-request-id':'req_synthetic'}});}) as typeof fetch;
  if(failure==='success')assert.equal(((await item.run(request,observer(values))).tokenUsage as Record<string,unknown>)?.aiUsageAttemptId,id);
  else await assert.rejects(item.run(request,observer(values)),`${item.name}/${failure}`);
  assert.equal(calls,1);assert.equal(values.length,1);assert.equal(values[0].inputTokens,100);assert.equal(values[0].responseId,'resp_synthetic_usage');assert.equal(values[0].requestId,'req_synthetic');
  assert.equal(values[0].usageState,failure==='different_model'?'reported_unpriced':'reported_priced');assert.equal(values[0].costUsd===null,failure==='different_model');
  assert.doesNotMatch(JSON.stringify(values),/PRIVATE|synthetic-only|rawValues|fields|startPages/);
 }
});

test('pre-dispatch failure sends no request; post-response observation failure cannot change a successful result',async t=>{
 t.mock.method(console,'warn',()=>{});
 for(const item of await cases()){
  let calls=0;const request=(async()=>{calls++;return Response.json(payload(item.output));}) as typeof fetch;
  await assert.rejects(item.run(request,observer([],{startFailure:true})));assert.equal(calls,0);
  const result=await item.run(request,observer([],{writeFailure:true}));assert.equal(calls,1);assert.equal((result.tokenUsage as Record<string,unknown>)?.aiUsageAttemptId,id);
 }
});

test('malformed and oversized error bodies retain safe header IDs and status retry classification',async()=>{
 for(const item of await cases())for(const status of [401,429,503])for(const body of ['not JSON PRIVATE','x'.repeat(1024*1024+1)]){
  const values:AIUsageObservation[]=[];
  await assert.rejects(item.run((async()=>new Response(body,{status,headers:{'x-request-id':'req_error'}})) as typeof fetch,observer(values)),(error:any)=>{
   assert.equal(error.permanent,status===401,`${item.name}/${status}`);assert.doesNotMatch(error.message,/PRIVATE/);return true;
  });
  assert.equal(values.length,1);assert.equal(values[0].requestId,'req_error');assert.equal(values[0].httpStatus,status);assert.equal(values[0].usageState,'unknown');assert.equal(values[0].costUsd,null);
 }
});

test('aborted error bodies preserve known HTTP classification and header-only observations',async()=>{
 for(const item of await cases())for(const status of [401,429,503]){
  const controller=new AbortController(),values:AIUsageObservation[]=[];let timer:ReturnType<typeof setTimeout>|undefined;
  const request=(async()=>new Response(new ReadableStream({start(stream){timer=setTimeout(()=>{controller.abort();stream.error(new Error('PRIVATE interrupted body'));},10);}}),{status,headers:{'x-request-id':'req_aborted'}})) as typeof fetch;
  try{await assert.rejects(item.run(request,observer(values),controller.signal),(error:any)=>{assert.equal(error.permanent,status===401);assert.doesNotMatch(error.message,/PRIVATE/);return true;});}
  finally{clearTimeout(timer);}
  assert.equal(values.length,1);assert.equal(values[0].requestId,'req_aborted');assert.equal(values[0].usageState,'unknown');
 }
});

test('unknown usage is distinct from real zero; malformed counters and untrusted metadata are not retained',()=>{
 const response=new Response('{}',{headers:{'x-request-id':'PRIVATE secret value'}});
 for(const bad of [null,{}, {...usage,input_tokens:-1},{...usage,input_tokens:Infinity},{...usage,input_tokens_details:{cached_tokens:101}},{...usage,total_tokens:1},{...usage,output_tokens_details:'PRIVATE'}]){
  const value=openAIUsageObservation(response,payload({}, {usage:bad,id:'PRIVATE secret',model:'PRIVATE secret',error:{message:'PRIVATE secret'}}),pricing);
  assert.equal(value.usageState,'unknown');assert.equal(value.costUsd,null);assert.equal(value.requestId,null);assert.equal(value.responseId,null);assert.equal(value.model,null);assert.doesNotMatch(JSON.stringify(value),/PRIVATE/);
 }
 const zero=openAIUsageObservation(response,payload({}, {usage:{input_tokens:0,output_tokens:0}}),pricing);
 assert.equal(zero.usageState,'reported_priced');assert.equal(zero.costUsd,0);
});


test('cancellation during intent admission remains safely retryable and sends no provider request',async()=>{
 for(const item of await cases()){
  const controller=new AbortController();let calls=0;
  const hook:AIUsageObserver={...observer([]),async start(){controller.abort();return id;}};
  await assert.rejects(item.run((async()=>{calls++;throw new Error('Must not send');}) as typeof fetch,hook,controller.signal),(error:any)=>{assert.equal(error.permanent,false);assert.match(error.message,/canceled/);return true;});
  assert.equal(calls,0);
 }
});

test('nonclosing HTTP error bodies settle promptly and cancel even when stream cancellation never settles',async()=>{
 const variants=await cases();
 await Promise.all(variants.flatMap(item=>[400,401,408,429,503].map(async status=>{
  const values:AIUsageObservation[]=[];let calls=0,cancellations=0;
  const body=new ReadableStream<Uint8Array>({start(stream){stream.enqueue(Buffer.from('PRIVATE incomplete error'));},cancel(){cancellations++;return new Promise<void>(()=>{});}});
  const start=performance.now();
  await assert.rejects(item.run((async()=>{calls++;return new Response(body,{status,headers:{'x-request-id':'req_stalled','retry-after':'17'}});}) as typeof fetch,observer(values)),(error:any)=>{
   const permanent=status===400||status===401||(item.name==='extraction'&&status===408);
   assert.equal(error.permanent,permanent,`${item.name}/${status}`);assert.doesNotMatch(error.message,/PRIVATE|deadline/);return true;
  });
  assert(performance.now()-start<2500,`${item.name}/${status}: error handling must not wait for the 80-second successful-response budget`);
  assert.equal(calls,1);assert.equal(cancellations,1);assert.equal(values.length,1);
  assert.equal(values[0].httpStatus,status);assert.equal(values[0].requestId,'req_stalled');assert.equal(values[0].usageState,'unknown');assert.equal(values[0].costUsd,null);
 })));
});

test('prompt quota error bodies retain permanent classification and available returned usage',async()=>{
 for(const item of await cases()){
  const values:AIUsageObservation[]=[];let calls=0;
  await assert.rejects(item.run((async()=>{calls++;return Response.json(payload(item.output,{status:'failed',error:{code:'insufficient_quota',message:'PRIVATE'}}),{status:429,headers:{'x-request-id':'req_quota'}});}) as typeof fetch,observer(values)),(error:any)=>{
   assert.equal(error.permanent,true);assert.match(error.message,/quota/);assert.doesNotMatch(error.message,/PRIVATE/);return true;
  });
  assert.equal(calls,1);assert.equal(values.length,1);assert.equal(values[0].usageState,'reported_priced');assert.equal(values[0].inputTokens,100);
 }
});

test('the short error observation deadline does not truncate a successful response',async()=>{
 await Promise.all((await cases()).map(async item=>{
  const values:AIUsageObservation[]=[];let timer:ReturnType<typeof setTimeout>|undefined,cancellations=0;
  const body=new ReadableStream<Uint8Array>({start(stream){timer=setTimeout(()=>{stream.enqueue(Buffer.from(JSON.stringify(payload(item.output))));stream.close();},1200);},cancel(){cancellations++;}});
  try{
   const result=await item.run((async()=>new Response(body)) as typeof fetch,observer(values));
   assert.equal((result.tokenUsage as Record<string,unknown>).aiUsageAttemptId,id);assert.equal(values[0].usageState,'reported_priced');assert.equal(cancellations,0);
  }finally{clearTimeout(timer);}
 }));
});
