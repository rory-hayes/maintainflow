import test from 'node:test';
import assert from 'node:assert/strict';
import {bankDescriptionEvidenceIssues,bankEvidenceReviewIssues} from '../server/core/bank-statement-evidence.js';
import {createBankStatementResult} from '../server/core/bank-statement-domain.js';
import type {Evidence} from '../shared/types.js';

const field='accounts[0].transactions[0].description';
const raw=()=>({accounts:[{currency:'EUR',transactions:[{description:'Office supplies\nWrapped description'},{description:null}]}]});
const quote=(text:string,page=1,source:Evidence['source']='matched-text'):Evidence=>({page,text,...(source?{source}:{})});
const issues=(quotes:unknown,value:unknown=raw())=>bankDescriptionEvidenceIssues(value,{[field]:quotes});

test('bank descriptions retain partial quotes and warn unless complete literal coverage is present',()=>{
 const input=raw(),evidence={[field]:[quote('Office supplies')]},before=structuredClone({input,evidence});
 assert.deepEqual(bankDescriptionEvidenceIssues(input,evidence).map(issue=>[issue.field,issue.code]),[[field,'evidence_incomplete']]);
 assert.deepEqual({input,evidence},before);
 for(const entries of [[quote('Office supplies\nWrapped description')],[quote('Label: Office supplies Wrapped description')],[quote('Office supplies'),quote('Wrapped description')],[quote('Office supplies',1),quote('Wrapped description',2)]])assert.deepEqual(issues(entries),[]);
 for(const entries of [[quote('Wrapped description'),quote('Office supplies')],[quote('Office supplies'),quote('Office supplies')],[quote('Office supplies',2),quote('Wrapped description',1)],[quote('Office supplies Wrapped')]])assert.equal(issues(entries)[0].code,'evidence_incomplete');
 const repeated={accounts:[{transactions:[{description:'Payment Payment'}]}]};assert.equal(issues([quote('Payment')],repeated)[0].code,'evidence_incomplete');assert.deepEqual(issues([quote('Payment Payment')],repeated),[]);
});

test('empty, missing, long and malformed evidence stays bounded without fabricating source text',()=>{
 assert.equal(issues([])[0].code,'evidence_missing');
 for(const description of [null,undefined,'',' \n '])assert.deepEqual(issues([],{accounts:[{transactions:[{description}]}]}),[]);
 for(const entries of [null,'PRIVATE invalid quotes',[quote('Office supplies',0)],[quote('x'.repeat(2001))],Array.from({length:21},()=>quote('Office supplies'))])assert.equal(issues(entries)[0].code,'evidence_incomplete');
 assert.equal(issues([], {accounts:[{transactions:[{description:'x'.repeat(4001)}]}]})[0].code,'evidence_incomplete');
 for(const value of [null,{accounts:Array(101).fill({})},{accounts:[{transactions:Array(20_001).fill({})}]}])assert.deepEqual(bankDescriptionEvidenceIssues(value,{}).map(issue=>[issue.field,issue.code]),[['_source','evidence_incomplete']]);
 const long='x'.repeat(4000),large={accounts:[{transactions:Array.from({length:300},()=>({description:long}))}]};
 const result=bankDescriptionEvidenceIssues(large,{});assert.ok(result.length<300);assert.equal(result.at(-1)?.field,'_source');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|xxxxx/);
 const fragments=[quote('a'.repeat(2000)),quote('b'.repeat(1999))];assert.deepEqual(issues(fragments,{accounts:[{transactions:[{description:'a'.repeat(2000)+' '+'b'.repeat(1999)}]}]}),[]);
});

test('legacy indexed paths and whitespace are supported without upgrading quote provenance',()=>{
 const evidence={'accounts.0.transactions.0.description':[{page:1,text:'Office supplies\tWrapped description'}]},before=structuredClone(evidence);
 assert.deepEqual(bankDescriptionEvidenceIssues(raw(),evidence),[]);assert.deepEqual(evidence,before);assert.equal('source' in evidence['accounts.0.transactions.0.description'][0],false);
});

test('current review maps original paths to stable IDs through row/account reorder and corrected text',()=>{
 const input=raw();input.accounts.push({currency:'USD',transactions:[{description:'Other account description'}]});
 const evidence={[field]:[quote('Office supplies')],'accounts[1].transactions[0].description':[quote('Other account description')]};
 const created=createBankStatementResult(input,evidence,'en-IE'),before=structuredClone(created.context),values=structuredClone(created.values),account=values.accounts[0],id=account.transactions[0].id;
 account.transactions[0].description='Office supplies';account.transactions.reverse();values.accounts.reverse();
 const stored=[{field,code:'evidence_incomplete',message:'PRIVATE provider text'},{field:'accounts.0.transactions.0.reference',code:'value_source_mismatch',message:'PRIVATE provider text'},{field:'accounts[999].transactions[0].description',code:'evidence_missing',message:'PRIVATE'}, {field,code:'unknown_provider_error',message:'PRIVATE'}];
 const result=bankEvidenceReviewIssues(input,evidence,stored,created.context,values);
 assert.equal(result.filter(issue=>issue.code==='evidence_incomplete').length,1);
 assert.ok(result.every(issue=>issue.accountId===account.id&&issue.transactionId===id));
 assert.deepEqual(result.map(issue=>issue.field).sort(),['description','reference']);assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.deepEqual(created.context,before);
 const legacy=bankEvidenceReviewIssues(input,evidence,[],created.context,values);assert.equal(legacy[0].transactionId,id);assert.equal(legacy[0].code,'evidence_incomplete');
});

test('excluded accounts/rows keep stored audit material but leave active evidence checks; user rows never inherit it',()=>{
 const input=raw(),evidence={[field]:[quote('Office supplies')]},stored=[{field,code:'evidence_incomplete',message:'Original fixed audit issue'}];
 const created=createBankStatementResult(input,evidence,'en-IE'),values=structuredClone(created.values),before=structuredClone({input,evidence,stored,context:created.context});
 values.accounts[0].transactions[0].excluded=true;
 values.accounts[0].transactions.push({...values.accounts[0].transactions[0],id:'new-user-row',origin:'user',excluded:false});
 assert.deepEqual(bankEvidenceReviewIssues(input,evidence,stored,created.context,values),[]);
 values.accounts[0].transactions[0].excluded=false;values.accounts[0].excluded=true;
 assert.deepEqual(bankEvidenceReviewIssues(input,evidence,stored,created.context,values),[]);
 assert.deepEqual({input,evidence,stored,context:created.context},before);
});

test('visual uncertainty follows only explicitly model-read evidence for included original fields',()=>{
 const input=raw(),evidence={[field]:[quote('Office supplies Wrapped description',1,'model-visual')]},created=createBankStatementResult(input,evidence,'en-IE');
 const stored=[{field:'_source',code:'visual_evidence',message:'PRIVATE stored copy'}];
 assert.deepEqual(bankDescriptionEvidenceIssues(input,evidence),[]);
 const result=bankEvidenceReviewIssues(input,evidence,stored,created.context,created.values);assert.equal(result.length,1);assert.equal(result[0].code,'visual_evidence');assert.doesNotMatch(result[0].message,/PRIVATE/);
 const values=structuredClone(created.values);values.accounts[0].transactions[0].excluded=true;
 assert.deepEqual(bankEvidenceReviewIssues(input,evidence,stored,created.context,values),[]);
 const native={[field]:[quote('Office supplies Wrapped description')]};assert.deepEqual(bankEvidenceReviewIssues(input,native,stored,created.context,created.values),[]);
 assert.equal(evidence[field][0].source,'model-visual');
});
