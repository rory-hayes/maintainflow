import {createHash,timingSafeEqual} from 'node:crypto';
import {stripeConfiguration} from '../integrations/provider-policy.js';

export function previewEnabled(environment:NodeJS.ProcessEnv=process.env){
  return environment.FOLIO_PREVIEW_MODE==='true';
}

function validStripeTestOptIn(environment:NodeJS.ProcessEnv){
  const flag=environment.FOLIO_PREVIEW_STRIPE_TEST;
  return flag===undefined||flag==='false'||(flag==='true'&&previewEnabled(environment));
}

/** Static configuration only; account/catalog acceptance still happens at Stripe. */
export function previewBillingMode(environment:NodeJS.ProcessEnv=process.env):'mock'|'stripe_test'|null{
  if(!previewEnabled(environment)||!validStripeTestOptIn(environment))return null;
  if(environment.FOLIO_PREVIEW_STRIPE_TEST!=='true')return environment.FOLIO_BILLING_MOCK==='true'?'mock':null;
  if(environment.FOLIO_BILLING_MOCK!=='false'||environment.STRIPE_MODE!=='test')return null;
  try{
    const billing=stripeConfiguration(environment),origin=new URL(environment.APP_ORIGIN||'');
    if(origin.protocol!=='https:'||origin.origin!==environment.APP_ORIGIN||['localhost','127.0.0.1','[::1]'].includes(origin.hostname))return null;
    if(!/^acct_[A-Za-z0-9]+$/.test(billing.accountId||'')||!billing.prices.standard||!billing.prices.team||!/^bpc_[A-Za-z0-9]+$/.test(billing.portalConfigurationId||'')||billing.webhookSecret.length<=6)return null;
    return 'stripe_test';
  }catch{return null;}
}

export function previewConfigured(environment:NodeJS.ProcessEnv=process.env){
  return previewBillingMode(environment)!==null&&
    (environment.FOLIO_PREVIEW_INVITE_CODE?.length??0)>=32;
}

export function validatePreviewConfiguration(environment:NodeJS.ProcessEnv=process.env){
  if(!validStripeTestOptIn(environment))throw new Error('Preview Stripe TEST opt-in must be true or false and requires private preview mode.');
  if(previewEnabled(environment)&&!previewConfigured(environment)){
    throw new Error('Preview mode requires an invite code of at least 32 characters and either mocked billing or explicitly configured private Stripe TEST billing.');
  }
}

export function acceptsPreviewInvite(value:unknown,environment:NodeJS.ProcessEnv=process.env){
  if(!validStripeTestOptIn(environment))return false;
  if(!previewEnabled(environment))return true;
  if(!previewConfigured(environment)||typeof value!=='string'||value.length>256)return false;
  const digest=(text:string)=>createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(value),digest(environment.FOLIO_PREVIEW_INVITE_CODE!));
}
