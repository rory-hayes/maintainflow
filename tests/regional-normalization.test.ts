import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRules,normalizeValue} from '../server/core/extraction.js';
import {parserSchema,validateValues} from '../server/core/schema.js';
import {normalizeTimestampCorrections} from '../server/core/timestamps.js';
import {selectTemplateExtraction} from '../server/core/template-selection.js';
import {previewTemplateDefinition,selectCurrentTemplateExtraction} from '../server/core/template-region-selection.js';
import {pinnedTemplateConfig} from '../server/core/template-snapshot.js';
import {createOpenAIProvider,openAIExtraction} from '../server/core/openai-provider.js';
import {assertJobSourceFormats,resolveJobNormalizationPolicy,supportedSourceLocales} from '../shared/source-formats.js';
import {pdfGeometryVersion,type PdfGeometry} from '../shared/pdf-regions.js';
import type {ParserSchema,SchemaField} from '../shared/types.js';

const number:SchemaField={key:'amount',label:'Amount',type:'number'};
const currency:SchemaField={...number,type:'currency'};
const date:SchemaField={key:'date',label:'Date',type:'date'};
const timestamp:SchemaField={key:'occurred',label:'Occurred',type:'timestamp'};
const settings={locale:'en-IE',timezone:'Europe/Dublin',version:'regional-v2' as const};

test('each advertised format admits complete numeric tokens with its own grouping and decimal punctuation',()=>{
 for(const [locale,source] of [['en-IE','1,234.56'],['en-GB','1,234.56'],['en-US','1,234.56'],['de-DE','1.234,56'],['fr-FR','1\u202f234,56'],['es-ES','1.234,56']] as const){
  assert.equal(normalizeValue(source,{...number,sourceLocale:locale},'en-IE'),1234.56,locale);
  assert.equal(normalizeValue(source,number,locale),1234.56,locale+' parser default');
 }
 for(const [source,expected] of [['.5',0.5],['-.5',-0.5],['+12.50',12.5],['(1,234.56)',-1234.56],['  1234.56  ',1234.56]] as const)
  assert.equal(normalizeValue(source,number,'en-IE'),expected,source);
 for(const separator of [' ','\u00a0','\u202f'])assert.equal(normalizeValue(`1${separator}234${separator}567,89`,number,'fr-FR'),1234567.89);
 // Legacy parser locales stay supported when their Latin/Gregorian grouping is understood.
 assert.equal(normalizeValue('12,34,567.89',number,'en-IN'),1234567.89);
});

test('currency supports one bounded marker and one sign without deleting arbitrary text',()=>{
 for(const [source,expected] of [['EUR 1,234.56',1234.56],['1,234.56 EUR',1234.56],['€1,234.56',1234.56],['-€ 12.50',-12.5],['€-12.50',-12.5],['(€12.50)',-12.5],['(12.50 EUR)',-12.5],['+ USD 12.50',12.5]] as const)
  assert.equal(normalizeValue(source,currency,'en-IE'),expected,source);
 assert.equal(normalizeValue('1.234,56 €',{...currency,sourceLocale:'de-DE'},'en-IE'),1234.56);
 assert.equal(normalizeValue('(1\u00a0234,56 EUR)',currency,'fr-FR'),-1234.56);
 for(const source of ['USD $12.50','€12.50 EUR','EUR USD 12.50','12 EUR 34','12.50 EUR USD','ZZZ 12','eur 12','€€12','--12','+-12','(-12)','(+12)','-(12)','12-','12CR','12.50 CR']){
  assert.equal(normalizeValue(source,currency,'en-IE'),source,source);
  assert.ok(validateValues({amount:source},{fields:[currency]},settings).some(issue=>issue.code==='number'));
 }
 assert.equal(normalizeValue('€12',number,'en-IE'),'€12','number fields do not accept currency markers');
});

