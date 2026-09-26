import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createBankSourceFixtures,syntheticBankRaw,syntheticBankEvidence} from '../scripts/bank-statement-fixtures.js';
import {inspectSource} from '../server/core/source.js';
import {createOpenAIProvider,openAIExtraction} from '../server/core/openai-provider.js';
import {createBankStatementResult} from '../server/core/bank-statement-domain.js';
import {bankStatementSchema,bankStatementInstructions} from '../shared/bank-statement-preset.js';

test('real synthetic native and image-only multipage PDFs reach the provider unchanged with page-specific evidence',async()=>{
 const files=await createBankSourceFixtures();
 for(const [kind,bytes] of [['native',files.native],['scanned',files.scanned]] as const){
  const hash=createHash('sha256').update(bytes).digest('hex'),source=await inspectSource(bytes,`synthetic-${kind}.pdf`);
  assert.equal(source.pageCount,2);assert.equal(source.mimeType,'application/pdf');
  if(kind==='native'){assert.match(source.pages[0].text,/monthly office stock/);assert.match(source.pages[0].text,/Date \| Description/);assert.match(source.pages[1].text,/Date \| Description/);}
  else assert.ok(source.pages.every(page=>page.text===''));
  let requests=0;
  const provider=createOpenAIProvider({apiKey:'synthetic-controlled-provider-only',fetch:(async(url,options)=>{
   requests++;assert.equal(url,'https://api.openai.com/v1/responses');const request=JSON.parse(String(options?.body));
   assert.equal(request.store,false);assert.ok(request.instructions.includes(bankStatementInstructions));
   const visual=request.input[0].content.find((entry:any)=>entry.type==='input_file');assert.equal(visual.file_data,`data:application/pdf;base64,${bytes.toString('base64')}`);
   return new Response(JSON.stringify({id:'synthetic-bank-response',status:'completed',model:openAIExtraction.model,usage:{input_tokens:100,output_tokens:100},output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({rawValues:syntheticBankRaw,evidence:syntheticBankEvidence})}]}]}));
  }) as typeof fetch});
  const extracted=await provider.extract({bytes,mimeType:source.mimeType,pages:source.pages,schema:bankStatementSchema,instructions:bankStatementInstructions,locale:'en-IE'});
  assert.equal(requests,1);assert.deepEqual(extracted.rawValues,syntheticBankRaw);
  const result=createBankStatementResult(extracted.rawValues,extracted.evidence,'en-IE'),account=result.values.accounts[0];
  assert.equal(account.transactions.length,2);assert.equal(account.transactions[0].description,'Coffee supply monthly office stock');
  assert.equal(account.balance_convention,'credit_increases');assert.equal(account.closing_balance,'1010.00');assert.equal(result.issues.filter(issue=>issue.severity==='error').length,0);
  assert.deepEqual(account.transactions.map(row=>result.context.transactions[row.id].sourcePages),[[1],[2]]);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);
 }
});

test('synthetic scanned PNG remains image input, without fabricated native text or second-page transactions',async()=>{
 const bytes=(await createBankSourceFixtures()).images[0],source=await inspectSource(bytes,'synthetic-page-one.png');
 assert.equal(source.pageCount,1);assert.deepEqual(source.pages,[{page:1,text:''}]);
 const raw=structuredClone(syntheticBankRaw);raw.accounts[0].transactions.splice(1);raw.accounts[0].closing_balance=null;raw.accounts[0].total_debits=null;raw.accounts[0].total_credits=null;
 let visual:any;
 const provider=createOpenAIProvider({apiKey:'synthetic-only',fetch:(async(_url,options)=>{visual=JSON.parse(String(options?.body)).input[0].content.find((entry:any)=>entry.type==='input_image');return new Response(JSON.stringify({status:'completed',model:openAIExtraction.model,usage:{input_tokens:100,output_tokens:100},output:[{type:'message',status:'completed',content:[{type:'output_text',text:JSON.stringify({rawValues:raw,evidence:syntheticBankEvidence.slice(0,2)})}]}]}));}) as typeof fetch});
 const extracted=await provider.extract({bytes,mimeType:source.mimeType,pages:source.pages,schema:bankStatementSchema,instructions:bankStatementInstructions,locale:'en-IE'});
 assert.equal(visual.image_url,`data:image/png;base64,${bytes.toString('base64')}`);
 const result=createBankStatementResult(extracted.rawValues,extracted.evidence,'en-IE');assert.equal(result.values.accounts[0].transactions.length,1);assert.equal(result.values.accounts[0].closing_balance,null);assert.ok(result.issues.some(issue=>issue.code==='statement_balance_missing'));
});
