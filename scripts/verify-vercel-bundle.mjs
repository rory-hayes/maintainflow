import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-bundle-check-'));
try{
  await fs.cp('.vercel/output/functions/api.func',directory,{recursive:true});
  await fs.cp('fixtures/generated',path.join(directory,'fixtures'),{recursive:true});
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {inspectSource,decoderLaunchSpec,splitPdfSource} from './server/core/source.js';
    import {buildApp} from './server/app.js';
    for (const launch of [decoderLaunchSpec('document.txt'), decoderLaunchSpec('bundle.pdf',{mode:'every',pagesPerDocument:1})]) {
      assert.equal(launch.args.includes('tsx'),false);
      assert.ok(launch.args.includes('--max-old-space-size=192'));
      assert.equal(launch.args.includes('--max-old-space-size=256'),false);
    }
    for(const filename of ['invoice-multipage.pdf','receipt-scan.png','receipt.docx','receipt.xlsx','lead.eml','freeform-receipt.txt']){
      const result=await inspectSource(await fs.readFile('fixtures/'+filename),filename);
      assert.ok(result.pageCount>=1); console.log('PASS packaged decoder '+filename);
    }
    const html=await inspectSource(Buffer.from('<h1>Owned bundle fixture</h1><p>Total: 12.50</p>'),'fixture.html');
    assert.match(html.pages[0].text,/12.50/);
    const split=await splitPdfSource(await fs.readFile('fixtures/invoice-multipage.pdf'),'bundle.pdf',{mode:'every',pagesPerDocument:1});
    assert.equal(split.parts.length,2); assert.equal(split.selectedPages,2);
    assert.match(split.parts[0].source.pages[0].text,/INV-00601/);
    assert.match(split.parts[1].source.pages[0].text,/Desk pads/);
    assert.equal(split.parts[1].range.start,2);
    assert.equal((await inspectSource(split.parts[1].bytes,'child.pdf')).pageCount,1);
    console.log('PASS packaged PDF splitting and derived PDF decoding');
    // This isolated packaging check has no database. Exercise the packaged
    // limiter hook with an explicit in-memory test store; shared PostgreSQL
    // enforcement is verified by the request-rate-limit integration tests.
    let limiterCalls=0,blockRequests=false;
    class BundleStore {
      incr(_key, callback) { limiterCalls++; callback(null, { current: blockRequests?301:1, ttl: 60000 }); }
      child() { return this; }
    }
    const app=await buildApp({rateLimitStore:BundleStore});
    assert.equal((await app.inject('/api/health')).statusCode,200);
    const preview=await app.inject('/api/config');assert.equal(preview.json().preview,true);
    const missing=await app.inject('/api/packaged-missing-route');
    assert.equal(missing.statusCode,404);assert.equal(missing.headers['x-ratelimit-limit'],'300');
    assert.equal(limiterCalls,3);
    const denied=await app.inject({method:'POST',url:'/api/auth/register',payload:{name:'Owned fixture',workspaceName:'Owned fixture',email:'bundle@example.test',password:'owned bundle fixture'}});
    assert.equal(denied.statusCode,403);
    blockRequests=true;
    const throttled=await app.inject('/api/packaged-missing-route');
    assert.equal(throttled.statusCode,429);assert.ok(Number(throttled.headers['retry-after'])>0);
    await app.close(); console.log('PASS packaged API and preview invitation guard');
  `],{cwd:directory,encoding:'utf8',timeout:90_000,env:{PATH:process.env.PATH,NODE_ENV:'production',FOLIO_PREVIEW_MODE:'true',FOLIO_BILLING_MOCK:'true',FOLIO_PREVIEW_INVITE_CODE:'owned-bundle-fixture-'.repeat(3),INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')}});
  process.stdout.write(result.stdout??'');
  if(result.status!==0){process.stderr.write(result.stderr??'');throw new Error('Standalone Vercel bundle verification failed.');}
}finally{await fs.rm(directory,{recursive:true,force:true});}
