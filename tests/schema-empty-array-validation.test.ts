import test from 'node:test';
import assert from 'node:assert/strict';
import {validateValues} from '../server/core/schema.js';
import type {ParserSchema,SchemaField} from '../shared/types.js';

const scalarCases = [
  ['string','text'], ['multiline','text'], ['number','number'], ['currency','number'],
  ['boolean','boolean'], ['date','date'], ['timestamp','timestamp_invalid'], ['object','object'],
] as const;
const field=(type:SchemaField['type']):SchemaField=>({key:'value',label:'Value',type,...(type==='object'?{fields:[{key:'note',label:'Note',type:'string' as const}]}:{})});

test('an empty array is a wrong type for every optional scalar or object field, not a missing value',()=>{
  for(const [type,code] of scalarCases){
    const schema:ParserSchema={fields:[field(type)]};
    const issues=validateValues({value:[]},schema);
    assert.ok(issues.some(issue=>issue.field==='value'&&issue.code===code),`${type} must reject an empty array`);
  }
});

test('empty arrays cannot bypass type validation inside objects or repeating rows',()=>{
  const fields:SchemaField[]=[{...field('currency'),key:'amount'},{...field('string'),key:'reference'}];
  const schema:ParserSchema={fields:[{key:'details',label:'Details',type:'object',fields},{key:'items',label:'Items',type:'array',fields}]};
  const values={details:{amount:[],reference:[]},items:[{amount:[],reference:[]}]};
  const before=structuredClone(values);
  assert.deepEqual(validateValues(values,schema).map(issue=>[issue.field,issue.code]),[
    ['details.amount','number'],['details.reference','text'],['items[0].amount','number'],['items[0].reference','text'],
  ]);
  assert.deepEqual(values,before,'Validation preserves the reviewable correction exactly');
});

test('optional empty tables stay valid and required empty tables stay missing',()=>{
  const table:SchemaField={key:'items',label:'Items',type:'array',fields:[field('string')]};
  assert.deepEqual(validateValues({items:[]},{fields:[table]}),[]);
  assert.deepEqual(validateValues({items:[]},{fields:[{...table,required:true}]}),[{field:'items',code:'required',message:'Items is required.'}]);
});

test('optional null, absent and blank values retain their existing missing-value semantics',()=>{
  for(const [type] of scalarCases){
    const schema:ParserSchema={fields:[field(type)]};
    for(const values of [{},{value:null},{value:''}])assert.deepEqual(validateValues(values,schema),[],type);
  }
});
