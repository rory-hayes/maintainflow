import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {PDFDocument,StandardFonts,degrees,PDFName,PDFNumber} from 'pdf-lib';
import {canonicalPdfRegionRule,findPdfRegionAnchor,matchPdfRegion,pdfGeometrySchema,pdfGeometryVersion,pdfRegionLimits,pdfRegionRuleSchema,PdfGeometryError,type PdfGeometry,type PdfGeometryItem,type PdfPageGeometry,type PdfRegionRect,type PdfRegionRule} from '../shared/pdf-regions.js';
import {nativePdfItemRect} from '../server/core/pdf-geometry.js';
import {decoderLaunchSpec,readPdfGeometry,runDecoder} from '../server/core/source.js';
import {SourceValidationError} from '../server/core/source-validation.js';

const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const near=(actual:number,expected:number)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
const nearRect=(actual:PdfRegionRect,expected:PdfRegionRect)=>{for(const key of ['x','y','width','height'] as const)near(actual[key],expected[key]);};
const item=(id:number,text:string,x=.1,y=.1,width=.2,height=.03,separator:PdfGeometryItem['separator']=' '):PdfGeometryItem=>({id,text,rect:{x,y,width,height},separator});
const page=(items:PdfGeometryItem[],reason:PdfPageGeometry['reason']=null):PdfPageGeometry=>({page:1,width:500,height:700,rotation:0,items,reason});
const geometry=(items:PdfGeometryItem[]):PdfGeometry=>({version:pdfGeometryVersion,sourceSha256:'a'.repeat(64),pageCount:1,pages:[page(items)]});
const rule=(offset:PdfRegionRect={x:.3,y:0,width:.25,height:.05}):PdfRegionRule=>({field:'details.account',anchor:'Account',page:1,reference:{width:500,height:700,rotation:0},offset});
const reason=(value:ReturnType<typeof matchPdfRegion>,expected:string)=>assert.deepEqual(value,{matched:false,reason:expected});
const geometryFailure=(expected:string)=>(error:unknown)=>error instanceof PdfGeometryError&&error.reason===expected;
async function blankPdf(count=1,width=500,height=700){const pdf=await PDFDocument.create({updateMetadata:false});for(let i=0;i<count;i++)pdf.addPage([width,height]);return Buffer.from(await pdf.save());}

// Expected rectangles use independently specified crop coordinates and standard
// Helvetica ascent .718/descent -.207, not a second PDF.js transform.
test('isolated geometry retains exact source identity and independently known crop/right-angle page coordinates',async()=>{
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica),text='Account: 000042';
 for(const rotation of [0,90,180,270]){const p=pdf.addPage([500,700]);p.setCropBox(20,30,440,620);p.setRotation(degrees(rotation));p.drawText(text,{x:80,y:580,size:20,font});}
 const bytes=Buffer.from(await pdf.save()),original=Buffer.from(bytes),result=await readPdfGeometry(bytes);
 assert.equal(result.sourceSha256,sha(original));assert.deepEqual(bytes,original);assert.equal(result.pageCount,4);
 const left=60,top=620-(580-30+20*.718),w=[...text].reduce((sum,char)=>sum+font.widthOfTextAtSize(char,20),0),h=20*(.718+.207);
 const expected=[{x:left/440,y:top/620,width:w/440,height:h/620},
  {x:(620-top-h)/620,y:left/440,width:h/620,height:w/440},
  {x:(440-left-w)/440,y:(620-top-h)/620,width:w/440,height:h/620},
  {x:top/620,y:(440-left-w)/440,width:h/620,height:w/440}];
 for(const [index,p] of result.pages.entries()){assert.equal(p.rotation,index*90);assert.deepEqual([p.width,p.height],index%2?[620,440]:[440,620]);assert.equal(p.reason,null);assert.equal(p.items.length,1);assert.equal(p.items[0].text,text);nearRect(p.items[0].rect,expected[index]);}
 const ordinary=await runDecoder(bytes,'owned.pdf');assert.equal(ordinary.pageCount,4);assert.deepEqual(Object.keys(ordinary).sort(),['mimeType','pageCount','pages']);assert.equal(ordinary.pages[0].text,text);
});

