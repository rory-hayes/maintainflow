import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {config} from './config.js';
import {adminPool,badRequest} from './db.js';
import {requireActor,requireSession} from './auth.js';
import {authenticationRateLimit} from './rate-limit.js';
import {completeEmailVerification,emailVerificationStatus,EmailVerificationUnavailableError,invalidVerificationMessage,requestEmailVerification} from './email-verification.js';
const emailInput=z.object({email:z.string().max(254).trim().email().toLowerCase()}).strict();
const confirmation=z.object({token:z.string(),password:z.string().min(1).max(128)}).strict();
function origin(request:FastifyRequest){
 if(request.headers.origin&&request.headers.origin!==config.origin)badRequest('Request origin is not allowed',403);
 if(request.headers['sec-fetch-site']==='cross-site')badRequest('Cross-site requests are not allowed',403);
}
export async function registerEmailVerificationRoutes(app:FastifyInstance){
 app.get('/api/auth/email-verification',async request=>{
  const actor=await requireActor(request);requireSession(actor);
  const {rows:[user]}=await adminPool.query('SELECT email_verified_at FROM users WHERE id=$1',[actor.userId]);
  return {verified:Boolean(user.email_verified_at),verifiedAt:user.email_verified_at?.toISOString()??null,available:emailVerificationStatus().available};
 });
 app.post('/api/auth/email-verification/request',{config:{rateLimit:authenticationRateLimit}},async(request,reply)=>{
  origin(request);reply.header('Referrer-Policy','no-referrer');
  const parsed=emailInput.safeParse(request.body);if(!parsed.success)badRequest('Enter a valid email address.',400);
  try{return reply.code(202).send(await requestEmailVerification(parsed.data.email));}
  catch(error){if(error instanceof EmailVerificationUnavailableError)return reply.code(503).send({error:'email_verification_unavailable',message:error.message});throw error;}
 });
 app.post('/api/auth/email-verification/complete',{config:{rateLimit:authenticationRateLimit}},async(request,reply)=>{
  origin(request);reply.header('Referrer-Policy','no-referrer');
  const parsed=confirmation.safeParse(request.body);if(!parsed.success)badRequest(invalidVerificationMessage,400);
  return completeEmailVerification(parsed.data.token,parsed.data.password);
 });
}
