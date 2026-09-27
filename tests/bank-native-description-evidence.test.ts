import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {completeNativeBankDescriptionEvidence as complete,nativeDescriptionEvidenceLimits as limits} from '../server/core/bank-native-description-evidence.js';
import {bankDescriptionEvidenceIssues} from '../server/core/bank-statement-evidence.js';
import {createBankStatementResult,normalizeBankStatementCorrections} from '../server/core/bank-statement-domain.js';
import {nativeDescriptionEvidenceLabel,nativeDescriptionEvidenceVersion} from '../shared/bank-evidence.js';
import type {Evidence,PageText} from '../shared/types.js';

const field='accounts[0].transactions[0].description';
const description='Café refund\nReturned component 🛠️';
const raw=(value=description)=>({accounts:[{currency:'EUR',transactions:[{description:value,debit:'275,25',credit:null}]}]});
const evidence=(text='Café refund',page=1,source:Evidence['source']='matched-text'):Record<string,Evidence[]>=>({[field]:[{page,text,source}]});
const source=(text=description):PageText[]=>[{page:1,text:`SYNTHETIC HEADER\n${text}\nSYNTHETIC FOOTER`}];

test('completion appends the exact unique native substring with auditable offsets and leaves provider material untouched',()=>{
 const input=raw(),quotes=evidence(),pages=source('Café\trefund\r\n  Returned\u00a0component 🛠️'),before=structuredClone({input,quotes,pages});
 const result=complete(input,quotes,pages),added=result[field][1];
 assert.notEqual(result,quotes);assert.equal(result[field][0],quotes[field][0]);assert.deepEqual({input,quotes,pages},before);
 assert.equal(added.text,'Café\trefund\r\n  Returned\u00a0component 🛠️');assert.equal(added.page,1);assert.equal(added.source,'matched-text');
 assert.deepEqual(added.derivation,{version:nativeDescriptionEvidenceVersion,pageTextSha256:createHash('sha256').update(pages[0].text).digest('hex'),startUtf16:17,endUtf16:17+added.text.length});
 assert.equal(pages[0].text.slice(added.derivation!.startUtf16,added.derivation!.endUtf16),added.text);
 assert.equal(nativeDescriptionEvidenceLabel(added),'Matched in original PDF text');assert.deepEqual(bankDescriptionEvidenceIssues(input,result),[]);
 assert.equal(complete(input,result,pages),result,'Completion is idempotent');
});

test('repeated source passages on one or different pages and duplicate extracted descriptions stay unresolved',()=>{
 const input=raw(),quotes=evidence();
 for(const pages of [source(description+'\n'+description),[...source(),{page:2,text:description}]])assert.equal(complete(input,quotes,pages),quotes);
 const duplicate=raw();duplicate.accounts[0].transactions.push({...duplicate.accounts[0].transactions[0]});
 assert.equal(complete(duplicate,quotes,source()),quotes);
 const secondAccount={accounts:[raw().accounts[0],raw().accounts[0]]};assert.equal(complete(secondAccount,quotes,source()),quotes);
});

test('only a native quote on the uniquely matching page can anchor completion',()=>{
 const pages=[{page:1,text:'Café refund on an unrelated page'},{page:2,text:description}],input=raw();
 for(const quotes of [evidence(),evidence('Café refund',2,'model-visual'),{[field]:[{page:2,text:'Café refund'}]},{},evidence('Unrelated quote',2)])assert.equal(complete(input,quotes,pages),quotes);
 const quotes=evidence('Café refund',2);const result=complete(input,quotes,pages);assert.equal(result[field][1].page,2);
 // A native header quote cannot create a missing scanned-body description.
 const scanned=evidence('Café refund',1,'model-visual');assert.equal(complete(input,scanned,[{page:1,text:''}]),scanned);
});

test('a repeated short anchor elsewhere on the cited page cannot attach its unique longer description',()=>{
 const input=raw(),quotes=evidence(),pages=source(description+'\nCafé refund\nA different transaction');
 assert.equal(complete(input,quotes,pages),quotes);
 const ambiguous=evidence('refund');assert.equal(complete(input,ambiguous,source(description+'\nOther refund')),ambiguous);
 const alternative={[field]:[...quotes[field],{page:1,text:'Returned component 🛠️',source:'matched-text' as const}]};
 // A separate unique anchor can identify the span; this preserves both old quotes.
 const result=complete(input,alternative,pages);assert.equal(result,alternative,'Already-complete ordered fragments need no append');
 const incompleteAlternative={[field]:[...quotes[field],{page:1,text:'Returned component',source:'matched-text' as const}]};
 assert.equal(complete(input,incompleteAlternative,pages)[field].length,3);
});

test('case, accents, punctuation, word order and missing/repeated words are never repaired by matching',()=>{
 for(const text of ['café refund Returned component 🛠️','Cafe refund Returned component 🛠️','Café refund: Returned component 🛠️','Returned component 🛠️ Café refund','Café refund component 🛠️','Café refund Returned Returned component 🛠️','XCafé refund Returned component 🛠️']){
  const quotes=evidence();assert.equal(complete(raw(),quotes,source(text)),quotes,text);
 }
 const short=raw('Office supplies'),quotes=evidence('Office');assert.equal(complete(short,quotes,source('Office suppliesX')),quotes);
 const repeated=raw('Payment Payment'),partial=evidence('Payment');assert.equal(complete(repeated,partial,source('Payment')),partial);
});

