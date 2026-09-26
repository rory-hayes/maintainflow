import {enqueueIntegrationEvents,processOneDelivery} from './webhooks.js';
import {tickProviders} from './providers.js';
let lastEnqueue=0;
export async function tickIntegrations() {
  if(Date.now()-lastEnqueue>5000){await enqueueIntegrationEvents();lastEnqueue=Date.now();}
  await Promise.all([processOneDelivery(),tickProviders()]);
}
