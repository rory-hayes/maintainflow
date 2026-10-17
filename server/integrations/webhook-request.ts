/** Pure sender contract; importing it opens no database or provider connection. */
import {createHmac} from 'node:crypto';

export function signDelivery(secret:string,timestamp:string,body:string) {
  return createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
}

export function createWebhookRequest(delivery:{id:string;payload:unknown},secret:string,timestamp=String(Math.floor(Date.now()/1000))) {
  const body=JSON.stringify(delivery.payload);
  return {body,headers:{
    'Content-Type':'application/json','User-Agent':'Folio-Webhooks/1.0',
    'X-Folio-Delivery':delivery.id,'X-Folio-Timestamp':timestamp,
    'X-Folio-Signature':`v1=${signDelivery(secret,timestamp,body)}`,'Idempotency-Key':delivery.id,
  }};
}