test('pathological repeated substrings stop full-value and short-anchor searches conservatively',()=>{
 const input=raw(),quotes=evidence();
 const fullPrefixes=Array(limits.candidates).fill('X'+description).join('\n')+'\n'+description;
 assert.equal(complete(input,quotes,source(fullPrefixes)),quotes);
 const anchorPrefixes=Array(limits.candidates).fill('XCafé refund').join('\n')+'\n'+description;
 assert.equal(complete(input,quotes,source(anchorPrefixes)),quotes);
});

test('complete existing quotes and complete ordered fragments require no append',()=>{
 for(const quotes of [evidence(description),{[field]:[{page:1,text:'Café refund',source:'matched-text' as const},{page:1,text:'Returned component 🛠️',source:'matched-text' as const}]}])assert.equal(complete(raw(),quotes,source()),quotes);
});

test('source, description, evidence and output limits conservatively retain original evidence',()=>{
 const quotes=evidence();
 for(const pages of [[{page:1,text:'x'.repeat(limits.pageText+1)}],Array.from({length:31},(_,i)=>({page:i+1,text:description})),[{page:2,text:description}]])assert.equal(complete(raw(),quotes,pages),quotes);
 for(const input of [null,{accounts:Array(101).fill({transactions:[]})},{accounts:[{transactions:Array(20_001).fill({description:null})}]},raw('x'.repeat(limits.description+1)),{accounts:[{transactions:Array.from({length:300},()=>({description:'x'.repeat(4000)}))}]}])assert.equal(complete(input,quotes,source()),quotes);
 const tooMany={[field]:Array.from({length:20},()=>quotes[field][0])};assert.equal(complete(raw(),tooMany,source()),tooMany);
 const tooLong=evidence('x'.repeat(2001));assert.equal(complete(raw(),tooLong,source()),tooLong);
 const wideWhitespace=source('Café refund'+' '.repeat(2001)+'Returned component 🛠️');assert.equal(complete(raw(),quotes,wideWhitespace),quotes);
 const longDescription='A'.repeat(2000)+' tail',longQuotes=evidence('A');assert.equal(complete(raw(longDescription),longQuotes,source(longDescription)),longQuotes);
});

test('aggregate searching has a fixed ceiling and later unresolved descriptions retain coverage warnings',()=>{
 const transactions=Array.from({length:40},(_,i)=>({description:`Synthetic ${i} payment\nContinuation ${i}`}));
 const input={accounts:[{transactions}]},quotes:Record<string,Evidence[]>={};
 transactions.forEach((row,i)=>{quotes[`accounts[0].transactions[${i}].description`]=[{page:1,text:row.description.split('\n')[0],source:'matched-text'}];});
 const text=transactions.map(row=>row.description).join('\n')+'\n'+'Z'.repeat(300_000),result=complete(input,quotes,[{page:1,text}]);
 const completed=Object.values(result).filter(items=>items.length===2).length;
 assert.equal(completed,Math.floor(limits.searchText/(2*text.length)));assert.ok(completed>0&&completed<transactions.length);
 assert.equal(bankDescriptionEvidenceIssues(input,result).length,transactions.length-completed);
 assert.ok(Object.values(result).flat().filter(item=>item.derivation).reduce((sum,item)=>sum+item.text.length,0)<=limits.addedText);
});

test('bank identity/correction flow retains derived provenance without rewriting the raw wrong-column amount',()=>{
 const input=raw(),quotes=evidence(),completed=complete(input,quotes,source());let next=0;
 const original=createBankStatementResult(input,completed,'de-DE',{id:()=>`f3000000-0000-4000-8000-${String(++next).padStart(12,'0')}`});
 const before=structuredClone(original.context),values=structuredClone(original.values),id=values.accounts[0].transactions[0].id;
 assert.equal(values.accounts[0].transactions[0].debit,'275.25');assert.equal(values.accounts[0].transactions[0].credit,null);
 values.accounts[0].transactions[0].description='User-corrected description';
 const correction=normalizeBankStatementCorrections(values,original.context,original.values);
 assert.equal(correction.values.accounts[0].transactions[0].id,id);assert.deepEqual(original.context,before);
 assert.deepEqual(original.context.transactions[id].evidence[field],completed[field]);assert.equal(input.accounts[0].transactions[0].debit,'275,25');
});

test('derived label cannot relabel legacy, visual, unknown-version or malformed provenance',()=>{
 const completed=complete(raw(),evidence(),source())[field][1];
 for(const item of [evidence()[field][0],{...completed,source:'model-visual' as const},{...completed,derivation:{...completed.derivation!,version:'unknown'}},{...completed,derivation:{...completed.derivation!,pageTextSha256:'not-a-hash'}},{...completed,derivation:{...completed.derivation!,startUtf16:-1}},{...completed,derivation:{...completed.derivation!,endUtf16:99999}}])assert.equal(nativeDescriptionEvidenceLabel(item as Evidence),null);
});
