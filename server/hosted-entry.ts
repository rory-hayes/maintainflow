import type {IncomingMessage,ServerResponse} from 'node:http';
import {buildApp} from './app.js';
import {setExtractionProvider} from './core/worker.js';
import {createOpenAIProvider} from './core/openai-provider.js';
import {setSchemaSuggestionProvider} from './core/schema-suggestions.js';
import {createOpenAISchemaSuggestionProvider} from './core/openai-schema-suggestions.js';
import {setSplitSuggestionProvider} from './core/split-suggestions.js';
import {createOpenAISplitSuggestionProvider} from './core/openai-split-suggestions.js';
import {waitUntil} from '@vercel/functions';
import {recordHostedInvocation,registerHostedWorker} from './hosted-worker.js';

let application:ReturnType<typeof buildApp>|undefined;
async function hostedApp(){
  setExtractionProvider(createOpenAIProvider());
  setSchemaSuggestionProvider(createOpenAISchemaSuggestionProvider());
  setSplitSuggestionProvider(createOpenAISplitSuggestionProvider());
  const app=await buildApp();
  registerHostedWorker(app,{waitUntil,wakeAfterMutation:true});
  await app.ready();
  return app;
}

/** Raw streams preserve Fastify multipart parsing and signed webhook bodies. */
export default async function handler(request:IncomingMessage,response:ServerResponse){
  recordHostedInvocation(request);
  application??=hostedApp().catch(error=>{application=undefined;throw error;});
  const app=await application;
  await new Promise<void>((resolve,reject)=>{
    response.once('finish',resolve);
    response.once('close',resolve);
    response.once('error',reject);
    app.server.emit('request',request,response);
  });
}
