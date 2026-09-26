import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {appPool,transaction,badRequest} from './db.js';
import {canonicalSignupPolicy,signupPolicyInputSchema,signupPolicySchema,signupTermsPolicyMaxBytes,signupTermsAcceptanceSchema,signupTermsSnapshotSchema,type SignupPolicyInput,type SignupPolicy,type SignupTermsStatus,type SignupTermsSnapshot,type SignupTermsRecord} from '../../shared/signup-terms.js';
export type {SignupPolicyInput} from '../../shared/signup-terms.js';
export type SignupTermsDependencies={signupPolicy?:()=>SignupPolicyInput|null};
export const signupTermsEvidenceNotice='This record preserves the signup terms presented and the server-observed acceptance request. It does not verify the person’s identity, prove delivery of contractual information, record privacy consent, or establish payment or legal completeness.';
const digest=(policy:SignupPolicyInput)=>createHash('sha256').update(canonicalSignupPolicy(policy),'utf8').digest('hex');
const unavailable=()=>badRequest('Signup terms are temporarily unavailable. Please try again later.',503);
/** No catalogue, environment switch or default policy enables this dormant seam. */
export function validateSignupPolicy(input:unknown):SignupPolicy{
 const parsed=signupPolicyInputSchema.safeParse(input);if(!parsed.success||Buffer.byteLength(canonicalSignupPolicy(parsed.data))>signupTermsPolicyMaxBytes)return unavailable();
 return {...parsed.data,sha256:digest(parsed.data)};
}
export function currentSignupTerms(dependencies:SignupTermsDependencies={}):SignupTermsStatus{
 if(!dependencies.signupPolicy)return {enabled:false,policy:null};
 let input:SignupPolicyInput|null;try{input=dependencies.signupPolicy();}catch{return unavailable();}
 if(input===null)return {enabled:false,policy:null};
 return {enabled:true,policy:validateSignupPolicy(input)};
}
export function acceptSignupTerms(status:SignupTermsStatus,acceptance:unknown):SignupTermsSnapshot|undefined{
 if(!status.enabled){if(acceptance!==undefined)badRequest('Signup terms acceptance is not currently requested. Refresh the signup page.',409);return;}
 const parsed=signupTermsAcceptanceSchema.safeParse(acceptance);if(!parsed.success)badRequest('Please review and accept the signup terms before creating your account.');
 if(parsed.data.version!==status.policy.version||parsed.data.sha256!==status.policy.sha256)badRequest('The signup terms have changed. Please review the current terms and accept them again.',409);
 return {policy:structuredClone(status.policy),acceptedAt:new Date().toISOString()};
}
/** Strict present snapshots must never be treated as legacy missing evidence. */
export function checkedSignupTermsSnapshot(input:unknown):SignupTermsSnapshot{
 const snapshot=signupTermsSnapshotSchema.parse(input);if(snapshot.policy.sha256!==digest(snapshot.policy))throw new Error('Signup terms snapshot failed its integrity check.');return snapshot;
}
export async function saveSignupTermsAcceptance(c:PoolClient,userId:string,snapshot:SignupTermsSnapshot|undefined){
 if(snapshot===undefined)return;const checked=checkedSignupTermsSnapshot(snapshot);
 await c.query('INSERT INTO signup_terms_acceptances(user_id,policy,accepted_at) VALUES($1,$2,$3)',[userId,JSON.stringify(checked.policy),checked.acceptedAt]);
}
export async function ownSignupTermsRecord(userId:string):Promise<SignupTermsRecord|null>{
 z.string().uuid().parse(userId);
 return transaction(appPool,async c=>{
  await c.query("SELECT set_config('app.user_id',$1,true)",[userId]);
  const {rows:[row]}=await c.query('SELECT policy,accepted_at,recorded_at FROM signup_terms_acceptances WHERE user_id=$1',[userId]);
  if(!row)return null;
  const snapshot=checkedSignupTermsSnapshot({policy:signupPolicySchema.parse(row.policy),acceptedAt:row.accepted_at.toISOString()});
  return {...snapshot,recordedAt:row.recorded_at.toISOString(),evidenceNotice:signupTermsEvidenceNotice};
 });
}
export function renderSignupTermsRecord(record:SignupTermsRecord):string{
 return ['Signup terms acceptance record',record.evidenceNotice,'',`Acceptance request received: ${record.acceptedAt}`,`Record saved: ${record.recordedAt}`,`Policy version: ${record.policy.version}`,`Language: ${record.policy.language}`,`Displayed policy SHA256: ${record.policy.sha256}`,`Presented policy link: ${record.policy.url}`,'',record.policy.agreementText,'',record.policy.title,record.policy.text,''].join('\n');
}
