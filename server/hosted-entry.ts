import type {IncomingMessage,ServerResponse} from 'node:http';
import {buildApp} from './app.js';
import {setExtractionProvider} from './core/worker.js';
import {createOpenAIProvider} from './core/openai-provider.js';
import {waitUntil} from '@vercel/functions';
import {registerHostedWorker,wakeHostedWorker} from './hosted-worker.js';

let application:ReturnType<typeof buildApp>|undefined;
async function hostedApp(){
  setExtractionProvider(createOpenAIProvider());
  const app=await buildApp();
  registerHostedWorker(app,{waitUntil});
  app.addHook('onResponse',async(request,reply)=>{
    if(!['GET','HEAD','OPTIONS'].includes(request.method)&&reply.statusCode>=200&&reply.statusCode<300&&request.url!=='/api/internal/worker'){
      waitUntil(wakeHostedWorker());
    }
  });
  await app.ready();
  return app;
}

/** Raw streams preserve Fastify multipart parsing and signed webhook bodies. */
export default async function handler(request:IncomingMessage,response:ServerResponse){
  application??=hostedApp().catch(error=>{application=undefined;throw error;});
  const app=await application;
  await new Promise<void>((resolve,reject)=>{
    response.once('finish',resolve);
    response.once('close',resolve);
    response.once('error',reject);
    app.server.emit('request',request,response);
  });
}
