import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import type {ParserSchema} from '../shared/types.js';
import {pdfGeometryVersion,type PdfGeometry,type PdfRegionRule} from '../shared/pdf-regions.js';
import {canonicalTemplateDefinition,type TemplateDefinition} from '../shared/template-definitions.js';
import {selectTemplateExtraction} from '../server/core/template-selection.js';
import {previewTemplateDefinition,selectCurrentTemplateExtraction,templateDefinitionDigest,validateTemplateDefinition} from '../server/core/template-region-selection.js';
import {pinnedTemplateConfig} from '../server/core/template-snapshot.js';
import {templateDefinitionInput} from '../server/core/template-input.js';
import {parserSchema} from '../server/core/schema.js';

const schema:ParserSchema={fields:[{key:'reference',label:'Reference',type:'string',required:true},{key:'amount',label:'Amount',type:'currency',required:true},{key:'enabled',label:'Enabled',type:'boolean',required:true}]};
const source=[{page:1,text:'Reference: REF-001\nAmount: €1,234.50\nEnabled: false'}];
function geometry(delta=0):PdfGeometry {
  const entries=[['Reference:',.1,'REF-001'],['Amount:',.3,'€1,234.50'],['Enabled:',.5,'false']] as const;
  return {version:pdfGeometryVersion,sourceSha256:'a'.repeat(64),pageCount:1,pages:[{page:1,width:500,height:700,rotation:0,reason:null,items:entries.flatMap(([label,y,value],index)=>[
    {id:index*2+1,text:label,rect:{x:.1+delta,y:y+delta,width:.2,height:.025},separator:index?'\n' as const:'' as const},
    {id:index*2+2,text:value,rect:{x:.55+delta,y:y+delta,width:.13,height:.025},separator:' ' as const},
  ])}]};
}
const rules:PdfRegionRule[]=[['reference','Reference:'],['amount','Amount:'],['enabled','Enabled:']].map(([field,anchor])=>({field,anchor,page:1,reference:{width:500,height:700,rotation:0},offset:{x:.44,y:-.003,width:.17,height:.035}}));
const definition:TemplateDefinition={kind:'native-pdf-region-v1',name:'Owned invoice regions',matchText:'Reference:',enabled:true,rules};
const saved={...definition,id:'00000000-0000-4000-8000-000000000001',revision:3,created_at:'2026-01-02T00:00:00Z'};

test('native timestamp regions use the saved timezone and preserve repeated clock times for review',()=>{
 const timestampSchema:ParserSchema={fields:[{key:'reference',label:'Reference',type:'timestamp',required:true}]};
 const template={...saved,rules:[rules[0]]};
 for(const [text,expected,issue] of [['2026-07-15 14:30','2026-07-15T13:30:00Z',undefined],['2026-10-25 01:30','2026-10-25 01:30','timestamp_ambiguous']] as const){
  const sourceGeometry=geometry();sourceGeometry.pages[0].items[1].text=text;
  const result=selectCurrentTemplateExtraction(source,timestampSchema,'en-IE',[template],'rules',sourceGeometry,'Europe/Dublin');
  assert.equal(result.selection.outcome,'template');assert.equal(result.result?.rawValues.reference,text);assert.equal(result.result?.normalizedValues.reference,expected);
  assert.deepEqual(result.result?.issues.map(value=>value.code),issue?[issue]:[]);
 }
});

test('native regions normalize exact source values including false and retain geometry plus immutable definition provenance',()=>{
  const result=selectCurrentTemplateExtraction(source,schema,'en-IE',[saved],'ai',geometry());
  assert.equal(result.selection.policy,'complete-regions-v1');assert.equal(result.selection.outcome,'template');assert.equal(result.selection.template?.kind,'native-pdf-region-v1');assert.equal(result.selection.template?.revision,3);
  assert.deepEqual(result.result?.rawValues,{reference:'REF-001',amount:'€1,234.50',enabled:'false'});
  assert.deepEqual(result.result?.normalizedValues,{reference:'REF-001',amount:1234.5,enabled:false});assert.deepEqual(result.result?.issues,[]);
  assert.equal(result.result?.evidence.amount[0].source,'matched-region');assert.equal(result.result?.evidence.amount[0].region?.sourceSha256,'a'.repeat(64));
  assert.equal(result.result?.evidence.amount[0].region?.anchor.capturedText,'Amount:');assert.deepEqual(result.result?.evidence.amount[0].region?.itemIds,[4]);
  assert.deepEqual(result.result?.templateSnapshot?.template,{...definition,id:saved.id,revision:3});
  assert.equal(result.result?.templateSnapshot?.definitionDigest,createHash('sha256').update(canonicalTemplateDefinition(definition)).digest('hex'));
});

