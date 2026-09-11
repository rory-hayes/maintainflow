import {createHash,timingSafeEqual} from 'node:crypto';

export function previewEnabled(environment:NodeJS.ProcessEnv=process.env){
  return environment.FOLIO_PREVIEW_MODE==='true';
}

export function previewConfigured(environment:NodeJS.ProcessEnv=process.env){
  return previewEnabled(environment)&&environment.FOLIO_BILLING_MOCK==='true'&&
    (environment.FOLIO_PREVIEW_INVITE_CODE?.length??0)>=32;
}

export function validatePreviewConfiguration(environment:NodeJS.ProcessEnv=process.env){
  if(previewEnabled(environment)&&!previewConfigured(environment)){
    throw new Error('Preview mode requires mocked billing and an invite code of at least 32 characters.');
  }
}

export function acceptsPreviewInvite(value:unknown,environment:NodeJS.ProcessEnv=process.env){
  if(!previewEnabled(environment))return true;
  if(!previewConfigured(environment)||typeof value!=='string'||value.length>256)return false;
  const digest=(text:string)=>createHash('sha256').update(text).digest();
  return timingSafeEqual(digest(value),digest(environment.FOLIO_PREVIEW_INVITE_CODE!));
}
