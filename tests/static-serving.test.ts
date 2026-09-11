import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

test('production server serves the root and SPA routes while retaining static assets and API 404s',async()=>{
  const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'folio-static-routing-'));
  const appUrl=pathToFileURL(path.resolve('server/app.ts')).href;
  const databaseUrl=pathToFileURL(path.resolve('server/core/db.ts')).href;
  try{
    await fs.mkdir(path.join(temporary,'dist/assets'),{recursive:true});
    await fs.writeFile(path.join(temporary,'dist/index.html'),'<!doctype html><html><head><title>Static routing QA</title></head><body>Workspace</body></html>');
    await fs.writeFile(path.join(temporary,'dist/assets/app.js'),'globalThis.staticRoutingQA = true;');
    // A child owns the temporary cwd and production environment, preventing
    // module/config state from leaking into other tests. It opens no DB socket.
    const script=`
      import assert from 'node:assert/strict';
      const original=process.cwd();
      process.chdir(${JSON.stringify(temporary)});
      const {buildApp}=await import(${JSON.stringify(appUrl)});
      const {closeDatabase}=await import(${JSON.stringify(databaseUrl)});
      const app=await buildApp();
      try{
        for(const url of ['/','/app/parsers']){
          const response=await app.inject({method:'GET',url});
          assert.equal(response.statusCode,200,response.body);
          assert.ok(response.headers['content-type'].startsWith('text/html'));
          assert.ok(response.body.includes('<title>Static routing QA</title>'));
        }
        const asset=await app.inject({method:'GET',url:'/assets/app.js'});
        assert.equal(asset.statusCode,200,asset.body);
        assert.equal(asset.body,'globalThis.staticRoutingQA = true;');
        const health=await app.inject({method:'GET',url:'/api/health'});
        assert.equal(health.statusCode,200,health.body);
        assert.equal(health.json().environment,'production');
        assert.equal(health.headers['cache-control'],'private, no-store');
        const missing=await app.inject({method:'GET',url:'/api/missing-static-qa'});
        assert.equal(missing.statusCode,404,missing.body);
        assert.equal(missing.json().error,'not_found');
      }finally{
        await app.close();
        await closeDatabase();
        process.chdir(original);
      }
    `;
    const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{
      cwd:process.cwd(),
      env:{...process.env,NODE_ENV:'production',INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,29).toString('base64')},
      encoding:'utf8',
      timeout:30_000,
    });
    assert.equal(child.status,0,child.error?.message||child.stderr||child.stdout);
  }finally{
    await fs.rm(temporary,{recursive:true,force:true});
  }
});
