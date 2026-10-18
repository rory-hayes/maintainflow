import type {AIUsageObservation,AIUsageObserver} from '../../shared/ai-usage.js';

type Pricing={model:string;inputPerMillion:number;cachedInputPerMillion:number;outputPerMillion:number;pricingBasis:string};
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=1_000_000_000;
const identifier=(v:unknown,pattern:RegExp)=>typeof v==='string'&&pattern.test(v)?v:null;

/** Independent of output/schema validity. Invalid or absent usage is not zero. */
export function openAIUsageObservation(response:Pick<Response,'status'|'headers'>,payload:unknown,pricing:Pricing):AIUsageObservation{
 const body=object(payload)?payload:{};
 const value:AIUsageObservation={
  model:identifier(body.model,/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/),
  requestId:identifier(response.headers.get('x-request-id'),/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/),
  responseId:identifier(body.id,/^resp_[a-zA-Z0-9_-]{1,195}$/),httpStatus:response.status,
  responseStatus:['completed','incomplete','failed','cancelled','queued','in_progress'].includes(String(body.status))?body.status as AIUsageObservation['responseStatus']:'unknown',
  usageState:'unknown',inputTokens:null,cachedInputTokens:null,outputTokens:null,reasoningTokens:null,costUsd:null,pricingBasis:null,
 };
 const usage=body.usage;if(!object(usage)||!count(usage.input_tokens)||!count(usage.output_tokens))return value;
 if(usage.input_tokens_details!==undefined&&!object(usage.input_tokens_details)||usage.output_tokens_details!==undefined&&!object(usage.output_tokens_details))return value;
 const cached=object(usage.input_tokens_details)?usage.input_tokens_details.cached_tokens??0:0;
 const reasoning=object(usage.output_tokens_details)?usage.output_tokens_details.reasoning_tokens??0:0;
 if(!count(cached)||cached>usage.input_tokens||!count(reasoning)||reasoning>usage.output_tokens||usage.total_tokens!==undefined&&usage.total_tokens!==usage.input_tokens+usage.output_tokens)return value;
 Object.assign(value,{usageState:'reported_unpriced',inputTokens:usage.input_tokens,cachedInputTokens:cached,outputTokens:usage.output_tokens,reasoningTokens:reasoning});
 if(value.model!==pricing.model)return value;
 const cost=((usage.input_tokens-cached)*pricing.inputPerMillion+cached*pricing.cachedInputPerMillion+usage.output_tokens*pricing.outputPerMillion)/1_000_000;
 if(!Number.isFinite(cost)||cost<0||cost>=1_000_000)return value;
 return {...value,usageState:'reported_priced',costUsd:cost,pricingBasis:pricing.pricingBasis};
}

/** Error status is already known. Inspect its body briefly without delaying disposition.
 * Cancellation is deliberately not awaited: an uncooperative stream must not
 * turn a bounded observation into an unbounded provider request. */
export async function readOpenAIErrorBody(response:Response,signal:AbortSignal,maxBytes:number):Promise<Record<string,unknown>|undefined>{
 if(!response.body)return;
 let reader:ReadableStreamDefaultReader<Uint8Array>;
 try{reader=response.body.getReader();}catch{return;}
 let expired=false,completed=false,rejectDeadline!:(reason:Error)=>void;
 const deadline=new Promise<never>((_,reject)=>{rejectDeadline=reject;});
 const stop=()=>{expired=true;rejectDeadline(new Error('Error body observation deadline'));};
 const timer=setTimeout(stop,1000);signal.addEventListener('abort',stop,{once:true});
 if(signal.aborted)stop();
 const reading=(async()=>{
  const chunks:Uint8Array[]=[];let size=0;
  for(;;){
   if(expired)throw new Error('Error body observation stopped');
   const item=await reader.read();
   if(expired)throw new Error('Error body observation stopped');
   if(item.done){completed=true;break;}
   size+=item.value.length;if(size>maxBytes)throw new Error('Error body size limit');chunks.push(item.value);
  }
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  return object(value)?value:undefined;
 })();
 try{return await Promise.race([reading,deadline]);}catch{return;}
 finally{
  clearTimeout(timer);signal.removeEventListener('abort',stop);expired=true;
  if(!completed)try{void reader.cancel().catch(()=>{});}catch{/* Best effort only. */}
  try{reader.releaseLock();}catch{/* Pending reads are already abandoned. */}
 }
}

/** Only start() may fail processing; later diagnostics have no retry authority. */
export async function startAIUsage(observer:AIUsageObserver|undefined,signal:AbortSignal){
 signal.throwIfAborted();const id=await observer?.start();signal.throwIfAborted();return id;
}
export async function observeOpenAIResponse(observer:AIUsageObserver|undefined,response:Response,payload:unknown,pricing:Pricing){
 if(!observer)return;
 try{await observer.observe(openAIUsageObservation(response,payload,pricing));}
 catch{console.warn('AI usage observation could not be recorded. The request estimate remains incomplete.');}
}
export function withAIUsageId<T extends {tokenUsage:Record<string,unknown>}>(result:T,id:string|undefined):T{
 return id?{...result,tokenUsage:{...result.tokenUsage,aiUsageAttemptId:id}}:result;
}
