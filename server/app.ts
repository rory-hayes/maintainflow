import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import {ZodError} from 'zod';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerCore} from './core/index.js';
import {config} from './core/config.js';
import {setExtractionProvider} from './core/worker.js';
import {registerExports} from './integrations/exports.js';
import {registerIntegrations} from './integrations/webhooks.js';
import {registerProviders} from './integrations/providers.js';

export async function buildApp(){
  const app=Fastify({logger:{level:process.env.LOG_LEVEL||'warn',redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie']},bodyLimit:1024*1024,requestTimeout:60_000,disableRequestLogging:true});
  await app.register(cookie);await app.register(multipart,{limits:{fileSize:config.maxBytes,files:20,parts:30}});
  app.addHook('onSend',async(request,reply,payload)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin').header('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(request.url.startsWith('/api/'))reply.header('Cache-Control','private, no-store');
    return payload;
  });
  app.setErrorHandler((error,request,reply)=>{
    if(error instanceof ZodError)return reply.status(400).send({error:'validation_error',message:error.issues.map(i=>`${i.path.join('.')||'Request'}: ${i.message}`).join(' ')});
    const code=(error as {statusCode?:number}).statusCode;
    const status=code&&code>=400&&code<600?code:500;
    if(status>=500)request.log.error({errorName:error instanceof Error?error.name:'Unknown',route:request.routeOptions.url},'Request failed');
    return reply.status(status).send({error:status>=500?'server_error':'request_error',message:status>=500?'The request could not be completed. Check the server status and try again.':error instanceof Error?error.message:'Invalid request.'});
  });
  app.get('/api/health',async()=>({status:'ok',name:'Folio',environment:config.production?'production':'local',limits:{maxBytes:config.maxBytes,maxPages:config.maxPages}}));
  await registerCore(app);await registerExports(app);await registerIntegrations(app);await registerProviders(app);
  const dist=path.resolve('dist');
  if(existsSync(dist)){
    await app.register(staticFiles,{root:dist,prefix:'/',index:false});
    // The static wildcard treats an existing directory with index disabled as
    // forbidden, so the application's root needs its own SPA document route.
    app.get('/',(_req,reply)=>reply.sendFile('index.html'));
    app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.status(404).send({error:'not_found',message:'API route not found.'}):reply.sendFile('index.html'));
  }
  return app;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  // Config loads the approved local environment before the factory is imported.
  // Importing buildApp for tests never enables a network provider.
  const {createOpenAIProvider}=await import('./core/openai-provider.js');
  setExtractionProvider(createOpenAIProvider());
  const host=process.env.HOST||(config.production?'0.0.0.0':'127.0.0.1');
  const app=await buildApp();await app.listen({port:config.port,host});console.log(`Folio API ready on http://${host}:${config.port}`);
  const stop=async()=>{await app.close();process.exit(0);};process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
