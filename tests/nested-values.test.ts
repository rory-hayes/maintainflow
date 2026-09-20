import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import type {ParserSchema} from '../shared/types.js';
import {parserSchema,validateValueKeys,validateValues} from '../server/core/schema.js';
import {exportColumns,exportMappingInput} from '../server/integrations/export-input.js';
import {sheetConfigSchema} from '../server/integrations/provider-policy.js';
import {renderExport,type ExportRecord} from '../server/integrations/export-format.js';
import {maximumExportFieldPathLength,maximumExportColumnSourceLength} from '../shared/export-contract.js';

const schema:ParserSchema={fields:[{key:'group',label:'Group',type:'object',fields:[{key:'rows',label:'Rows',type:'array',fields:[{key:'detail',label:'Detail',type:'object',fields:[{key:'amount',label:'Amount',type:'number',required:true},{key:'enabled',label:'Enabled',type:'boolean'}]}]}]}]};
test('nested key validation reaches depth four while allowing drafts with missing values and incorrect types',()=>{
 assert.equal(parserSchema.safeParse(schema).success,true);
 const draft={group:{rows:[{detail:{amount:'unfinished-',enabled:null}},null,42]}};
 assert.deepEqual(validateValueKeys(draft,schema),[]);assert.ok(validateValues(draft,schema).some(issue=>issue.code==='number'));assert.ok(validateValues(draft,schema).some(issue=>issue.code==='object'));
 const extra={group:{rows:[{detail:{amount:0,enabled:false,hidden:'not in schema'},extra:'not in row'}],hidden:'not in group'}};
 assert.deepEqual(new Set(validateValueKeys(extra,schema).map(issue=>issue.field)),new Set(['group.hidden','group.rows[0].extra','group.rows[0].detail.hidden']));
 assert.equal(validateValues(extra,schema).filter(issue=>issue.code==='unknown_field').length,3);
});

test('declared prototype-named keys require own values and prototype injection is never accepted as a schema child',()=>{
 const fields:ParserSchema={fields:[{key:'constructor',label:'Constructor',type:'number',required:true},{key:'object',label:'Object',type:'object',fields:[{key:'toString',label:'Text',type:'string',required:true}]}]};
 assert.equal(parserSchema.safeParse(fields).success,true);
 assert.deepEqual(validateValues({object:{}},fields).map(issue=>issue.code),['required','required']);
 const nullRecord=Object.assign(Object.create(null),{constructor:0,object:Object.assign(Object.create(null),{toString:'owned value'})});assert.deepEqual(validateValues(nullRecord,fields),[]);
 const injection=JSON.parse('{"constructor":0,"object":{"toString":"owned","__proto__":{"polluted":true}}}');assert.equal(validateValueKeys(injection,fields)[0].field,'object.__proto__');assert.equal(Object.hasOwn(Object.prototype,'polluted'),false);
});

test('every supported four-level key path fits export mappings while the shared bounds still reject oversize sources',async()=>{
 const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),d='d'.repeat(64),path=[a,b,c,d].join('.');
 const deepest:ParserSchema={fields:[{key:a,label:'A',type:'object',fields:[{key:b,label:'B',type:'object',fields:[{key:c,label:'C',type:'object',fields:[{key:d,label:'D',type:'number'}]}]}]}]};
 assert.equal(parserSchema.safeParse(deepest).success,true);assert.equal(path.length,maximumExportFieldPathLength);
 assert.equal(exportColumns.safeParse([{source:path,label:'Deep value'}]).success,true);
 assert.equal(sheetConfigSchema.safeParse({spreadsheetId:'owned_sheet_fixture',sheetName:'Owned',columns:[{source:path,label:'Deep value'}],lineItems:[a,b,c].join('.')}).success,true);
 assert.equal(exportMappingInput.safeParse({parserId:'12345678-1234-4234-8234-123456789012',name:'Deep export',columns:[{source:'$item.'+d,label:'Deep row'}],lineItems:[a,b,c].join('.')}).success,true);
 assert.equal(exportColumns.safeParse([{source:'a'.repeat(maximumExportColumnSourceLength+1),label:'Too long'}]).success,false);
 assert.equal(exportMappingInput.safeParse({parserId:'12345678-1234-4234-8234-123456789012',name:'Too long',columns:[{source:'value',label:'Value'}],lineItems:'a'.repeat(maximumExportFieldPathLength+1)}).success,false);
 const values={[a]:{[b]:{[c]:{[d]:0}}}},record:ExportRecord={documentId:'owned-document',filename:'owned.txt',runId:'owned-run',revision:0,values};
 const csv=await renderExport([record],{format:'csv',columns:[{source:path,label:'Deep value'}]});assert.equal(csv.bytes.toString(),'\uFEFF"Deep value"\r\n"0"\r\n');
 const xlsx=await renderExport([record],{format:'xlsx',columns:[{source:path,label:'Deep value'}]}),book=new ExcelJS.Workbook();await book.xlsx.load(xlsx.bytes as any);assert.equal(book.getWorksheet(1)!.getCell(2,1).value,0);
 const json=await renderExport([record],{format:'json'});assert.deepEqual(JSON.parse(json.bytes.toString()).documents[0].values,values);
});