test('invalid source tokens remain byte-for-byte reviewable instead of having punctuation repaired',()=>{
 const cases:[string,string][]=[['en-IE','12,34'],['en-IE','1.234,56'],['en-IE','1 2'],['en-IE','1\u00a0234.56'],['en-IE','12,3456'],['en-IE',',123'],['en-IE','1,,234'],['en-IE','1.'],['en-IE','1.2.3'],['en-IE','1e3'],['en-IE','0x10'],['en-IE','12\t34'],['en-IE','12\n34'],['en-IE','  12,34  '],['de-DE','1,234.56'],['de-DE','12.34'],['de-DE','1 234,56'],['fr-FR','12 34,56'],['fr-FR','1 234\u202f567,89'],['en-IN','1,234,567.89']];
 for(const [locale,source] of cases){
  const field={...currency,sourceLocale:locale==='de-DE'?'de-DE' as const:undefined};
  const normalized=normalizeValue(source,field,locale);
  assert.equal(normalized,source,`${locale}: ${source}`);
  const issues=validateValues({amount:normalized},{fields:[field]},{locale,version:'regional-v2'});
  assert.equal(issues.length,1);assert.equal(issues[0].code,'number');assert.ok(issues[0].message.includes(`(${locale})`));
 }
 for(const source of [true,{},[],Infinity])assert.deepEqual(normalizeValue(source,number,'en-IE'),source);
});

test('unsupported source numbering systems and calendars do not fall back to permissive parsing',()=>{
 for(const locale of ['ar-EG','en-IE-u-nu-arab','en-IE-u-ca-buddhist','zz-ZZ','en-US-u-nu-foobar','en-US-u-ca-foobar','not_a_locale']){
  assert.equal(normalizeValue('1,234.56',number,locale),'1,234.56',locale);
  assert.equal(normalizeValue('04/05/2026',date,locale),'04/05/2026',locale);
  assert.equal(normalizeValue('04/05/2026 14:30',timestamp,locale,'Europe/Dublin'),'04/05/2026 14:30',locale);
  assert.equal(normalizeValue('2026-04-05',date,locale),'2026-04-05','canonical date is locale-independent');
  assert.equal(normalizeValue(1234.56,number,locale),1234.56,'canonical numeric values are not source text');
 }
 assert.equal(normalizeValue('1.234,56',{...number,sourceLocale:'de-DE'},'ar-EG'),1234.56);
 assert.equal(normalizeValue('04/05/2026',date,'en-PH'),'2026-04-05','supported month-first parser locales use their actual order');
 assert.equal(normalizeValue('04/05/2026 14:30',timestamp,'en-PH','Europe/Dublin'),'2026-04-05T13:30:00Z');
 assert.equal(normalizeValue('04/05/2026',date,'ja-JP'),'04/05/2026','year-first formats do not guess a year-last source');
});

test('source-format schema controls are restricted to supported scalar types at every nesting depth',()=>{
 assert.deepEqual(supportedSourceLocales,['en-IE','en-GB','en-US','de-DE','fr-FR','es-ES']);
 for(const type of ['date','timestamp','number','currency'] as const)for(const sourceLocale of supportedSourceLocales)
  assert.equal(parserSchema.safeParse({fields:[{...number,type,sourceLocale}]}).success,true);
 for(const type of ['string','multiline','boolean','array','object'] as const)
  assert.equal(parserSchema.safeParse({fields:[{...number,type,sourceLocale:'de-DE',...(['array','object'].includes(type)?{fields:[number]}:{})}]}).success,false,type);
 for(const sourceLocale of ['en','DE-de','en-US-u-nu-arab','ja-JP','',null])
  assert.equal(parserSchema.safeParse({fields:[{key:'nested',label:'Nested',type:'object',fields:[{...number,sourceLocale}]}]}).success,false,String(sourceLocale));
 assert.equal(parserSchema.safeParse({fields:[{...timestamp,sourceLocale:'en-US',timezone:'Europe/Dublin'}]}).success,true);
 assert.equal(parserSchema.safeParse({fields:[{...date,sourceLocale:'en-US',timezone:'Europe/Dublin'}]}).success,false);
});