test('canonical UserUnit coordinates follow the displayed crop rather than unscaled PDF points',async()=>{
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica),p=pdf.addPage([500,700]);
 p.node.set(PDFName.of('UserUnit'),PDFNumber.of(2));p.drawText('Unit',{x:50,y:600,size:20,font});
 const result=await readPdfGeometry(Buffer.from(await pdf.save()));assert.deepEqual([result.pages[0].width,result.pages[0].height],[1000,1400]);near(result.pages[0].items[0].rect.x,.1);
});

test('real translated label/value blocks capture exact zero strings with unchanged region size and exclude nearby text',async()=>{
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica);
 for(const [dx,dy] of [[0,0],[40,-70]]){const p=pdf.addPage([500,700]);p.drawText('Account',{x:50+dx,y:600+dy,size:20,font});p.drawText('000042',{x:220+dx,y:600+dy,size:20,font});p.drawText('Other 999999',{x:50+dx,y:520+dy,size:20,font});}
 const result=await readPdfGeometry(Buffer.from(await pdf.save())),first=result.pages[0],value=first.items.find(i=>i.text==='000042')!;
 assert.ok(value);const anchor=findPdfRegionAnchor(first,'Account');assert.ok(anchor.matched);
 const config=rule({x:value.rect.x-anchor.anchor.rect.x-.001,y:-.001,width:value.rect.width+.002,height:value.rect.height+.002});
 const a=matchPdfRegion(result,config),b=matchPdfRegion(result,{...config,page:2});assert.ok(a.matched&&b.matched);assert.equal(a.text,'000042');assert.equal(b.text,'000042');near(b.rect.x-a.rect.x,40/500);near(b.rect.y-a.rect.y,70/700);assert.equal(a.rect.width,b.rect.width);assert.equal(a.rect.height,b.rect.height);
});

test('real touching split-word items form one literal anchor while combined labels retain whole block origin',async()=>{
 const pdf=await PDFDocument.create({updateMetadata:false}),regular=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold),p=pdf.addPage([500,700]);
 p.drawText('Acc',{x:50,y:600,size:20,font:regular});p.drawText('ount',{x:50+regular.widthOfTextAtSize('Acc',20),y:600,size:20,font:bold});
 const p2=pdf.addPage([500,700]);p2.drawText('Account: 000042',{x:50,y:600,size:20,font:regular});
 const result=await readPdfGeometry(Buffer.from(await pdf.save())),found=findPdfRegionAnchor(result.pages[0],'Account');assert.ok(found.matched);assert.equal(found.anchor.capturedText,'Account');assert.equal(found.anchor.itemIds.length,2);
 const combined=findPdfRegionAnchor(result.pages[1],'Account');assert.ok(combined.matched);assert.equal(combined.anchor.capturedText,'Account: 000042');assert.deepEqual(combined.anchor.itemIds,[1]);nearRect(combined.anchor.rect,result.pages[1].items[0].rect);
 reason(matchPdfRegion(result,{...rule({x:.1,y:0,width:.2,height:.05}),page:2}),'partial_item');
});

test('literal whitespace-normalized anchors count every occurrence and return full containing block text',()=>{
 const p=page([item(1,'Ref: Account\t  number',.1),item(2,'AB  012',.4,.1,.2,.03,'\n')]);
 const found=findPdfRegionAnchor(p,'Account number AB');assert.ok(found.matched);assert.equal(found.anchor.capturedText,'Ref: Account\t  number\nAB  012');assert.deepEqual(found.anchor.itemIds,[1,2]);nearRect(found.anchor.rect,{x:.1,y:.1,width:.5,height:.03});
 reason(findPdfRegionAnchor(p,'account number') as any,'missing_anchor');
 for(const [text,query] of [['Account Account','Account'],['aaa','aa'],['A\t B A B','A B']])reason(findPdfRegionAnchor(page([item(1,text)]),query) as any,'ambiguous_anchor');
 reason(findPdfRegionAnchor(page([item(1,'Account'),item(2,'Account',.5)]),'Account') as any,'ambiguous_anchor');
 const metachar=findPdfRegionAnchor(page([item(1,'Reference [a.+] literal')]),'[a.+]');assert.ok(metachar.matched);
});

