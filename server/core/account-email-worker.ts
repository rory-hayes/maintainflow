import {setTimeout as delay} from 'node:timers/promises';
import {processOneAccountEmail} from './account-recovery-mail.js';
import type {WorkBudget} from './work-budget.js';

/** An independent local lane prevents slow extraction from delaying reset mail. */
export async function runAccountEmailWorker(signal:AbortSignal,options:{processOne?:(budget:WorkBudget)=>Promise<boolean>;idleMs?:number;onError?:()=>void}={}){
  const processOne=options.processOne??processOneAccountEmail;
  const idleMs=options.idleMs??1000;
  if(!Number.isInteger(idleMs)||idleMs<1||idleMs>5000)throw new Error('Invalid account email polling interval.');
  while(!signal.aborted){
    let worked=false;
    try{worked=await processOne({signal});}
    catch{if(!signal.aborted)options.onError?.();}
    if(!worked&&!signal.aborted){
      try{await delay(idleMs,undefined,{signal});}catch{if(!signal.aborted)throw new Error('Account email polling failed.');}
    }
  }
}
