import {z} from 'zod';

const validText=(value:string)=>value.trim().length>0&&!/[\u0000-\u0008\u000b-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const text=(max:number)=>z.string().min(1).max(max).refine(validText);
const short=(max:number)=>text(max).refine(value=>!/[\r\n\t]/.test(value));
export const signupTermsPolicyMaxBytes=16384;
export const signupPolicyInputSchema=z.object({
 version:short(80),language:z.string().max(35).regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),
 title:short(160),text:text(16000),url:z.string().max(2048).url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.hash;}),agreementText:short(1000),
}).strict();
export type SignupPolicyInput=z.infer<typeof signupPolicyInputSchema>;
/** Fixed field order binds all displayed content; there is no text-only digest. */
export function canonicalSignupPolicy(policy:SignupPolicyInput):string{return JSON.stringify({version:policy.version,language:policy.language,title:policy.title,text:policy.text,url:policy.url,agreementText:policy.agreementText});}
const withinBudget=(policy:SignupPolicyInput)=>new TextEncoder().encode(canonicalSignupPolicy(policy)).length<=signupTermsPolicyMaxBytes;
export const signupPolicySchema=signupPolicyInputSchema.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().refine(withinBudget);
export type SignupPolicy=z.infer<typeof signupPolicySchema>;
export const signupTermsAcceptanceSchema=z.object({accepted:z.literal(true),version:short(80),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SignupTermsAcceptance=z.infer<typeof signupTermsAcceptanceSchema>;
export const signupTermsStatusSchema=z.discriminatedUnion('enabled',[
 z.object({enabled:z.literal(false),policy:z.null()}).strict(),
 z.object({enabled:z.literal(true),policy:signupPolicySchema}).strict(),
]);
export type SignupTermsStatus=z.infer<typeof signupTermsStatusSchema>;
export const signupTermsSnapshotSchema=z.object({policy:signupPolicySchema,acceptedAt:z.string().datetime()}).strict();
export type SignupTermsSnapshot=z.infer<typeof signupTermsSnapshotSchema>;
export const signupTermsRecordSchema=signupTermsSnapshotSchema.extend({recordedAt:z.string().datetime(),evidenceNotice:text(1000)}).strict();
export type SignupTermsRecord=z.infer<typeof signupTermsRecordSchema>;
export const signupTermsRecordResponseSchema=z.object({record:signupTermsRecordSchema.nullable()}).strict();
export type SignupTermsRecordResponse=z.infer<typeof signupTermsRecordResponseSchema>;
