/** Server-side receiver building block. No HTTP listener, forwarding or account mutation. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
const schema=JSON.parse(readFileSync(new URL('../../fixtures/automations/document-approved.schema.json',import.meta.url),'utf8'));
const approvalSchema=z.fromJSONSchema(schema);
export function verifyApprovalDelivery(input:{body:Buffer;headers:Record<string,string|undefined>},secret:string,nowSeconds=Math.floor(Date.now()/1000)) {
 if(!secret||input.body.length>1024*1024)throw new Error('Missing receiver secret or payload limit exceeded');
 const headers=Object.fromEntries(Object.entries(input.headers).map(([key,value])=>[key.toLowerCase(),value]));
 const timestamp=headers['x-folio-timestamp']||'',signature=headers['x-folio-signature']||'',deliveryId=headers['x-folio-delivery']||'';
 if(!/^\d{10,12}$/.test(timestamp)||Math.abs(nowSeconds-Number(timestamp))>300)throw new Error('Delivery timestamp is invalid or expired');
 if(!z.uuid().safeParse(deliveryId).success||headers['idempotency-key']!==deliveryId)throw new Error('Delivery identity is invalid');
 if(!/^v1=[a-f0-9]{64}$/i.test(signature))throw new Error('Delivery signature is missing or invalid');
 const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(input.body).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature.slice(3),'hex')))throw new Error('Delivery signature does not match');
 const event=approvalSchema.parse(JSON.parse(input.body.toString('utf8'))) as {id:string;event:'document.approved';document:{id:string;name:string;parserId:string};runId:string;revision:number;correctionId:string|null;approvedAt:string;values:Record<string,unknown>};
 // Caller must atomically persist (connectionId, deliveryId) and an outbox item before
 // acknowledging 2xx. This pure verifier deliberately does not pretend to deduplicate.
 return {deliveryId,event};
}
