import {createHash,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {WorkBudget} from './core/work-budget.js';
import {assertStorageRestoreReady} from './core/restore-state.js';

// Vercel Fluid is configured for 300s. Abort cooperative work 210s after invocation start, keeping a
// separate grace window for bounded IO and durable lease/retry updates.
export const hostedWorkBudgetMs=210_000;
export const workerRoute='/api/internal/worker';
const invocationDeadlines=new WeakMap<object,number>();
/** Called before cold app initialization; Fastify receives this same raw request. */
export function recordHostedInvocation(request:object,startedAt=Date.now()){
  invocationDeadlines.set(request,startedAt+hostedWorkBudgetMs);
}
export type HostedWorkerServices={
  enqueue:()=>Promise<unknown>;
  core:(budget:WorkBudget)=>Promise<boolean>;
  suggestion:(budget:WorkBudget)=>Promise<boolean>;
  splitSuggestion?:(budget:WorkBudget)=>Promise<boolean>;
  delivery:(budget:WorkBudget)=>Promise<boolean>;
  provider:(budget:WorkBudget)=>Promise<boolean>;
  deletion:(budget:WorkBudget)=>Promise<boolean>;
  email:(budget:WorkBudget)=>Promise<boolean>;
  maintenance:(budget:WorkBudget)=>Promise<unknown>;
};
export type DrainResult={core:number;suggestion:number;splitSuggestion:number;delivery:number;provider:number;deletion:number;email:number;stopped:'idle'|'budget';errors:number};
type HostedWorkerOptions={budgetMs?:number;now?:()=>number;reserveMs?:Partial<Record<'core'|'suggestion'|'splitSuggestion'|'delivery'|'provider'|'deletion'|'email',number>>;onError?:(lane:string,error:unknown)=>void};
const emptyResult=(stopped:DrainResult['stopped']):DrainResult=>({core:0,suggestion:0,splitSuggestion:0,delivery:0,provider:0,deletion:0,email:0,stopped,errors:0});

/** One serial consumer per durable queue. No polling, sleeps or process lifetime dependency. */
export function createHostedWorker(services:HostedWorkerServices,options:HostedWorkerOptions={}){
  const budgetMs=options.budgetMs??hostedWorkBudgetMs;
  if(!Number.isFinite(budgetMs)||budgetMs<=0||budgetMs>hostedWorkBudgetMs)throw new Error('Hosted worker budget must be positive and at most 210 seconds.');
  const now=options.now??Date.now;
  let active:Promise<DrainResult>|undefined;
  async function drain(deadlineAt:number){
    const remaining=()=>deadlineAt-now();
    if(remaining()<=0)return emptyResult('budget');
    const controller=new AbortController();
    const budget:WorkBudget={signal:controller.signal,deadlineAt};
    const timer=setTimeout(()=>controller.abort(),Math.max(0,remaining()));
    const result=emptyResult('idle');
    const expired=()=>{
      if(controller.signal.aborted||remaining()<=0){result.stopped='budget';return true;}
      return false;
    };
    const report=(lane:string,error:unknown)=>{result.errors++;options.onError?.(lane,error);};
    async function consume(lane:'core'|'suggestion'|'delivery'|'provider'|'deletion'|'email',reserveMs:number){
      // The optional reserve override is only a controlled scheduler test seam.
      const reserve=options.reserveMs?.[lane]??reserveMs;
      try{
        while(!controller.signal.aborted&&remaining()>reserve){
          if(!await services[lane](budget))return;
          result[lane]++;
        }
        result.stopped='budget';
      }catch(error){report(lane,error);}
    }
    async function consumeExtractionWork(){
      const failed=new Set<'core'|'suggestion'|'splitSuggestion'>();
      async function attempt(lane:'core'|'suggestion'|'splitSuggestion'){
        const service=services[lane];
        if(!service||failed.has(lane))return false;
        if(controller.signal.aborted||remaining()<=(options.reserveMs?.[lane]??110_000)){
          result.stopped='budget';return false;
        }
        try{
          const worked=await service(budget);
          if(worked)result[lane]++;
          return worked;
        }catch(error){failed.add(lane);report(lane,error);return false;}
      }
      // FIFO and shared workspace capacity can temporarily block any extraction queue.
      // Recheck after progress releases capacity; stop when none can work.
      while(!controller.signal.aborted){
        const progress=await Promise.all([attempt('core'),attempt('suggestion'),attempt('splitSuggestion')]);
        if(!progress.some(Boolean))return;
      }
      result.stopped='budget';
    }
    try{
      async function consumeDeliveries(){
        if(expired())return;
        try{await services.enqueue();}catch(error){report('enqueue',error);}
        await consume('delivery',70_000);
      }
      async function maintain(){
        if(expired())return;
        try{await services.maintenance(budget);}catch(error){report('maintenance',error);}
      }
      // Separate lanes prevent a backlog of extraction from starving email, delivery
      // or cleanup. Database leases fence other concurrent function instances.
      await Promise.all([
        consumeExtractionWork(),consumeDeliveries(),
        consume('provider',140_000),consume('deletion',40_000),consume('email',40_000),
        maintain(),
      ]);
      return result;
    }catch(error){report('enqueue',error);return result;}
    finally{clearTimeout(timer);controller.abort();}
  }
  return (deadlineAt=now()+budgetMs)=>{
    if(!Number.isFinite(deadlineAt))throw new Error('Hosted worker deadline must be finite.');
    // A second invocation cannot extend or abort the drain already in flight.
    if(!active)active=drain(Math.min(deadlineAt,now()+budgetMs)).finally(()=>{active=undefined;});
    return active;
  };
}

/** Initialization consumes the originating invocation's budget too. */
export function createHostedWorkerWake(initialize:()=>Promise<HostedWorkerServices>,options:HostedWorkerOptions={}){
  const now=options.now??Date.now;
  let worker:ReturnType<typeof createHostedWorker>|undefined,initialization:Promise<void>|undefined;
  return async(deadlineAt=now()+(options.budgetMs??hostedWorkBudgetMs))=>{
    if(!Number.isFinite(deadlineAt))throw new Error('Hosted worker deadline must be finite.');
    if(!worker){
      if(deadlineAt<=now())return emptyResult('budget');
      initialization??=initialize().then(services=>{worker=createHostedWorker(services,options);}).catch(error=>{initialization=undefined;throw error;});
      await initialization;
    }
    return worker!(deadlineAt);
  };
}

async function productionServices():Promise<HostedWorkerServices>{
  const [{processOneCoreJob,enforceRetention},{processOneFileDeletion},{reconcileInterruptedIntake},{enqueueIntegrationEvents,processOneDelivery},{tickProviders},{processOneSchemaSuggestion},{processOneWorkspaceEmail},{processOneSplitSuggestion,reconcileExpiredSplitSuggestions}]=await Promise.all([
    import('./core/worker.js'),import('./core/retention.js'),import('./core/object-reconciliation.js'),
    import('./integrations/webhooks.js'),import('./integrations/providers.js'),import('./core/schema-suggestions.js'),import('./core/workspace-email.js'),import('./core/split-suggestions.js'),
  ]);
  return {
    enqueue:enqueueIntegrationEvents,
    core:budget=>processOneCoreJob(undefined,{signal:budget.signal,onAttemptEvent:event=>{console.info(JSON.stringify({event:'core_worker_attempt',jobId:event.jobId,attempt:event.attempt,stage:event.stage,elapsedMs:event.elapsedMs,...('outcome' in event?{outcome:event.outcome}:{})}));}}),
    suggestion:budget=>processOneSchemaSuggestion(undefined,{signal:budget.signal}),
    splitSuggestion:budget=>processOneSplitSuggestion(undefined,{signal:budget.signal}),
    delivery:budget=>processOneDelivery({signal:budget.signal}),
    provider:tickProviders,
    deletion:async budget=>budget.signal?.aborted?false:processOneFileDeletion(),
    email:processOneWorkspaceEmail,
    maintenance:async budget=>{
      if(budget.signal?.aborted)return;
      const results=await Promise.allSettled([
        reconcileInterruptedIntake(undefined,{signal:budget.signal,limit:1}),
        enforceRetention(undefined,{signal:budget.signal,limit:1}),
        reconcileExpiredSplitSuggestions(undefined,{signal:budget.signal,limit:1}),
      ]);
      if(results.some(result=>result.status==='rejected'))throw new Error('Hosted maintenance remains queued.');
    },
  };
}
const wakeInitializedWorker=createHostedWorkerWake(productionServices,{onError:lane=>console.error(`Hosted worker ${lane} failed; durable work remains queued.`)});
/** Pass this promise to Vercel waitUntil after a successful mutation or watchdog wake. */
export async function wakeHostedWorker(deadlineAt=Date.now()+hostedWorkBudgetMs){
  const {config}=await import('./core/config.js');
  await assertStorageRestoreReady(config.storageDir,process.env.STORAGE_DRIVER||'filesystem');
  return wakeInitializedWorker(deadlineAt);
}

export function acceptsWorkerBearer(header:unknown,secret=process.env.FOLIO_WORKER_SECRET){
  if(!secret||secret.length<32||typeof header!=='string'||header.length>1024)return false;
  const match=/^Bearer ([^\s]+)$/.exec(header);
  if(!match)return false;
  const digest=(value:string)=>createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]!),digest(secret));
}

