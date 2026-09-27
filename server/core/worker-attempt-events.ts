type WorkerAttemptPhase =
 | {stage:'claimed'}
 | {stage:'extraction_finished';outcome:'succeeded'|'failed'|'source_missing'}
 | {stage:'persistence_started';outcome:'completed'|'retry'|'failed'}
 | {stage:'finished';outcome:'completed'|'retry'|'failed'|'fence_lost'|'source_missing'|'persistence_error'};
export type WorkerAttemptEvent=Readonly<{jobId:string;attempt:number;elapsedMs:number}&WorkerAttemptPhase>;
export type WorkerAttemptObserver=(event:WorkerAttemptEvent)=>void|Promise<void>;

/** Monotonic time since processOneCoreJob entry, including claim setup. Unclaimed work emits nothing. */
export function createWorkerAttemptReporter(observer?:WorkerAttemptObserver){
 const startedAt=performance.now();
 return (jobId:string,attempt:number,phase:WorkerAttemptPhase)=>{
  if(!observer)return;
  const elapsedMs=Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(performance.now()-startedAt)));
  const event:WorkerAttemptEvent={jobId,attempt,elapsedMs,...phase};
  try{void Promise.resolve(observer(event)).catch(()=>{});}catch{/* Observer errors never become job errors. */}
 };
}