test('value rectangles preserve whole native text and explicit multiline order, including false and zero',()=>{
 const source=geometry([item(1,'Account',.1,.1),item(2,'false',.4,.1,.12),item(3,'0',.4,.16,.12,.03,'\n'),item(4,'000042',.4,.22,.12,.03,'\n'),item(5,'outside',.8,.1,.1)]);
 const result=matchPdfRegion(source,rule({x:.299,y:-.001,width:.122,height:.152}));assert.ok(result.matched);assert.equal(result.text,'false\n0\n000042');assert.deepEqual(result.itemIds,[2,3,4]);
 reason(matchPdfRegion(source,rule({x:.32,y:0,width:.1,height:.05})),'partial_item');
 reason(matchPdfRegion(source,rule({x:.3,y:.3,width:.1,height:.05})),'missing_value');
 reason(matchPdfRegion(source,rule({x:-.2,y:0,width:.1,height:.05})),'region_outside_page');
 reason(matchPdfRegion(source,{...rule(),page:2}),'missing_page');
 for(const reference of [{width:500.1,height:700,rotation:0},{width:500,height:701,rotation:0},{width:500,height:700,rotation:90}])reason(matchPdfRegion(source,{...rule(),reference}),'page_geometry_changed');
 assert.ok(matchPdfRegion(source,{...rule(),reference:{width:500.001,height:700,rotation:0}}).matched);
});

test('image-only and unsupported independent text rotations produce explicit whole-page nonmatches',async()=>{
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica);
 const png=await pdf.embedPng(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
 pdf.addPage([500,700]).drawImage(png,{x:20,y:20,width:200,height:200});
 for(const rotation of [45,90]){const p=pdf.addPage([500,700]);p.drawText('Account',{x:50,y:600,size:20,font});p.drawText('rotated',{x:250,y:350,size:20,font,rotate:degrees(rotation)});}
 const result=await readPdfGeometry(Buffer.from(await pdf.save()));assert.deepEqual(result.pages.map(p=>p.reason),['no_native_text','unsupported_text_geometry','unsupported_text_geometry']);assert.ok(result.pages.every(p=>p.items.length===0));
 reason(matchPdfRegion(result,rule()),'no_native_text');reason(matchPdfRegion(result,{...rule(),page:2}),'unsupported_text_geometry');
});

test('native font-metric helper rejects nonfinite dimensions and marks skew/mirror/vertical/RTL unsupported',()=>{
 const value={str:'text',transform:[20,0,0,20,50,600],width:40,height:20,fontName:'font',dir:'ltr',hasEOL:false},style={ascent:.718,descent:-.207},viewport={width:500,height:700,transform:[1,0,0,-1,0,700]};
 for(const dimension of [0,-1,NaN,Infinity])assert.throws(()=>nativePdfItemRect(value,style,{...viewport,width:dimension}),geometryFailure('geometry_invalid'));
 for(const transform of [[20,1,0,20,50,600],[20,0,1,20,50,600],[-20,0,0,20,50,600]])assert.equal(nativePdfItemRect({...value,transform},style,viewport),null);
 assert.equal(nativePdfItemRect({...value,dir:'rtl'},style,viewport),null);assert.equal(nativePdfItemRect(value,{...style,vertical:true},viewport),null);assert.equal(nativePdfItemRect(value,{},viewport),null);
 assert.throws(()=>nativePdfItemRect({...value,transform:[20,0,0,20,NaN,600]},style,viewport),geometryFailure('geometry_invalid'));
});

