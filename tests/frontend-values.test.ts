import test from 'node:test';
import assert from 'node:assert/strict';
import type {SchemaField} from '../shared/types';
import {emptyFieldValue,normalizeEditorValues} from '../src/features/documents/value-editing';

const schema:SchemaField[]=[
  {key:'amount',label:'Amount',type:'currency'},
  {key:'approved',label:'Approved',type:'boolean'},
  {key:'groups',label:'Groups',type:'array',fields:[
    {key:'account',label:'Account',type:'object',fields:[{key:'limit',label:'Limit',type:'number'}]},
    {key:'items',label:'Items',type:'array',fields:[{key:'price',label:'Price',type:'currency'},{key:'paid',label:'Paid',type:'boolean'}]},
  ]},
];
test('review correction saves blanks as missing and preserves explicit zero and false',()=>{
  assert.deepEqual(normalizeEditorValues({amount:'  ',approved:false,groups:[]},schema),{amount:null,approved:false,groups:[]});
  assert.equal(normalizeEditorValues({amount:'0'},schema).amount,0);
  assert.equal(normalizeEditorValues({amount:''},schema).amount,null);
});
test('review normalization reaches nested arrays and objects without changing the editing draft',()=>{
  const draft={amount:'12.30',approved:true,groups:[{account:{limit:'-2.5'},items:[{price:'1.20',paid:false},{price:'',paid:null}]}]};
  assert.deepEqual(normalizeEditorValues(draft,schema),{amount:12.3,approved:true,groups:[{account:{limit:-2.5},items:[{price:1.2,paid:false},{price:null,paid:null}]}]});
  assert.equal(draft.amount,'12.30');
  assert.equal(draft.groups[0].items[0].price,'1.20');
});
test('invalid and non-finite numeric drafts remain visible to server validation',()=>{
  for(const draft of ['-','1.2.3','1e999','Infinity','0x20','€12.50'])assert.equal(normalizeEditorValues({amount:draft},schema).amount,draft);
});
test('new review rows initialize nested structures and copy explicit defaults independently',()=>{
  const field:SchemaField={key:'group',label:'Group',type:'object',fields:[{key:'enabled',label:'Enabled',type:'boolean',default:false},{key:'items',label:'Items',type:'array',fields:[{key:'name',label:'Name',type:'string'}],default:[{name:'Sample'}]}]};
  const first=emptyFieldValue(field) as {enabled:boolean;items:{name:string}[]};
  const second=emptyFieldValue(field) as typeof first;
  assert.deepEqual(first,{enabled:false,items:[{name:'Sample'}]});
  first.items[0].name='Changed';
  assert.equal(second.items[0].name,'Sample');
});
