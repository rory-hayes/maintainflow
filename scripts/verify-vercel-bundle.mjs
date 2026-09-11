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
    import {inspectSource,decoderLaunchSpec} from './server/core/source.js';
    import {buildApp} from './server/app.js';
    assert.equal(decoderLaunchSpec('document.txt').args.includes('tsx'),false);
    for(const filename of ['invoice-multipage.pdf','receipt-scan.png','receipt.docx','receipt.xlsx','lead.eml','freeform-receipt.txt']){
      const result=await inspectSource(await fs.readFile('fixtures/'+filename),filename);
      assert.ok(result.pageCount>=1); console.log('PASS packaged decoder '+filename);
    }
    const html=await inspectSource(Buffer.from('<h1>Owned bundle fixture</h1><p>Total: 12.50</p>'),'fixture.html');
    assert.match(html.pages[0].text,/12.50/);
    const app=await buildApp();
    assert.equal((await app.inject('/api/health')).statusCode,200);
    const preview=await app.inject('/api/config');assert.equal(preview.json().preview,true);
    const denied=await app.inject({method:'POST',url:'/api/auth/register',payload:{name:'Owned fixture',workspaceName:'Owned fixture',email:'bundle@example.test',password:'owned bundle fixture'}});
    assert.equal(denied.statusCode,403);
    await app.close(); console.log('PASS packaged API and preview invitation guard');
  `],{cwd:directory,encoding:'utf8',timeout:90_000,env:{PATH:process.env.PATH,NODE_ENV:'production',FOLIO_PREVIEW_MODE:'true',FOLIO_BILLING_MOCK:'true',FOLIO_PREVIEW_INVITE_CODE:'owned-bundle-fixture-'.repeat(3),INTEGRATION_ENCRYPTION_KEY:Buffer.alloc(32,7).toString('base64')}});
  process.stdout.write(result.stdout??'');
  if(result.status!==0){process.stderr.write(result.stderr??'');throw new Error('Standalone Vercel bundle verification failed.');}
}finally{await fs.rm(directory,{recursive:true,force:true});}
