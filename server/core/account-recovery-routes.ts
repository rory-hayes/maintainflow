import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {config} from './config.js';
import {badRequest} from './db.js';
import {authenticationRateLimit} from './rate-limit.js';
import {AccountRecoveryUnavailableError,completePasswordReset,invalidResetMessage,requestPasswordReset} from './account-recovery.js';
const emailInput=z.object({email:z.string().max(254).trim().email().toLowerCase()}).strict();
const passwordInput=z.string().min(10).max(128);
function origin(request:FastifyRequest){
 if(request.headers.origin&&request.headers.origin!==config.origin)badRequest('Request origin is not allowed',403);
 if(request.headers['sec-fetch-site']==='cross-site')badRequest('Cross-site requests are not allowed',403);
}
export async function registerAccountRecoveryRoutes(app:FastifyInstance){
 app.post('/api/auth/password-reset/request',{config:{rateLimit:authenticationRateLimit}},async(request,reply)=>{
  origin(request);reply.header('Referrer-Policy','no-referrer');
  const parsed=emailInput.safeParse(request.body);
  if(!parsed.success)badRequest('Enter a valid email address.',400);
  try{return reply.code(202).send(await requestPasswordReset(parsed.data.email));}
  catch(error){if(error instanceof AccountRecoveryUnavailableError)return reply.code(503).send({error:'password_recovery_unavailable',message:error.message});throw error;}
 });
 app.post('/api/auth/password-reset/complete',{config:{rateLimit:authenticationRateLimit}},async(request,reply)=>{
  origin(request);reply.header('Referrer-Policy','no-referrer');
  const body=request.body as Record<string,unknown>|undefined;
  if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.token!=='string'||Object.keys(body).some(key=>!['token','newPassword'].includes(key)))badRequest(invalidResetMessage,400);
  if(!passwordInput.safeParse(body.newPassword).success)badRequest('New password must be between 10 and 128 characters.',400);
  return completePasswordReset(body.token,body.newPassword as string);
 });
}
