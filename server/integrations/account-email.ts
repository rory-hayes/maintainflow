import {z} from 'zod';
import {config} from '../core/config.js';
import type {WorkBudget} from '../core/work-budget.js';

export type AccountEmailMessage={idempotencyKey:string;to:string;subject:string;text:string};
export type AccountEmailSender={send:(message:AccountEmailMessage,budget?:WorkBudget)=>Promise<{providerId:string}>};
export type AccountEmailErrorCode='unavailable'|'invalid_message'|'temporary_failure'|'permanent_failure'|'timeout'|'cancelled'|'invalid_response';
export class AccountEmailError extends Error{
  constructor(readonly code:AccountEmailErrorCode,readonly retryable:boolean){super('Account email delivery could not be completed.');this.name='AccountEmailError';}
}
type Environment=NodeJS.ProcessEnv;
type Dependencies={fetchImpl?:typeof fetch;timeoutMs?:number};
const email=z.string().max(254).email();
const uuid=z.string().uuid();
const maximumResponseBytes=16*1024;

/** Use configured application identity, never request Host or a supplied redirect. */
export function trustedAccountOrigin(environment:Environment=process.env):string|undefined{
  const raw=environment.APP_ORIGIN??config.origin;
  try{
    const url=new URL(raw);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||raw!==url.origin&&raw!==url.origin+'/')return;
    const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback&&environment.NODE_ENV!=='production'&&environment.VERCEL!=='1'))return;
    return url.origin;
  }catch{return;}
}

function configuredSender(environment:Environment){
  if(environment.FOLIO_AUTH_EMAIL_ENABLED!=='true'||!trustedAccountOrigin(environment))return;
  const from=environment.FOLIO_AUTH_EMAIL_FROM?.trim();
  const apiKey=environment.FOLIO_AUTH_EMAIL_API_KEY;
  if(!from||!email.safeParse(from).success||!apiKey||!/^re_[A-Za-z0-9_-]{8,250}$/.test(apiKey))return;
  return {from:`Folio <${from}>`,apiKey};
}

async function responseJson(response:Response,signal:AbortSignal){
  if(signal.aborted){await response.body?.cancel().catch(()=>{});throw new AccountEmailError('cancelled',true);}
  if(!response.ok){
    await response.body?.cancel().catch(()=>{});
    const retryable=[408,409,425,429].includes(response.status)||response.status>=500;
    throw new AccountEmailError(retryable?'temporary_failure':'permanent_failure',retryable);
  }
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maximumResponseBytes)){
    await response.body?.cancel().catch(()=>{});throw new AccountEmailError('invalid_response',true);
  }
  const reader=response.body?.getReader();
  if(!reader)throw new AccountEmailError('invalid_response',true);
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const part=await reader.read();
      if(signal.aborted)throw new AccountEmailError('cancelled',true);
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>maximumResponseBytes)throw new AccountEmailError('invalid_response',true);
      chunks.push(part.value);
    }
    const body:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const id=typeof body==='object'&&body!==null&&'id' in body?body.id:undefined;
    if(!uuid.safeParse(id).success)throw new AccountEmailError('invalid_response',true);
    return {providerId:id as string};
  }catch(error){
    if(error instanceof AccountEmailError)throw error;
    throw new AccountEmailError('invalid_response',true);
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Fixed HTTPS transport; no domain/account provisioning or sending during construction. */
export function createAccountEmailSender(environment:Environment=process.env,dependencies:Dependencies={}):AccountEmailSender|undefined{
  const settings=configuredSender(environment);
  if(!settings)return;
  const configuredTimeout=dependencies.timeoutMs??10_000;
  if(!Number.isInteger(configuredTimeout)||configuredTimeout<1||configuredTimeout>10_000)throw new Error('Account email timeout must be 1 to 10000 milliseconds.');
  const transport=dependencies.fetchImpl??globalThis.fetch;
  return {async send(message,budget={}){
    if(!message||typeof message.idempotencyKey!=='string'||!message.idempotencyKey.startsWith('folio-account-email/')||!uuid.safeParse(message.idempotencyKey.slice('folio-account-email/'.length)).success||
      !email.safeParse(message.to).success||!['Reset your Folio password','Your Folio password was changed'].includes(message.subject)||typeof message.text!=='string'||message.text.length<1||Buffer.byteLength(message.text)>4096){
      throw new AccountEmailError('invalid_message',false);
    }
    const body=JSON.stringify({from:settings.from,to:[message.to],subject:message.subject,text:message.text});
    if(Buffer.byteLength(body)>8192)throw new AccountEmailError('invalid_message',false);
    if(budget.signal?.aborted)throw new AccountEmailError('cancelled',true);
    const remaining=budget.deadlineAt===undefined?configuredTimeout:Math.min(configuredTimeout,budget.deadlineAt-Date.now());
    if(!Number.isFinite(remaining)||remaining<=0)throw new AccountEmailError('timeout',true);
    const controller=new AbortController();
    let timedOut=false;
    const abort=()=>controller.abort();
    budget.signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},remaining);
    let rejectAborted!:(error:AccountEmailError)=>void;
    const aborted=new Promise<never>((_resolve,reject)=>{rejectAborted=reject;});
    const rejectOnAbort=()=>rejectAborted(new AccountEmailError(timedOut?'timeout':'cancelled',true));
    controller.signal.addEventListener('abort',rejectOnAbort,{once:true});
    try{
      // The race also fences a transport implementation that ignores AbortSignal.
      const request=(async()=>{
        const response=await transport('https://api.resend.com/emails',{
          method:'POST',redirect:'error',signal:controller.signal,
          headers:{Authorization:`Bearer ${settings.apiKey}`,'Content-Type':'application/json','Idempotency-Key':message.idempotencyKey},body,
        });
        return responseJson(response,controller.signal);
      })();
      return await Promise.race([request,aborted]);
    }catch(error){
      if(controller.signal.aborted)throw new AccountEmailError(timedOut?'timeout':'cancelled',true);
      if(error instanceof AccountEmailError)throw error;
      throw new AccountEmailError('temporary_failure',true);
    }finally{
      clearTimeout(timer);budget.signal?.removeEventListener('abort',abort);
      controller.signal.removeEventListener('abort',rejectOnAbort);
    }
  }};
}

let testSender:AccountEmailSender|null|undefined;
/** Internal controlled-fixture seam; no HTTP route exposes the sender or tokens. */
export function setAccountEmailSenderForTests(sender?:AccountEmailSender|null){testSender=sender;}
function sender(){return testSender===undefined?createAccountEmailSender():testSender??undefined;}
export function accountEmailStatus(){return {available:Boolean(trustedAccountOrigin()&&sender())};}
export async function sendAccountEmail(message:AccountEmailMessage,budget?:WorkBudget){
  const active=sender();
  if(!trustedAccountOrigin()||!active)throw new AccountEmailError('unavailable',true);
  return active.send(message,budget);
}
