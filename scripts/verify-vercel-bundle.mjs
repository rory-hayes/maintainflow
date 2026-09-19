import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-bundle-check-'));
try{
  const routing=JSON.parse(await fs.readFile('.vercel/output/config.json','utf8'));
  for(const pathname of ['/invite','/invite/','/app/invite','/app/invite/','/forgot-password','/reset-password','/verify-email','/verify-email/confirm','/verify-email/confirm/']){
    const privacy=routing.routes.find(route=>route.headers?.['Referrer-Policy']==='no-referrer'&&new RegExp('^'+route.src+'$').test(pathname));
    if(!privacy||privacy.headers['Cache-Control']!=='private, no-store'||privacy.continue!==true)throw new Error('Account access privacy headers are absent from the deployment routes.');
  }
  await fs.cp('.vercel/output/functions/api.func',directory,{recursive:true});
  await fs.cp('fixtures/generated',path.join(directory,'fixtures'),{recursive:true});
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {inspectSource,decoderLaunchSpec,splitPdfSource,previewArchiveSource,importArchiveSource} from './server/core/source.js';
    import {createHash} from 'node:crypto';
    import JSZip from 'jszip';
    import {PDFDocument,StandardFonts} from 'pdf-lib';
    import {buildApp} from './server/app.js';
    for (const launch of [decoderLaunchSpec('document.txt'), decoderLaunchSpec('bundle.pdf',{mode:'every',pagesPerDocument:1}),decoderLaunchSpec('archive.zip',undefined,{})]) {
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
    const markerSpec={mode:'marker',marker:'Desk pads',ranges:[{start:1,end:1},{start:2,end:2}]};
    const markerLaunch=decoderLaunchSpec('marker-bundle.pdf',markerSpec);
    assert.ok(markerLaunch.args.includes('--max-old-space-size=192'));
    assert.equal(markerLaunch.args.some(argument=>argument.includes(markerSpec.marker)),false);
    const markerSplit=await splitPdfSource(await fs.readFile('fixtures/invoice-multipage.pdf'),'marker-bundle.pdf',markerSpec);
    assert.deepEqual(markerSplit.parts.map(part=>part.range),markerSpec.ranges);
    assert.equal(markerSplit.sourcePageCount,2);assert.equal(markerSplit.selectedPages,2);
    assert.match(markerSplit.parts[0].source.pages[0].text,/INV-00601/);
    assert.match(markerSplit.parts[1].source.pages[0].text,/Desk pads/);
    assert.equal((await inspectSource(markerSplit.parts[1].bytes,'marker-child.pdf')).pageCount,1);
    await assert.rejects(splitPdfSource(await fs.readFile('fixtures/invoice-multipage.pdf'),'marker-bundle.pdf',{
      ...markerSpec,ranges:[{start:1,end:2}],
    }),error=>error.code==='pdf_split_validation_failed'&&error.reason==='marker_plan_mismatch');
    console.log('PASS packaged marker boundaries, preserved prefix and rejected changed preview');
    const archiveFiles=['invoice-multipage.pdf','receipt-scan.png','receipt.docx','receipt.xlsx','lead.eml','freeform-receipt.txt'];
    const mixedZip=new JSZip();
    for(let index=0;index<20;index++){
      const filename=archiveFiles[index%archiveFiles.length];
      mixedZip.file(index+'-'+filename,await fs.readFile('fixtures/'+filename),{createFolders:false});
    }
    const mixedBytes=await mixedZip.generateAsync({type:'nodebuffer',compression:'DEFLATE',streamFiles:true});
    let benchmark=performance.now();
    const mixedArchive=await previewArchiveSource(mixedBytes,'mixed.zip');
    assert.equal(mixedArchive.parts.length,20);assert.equal(mixedArchive.entries.length,20);
    console.log('PASS packaged 20-document mixed ZIP '+Math.round(performance.now()-benchmark)+' ms');
    const selected={mode:'zip',version:1,sourceSha256:createHash('sha256').update(mixedBytes).digest('hex'),entries:[1,7,13,19]};
    const archive=await importArchiveSource(mixedBytes,'mixed.zip',selected);
    assert.deepEqual(archive.parts.map(part=>part.index),selected.entries);
    assert.ok(archive.parts.every(part=>part.bytes.equals(mixedArchive.parts[part.index-1].bytes)));
    assert.equal(archive.totalPages,8);
    assert.equal(decoderLaunchSpec('archive.zip',undefined,{spec:selected}).args.some(value=>value.includes(selected.sourceSha256)),false);
    const sourcePng=await fs.readFile('fixtures/receipt-scan.png');
    assert.ok(sourcePng.length<1024*1024);
    const paddedPng=Buffer.alloc(1024*1024);sourcePng.copy(paddedPng);
    const boundedZip=new JSZip();
    for(let index=0;index<20;index++)boundedZip.file(index+'.png',paddedPng);
    benchmark=performance.now();
    const bounded=await previewArchiveSource(await boundedZip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),'20mb-expanded.zip');
    assert.equal(bounded.parts.length,20);assert.equal(bounded.parts.reduce((n,part)=>n+part.bytes.length,0),20*1024*1024);
    assert.ok(bounded.parts.every(part=>part.bytes.equals(paddedPng)));
    console.log('PASS packaged full 20 MiB expanded ZIP '+Math.round(performance.now()-benchmark)+' ms');
    const thirtyPdf=await PDFDocument.create(),thirtyFont=await thirtyPdf.embedFont(StandardFonts.Helvetica);
    for(let page=1;page<=30;page++)thirtyPdf.addPage().drawText('Reference PAGE-'+page,{x:40,y:600,font:thirtyFont});
    const thirtyBytes=Buffer.from(await thirtyPdf.save()),pageZip=new JSZip();
    for(let index=0;index<20;index++)pageZip.file(index+'.pdf',thirtyBytes);
    benchmark=performance.now();
    const allPages=await previewArchiveSource(await pageZip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),'600-pages.zip');
    assert.equal(allPages.totalPages,600);assert.equal(allPages.parts.length,20);
    assert.ok(allPages.parts.every(part=>part.source.pageCount===30&&part.source.pages[29].text.includes('PAGE-30')));
    console.log('PASS packaged full 600-page ZIP '+Math.round(performance.now()-benchmark)+' ms');
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
    const preview=await app.inject('/api/config');assert.equal(preview.json().preview,true);assert.equal(preview.json().passwordRecovery.available,false);assert.deepEqual(preview.json().emailVerification,{available:false,requiredForSignup:true});
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