/** Requires an explicit platform lifetime hook: never silently detach background work. */
export function registerHostedWorker(app:FastifyInstance,options:{waitUntil:(work:Promise<unknown>)=>void;wake?:(deadlineAt:number)=>Promise<unknown>;secret?:()=>string|undefined;wakeAfterMutation?:boolean;now?:()=>number}){
  const now=options.now??Date.now;
  const deadline=(request:{raw:object})=>invocationDeadlines.get(request.raw)!;
  // Local injection/non-Vercel callers have no raw-handler timestamp. Preserve
  // any earlier timestamp from hosted-entry rather than resetting cold starts.
  app.addHook('onRequest',async request=>{
    if(!invocationDeadlines.has(request.raw))recordHostedInvocation(request.raw,now());
  });
  if(options.wakeAfterMutation)app.addHook('onResponse',async(request,reply)=>{
    if(!['GET','HEAD','OPTIONS'].includes(request.method)&&reply.statusCode>=200&&reply.statusCode<300&&request.routeOptions.url!==workerRoute){
      options.waitUntil((options.wake??wakeHostedWorker)(deadline(request)));
    }
  });
  app.post(workerRoute,{bodyLimit:1024},async(request,reply)=>{
    const secret=options.secret?.()??process.env.FOLIO_WORKER_SECRET;
    if(!secret||secret.length<32)return reply.code(503).send({error:'worker_unconfigured'});
    if(!acceptsWorkerBearer(request.headers.authorization,secret))return reply.code(401).send({error:'unauthorized'});
    options.waitUntil((options.wake??wakeHostedWorker)(deadline(request)));
    return reply.code(202).send({accepted:true});
  });
}