test('nested mixed formats preserve raw values, evidence, identifiers and independent sibling settings',()=>{
 const schema:ParserSchema={fields:[
  {key:'reference',label:'Reference',type:'string'},
  {...date,key:'irish_date',label:'Irish date'},
  {key:'details',label:'Details',type:'object',fields:[{...date,key:'us_date',label:'US date',sourceLocale:'en-US'},{...currency,label:'German amount',sourceLocale:'de-DE'}]},
  {key:'rows',label:'Rows',type:'array',fields:[{key:'code',label:'Code',type:'string'},{...currency,label:'French amount',sourceLocale:'fr-FR'}]},
 ]};
 const text='Reference: 000127\nIrish date: 04/05/2026\nUS date: 04/05/2026\nGerman amount: 1.234,56\nCode|French amount\n000012|1\u202f234,56';
 const result=extractRules([{page:3,text}],schema,'en-IE');
 assert.deepEqual(result.normalizedValues,{reference:'000127',irish_date:'2026-05-04',details:{us_date:'2026-04-05',amount:1234.56},rows:[{code:'000012',amount:1234.56}]});
 assert.deepEqual(result.rawValues,{reference:'000127',irish_date:'04/05/2026',details:{us_date:'04/05/2026',amount:'1.234,56'},rows:[{code:'000012',amount:'1\u202f234,56'}]});
 assert.deepEqual(result.evidence['details.amount'],[{page:3,text:'German amount: 1.234,56'}]);
 assert.deepEqual(result.evidence.rows,[{page:3,text:'000012|1\u202f234,56'}]);assert.deepEqual(result.issues,[]);
});

test('canonical defaults and manual corrections never become source tokens or receive text transforms again',()=>{
 const fields:SchemaField[]=[{...currency,sourceLocale:'de-DE',default:1234.56},{...date,sourceLocale:'en-US',default:'2026-05-04'},{key:'identifier',label:'Identifier',type:'string',transform:'uppercase',default:'keepLower'},{key:'nested',label:'Nested',type:'object',fields:[{...currency,sourceLocale:'de-DE'},{...date,sourceLocale:'en-US'}],default:{amount:1234.56,date:'2026-05-04'}}];
 assert.deepEqual(Object.fromEntries(fields.map(field=>[field.key,normalizeValue(null,field,'en-IE')])),{amount:1234.56,date:'2026-05-04',identifier:'keepLower',nested:{amount:1234.56,date:'2026-05-04'}});
 const manual={amount:9876.54,date:'2026-05-04',identifier:' lower ',nested:{amount:9876.54,date:'2026-05-04'}};
 assert.deepEqual(normalizeTimestampCorrections(manual,{fields},settings),manual);
 assert.deepEqual(validateValues(manual,{fields},settings),[]);
 const invalid={...manual,amount:'1.234,56'};assert.equal(normalizeTimestampCorrections(invalid,{fields},settings).amount,'1.234,56');
 assert.equal(validateValues(invalid,{fields},settings)[0].code,'number');
});

test('date-only parsing validates the calendar and locale without shifting the day or repairing separators',()=>{
 assert.equal(normalizeValue('04/05/2026',{...date,sourceLocale:'en-US'},'en-IE'),'2026-04-05');
 assert.equal(normalizeValue('04/05/2026',date,'en-IE'),'2026-05-04');
 assert.equal(normalizeValue('17 septembre 2026',{...date,sourceLocale:'fr-FR'},'en-IE'),'2026-09-17');
 for(const source of ['31/02/2026','2026-02-29','31 February 2026','04/05-2026','04.05/2026','0000-01-01'])
  assert.equal(normalizeValue(source,date,'en-IE'),source);
 for(const values of [{date:normalizeValue('0000-01-01',date,'en-IE')},{date:normalizeValue(null,{...date,default:'0000-01-01'},'en-IE')},normalizeTimestampCorrections({date:'0000-01-01'},{fields:[date]},settings)])
  assert.equal(validateValues(values,{fields:[date]},settings)[0].code,'date');
 assert.deepEqual(validateValues({date:'0000-01-01'},{fields:[date]},{version:'timestamp-v1'}),[]);
 assert.equal(normalizeValue('31 February 2026',date,'en-IE',undefined,'timestamp-v1'),'2026-02-31');
});

