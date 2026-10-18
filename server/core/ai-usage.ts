import {randomUUID} from 'node:crypto';
import type {PoolClient,QueryResult} from 'pg';
import type {AIUsageKind,AIUsageObservation,AIUsageObserver} from '../../shared/ai-usage.js';
import {adminPool} from './db.js';

const diagnostic=()=>console.warn('AI usage observation could not be recorded. The request estimate remains incomplete.');
type UsageClient={query:(sql:string,values?:unknown[])=>Promise<QueryResult>};
/** Bound the entire transaction, including a stalled BEGIN/COMMIT or socket. */
async function boundedWorkspace<T>(workspaceId:string,work:(c:UsageClient)=>Promise<T>):Promise<T>{
 let client:PoolClient|undefined,expired=false,released=false;
 let acquireTimer:ReturnType<typeof setTimeout>|undefined,totalTimer:ReturnType<typeof setTimeout>|undefined;
 const failure=new Error('AI usage database deadline exceeded');
 const release=(destroy=false)=>{if(client&&!released){released=true;try{client.release(destroy);}catch{/* The deadline must still settle. */}}};
 const check=()=>{if(expired||released)throw failure;};
 const deadline=new Promise<never>((_,reject)=>{
  const expire=()=>{expired=true;release(true);reject(failure);};
  acquireTimer=setTimeout(expire,1000);totalTimer=setTimeout(expire,3000);
 });
 const operation=(async()=>{
  try{
   client=await adminPool.connect();clearTimeout(acquireTimer);check();
   const query:UsageClient['query']=async(sql,values)=>{check();const result=await client!.query(sql,values);check();return result;};
   try{
    await query('BEGIN');
    await query("select set_config('app.workspace_id',$1,true),set_config('statement_timeout','1000',true),set_config('lock_timeout','500',true),set_config('idle_in_transaction_session_timeout','2000',true)",[workspaceId]);
    const result=await work({query});await query('COMMIT');return result;
   }catch(error){
    if(!expired&&!released)try{await query('ROLLBACK');}catch{release(true);}
    throw error;
   }
  }finally{release(expired);}
 })();
 // A timed-out operation may reject later after its destroyed socket settles.
 void operation.catch(()=>{});
 try{return await Promise.race([operation,deadline]);}
 finally{clearTimeout(acquireTimer);clearTimeout(totalTimer);}
}

/** Construct only from a worker's claimed identity; no browser input is accepted. */
export function createAIUsageObserver(identity:{workspaceId:string;kind:AIUsageKind;operationId:string;attempt:number},beforeDispatch?:()=>Promise<unknown>):AIUsageObserver{
 identity=Object.freeze({...identity});
 const id=randomUUID();let started=false,starting=false,closed=false,interruptionWritten=false,responseWritten=false;
 let captured:Readonly<AIUsageObservation>|undefined,inFlight:Promise<void>|undefined;
 const tuple=[id,identity.workspaceId,identity.kind,identity.operationId,identity.attempt];
 async function persist(value:AIUsageObservation){
   try{
    await boundedWorkspace(identity.workspaceId,async c=>{
     const facts=[value.model,value.requestId,value.responseId,value.httpStatus,value.responseStatus,value.usageState,value.inputTokens,value.cachedInputTokens,value.outputTokens,value.reasoningTokens,value.costUsd,value.pricingBasis];
     const changed=await c.query(`update ai_usage_attempts set outcome='response_received',observed_at=clock_timestamp(),model=$3,request_id=$4,response_id=$5,http_status=$6,response_status=$7,usage_state=$8,input_tokens=$9,cached_input_tokens=$10,output_tokens=$11,reasoning_tokens=$12,cost_usd=$13,pricing_basis=$14 where id=$1 and workspace_id=$2 and outcome<>'response_received' returning id`,[id,identity.workspaceId,...facts]);
     if(changed.rowCount)return;
     const same=await c.query(`select id from ai_usage_attempts where id=$1 and workspace_id=$2 and outcome='response_received' and (model,request_id,response_id,http_status,response_status,usage_state,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,cost_usd,pricing_basis) is not distinct from ($3::text,$4::text,$5::text,$6::integer,$7::text,$8::text,$9::bigint,$10::bigint,$11::bigint,$12::bigint,$13::numeric(20,9),$14::text)`,[id,identity.workspaceId,...facts]);
     if(!same.rowCount)throw new Error('AI usage response conflicts or no longer exists');
    });
   }catch{diagnostic();}
 }
 async function flush(){
  // A single joined write, never a telemetry queue or a reason to repeat HTTP.
  if(inFlight)await inFlight;if(!started)return;
  if(captured&&!responseWritten){responseWritten=true;inFlight=persist(captured);}
  else if(!captured&&!interruptionWritten){
   interruptionWritten=true;
   inFlight=(async()=>{try{await boundedWorkspace(identity.workspaceId,async c=>{await c.query("update ai_usage_attempts set outcome='interrupted' where id=$1 and workspace_id=$2 and outcome='pending'",[id,identity.workspaceId]);});}catch{diagnostic();}})();
  }
  await inFlight;
 }
 return {
  async start(){
   if(starting||started||closed)throw new Error('AI usage dispatch already started or interrupted');
   starting=true;
   try{
    try{await boundedWorkspace(identity.workspaceId,async c=>{await c.query('insert into ai_usage_attempts(id,workspace_id,kind,operation_id,attempt) values($1,$2,$3,$4,$5)',tuple);});}
    catch{throw new Error('AI usage could not be reserved before processing. Retry shortly.');}
    started=true;
    if(closed)throw new Error('AI usage dispatch was interrupted');
    // Caller-specific authority may change while recording intent (notably split).
    await beforeDispatch?.();
    if(closed)throw new Error('AI usage dispatch was interrupted');
    return id;
   }finally{starting=false;if(closed&&started)await flush();}
  },
  async observe(value:AIUsageObservation){
   if(!started){diagnostic();return;}
   if(captured&&JSON.stringify(captured)!==JSON.stringify(value)){diagnostic();return;}
   captured=Object.freeze({...value});
   // The normal worker flush is outside its processing deadline/result fence.
   // A genuine late response may still supply facts after that fence has closed.
   if(closed)await flush();
  },
  async finish(){closed=true;await flush();},
 };
}
