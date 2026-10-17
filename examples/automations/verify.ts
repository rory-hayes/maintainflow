/** Server-side receiver building block. No HTTP listener, forwarding or account mutation. */
import {createHmac,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {z} from 'zod';
const schema=JSON.parse(readFileSync(new URL('../../fixtures/automations/document-approved.schema.json',import.meta.url),'utf8'));
const approvalSchema=z.fromJSONSchema(schema);
const failureSchema=z.fromJSONSchema(JSON.parse(readFileSync(new URL('../../fixtures/automations/document-failed.schema.json',import.meta.url),'utf8')));
export type ReceiverInput={body:Buffer;headers:Record<string,string|undefined>};
function verifySignedBody(input:ReceiverInput,secret:string,nowSeconds:number) {
 if(!secret||input.body.length>1024*1024)throw new Error('Missing receiver secret or payload limit exceeded');
 if(!Number.isSafeInteger(nowSeconds)||nowSeconds<0)throw new Error('Receiver clock is invalid');
 const headers:Record<string,string|undefined>={};
 const signedHeaders=new Set(['x-folio-timestamp','x-folio-signature','x-folio-delivery','idempotency-key']);
 for(const [key,value] of Object.entries(input.headers)){
  const name=key.toLowerCase();
  if(signedHeaders.has(name)&&(Object.hasOwn(headers,name)||typeof value!=='string'))throw new Error('Delivery headers are ambiguous or invalid');
  headers[name]=value;
 }
 const timestamp=headers['x-folio-timestamp']||'',signature=headers['x-folio-signature']||'',deliveryId=headers['x-folio-delivery']||'';
 if(!/^\d{10,12}$/.test(timestamp)||Math.abs(nowSeconds-Number(timestamp))>300)throw new Error('Delivery timestamp is invalid or expired');
 if(!z.uuid().safeParse(deliveryId).success||headers['idempotency-key']!==deliveryId)throw new Error('Delivery identity is invalid');
 if(!/^v1=[a-f0-9]{64}$/i.test(signature))throw new Error('Delivery signature is missing or invalid');
 const expected=createHmac('sha256',secret).update(`${timestamp}.`).update(input.body).digest();
 if(!timingSafeEqual(expected,Buffer.from(signature.slice(3),'hex')))throw new Error('Delivery signature does not match');
 return {deliveryId,event:JSON.parse(input.body.toString('utf8')) as unknown};
}
export function verifyApprovalDelivery(input:ReceiverInput,secret:string,nowSeconds=Math.floor(Date.now()/1000)) {
 const verified=verifySignedBody(input,secret,nowSeconds);
 const event=approvalSchema.parse(verified.event) as {id:string;event:'document.approved';document:{id:string;name:string;parserId:string};runId:string;revision:number;correctionId:string|null;approvedAt:string;values:Record<string,unknown>};
 // Caller must atomically persist (connectionId, deliveryId) and an outbox item before
 // acknowledging 2xx. This pure verifier deliberately does not pretend to deduplicate.
 return {deliveryId:verified.deliveryId,event};
}

/** Use one explicitly configured parser per invoice recipe, before durable acceptance. */
export function verifyParserApprovalDelivery(input:ReceiverInput,secret:string,parserId:string,nowSeconds=Math.floor(Date.now()/1000)) {
 const expectedParser=z.uuid().parse(parserId).toLowerCase();
 const verified=verifyApprovalDelivery(input,secret,nowSeconds);
 if(verified.event.document.parserId.toLowerCase()!==expectedParser)throw new Error('Delivery parser is outside this receiver scope');
 return verified;
}

/** For receivers explicitly subscribed to approval and/or terminal failure events. */
export function verifyWebhookDelivery(input:ReceiverInput,secret:string,nowSeconds=Math.floor(Date.now()/1000)) {
 const verified=verifySignedBody(input,secret,nowSeconds);
 return {deliveryId:verified.deliveryId,event:z.union([approvalSchema,failureSchema]).parse(verified.event)};
}