test('timestamp locale and timezone remain independent for extraction and immutable-context corrections',()=>{
 const field={...timestamp,sourceLocale:'en-US' as const,timezone:'America/New_York'};
 assert.equal(normalizeValue('04/05/2026 14:30',field,'en-IE','Europe/Dublin'),'2026-04-05T18:30:00Z');
 assert.equal(normalizeValue('04/05/2026 14:30+01:00',field,'en-IE','Europe/Dublin'),'2026-04-05T13:30:00Z');
 const schema={fields:[{key:'nested',label:'Nested',type:'object' as const,fields:[field]}]};
 assert.deepEqual(normalizeTimestampCorrections({nested:{occurred:'04/05/2026 14:30'}},schema,settings),{nested:{occurred:'2026-04-05T18:30:00Z'}});
 for(const [source,code] of [['03/08/2026 02:30','timestamp_nonexistent'],['11/01/2026 01:30','timestamp_ambiguous']]){
  const value=normalizeValue(source,field,'en-IE','Europe/Dublin');assert.equal(value,source);
  assert.equal(validateValues({occurred:value},{fields:[field]},settings)[0].code,code);
 }
 assert.equal(normalizeValue('04/05-2026 14:30',field,'en-IE','Europe/Dublin'),'04/05-2026 14:30');
});

test('normalization policy is independent of both text template generations and default rules extraction',()=>{
 const pages=[{page:1,text:'Amount: 12,34'}],schema={fields:[number]},templates=[{id:'synthetic-template',name:'Synthetic',enabled:true,kind:'text-v1',match_text:'',rules:[{field:'amount',anchor:'Amount'}]}];
 assert.equal(extractRules(pages,schema,'en-IE').normalizedValues.amount,'12,34');
 assert.equal(extractRules(pages,schema,'en-IE',[],undefined,'timestamp-v1').normalizedValues.amount,1234);
 for(const policy of ['timestamp-v1','regional-v2'] as const){
  const results=[selectTemplateExtraction(pages,schema,'en-IE',templates,'rules',undefined,policy),selectCurrentTemplateExtraction(pages,schema,'en-IE',templates,'rules',undefined,undefined,policy)];
  for(const result of results){assert.equal(result.selection.outcome,policy==='timestamp-v1'?'template':'failed');if(policy==='timestamp-v1')assert.equal(result.result?.normalizedValues.amount,1234);else assert.ok(result.candidates[0].reasons.includes('invalid_value'));}
 }
 const overrideSchema={fields:[{...currency,sourceLocale:'de-DE' as const}]},validPages=[{page:1,text:'Amount: 1.234,56'}];
 for(const result of [selectTemplateExtraction(validPages,overrideSchema,'en-IE',templates,'rules'),selectCurrentTemplateExtraction(validPages,overrideSchema,'en-IE',templates,'rules')])assert.equal(result.result?.normalizedValues.amount,1234.56);
});

test('controlled AI adapter keeps literal evidence while honoring new and historical numeric policies',async()=>{
 let requests=0;
 const rawValues={amount:'12,34'},source='Amount: 12,34';
 const provider=createOpenAIProvider({apiKey:'synthetic-regional-fixture',fetch:async()=>{
  requests++;return new Response(JSON.stringify({id:'resp_regional_fixture',status:'completed',model:openAIExtraction.model,
   output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({rawValues,evidence:[{field:'amount',page:1,text:source}]})}]}],
   usage:{input_tokens:10,output_tokens:10}}));
 }});
 for(const normalizationPolicy of [undefined,'regional-v2','timestamp-v1'] as const){
  const result=await provider.extract({bytes:Buffer.from(source),mimeType:'text/plain',schema:{fields:[number]},instructions:'Read literal values.',locale:'en-IE',pages:[{page:1,text:source}],normalizationPolicy});
  assert.deepEqual(result.rawValues,rawValues);assert.equal(result.evidence.amount[0].text,source);
  assert.equal(result.normalizedValues.amount,normalizationPolicy==='timestamp-v1'?1234:'12,34');
  assert.deepEqual(result.issues.map(issue=>issue.code),normalizationPolicy==='timestamp-v1'?[]:['number']);
 }
 assert.equal(requests,3);
});

