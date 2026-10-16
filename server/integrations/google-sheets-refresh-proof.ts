import {z} from 'zod';

/** This interface deliberately omits token values and SDK response contents. */
export type GoogleSheetsAccessClient={
 credentials:{expiry_date?:number|null};
 getAccessToken():Promise<{res?:{status?:unknown}|null}>;
 on(event:'tokens',listener:()=>void):unknown;
 off(event:'tokens',listener:()=>void):unknown;
};

const httpStatus=z.number().int().min(100).max(599).nullable();
const accessStepFields={
 version:z.literal(1),
 step:z.literal('pre_range_get_access_token'),
 stepStartedAt:z.iso.datetime().max(32),
 stepCompletedAt:z.iso.datetime().max(32),
 expiryKnown:z.boolean(),
 accessExpiredAtStepStart:z.boolean().nullable(),
 sdkTokensEventObserved:z.boolean(),
 sdkRefreshResponseObserved:z.boolean(),
 sdkRefreshResponseStatus:httpStatus,
};
function consistentStep(value:{expiryKnown:boolean;accessExpiredAtStepStart:boolean|null;sdkRefreshResponseObserved:boolean;sdkRefreshResponseStatus:number|null}){
 return value.expiryKnown===(value.accessExpiredAtStepStart!==null)
  &&(value.sdkRefreshResponseObserved||value.sdkRefreshResponseStatus===null);
}
export const googleSheetsAccessStepSchema=z.object(accessStepFields).strict().refine(consistentStep);
export type GoogleSheetsAccessStep=z.infer<typeof googleSheetsAccessStepSchema>;
export const googleSheetsRefreshProofSchema=z.object({
 ...accessStepFields,
 deliveryId:z.uuid(),
 credentialPersistence:z.literal('updated'),
 rangeWriteStatus:z.number().int().min(200).max(299).nullable(),
}).strict().refine(consistentStep);
export type GoogleSheetsRefreshProof=z.infer<typeof googleSheetsRefreshProofSchema>;

function safeHttpStatus(value:unknown):number|null{
 return typeof value==='number'&&Number.isInteger(value)&&value>=100&&value<=599?value:null;
}

/** Observes only this explicit SDK step, not later request-triggered refreshes.
 * google-auth-library 11.0.2 returns res from its refresh-token branch; cached
 * access returns no res. Its tokens event argument is intentionally ignored. */
export async function observeGoogleSheetsAccessStep(client:GoogleSheetsAccessClient,now:()=>number=Date.now):Promise<GoogleSheetsAccessStep>{
 const started=now(),expiry=client.credentials.expiry_date;
 const expiryKnown=typeof expiry==='number'&&Number.isFinite(expiry)&&expiry>0;
 let tokensEventObserved=false;
 const observeTokens=()=>{tokensEventObserved=true;};
 client.on('tokens',observeTokens);
 try{
  const response=await client.getAccessToken(),refreshResponse=response.res;
  return googleSheetsAccessStepSchema.parse({
   version:1,step:'pre_range_get_access_token',
   stepStartedAt:new Date(started).toISOString(),stepCompletedAt:new Date(now()).toISOString(),
   expiryKnown,accessExpiredAtStepStart:expiryKnown?expiry<=started:null,
   sdkTokensEventObserved:tokensEventObserved,
   sdkRefreshResponseObserved:refreshResponse!==undefined&&refreshResponse!==null,
   sdkRefreshResponseStatus:safeHttpStatus(refreshResponse?.status),
  });
 }finally{client.off('tokens',observeTokens);}
}

/** Call only after the existing credential CAS and reserved-range write succeed. */
export function googleSheetsDeliveredRefreshProof(step:GoogleSheetsAccessStep,deliveryId:string,rangeWriteStatus:unknown):GoogleSheetsRefreshProof{
 const status=safeHttpStatus(rangeWriteStatus);
 return googleSheetsRefreshProofSchema.parse({
  ...googleSheetsAccessStepSchema.parse(step),deliveryId,
  credentialPersistence:'updated',rangeWriteStatus:status!==null&&status>=200&&status<300?status:null,
 });
}
