import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {makeTiff} from './fixtures/tiff.js';
import {inspectSource} from '../server/core/source.js';
import {prepareVisualDocument,validatedVisualDocument} from '../server/core/visual-source.js';
import {createOpenAIProvider,openAIExtraction} from '../server/core/openai-provider.js';
import {createOpenAISchemaSuggestionProvider,openAISchemaSuggestions} from '../server/core/openai-schema-suggestions.js';
import {tiffLimits,tiffRenderVersion} from '../shared/tiff.js';
import type {ProviderInput,VisualDocument} from '../shared/types.js';

const schema={fields:[{key:'total',label:'Total',type:'currency' as const,required:true}]};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const payload=(model:string,value:unknown)=>({id:'resp_synthetic_tiff',status:'completed',model,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:100,output_tokens:30,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}});
async function input():Promise<ProviderInput>{
 const bytes=makeTiff([{width:40,height:60,color:[230,30,30]},{width:80,height:50,color:[20,30,230],orientation:6}],{bigTiff:true,byteOrder:'MM'});
 const source=await inspectSource(bytes,'sample.tiff');
 const original={bytes,mimeType:source.mimeType,pages:source.pages,schema,instructions:'',locale:'en-IE'};
 return {...original,visualDocument:await prepareVisualDocument(original,{expectedSha256:hash(bytes)})};
}

test('both AI adapters receive a bounded PDF in original TIFF page order while retaining original bytes and honest evidence',async()=>{
 const source=await input(),saved=Buffer.from(source.bytes),visual=source.visualDocument!;
 assert.equal(visual.pageCount,2);assert.equal(visual.sourceSha256,hash(saved));assert.equal(visual.renderVersion,tiffRenderVersion);
 const pdf=await PDFDocument.load(visual.bytes);assert.equal(pdf.getPageCount(),2);
 assert.deepEqual(pdf.getPages().map(page=>page.getSize()),[{width:40,height:60},{width:50,height:80}]);
 let requests=0;
 const check=(model:string,value:unknown)=>(async(_url:any,options:any)=>{
  requests++;const body=JSON.parse(options.body),content=body.input[0].content;
  assert.equal(body.store,false);assert.equal(body.tools,undefined);
  const file=content.find((part:any)=>part.type==='input_file');
  assert.equal(file.filename,'tiff-pages.pdf');assert.equal(file.detail,'high');assert.equal(file.file_data,`data:application/pdf;base64,${visual.bytes.toString('base64')}`);
  assert.ok(content.some((part:any)=>part.type==='input_text'&&/original TIFF page/i.test(part.text)));
  assert.ok(!JSON.stringify(body).includes(source.bytes.toString('base64')));
  return new Response(JSON.stringify(payload(model,value)));
 }) as typeof fetch;
 const extraction=await createOpenAIProvider({apiKey:'synthetic-tiff-test',fetch:check(openAIExtraction.model,{rawValues:{total:'9.99'},evidence:[{field:'total',page:2,text:'Total 9.99'}]})}).extract(source);
 assert.equal(extraction.normalizedValues.total,9.99);assert.equal(extraction.evidence.total[0].page,2);assert.equal(extraction.evidence.total[0].source,'model-visual');assert.ok(extraction.issues.some(issue=>issue.code==='visual_evidence'));
 const suggestion=await createOpenAISchemaSuggestionProvider({apiKey:'synthetic-tiff-test',fetch:check(openAISchemaSuggestions.model,{fields:[{key:'total',label:'Total',type:'currency',instructions:null,fields:null}]})}).suggest(source);
 assert.equal(suggestion.schema.fields[0].key,'total');assert.equal(requests,2);assert.deepEqual(source.bytes,saved);
});

test('missing, mismatched or out-of-bounds TIFF derivatives never reach either provider',async()=>{
 const source=await input();let calls=0;
 const fetcher=(async()=>{calls++;throw new Error('Unexpected provider call');}) as typeof fetch;
 const extraction=createOpenAIProvider({apiKey:'synthetic-tiff-test',fetch:fetcher}),suggestion=createOpenAISchemaSuggestionProvider({apiKey:'synthetic-tiff-test',fetch:fetcher});
 for(const replacement of [undefined,{...source.visualDocument!,sourceSha256:'0'.repeat(64)},{...source.visualDocument!,pageCount:1},{...source.visualDocument!,renderVersion:'different'},{...source.visualDocument!,mimeType:'image/tiff'},{...source.visualDocument!,bytes:Buffer.from('not a PDF')},{...source.visualDocument!,bytes:Buffer.concat([Buffer.from('%PDF-'),Buffer.alloc(tiffLimits.maxPdfBytes)])}] as Array<VisualDocument|undefined>){
  const changed={...source,visualDocument:replacement};await assert.rejects(extraction.extract(changed),/TIFF visual pages/);await assert.rejects(suggestion.suggest(changed),/TIFF visual pages/);
 }
 await assert.rejects(extraction.extract({...source,mimeType:'application/pdf'}),/TIFF visual pages/);
 await assert.rejects(suggestion.suggest({...source,mimeType:'application/pdf'}),/TIFF visual pages/);
 assert.equal(calls,0);
});

test('TIFF preparation rejects changed originals and cancellation before conversion, and leaves existing source inputs unchanged',async()=>{
 const source=await input(),original=Buffer.from(source.bytes);
 await assert.rejects(prepareVisualDocument(source,{expectedSha256:'0'.repeat(64)}),/TIFF visual pages/);
 const controller=new AbortController();controller.abort();await assert.rejects(prepareVisualDocument(source,{expectedSha256:hash(source.bytes),signal:controller.signal}),error=>(error as Error).name==='AbortError');
 assert.equal(await prepareVisualDocument({...source,mimeType:'text/plain'},{expectedSha256:hash(source.bytes)}),undefined);
 assert.equal(validatedVisualDocument({...source,mimeType:'text/plain',visualDocument:undefined}),undefined);assert.deepEqual(source.bytes,original);
});