test('native region extraction and unsaved preview use the same strict format policy and retain source evidence',()=>{
 const geometry:PdfGeometry={version:pdfGeometryVersion,sourceSha256:'a'.repeat(64),pageCount:1,pages:[{page:1,width:600,height:800,rotation:0,reason:null,items:[{id:1,text:'AMOUNT',rect:{x:.1,y:.1,width:.1,height:.03},separator:''},{id:2,text:'1.234,56',rect:{x:.3,y:.1,width:.15,height:.03},separator:' '}]}]};
 const definition={kind:'native-pdf-region-v1' as const,name:'Synthetic native format',enabled:true,matchText:'',rules:[{field:'amount',anchor:'AMOUNT',page:1,reference:{width:600,height:800,rotation:0},offset:{x:.19,y:-.01,width:.2,height:.05}}]};
 const schema={fields:[{...currency,sourceLocale:'de-DE' as const}]};
 const checked=previewTemplateDefinition([{page:1,text:'AMOUNT 1.234,56'}],schema,'en-IE',definition,geometry);
 assert.equal(checked.selection.outcome,'template');assert.equal(checked.result?.normalizedValues.amount,1234.56);assert.equal(checked.result?.rawValues.amount,'1.234,56');
 assert.equal(checked.result?.evidence.amount[0].region?.sourceSha256,geometry.sourceSha256);
 const invalid=structuredClone(geometry);invalid.pages[0].items[1].text='12.34';
 const rejected=previewTemplateDefinition([{page:1,text:'AMOUNT 12.34'}],schema,'en-IE',definition,invalid);
 assert.equal(rejected.selection.outcome,'failed');assert.equal(rejected.result?.normalizedValues.amount,'12.34');assert.equal(rejected.result?.issues[0].code,'number');
 const old=selectCurrentTemplateExtraction([{page:1,text:'AMOUNT 12.34'}],{fields:[number]},'de-DE',[{...definition,id:'synthetic-native'}],'rules',invalid,undefined,'timestamp-v1');
 assert.equal(old.selection.outcome,'template');assert.equal(old.result?.normalizedValues.amount,1234);
});

test('new general jobs pin strict policy, bank jobs keep their domain policy, and historical jobs never silently upgrade',()=>{
 assert.equal(pinnedTemplateConfig({mode:'rules',locale:'en-IE'},[]).normalizationPolicy,'regional-v2');
 assert.equal(pinnedTemplateConfig({mode:'ai',locale:'de-DE',use_case:'bank_statement'},[]).normalizationPolicy,'timestamp-v1');
 for(const input of [undefined,null,'timestamp-v1'])assert.equal(resolveJobNormalizationPolicy(input),'timestamp-v1');
 assert.equal(resolveJobNormalizationPolicy('regional-v2'),'regional-v2');
 for(const input of ['future-v3','',{},1])assert.throws(()=>resolveJobNormalizationPolicy(input),(error:any)=>error.permanent===true&&/unsupported normalization version/.test(error.message));
 const nested:ParserSchema={fields:[{key:'rows',label:'Rows',type:'array',fields:[{...currency,sourceLocale:'de-DE'}]}]};
 assert.throws(()=>assertJobSourceFormats(nested,'timestamp-v1'),(error:any)=>error.permanent===true&&/predates field source formats/.test(error.message));
 assert.doesNotThrow(()=>assertJobSourceFormats(nested,'regional-v2'));assert.doesNotThrow(()=>assertJobSourceFormats({fields:[number]},'timestamp-v1'));
 const raw='1.234,56';assert.equal(normalizeValue(raw,number,'en-IE',undefined,'timestamp-v1'),1.23456);assert.equal(normalizeValue(raw,number,'en-IE'),raw);
 assert.equal(normalizeValue('1 2',number,'en-IE',undefined,'timestamp-v1'),12);assert.equal(normalizeValue('1 2',number,'en-IE'),'1 2');
 assert.equal(validateValues({amount:'bad'},{fields:[number]},{locale:'en-IE',version:'timestamp-v1'})[0].message,'Amount must be a finite number.');
});