test('translation follows the matching label block and excludes an unrelated adjacent native value',()=>{
  const shifted=geometry(.08);shifted.pages[0].items.push({id:9,text:'UNRELATED-999',rect:{x:.85,y:.18,width:.13,height:.025},separator:' '});
  const result=selectCurrentTemplateExtraction(source,schema,'en-IE',[saved],'rules',shifted);
  assert.equal(result.selection.outcome,'template');assert.deepEqual(result.result?.normalizedValues,{reference:'REF-001',amount:1234.5,enabled:false});
  assert.ok(Math.abs(result.result!.evidence.reference[0].region!.rect.x-.62)<1e-9);assert.ok(Math.abs(result.result!.evidence.reference[0].region!.rect.y-.177)<1e-9);
});

test('incomplete draft preview keeps other captured values and validation issues without making an admissible extraction',()=>{
  const changed=geometry();changed.pages[0].items[3].text='not money';
  const worker=selectCurrentTemplateExtraction(source,schema,'en-IE',[saved],'ai',changed);
  assert.equal(worker.selection.outcome,'ai');assert.equal(worker.result,undefined);assert.ok(worker.candidates[0].reasons.includes('invalid_value'));
  const preview=previewTemplateDefinition(source,schema,'en-IE',{...definition,enabled:false},changed);
  assert.equal(preview.selection.outcome,'failed');assert.equal(preview.result?.rawValues.reference,'REF-001');assert.equal(preview.result?.rawValues.amount,'not money');assert.ok(preview.result?.issues.some(issue=>issue.field==='amount'));
  assert.equal(preview.result?.templateSnapshot,undefined);
});

test('missing region source values cannot be supplied by defaults to establish a complete template',()=>{
  const defaults:ParserSchema={fields:schema.fields.map(field=>field.key==='amount'?{...field,default:99}:field)};
  const incomplete={...saved,rules:rules.filter(rule=>rule.field!=='amount')};
  const result=selectCurrentTemplateExtraction(source,defaults,'en-IE',[incomplete],'rules',geometry());
  assert.equal(result.selection.outcome,'failed');assert.ok(result.candidates[0].unmatchedFields.includes('amount'));assert.equal(result.result,undefined);
});

test('native rules allow nested scalar leaves but reject table targets, duplicate fields and unsupported versions',()=>{
  const nested:ParserSchema={fields:[{key:'party',label:'Party',type:'object',fields:[schema.fields[0]]},{key:'items',label:'Items',type:'array',fields:[schema.fields[0]]}]};
  assert.equal(validateTemplateDefinition(nested,{...definition,rules:[{...rules[0],field:'party.reference'}]}).valid,true);
  assert.equal(validateTemplateDefinition(nested,{...definition,rules:[{...rules[0],field:'items.reference'}]}).valid,false);
  assert.equal(validateTemplateDefinition(schema,{...definition,rules:[rules[0],rules[0]]}).valid,false);
  assert.equal(templateDefinitionInput.safeParse({...definition,kind:'unknown'}).success,false);
  assert.equal(templateDefinitionInput.safeParse({...definition,rules:[{...rules[0],offset:{...rules[0].offset,width:Infinity}}]}).success,false);
});

test('text and region candidates retain most-field and original creation priority without blanket region precedence',()=>{
  const text={kind:'text-v1',id:'00000000-0000-4000-8000-000000000002',revision:2,name:'Older text',enabled:true,match_text:'',rules:rules.map(({field,anchor})=>({field,anchor:anchor.slice(0,-1)})),created_at:'2026-01-01T00:00:00Z'};
  const result=selectCurrentTemplateExtraction(source,schema,'en-IE',[saved,text],'ai',geometry());
  assert.equal(result.selection.eligibleTemplates,2);assert.equal(result.selection.template?.id,text.id);assert.equal(result.selection.template?.tieCount,2);assert.equal(result.result?.engine,'text-template');
  const narrowed={...text,rules:text.rules.slice(0,1)};
  assert.equal(selectCurrentTemplateExtraction(source,schema,'en-IE',[saved,narrowed],'ai',geometry()).selection.template?.id,saved.id);
  const v1=selectTemplateExtraction(source,schema,'en-IE',[text],'ai');
  assert.equal(v1.selection.policy,'complete-v1');assert.equal(v1.selection.template?.revision,undefined);assert.equal(v1.result?.templateSnapshot,undefined);
});

test('missing geometry, duplicate anchor and changed page geometry yield declared nonmatches and preserve rules failure semantics',()=>{
  const absent=selectCurrentTemplateExtraction(source,schema,'en-IE',[saved],'rules');assert.equal(absent.selection.outcome,'failed');assert.ok(absent.candidates[0].reasons.includes('region_source_unsupported'));
  const duplicate=geometry();duplicate.pages[0].items.push({...duplicate.pages[0].items[0],id:8});
  assert.ok(selectCurrentTemplateExtraction(source,schema,'en-IE',[saved],'rules',duplicate).candidates[0].reasons.includes('region_ambiguous_anchor'));
  const changed=geometry();changed.pages[0].width=600;
  assert.ok(selectCurrentTemplateExtraction(source,schema,'en-IE',[saved],'rules',changed).candidates[0].reasons.includes('region_page_geometry_changed'));
});

