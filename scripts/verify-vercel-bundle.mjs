import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {makeTiff} from '../tests/fixtures/tiff.ts';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'folio-bundle-check-'));
try{
  const routing=JSON.parse(await fs.readFile('.vercel/output/config.json','utf8'));
  for(const pathname of ['/invite','/invite/','/app/invite','/app/invite/','/forgot-password','/reset-password','/verify-email','/verify-email/confirm','/verify-email/confirm/']){
    const privacy=routing.routes.find(route=>route.headers?.['Referrer-Policy']==='no-referrer'&&new RegExp('^'+route.src+'$').test(pathname));
    if(!privacy||privacy.headers['Cache-Control']!=='private, no-store'||privacy.continue!==true)throw new Error('Account access privacy headers are absent from the deployment routes.');
  }
  await fs.cp('.vercel/output/functions/api.func',directory,{recursive:true});
  // The child imports geometry lazily. Its compiled module must be traced into
  // the deployment, not accidentally resolved from this repository at runtime.
  const geometryModule=await fs.stat(path.join(directory,'server/core/pdf-geometry.js'));
  if(!geometryModule.isFile())throw new Error('Compiled native PDF geometry module is missing.');
  await fs.cp('fixtures/generated',path.join(directory,'fixtures'),{recursive:true});
  await fs.copyFile('fixtures/source-formats/synthetic-receipt.odt',path.join(directory,'fixtures/synthetic-receipt.odt'));
  const tiffPages=[{width:80,height:120,color:[30,80,150],compression:'deflate'},{width:96,height:64,orientation:6,color:[200,60,20],compression:'deflate'}];
  await fs.writeFile(path.join(directory,'fixtures/owned-classic.tiff'),makeTiff(tiffPages));
  await fs.writeFile(path.join(directory,'fixtures/owned-big.tiff'),makeTiff(tiffPages,{bigTiff:true,byteOrder:'MM'}));
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import {inspectSource,decoderLaunchSpec,splitPdfSource,previewArchiveSource,importArchiveSource,renderTiffPage,convertTiffForAI,readPdfGeometry} from './server/core/source.js';
    import {createHash} from 'node:crypto';
    import {tiffRenderVersion} from './shared/tiff.js';
    import JSZip from 'jszip';
    import {PDFDocument,StandardFonts,degrees} from 'pdf-lib';
    import {pdfGeometryVersion,findPdfRegionAnchor,matchPdfRegion,PdfGeometryError} from './shared/pdf-regions.js';
    import {buildApp} from './server/app.js';
    for (const launch of [decoderLaunchSpec('document.txt'), decoderLaunchSpec('bundle.pdf',{mode:'every',pagesPerDocument:1}),decoderLaunchSpec('archive.zip',undefined,{}),decoderLaunchSpec('private.tiff',undefined,undefined,{page:2}),decoderLaunchSpec('private.tiff',undefined,undefined,{}),decoderLaunchSpec('private.pdf',undefined,undefined,undefined,true)]) {
      assert.equal(launch.args.includes('tsx'),false);
      assert.ok(launch.args.includes('--max-old-space-size=192'));
      assert.equal(launch.args.includes('--max-old-space-size=256'),false);
    }
    for(const filename of ['invoice-multipage.pdf','receipt-scan.png','receipt.docx','receipt.xlsx','lead.eml','freeform-receipt.txt']){
      const result=await inspectSource(await fs.readFile('fixtures/'+filename),filename);
      assert.ok(result.pageCount>=1); console.log('PASS packaged decoder '+filename);
    }
    const odtBytes=await fs.readFile('fixtures/synthetic-receipt.odt');
    const odt=await inspectSource(odtBytes,'renamed.txt');
    assert.equal(odt.mimeType,'application/vnd.oasis.opendocument.text');assert.equal(odt.pageCount,1);
    assert.ok(odt.pages[0].text.includes('Merchant: Cedar & Pine'));
    assert.ok(odt.pages[0].text.endsWith('Paper | pens\\t00017\\t12.50\\t'));
    const odtArchive=new JSZip();odtArchive.file('statements/owned.odt',odtBytes,{createFolders:false});
    const odtZip=await odtArchive.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
    const odtPreview=await previewArchiveSource(odtZip,'owned.zip');
    assert.equal(odtPreview.parts.length,1);assert.equal(odtPreview.entries[0].format,'odt');assert.equal(odtPreview.totalPages,1);
    const odtImported=await importArchiveSource(odtZip,'owned.zip',{mode:'zip',version:1,sourceSha256:createHash('sha256').update(odtZip).digest('hex'),entries:[odtPreview.entries[0].index]});
    assert.deepEqual(odtImported.parts[0].bytes,odtBytes);assert.deepEqual(odtImported.parts[0].source,odt);
    await assert.rejects(previewArchiveSource(odtBytes,'renamed.zip'),error=>error.reason==='office_package');
    console.log('PASS packaged ODT byte-led text, exact table cells and atomic ZIP leaf');
    for(const filename of ['owned-classic.tiff','owned-big.tiff']){
      const bytes=await fs.readFile('fixtures/'+filename),sourceSha256=createHash('sha256').update(bytes).digest('hex');
      const source=await inspectSource(bytes,'misleading.txt');assert.deepEqual(source,{mimeType:'image/tiff',pageCount:2,pages:[{page:1,text:''},{page:2,text:''}]});
      const rendered=await renderTiffPage(bytes,2);assert.equal(rendered.page,2);assert.equal(rendered.pageCount,2);assert.equal(rendered.width,64);assert.equal(rendered.height,96);assert.equal(rendered.mimeType,'image/jpeg');assert.equal(rendered.sourceSha256,sourceSha256);assert.equal(rendered.renderVersion,tiffRenderVersion);
      const converted=await convertTiffForAI(bytes),pdf=await PDFDocument.load(converted.bytes);assert.equal(converted.pageCount,2);assert.equal(converted.sourceSha256,sourceSha256);assert.equal(converted.renderVersion,tiffRenderVersion);assert.equal(pdf.getPageCount(),2);assert.deepEqual(pdf.getPages().map(page=>page.getSize()),[{width:80,height:120},{width:64,height:96}]);
      const split=await splitPdfSource(bytes,filename,{mode:'every',pagesPerDocument:1});assert.equal(split.parts.length,2);assert.equal(split.selectedPages,2);
      for(const [i,part]of split.parts.entries()){assert.equal(part.source.mimeType,'image/tiff');assert.equal(part.source.pageCount,1);const decoded=await inspectSource(part.bytes,'child.tiff');assert.deepEqual(decoded,{mimeType:'image/tiff',pageCount:1,pages:[{page:1,text:''}]});const childPreview=await renderTiffPage(part.bytes,1);const originalPreview=await renderTiffPage(bytes,i+1);assert.deepEqual(childPreview.bytes,originalPreview.bytes);}
      console.log('PASS packaged TIFF full inspection, oriented preview, all-page PDF and lossless splitting '+filename);
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
    const regionPdf=await PDFDocument.create({updateMetadata:false}),regionFont=await regionPdf.embedFont(StandardFonts.Helvetica),regionPage=regionPdf.addPage([500,700]);
    regionPage.setCropBox(20,30,440,620);regionPage.setRotation(degrees(90));regionPage.drawText('Account: 000042',{x:80,y:580,size:16,font:regionFont});
    const regionBytes=Buffer.from(await regionPdf.save()),geometry=await readPdfGeometry(regionBytes),nativePage=geometry.pages[0];
    assert.equal(geometry.version,pdfGeometryVersion);assert.equal(geometry.sourceSha256,createHash('sha256').update(regionBytes).digest('hex'));assert.equal(geometry.pageCount,1);assert.equal(nativePage.reason,null);
    assert.deepEqual([nativePage.width,nativePage.height,nativePage.rotation],[620,440,90]);assert.equal(nativePage.items.length,1);
    assert.ok(Math.abs(nativePage.items[0].rect.x-(580-30-16*.207)/620)<1e-8);assert.ok(Math.abs(nativePage.items[0].rect.y-60/440)<1e-8);
    const anchor=findPdfRegionAnchor(nativePage,'Account');assert.ok(anchor.matched);assert.equal(anchor.anchor.capturedText,'Account: 000042');assert.deepEqual(anchor.anchor.itemIds,[1]);
    const regionRule={field:'reference',anchor:'Account',page:1,reference:{width:620,height:440,rotation:90},offset:{x:-.001,y:-.001,width:anchor.anchor.rect.width+.002,height:anchor.anchor.rect.height+.002}};
    const captured=matchPdfRegion(geometry,regionRule);assert.ok(captured.matched);assert.equal(captured.text,'Account: 000042');assert.deepEqual(captured.itemIds,[1]);
    assert.deepEqual(matchPdfRegion(geometry,{...regionRule,offset:{x:0,y:0,width:anchor.anchor.rect.width/2,height:anchor.anchor.rect.height}}),{matched:false,reason:'partial_item'});
    const oversizedGeometry=await PDFDocument.create({updateMetadata:false});oversizedGeometry.addPage([15000,700]);
    await assert.rejects(readPdfGeometry(Buffer.from(await oversizedGeometry.save())),error=>error instanceof PdfGeometryError&&error.reason==='geometry_limit'&&error.statusCode===413);
    console.log('PASS packaged native PDF crop/rotation geometry, whole-block region capture and fixed bound rejection');
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