test('rule and geometry boundaries reject malformed state and canonicalize JSONB key order safely',()=>{
 const config=rule(),reordered={offset:{height:.05,width:.25,y:0,x:.3},reference:{rotation:0,height:700,width:500},page:1,anchor:'  Account\t ',field:'details.account'};
 assert.equal(canonicalPdfRegionRule(config),canonicalPdfRegionRule(reordered));
 for(const invalid of [{...config,anchor:'\0'},{...config,anchor:'\ud800'},{...config,anchor:' '.repeat(201)},{...config,anchor:' '},{...config,offset:{...config.offset,x:Infinity}},{...config,offset:{...config.offset,width:0}},{...config,reference:{...config.reference,rotation:45}},{...config,extra:true}])assert.equal(pdfRegionRuleSchema.safeParse(invalid).success,false);
 assert.equal(pdfRegionRuleSchema.safeParse({...config,anchor:'Emoji 😀'}).success,true);
 const source=geometry([item(1,'Account'),item(2,'000042',.4)]);
 for(const modify of [(v:PdfGeometry)=>{v.pages[0].items[1].id=1;},(v:PdfGeometry)=>{v.pageCount=2;},(v:PdfGeometry)=>{v.pages[0].items[0].rect.x=.99;},(v:PdfGeometry)=>{v.pages[0].reason='no_native_text';},(v:PdfGeometry)=>{v.pages[0].items[0].text='\ud800';}]){const changed=structuredClone(source);modify(changed);assert.equal(pdfGeometrySchema.safeParse(changed).success,false);}
 const maximum=geometry(Array.from({length:pdfRegionLimits.maxItemsPerPage},(_,i)=>item(i+1,'x')));assert.equal(pdfGeometrySchema.safeParse(maximum).success,true);maximum.pages[0].items.push(item(5001,'x'));assert.equal(pdfGeometrySchema.safeParse(maximum).success,false);
 const textBudget=geometry(Array.from({length:257},(_,i)=>item(i+1,'x'.repeat(4096))));assert.equal(pdfGeometrySchema.safeParse(textBudget).success,false);reason(findPdfRegionAnchor(textBudget.pages[0],'unique') as any,'match_limit');
});

test('actual malformed and page/dimension/text limits have fixed errors with no document diagnostics',async()=>{
 await assert.rejects(readPdfGeometry(Buffer.from('not a PDF')),geometryFailure('pdf_required'));
 await assert.rejects(readPdfGeometry(Buffer.from('%PDF-secret source diagnostic')),(error:unknown)=>error instanceof SourceValidationError&&error.reason==='pdf_invalid'&&!error.message.includes('secret'));
 await assert.rejects(readPdfGeometry(await blankPdf(31)),(error:unknown)=>error instanceof SourceValidationError&&error.reason==='pdf_page_limit');
 await assert.rejects(readPdfGeometry(await blankPdf(1,15000,700)),geometryFailure('geometry_limit'));
 const pdf=await PDFDocument.create({updateMetadata:false}),font=await pdf.embedFont(StandardFonts.Helvetica),p=pdf.addPage([14400,700]);p.drawText('x'.repeat(4097),{x:10,y:600,size:1,font});
 await assert.rejects(readPdfGeometry(Buffer.from(await pdf.save())),geometryFailure('geometry_limit'));
 let spawned=false;await assert.rejects(readPdfGeometry(Buffer.alloc(pdfRegionLimits.maxBytes+1),{spawnChild:()=>{spawned=true;throw Error('not reached');}}),(error:unknown)=>error instanceof SourceValidationError&&error.reason==='file_too_large');assert.equal(spawned,false);
});

function fakeChild(onCreate?:(child:ChildProcessWithoutNullStreams)=>void){const child=new EventEmitter() as ChildProcessWithoutNullStreams;Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),killed:false});child.kill=()=>{(child as any).killed=true;queueMicrotask(()=>child.emit('close',null,'SIGKILL'));return true;};queueMicrotask(()=>onCreate?.(child));return child;}
const fixture=Buffer.from('%PDF-controlled IPC only');
function response(){const result=geometry([item(1,'Account'),item(2,'000042',.4)]);result.sourceSha256=sha(fixture);return {ok:true,geometry:result};}
function respond(value:unknown){return()=>fakeChild(child=>{child.stdout.emit('data',Buffer.from(JSON.stringify(value)));child.emit('close',0);});}