test('canonical request identity ignores JSONB property order but retains region order and the full definition',()=>{
  const shuffled=JSON.parse(JSON.stringify(definition));shuffled.rules=rules.map(rule=>({offset:{height:rule.offset.height,width:rule.offset.width,y:rule.offset.y,x:rule.offset.x},reference:{rotation:0,height:700,width:500},page:rule.page,anchor:rule.anchor,field:rule.field}));
  assert.equal(templateDefinitionDigest(shuffled),templateDefinitionDigest(definition));
  assert.notEqual(templateDefinitionDigest({...definition,rules:[...rules].reverse()}),templateDefinitionDigest(definition));
  assert.notEqual(templateDefinitionDigest({...definition,name:'Changed'}),templateDefinitionDigest(definition));
});

test('one snapshot helper pins complete definitions independently of later source-object mutations',()=>{
  const templates=[structuredClone(saved)];const config=pinnedTemplateConfig({mode:'rules',instructions:'',locale:'en-IE',timezone:'Europe/Dublin'},templates);
  assert.equal(config.templatePolicy,'complete-regions-v1');assert.equal(config.templates[0].kind,'native-pdf-region-v1');assert.equal(config.templates[0].revision,3);
  templates[0].rules[0].anchor='Changed';templates[0].revision=4;
  assert.equal(config.templates[0].rules[0].anchor,'Reference:');assert.equal(config.templates[0].revision,3);
});

test('legal legacy text definitions beyond the native cap still match and retain their complete snapshot',()=>{
  const nested:ParserSchema={fields:Array.from({length:4},(_,group)=>({key:'group'+group+'a'.repeat(55),label:'Group '+group,type:'object',fields:Array.from({length:25},(_,index)=>({key:'f'+index+'a'.repeat(55),label:'Field '+index,type:'string',required:true}))}))};
  const textRules=nested.fields.flatMap((group,g)=>group.fields!.map((field,index)=>({field:group.key+'.'+field.key,anchor:String(g*25+index).padStart(3,'0')+'漢'.repeat(197)})));
  const textDefinition:TemplateDefinition={kind:'text-v1',name:'Large legacy text',matchText:'',enabled:true,rules:textRules};
  const bytes=Buffer.byteLength(canonicalTemplateDefinition(textDefinition));assert.ok(bytes>73_728);
  assert.equal(parserSchema.safeParse(nested).success,true);assert.equal(templateDefinitionInput.safeParse(textDefinition).success,true);
  const pages=[{page:1,text:textRules.map(rule=>rule.anchor+': value').join('\n')}],template={...textDefinition,id:saved.id,revision:1};
  const old=selectTemplateExtraction(pages,nested,'en-IE',[template],'ai'),current=selectCurrentTemplateExtraction(pages,nested,'en-IE',[template],'ai');
  assert.equal(old.selection.outcome,'template');assert.equal(current.selection.outcome,'template');assert.equal(current.candidates[0].matched,true);
  assert.deepEqual(current.result?.rawValues,old.result?.rawValues);assert.deepEqual(current.result?.templateSnapshot?.template,{...textDefinition,id:saved.id,revision:1});
});

test('escaped disabled legacy text remains within its old per-rule contract while native definitions retain their tighter cap',()=>{
  const disabled:TemplateDefinition={kind:'text-v1',name:'Disabled legacy',matchText:'',enabled:false,rules:Array.from({length:100},()=>({field:'\u0001'.repeat(259),anchor:'\u0001'.repeat(200)}))};
  assert.ok(Buffer.byteLength(canonicalTemplateDefinition(disabled))>262_144);assert.equal(templateDefinitionInput.safeParse(disabled).success,true);
  const native={...definition,rules:Array.from({length:100},()=>({...rules[0],anchor:'漢'.repeat(200)}))};
  assert.ok(Buffer.byteLength(canonicalTemplateDefinition(native))>65_536);assert.equal(templateDefinitionInput.safeParse(native).success,false);
});

test('an invalid text definition cannot claim a matching candidate when excluded from selection',()=>{
  const invalid={kind:'text-v1',name:'',enabled:true,matchText:'',rules:rules.map(({field,anchor})=>({field,anchor:anchor.slice(0,-1)}))};
  assert.equal(selectTemplateExtraction(source,schema,'en-IE',[invalid],'ai').selection.outcome,'template');
  const checked=selectCurrentTemplateExtraction(source,schema,'en-IE',[invalid],'ai');
  assert.equal(checked.selection.outcome,'ai');assert.equal(checked.candidates[0].matched,false);assert.ok(checked.candidates[0].reasons.includes('invalid_rules'));assert.equal(checked.result,undefined);
});
