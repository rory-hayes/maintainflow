import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeTimestamp,isCanonicalTimestamp,normalizeTimestampCorrections,validTimezone} from '../server/core/timestamps.js';
import {extractRules,normalizeValue} from '../server/core/extraction.js';
import {parserSchema,validateValues} from '../server/core/schema.js';
import {selectTemplateExtraction} from '../server/core/template-selection.js';
import {selectCurrentTemplateExtraction} from '../server/core/template-region-selection.js';
import {extractionResponseSchema} from '../server/core/openai-provider.js';
import {schemaSuggestionResponseSchema} from '../server/core/openai-schema-suggestions.js';
import type {ParserSchema,SchemaField} from '../shared/types.js';

const field:SchemaField={key:'occurred_at',label:'Occurred at',type:'timestamp',required:true};
const schema:ParserSchema={fields:[field]};
const settings={locale:'en-IE',timezone:'Europe/Dublin'};
for(const [input,timezone,expected] of [
 ['2026-01-15 14:30','Europe/Dublin','2026-01-15T14:30:00Z'],
 ['2026-07-15 14:30','Europe/Dublin','2026-07-15T13:30:00Z'],
 ['2026-07-15T14:30:00.123456789','Europe/Dublin','2026-07-15T13:30:00.123456789Z'],
 ['2026-07-15T14:30:00.120000000','Europe/Dublin','2026-07-15T13:30:00.12Z'],
 ['2026-07-15T14:30Z','America/New_York','2026-07-15T14:30:00Z'],
 ['2026-07-15T14:30-04:00','Europe/Dublin','2026-07-15T18:30:00Z'],
 ['2026-07-15T14:30-00:00','Europe/Dublin','2026-07-15T14:30:00Z'],
 ['2026-10-25T01:30+01:00','Europe/Dublin','2026-10-25T00:30:00Z'],
 ['2026-10-25T01:30+00:00','Europe/Dublin','2026-10-25T01:30:00Z'],
 ['2026-01-01T00:15','Asia/Kathmandu','2025-12-31T18:30:00Z'],
 ['2026-07-15T01:15','Pacific/Kiritimati','2026-07-14T11:15:00Z'],
] as const){
 test(`timestamp ${input} in ${timezone} resolves exactly`,()=>{
  const result=normalizeTimestamp(input,{locale:'en-IE',timezone});assert.deepEqual(result,{value:expected});
  assert.equal(isCanonicalTimestamp(result.value),true);assert.deepEqual(normalizeTimestamp(result.value,settings),result);
 });
}
test('timestamp local dates follow the pinned locale and Gregorian written month rules',()=>{
 for(const [value,locale,expected] of [['09/10/2026 14:30','en-US','2026-09-10T13:30:00Z'],['09/10/2026 14:30','en-IE','2026-10-09T13:30:00Z'],['17.09.2026 14:30','de-DE','2026-09-17T13:30:00Z'],['17 September 2026 14:30','en-IE','2026-09-17T13:30:00Z'],['17 septembre 2026 14:30','fr-FR','2026-09-17T13:30:00Z']])assert.deepEqual(normalizeTimestamp(value,{locale,timezone:'Europe/Dublin'}),{value:expected});
});
for(const [input,timezone,code] of [
 ['2026-03-29T01:30','Europe/Dublin','timestamp_nonexistent'],
 ['2026-10-25T01:30','Europe/Dublin','timestamp_ambiguous'],
 ['2026-04-05T01:45','Australia/Lord_Howe','timestamp_ambiguous'],
 ['2026-10-04T02:15','Australia/Lord_Howe','timestamp_nonexistent'],
 ['2011-12-30T12:00','Pacific/Apia','timestamp_nonexistent'],
] as const){
 test(`${timezone} ${input} stays reviewable as ${code}`,()=>{
  const result=normalizeTimestamp(input,{locale:'en-IE',timezone});assert.equal(result.value,input);assert.equal(result.issue?.code,code);
  const extracted=extractRules([{page:1,text:`Occurred at: ${input}`}],schema,'en-IE',[],timezone);
  assert.deepEqual(extracted.rawValues,{occurred_at:input});assert.deepEqual(extracted.normalizedValues,{occurred_at:input});
  assert.equal(extracted.issues.length,1);assert.equal(extracted.issues[0].field,'occurred_at');assert.equal(extracted.issues[0].code,code);
 });
}
test('invalid timestamps retain their source and never use Date.parse rollover or an implicit host zone',()=>{
 for(const input of ['2026-02-29T14:30','2026-04-31T14:30','2026-09-17','14:30','2026-09-17T24:00','2026-09-17T14:60','2026-09-17T14:30:60Z','2026-09-17T14:30+24:00','2026-09-17T14:30:00.1234567890Z','2026-09-17T14:30 BST','2026-09-17T14:30[Europe/Dublin]','0000-01-01T00:00Z','9999-12-31T23:59-01:00',123,true,{}]){
  const result=normalizeTimestamp(input,settings);assert.deepEqual(result.value,input);assert.equal(result.issue?.code,'timestamp_invalid',String(input));
 }
 for(const timezone of [undefined,'','Invalid/Zone'])assert.equal(normalizeTimestamp('2026-09-17T14:30',{locale:'en-IE',timezone}).issue?.code,'timestamp_timezone_missing');
 assert.deepEqual(normalizeTimestamp('2026-09-17T14:30Z',{}),{value:'2026-09-17T14:30:00Z'});
 assert.equal(normalizeTimestamp('17/09/2026 14:30Z',{}).issue?.code,'timestamp_locale_missing');
});
test('schema timestamp option is additive; field timezone applies only to timestamps',()=>{
 assert.equal(parserSchema.safeParse(schema).success,true);
 assert.equal(parserSchema.safeParse({fields:[{...field,timezone:'America/New_York'}]}).success,true);
 for(const timezone of ['Bad/Zone','',' Europe/Dublin'])assert.equal(parserSchema.safeParse({fields:[{...field,timezone}]}).success,false);
 assert.equal(parserSchema.safeParse({fields:[{...field,type:'date',timezone:'Europe/Dublin'}]}).success,false);
 assert.equal(parserSchema.safeParse({fields:[{key:'date',label:'Date',type:'date'}]}).success,true);
 assert.equal(validTimezone('Europe/Dublin'),true);
});
test('canonical validation blocks unconverted timestamps and every populated optional timestamp',()=>{
 for(const input of ['2026-09-17T13:30:00Z','2026-09-17T13:30:00.000000001Z'])assert.deepEqual(validateValues({occurred_at:input},schema,settings),[]);
 for(const input of ['2026-09-17T14:30+01:00','2026-09-17T13:30:00.000Z','2026-09-17T13:30','invalid',22])assert.equal(validateValues({occurred_at:input},{fields:[{...field,required:false}]},settings).length,1);
 assert.deepEqual(validateValues({occurred_at:null},{fields:[{...field,required:false}]},settings),[]);
 assert.equal(validateValues({occurred_at:null},schema,settings)[0].code,'required');
});
test('nested timestamps and defaults use the same policy without modifying date-only fields or identifiers',()=>{
 const fields:SchemaField[]=[{key:'date',label:'Date',type:'date'},{key:'id',label:'ID',type:'string'},{key:'group',label:'Group',type:'object',fields:[field]},{key:'rows',label:'Rows',type:'array',fields:[{...field,timezone:'America/New_York'}]},{...field,key:'defaulted',default:'2026-07-15 14:30'},{key:'defaults',label:'Defaults',type:'object',fields:[field],default:{occurred_at:'2026-07-15 14:30'}}];
 const original={date:'17/09/2026',id:'000123',group:{occurred_at:'2026-07-15 14:30'},rows:[{occurred_at:'2026-07-15 14:30'}]};
 const normalized=Object.fromEntries(fields.map(f=>[f.key,normalizeValue((original as any)[f.key],f,'en-IE','Europe/Dublin')]));
 assert.deepEqual(normalized,{date:'2026-09-17',id:'000123',group:{occurred_at:'2026-07-15T13:30:00Z'},rows:[{occurred_at:'2026-07-15T18:30:00Z'}],defaulted:'2026-07-15T13:30:00Z',defaults:{occurred_at:'2026-07-15T13:30:00Z'}});
 assert.equal(original.group.occurred_at,'2026-07-15 14:30');
 assert.deepEqual(validateValues(normalized,{fields},settings),[]);
});
test('timestamp correction conversion leaves manual dates, numbers, strings, unknown keys and invalid rows untouched',()=>{
 const fields:SchemaField[]=[field,{key:'date',label:'Date',type:'date'},{key:'number',label:'Number',type:'number'},{key:'id',label:'ID',type:'string',transform:'uppercase',default:'DEFAULT'},{key:'rows',label:'Rows',type:'array',fields:[field]}];
 const original={occurred_at:'2026-07-15 14:30',date:'17/09/2026',number:'1.234,56',id:' 000abc ',unknown:'retained for admission rejection',rows:[{occurred_at:'2026-07-15 14:30'},'invalid']};
 const copy=structuredClone(original),result=normalizeTimestampCorrections(original,{fields},settings);
 assert.deepEqual(original,copy);assert.deepEqual(result,{...original,occurred_at:'2026-07-15T13:30:00Z',rows:[{occurred_at:'2026-07-15T13:30:00Z'},'invalid']});
 assert.deepEqual(normalizeTimestampCorrections({id:''},{fields},settings),{id:''});
});
test('both text template generations preserve clock ambiguity as reviewable extraction',()=>{
 const pages=[{page:1,text:'Occurred at: 2026-10-25T01:30'}],templates=[{id:'owned-template',name:'Owned',enabled:true,rules:[{field:'occurred_at',anchor:'Occurred at'}],kind:'text-v1',match_text:''}];
 for(const result of [selectTemplateExtraction(pages,schema,'en-IE',templates,'rules','Europe/Dublin'),selectCurrentTemplateExtraction(pages,schema,'en-IE',templates,'rules',undefined,'Europe/Dublin')]){
  assert.equal(result.selection.outcome,'template');assert.equal(result.result?.issues[0].code,'timestamp_ambiguous');assert.equal(result.result?.normalizedValues.occurred_at,'2026-10-25T01:30');
 }
});
test('AI schemas preserve full timestamp source but keep date-only instructions distinct',()=>{
 const response=extractionResponseSchema({fields:[field,{key:'date',label:'Date',type:'date'}]}) as any;
 assert.match(response.properties.rawValues.properties.occurred_at.description,/full literal date and time/);
 assert.match(response.properties.rawValues.properties.date.description,/excluding.*time of day/);
 const suggestions=schemaSuggestionResponseSchema() as any;assert.ok(suggestions.$defs.field.properties.type.enum.includes('timestamp'));
});