test('geometry IPC verifies exact hash, page order/count, finite rectangles, budgets, item identity and safe failures',async()=>{
 const mutations=[(r:ReturnType<typeof response>)=>{r.geometry.sourceSha256='b'.repeat(64);},(r:ReturnType<typeof response>)=>{r.geometry.pageCount=2;},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].page=2;},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].rotation=45;},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].width=0;},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].items[0].rect.x=-.1;},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].items[0].rect.width=NaN;},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].items[1].id=1;},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].items[0].text='x'.repeat(4097);},(r:ReturnType<typeof response>)=>{r.geometry.pages[0].reason='no_native_text';}];
 for(const mutate of mutations){const r=response();mutate(r);await assert.rejects(readPdfGeometry(fixture,{spawnChild:respond(r)}),(error:any)=>error.statusCode===422&&!(error instanceof PdfGeometryError));}
 await assert.rejects(readPdfGeometry(fixture,{spawnChild:respond({ok:false,code:'pdf_geometry_failed',reason:'geometry_limit'})}),geometryFailure('geometry_limit'));
 await assert.rejects(readPdfGeometry(fixture,{spawnChild:respond({ok:false,code:'pdf_geometry_failed',reason:'secret diagnostic'})}),(error:any)=>error.statusCode===422&&!error.message.includes('secret'));
 await assert.rejects(readPdfGeometry(fixture,{spawnChild:respond({ok:false,code:'decoder_failed'})}),(error:any)=>error.statusCode===503&&!(error instanceof PdfGeometryError));
 await assert.rejects(runDecoder(fixture,'owned.pdf',{spawnChild:respond({ok:false,code:'pdf_geometry_failed',reason:'geometry_limit'})}),(error:any)=>error.statusCode===422&&!(error instanceof PdfGeometryError));
});

test('geometry process uses private fixed arguments, copies input and bounds output/deadline before releasing slots',async()=>{
 const launch=decoderLaunchSpec('/private/customer.pdf',undefined,undefined,undefined,true);assert.ok(launch.args.includes('--pdf-geometry'));assert.ok(launch.args.includes('source.pdf'));assert.ok(!launch.args.some(arg=>arg.includes('customer')));assert.deepEqual(Object.keys(launch.options.env).sort(),['LANG','NODE_ENV','TSX_DISABLE_CACHE','TZ']);
 const mutable=Buffer.from(fixture);let received!:Buffer;
 const result=readPdfGeometry(mutable,{spawnChild:()=>fakeChild(child=>{received=Buffer.from((child.stdin as PassThrough).read());child.stdout.emit('data',Buffer.from(JSON.stringify(response())));child.emit('close',0);})});mutable.fill(0);assert.equal((await result).sourceSha256,sha(fixture));assert.deepEqual(received,fixture);
 let child!:ChildProcessWithoutNullStreams;await assert.rejects(readPdfGeometry(fixture,{spawnChild:()=>child=fakeChild(c=>c.stdout.emit('data',Buffer.alloc(pdfRegionLimits.maxOutputBytes+1)))}),(error:any)=>error.statusCode===413);assert.equal(child.killed,true);
 await assert.rejects(readPdfGeometry(fixture,{timeoutMs:15,spawnChild:()=>child=fakeChild()}),(error:any)=>error.statusCode===422);assert.equal(child.killed,true);
 for(const timeoutMs of [0,-1,NaN,Infinity,30001])await assert.rejects(readPdfGeometry(fixture,{timeoutMs,spawnChild:()=>{throw Error('must not start');}}),/Geometry deadline/);
});

test('abort holds the shared decoder capacity until killed child closes and prevents late results',async()=>{
 const children:ChildProcessWithoutNullStreams[]=[],controller=new AbortController();
 const spawnChild=()=>{const child=fakeChild();child.kill=()=>{(child as any).killed=true;return true;};children.push(child);return child;};
 const first=readPdfGeometry(fixture,{signal:controller.signal,spawnChild}),second=runDecoder(Buffer.from('ordinary'),'ordinary.txt',{spawnChild});
 const cancelled=assert.rejects(first,(error:any)=>error.name==='AbortError');controller.abort();assert.equal(children[0].killed,true);
 await assert.rejects(readPdfGeometry(fixture,{spawnChild}),(error:any)=>error.statusCode===429);
 children[0].stdout.emit('data',Buffer.from(JSON.stringify(response())));children[0].emit('close',0);await cancelled;
 const replacement=readPdfGeometry(fixture,{spawnChild:respond(response())});assert.equal((await replacement).pageCount,1);
 children[1].stdout.emit('data',Buffer.from(JSON.stringify({ok:true,source:{mimeType:'text/plain',pageCount:1,pages:[{page:1,text:'ordinary'}]}})));children[1].emit('close',0);assert.equal((await second).pages[0].text,'ordinary');
});
