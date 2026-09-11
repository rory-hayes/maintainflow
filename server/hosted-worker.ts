import {createHash,timingSafeEqual} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import type {WorkBudget} from './core/work-budget.js';

// Vercel Fluid is configured for 300s. Stop claiming before 210s, keeping a
// separate grace window for bounded IO and durable lease/retry updates.
export const hostedWorkBudgetMs=210_000;
export const workerRoute='/api/internal/worker';
export type HostedWorkerServices={
  enqueue:()=>Promise<unknown>;
  core:(budget:WorkBudget)=>Promise<boolean>;
  delivery:(budget:WorkBudget)=>Promise<boolean>;
  provider:(budget:WorkBudget)=>Promise<boolean>;
  deletion:(budget:WorkBudget)=>Promise<boolean>;
  maintenance:(budget:WorkBudget)=>Promise<unknown>;
};
export type DrainResult={core:number;delivery:number;provider:number;deletion:number;stopped:'idle'|'budget';errors:number};

/** One serial consumer per durable queue. No polling, sleeps or process lifetime dependency. */
export function createHostedWorker(services:HostedWorkerServices,options:{budgetMs?:number;now?:()=>number;reserveMs?:Partial<Record<'core'|'delivery'|'provider'|'deletion',number>>;onError?:(lane:string,error:unknown)=>void}={}){
  const budgetMs=options.budgetMs??hostedWorkBudgetMs;
  if(!Number.isFinite(budgetMs)||budgetMs<=0||budgetMs>hostedWorkBudgetMs)throw new Error('Hosted worker budget must be positive and at most 210 seconds.');
  const now=options.now??Date.now;
  let active:Promise<DrainResult>|undefined;
  async function drain(){
    const controller=new AbortController();
    const budget:WorkBudget={signal:controller.signal,deadlineAt:now()+budgetMs};
    const timer=setTimeout(()=>controller.abort(),budgetMs);
    const result:DrainResult={core:0,delivery:0,provider:0,deletion:0,stopped:'idle',errors:0};
    const remaining=()=>budget.deadlineAt!-now();
    const report=(lane:string,error:unknown)=>{result.errors++;options.onError?.(lane,error);};
    async function consume(lane:'core'|'delivery'|'provider'|'deletion',reserveMs:number){
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
    try{
      await services.enqueue();
      if(controller.signal.aborted){result.stopped='budget';return result;}
      // Separate lanes prevent a backlog of extraction from starving email, delivery
      // or cleanup. Database leases fence other concurrent function instances.
      await Promise.all([
        consume('core',110_000),consume('delivery',70_000),
        consume('provider',140_000),consume('deletion',40_000),
        services.maintenance(budget).catch(error=>report('maintenance',error)),
      ]);
      return result;
    }catch(error){report('enqueue',error);return result;}
    finally{clearTimeout(timer);controller.abort();}
  }
  return ()=>{
    if(!active)active=drain().finally(()=>{active=undefined;});
    return active;
  };
}

let defaultWorker:ReturnType<typeof createHostedWorker>|undefined;
async function productionServices():Promise<HostedWorkerServices>{
  const [{processOneCoreJob,enforceRetention},{processOneFileDeletion},{reconcileInterruptedIntake},{enqueueApprovals,processOneDelivery},{tickProviders}]=await Promise.all([
    import('./core/worker.js'),import('./core/retention.js'),import('./core/object-reconciliation.js'),
    import('./integrations/webhooks.js'),import('./integrations/providers.js'),
  ]);
  return {
    enqueue:enqueueApprovals,
    core:budget=>processOneCoreJob(undefined,{signal:budget.signal}),
    delivery:budget=>processOneDelivery({signal:budget.signal}),
    provider:tickProviders,
    deletion:async budget=>budget.signal?.aborted?false:processOneFileDeletion(),
    maintenance:async budget=>{
      await reconcileInterruptedIntake(undefined,{signal:budget.signal,limit:1});
      if(!budget.signal?.aborted)await enforceRetention(undefined,{signal:budget.signal,limit:1});
    },
  };
}
let initialization:Promise<void>|undefined;
/** Pass this promise to Vercel waitUntil after a successful mutation or watchdog wake. */
export async function wakeHostedWorker(){
  if(!defaultWorker){
    initialization??=(async()=>{
      const services=await productionServices();
      defaultWorker=createHostedWorker(services,{onError:lane=>console.error(`Hosted worker ${lane} failed; durable work remains queued.`)});
    })().catch(error=>{initialization=undefined;throw error;});
    await initialization;
  }
  return defaultWorker!();
}

export function acceptsWorkerBearer(header:unknown,secret=process.env.FOLIO_WORKER_SECRET){
  if(!secret||secret.length<32||typeof header!=='string'||header.length>1024)return false;
  const match=/^Bearer ([^\s]+)$/.exec(header);
  if(!match)return false;
  const digest=(value:string)=>createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(match[1]!),digest(secret));
}

/** Requires an explicit platform lifetime hook: never silently detach background work. */
export function registerHostedWorker(app:FastifyInstance,options:{waitUntil:(work:Promise<unknown>)=>void;wake?:()=>Promise<unknown>;secret?:()=>string|undefined}){
  app.post(workerRoute,{bodyLimit:1024},async(request,reply)=>{
    const secret=options.secret?.()??process.env.FOLIO_WORKER_SECRET;
    if(!secret||secret.length<32)return reply.code(503).send({error:'worker_unconfigured'});
    if(!acceptsWorkerBearer(request.headers.authorization,secret))return reply.code(401).send({error:'unauthorized'});
    options.waitUntil((options.wake??wakeHostedWorker)());
    return reply.code(202).send({accepted:true});
  });
}
