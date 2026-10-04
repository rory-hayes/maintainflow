import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const limits = {cwd:process.cwd(),env:{NODE_ENV:'test',TZ:'UTC'},timeout:10_000,maxBuffer:64*1024,killSignal:'SIGKILL' as const};
const requireOrigin = JSON.stringify(pathToFileURL(path.join(process.cwd(),'package.json')).href);
async function childResult(source:string){
  try{return await run(process.execPath,['--max-old-space-size=256','--input-type=commonjs','-e',source],limits);}
  catch(error){const value=error as {code?:string|number;stderr?:string};throw new Error(`Bounded synthetic child failed (${value.code??'unknown'}): ${String(value.stderr??'').slice(-1024)}`);}
}

// Original synthetic primitive regression, informed by the primary advisories:
// https://github.com/advisories/GHSA-6j4f-fj2g-mc7p
// https://github.com/advisories/GHSA-qhr7-859c-m2p7
// This covers both stack-exhaustion shapes, not measured real-world load or a
// demonstrated user-controlled glob path in MaintainFlow. No version assertions.
test('runtime brace-expansion copies handle bounded nested and comma patterns without stack exhaustion', async () => {
  const source = `
    const {createRequire}=require('node:module');
    const rootRequire=createRequire(${requireOrigin});
    let transports=0;const blocked=()=>{transports++;throw Error('No network in brace primitive regression');};
    for(const mod of ['node:http','node:https']){rootRequire(mod).request=blocked;rootRequire(mod).get=blocked;}
    rootRequire('node:net').Socket.prototype.connect=blocked;rootRequire('node:tls').connect=blocked;
    rootRequire('node:dgram').createSocket=blocked;globalThis.fetch=async()=>blocked();
    const origins=['package.json','node_modules/archiver-utils/package.json','node_modules/readdir-glob/package.json','node_modules/rimraf/package.json','node_modules/zip-stream/package.json'];
    const sources=[['nested', '{'.repeat(4000)+'a,b'+'}'.repeat(4000)],['comma', '{'+'{a},'.repeat(8000)+'b}']];
    const results=[];
    for(const origin of origins){
      const localRequire=createRequire(require('node:path').join(process.cwd(),origin));
      const imported=localRequire('brace-expansion');const expand=typeof imported==='function'?imported:imported.expand;
      const ordinary=expand('synthetic-{statement,receipt}-2026');
      for(const [kind,input] of sources){
        let output,error=null;try{output=expand(input);}catch(value){error=value?.name??'Error';}
        results.push({origin,kind,ordinary,error,count:output?.length??null,longest:output?Math.max(...output.map(x=>x.length)):null,inputBytes:Buffer.byteLength(input)});
      }
    }
    process.stdout.write(JSON.stringify({results,transports}));
  `;
  const child=await childResult(source);
  const result=JSON.parse(child.stdout);
  assert.equal(result.transports,0);assert.equal(result.results.length,10);
  for(const item of result.results){
    assert.deepEqual(item.ordinary,['synthetic-statement-2026','synthetic-receipt-2026']);
    assert.equal(item.error,null,`${item.origin}: ${item.kind} pattern exhausted the parser stack`);
    assert.ok(item.count>0 && item.count<=8001);
    assert.ok(item.longest>0 && item.longest<=item.inputBytes);
  }
});

// Original synthetic conditional protocol fixture, based on the primary fix:
// https://github.com/fastify/fastify/commit/ad06a4c3fe8a944a904f38068249b18b8f552e90
// Current MaintainFlow does not enable HTTP/2 or register reply.trailer().
// This tests the installed framework fix on loopback only; no DB/provider.
test('Fastify conditional HTTP2 trailers preserve response and HTTP1 trailer behaviour', async () => {
  const source = `
    (async()=>{
    const {createRequire}=require('node:module');const ownedRequire=createRequire(${requireOrigin});
    const Fastify=ownedRequire('fastify'), http2=require('node:http2'), http=require('node:http');
    let forbiddenConnections=0;
    const original=require('node:net').Socket.prototype.connect;
    require('node:net').Socket.prototype.connect=function(...args){
      const options=Array.isArray(args[0])?args[0][0]:args[0];
      const host=typeof options==='object'?options.host:args[1];
      if(host!=='127.0.0.1'){forbiddenConnections++;throw Error('Only synthetic loopback transport allowed');}
      return original.apply(this,args);
    };
    globalThis.fetch=async()=>{forbiddenConnections++;throw Error('No provider transport');};
    const observations=[];
    for(const protocol of ['http1','http2']){
      const app=Fastify(protocol==='http2'?{http2:true}:{});
      app.get('/synthetic-trailer',(_request,reply)=>{reply.trailer('x-synthetic-check',async()=> 'owned-fixture');return 'MaintainFlow synthetic protocol fixture';});
      await app.listen({host:'127.0.0.1',port:0});const port=app.server.address().port;
      let client;
      try{
        const value=await new Promise((resolve,reject)=>{
          const result={protocol,body:'',headers:{},trailers:{}};
          if(protocol==='http2'){
            client=http2.connect('http://127.0.0.1:'+port);client.on('error',reject);
            const stream=client.request({':path':'/synthetic-trailer',':method':'GET'});
            stream.setEncoding('utf8');stream.on('response',headers=>result.headers=headers);stream.on('trailers',headers=>result.trailers=headers);
            stream.on('data',data=>result.body+=data);stream.on('error',reject);stream.on('end',()=>resolve(result));stream.end();
          }else{
            const request=http.get({host:'127.0.0.1',port,path:'/synthetic-trailer'},response=>{
              result.headers={...response.headers,':status':response.statusCode};response.setEncoding('utf8');
              response.on('data',data=>result.body+=data);response.on('error',reject);response.on('end',()=>{result.trailers=response.trailers;resolve(result);});
            });request.on('error',reject);
          }
        });observations.push(value);
      }finally{if(client){client.close();client.destroy();}await app.close();}
    }
    process.stdout.write(JSON.stringify({observations,forbiddenConnections}));
    })().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
  `;
  const child=await childResult(source);
  const result=JSON.parse(child.stdout);assert.equal(result.forbiddenConnections,0);
  assert.equal(result.observations.length,2);
  for(const item of result.observations){
    assert.equal(item.headers[':status'],200);
    assert.equal(item.body,'MaintainFlow synthetic protocol fixture');
    assert.equal(item.trailers['x-synthetic-check'],'owned-fixture');
  }
  assert.equal(result.observations[0].headers['transfer-encoding'],'chunked');
  assert.equal(result.observations[1].headers['transfer-encoding'],undefined);
});
