import test from 'node:test';
import assert from 'node:assert/strict';
import {uploadStagingDeclarations} from '../scripts/backup/staging.js';
import type {BackupUploadStaging} from '../scripts/backup/types.js';

const workspace='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002',key=workspace+'/'+id;
const direct:BackupUploadStaging={key,recordType:'direct_upload',recordId:id};
const split:BackupUploadStaging={key:workspace+'/00000000-0000-4000-8000-000000000003',recordType:'split_suggestion',recordId:id};

test('staging declarations preserve exact record identities in canonical order without mutating input',()=>{
 const input=[split,direct];assert.deepEqual(uploadStagingDeclarations(input),[direct,split]);assert.deepEqual(input,[split,direct]);
 assert.deepEqual(uploadStagingDeclarations([]),[]);
});

test('staging cannot alias any required original, optional source or intake reference',()=>{
 // All source classes use the same deny set; optionality never permits exclusion.
 for(const item of [direct,split])assert.throws(()=>uploadStagingDeclarations([item],[item.key]),/aliases/);
 for(const input of [[direct,direct],[direct,{...split,key}],[split,{...split,key:workspace+'/00000000-0000-4000-8000-000000000004'}]])assert.throws(()=>uploadStagingDeclarations(input),/aliases/);
});

test('staging rejects malformed, excessive, wildcard and mismatched direct reservations',()=>{
 for(const patch of [{key:workspace+'/*'},{key:'../escape'},{recordId:'invalid'},{recordType:'source'},{key:split.key},{unexpected:true}])assert.throws(()=>uploadStagingDeclarations([{...direct,...patch} as BackupUploadStaging]));
 assert.throws(()=>uploadStagingDeclarations(Array(100001).fill(direct)),/limit/);
});
