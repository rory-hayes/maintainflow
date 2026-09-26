import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import type {Actor,Evidence} from '../shared/types.js';
import type {RawBankValues} from '../shared/bank-statements.js';
import {bankStatementSchema} from '../shared/bank-statement-preset.js';
import {adminPool,appPool,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';

const accounts:Actor[]=[];
export async function assertBankFixtureDatabase(){
 assert.equal(databaseSchema,'public');
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  if(pool.options.connectionString){const url=new URL(pool.options.connectionString);assert.equal(process.env.NODE_ENV,'test');assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/folio');assert.equal(url.port||'5432','5432');assert.equal(decodeURIComponent(url.username),role);}
  else{assert.ok(config.root.startsWith('/private/tmp/')||config.root.startsWith('/tmp/'),'Bank fixtures require a copied private temporary checkout');assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}
 }
 const identity=(await adminPool.query('select current_database() db,current_schema() schema,inet_server_addr()::text address')).rows[0];assert.equal(identity.db,'folio');assert.equal(identity.schema,'public');if(!adminPool.options.connectionString)assert.equal(identity.address,null);
}
export function bankRawFixture():RawBankValues{return {accounts:[{bank_name:'Synthetic Example Bank',account_identifier:'TEST-00001234',currency:'EUR',statement_start:'2026-09-01',statement_end:'2026-09-30',opening_balance:'1,000.00',closing_balance:'1,030.00',total_debits:'20.00',total_credits:'50.00',balance_convention:'credit_increases',transactions:[{date:'2026-09-02',description:'Office supplies\nWrapped description',reference:'TEST-001',debit:'20.00',credit:null,balance:'980.00',currency:null},{date:'2026-09-03',description:'Synthetic payment',reference:'TEST-002',debit:null,credit:'50.00',balance:'1,030.00',currency:null}]}]};}
export function setBankFixtureProvider(raw:RawBankValues){
 setExtractionProvider({configured:()=>true,async extract(input){assert.deepEqual(input.schema,bankStatementSchema);const evidence:Record<string,Evidence[]>={};for(const [index,account] of raw.accounts.entries())for(const [position,row] of account.transactions.entries())for(const [field,value] of Object.entries(row))if(value!==null)evidence[`accounts[${index}].transactions[${position}].${field}`]=[{page:1,text:value}];return {engine:'controlled-bank-fixture',model:'synthetic-fixture',rawValues:structuredClone(raw) as unknown as Record<string,unknown>,normalizedValues:{deliberately_ignored:'Provider normalized output must not be used'},evidence,issues:[]};}});
}
export async function createBankFixture(app:FastifyInstance,locale:'en-IE'|'en-US'|'de-DE'='en-IE'){
 const registration=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned bank fixture',workspaceName:'Owned bank fixture',email:`bank-${randomUUID()}@example.test`,password:'Owned bank fixture password'}});
 assert.equal(registration.statusCode,201,registration.body);const account=registration.json();
 const actor:Actor={userId:account.user.id,workspaceId:account.workspace.id,role:'owner',authType:'session'};accounts.push(actor);
 const headers={origin:config.origin,cookie:registration.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')};
 const request=(method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:unknown)=>app.inject({method,url,headers,payload:payload as any});
 const setup=await request('POST','/api/bank-statements/setup',{locale});assert.equal(setup.statusCode,200,setup.body);const {parser,schema}=setup.json();
 const detail=async(documentId:string)=>{const response=await request('GET',`/api/bank-statements/${documentId}`);assert.equal(response.statusCode,200,response.body);return response.json();};
 const queue=async(label:string=randomUUID())=>{const source=await addDocument(actor,parser.id,Buffer.from(`SYNTHETIC BANK FIXTURE ${label}`),`synthetic-bank-${label}.txt`);assert.ok(source.jobId);return {...source,jobId:source.jobId!};};
 const upload=async(raw=bankRawFixture(),label:string=randomUUID())=>{const source=await queue(label);setBankFixtureProvider(raw);try{assert.equal(await processOneCoreJob(source.jobId),true);const result=await detail(source.document.id);assert.equal(result.document.status,'needs_review',result.document.error);assert.ok(result.runs[0]?.bankContext);return {...source,run:result.runs[0]};}finally{setExtractionProvider(undefined);}};
 const approve=(run:any)=>request('POST',`/api/runs/${run.id}/approve`,{expectedRevision:run.effectiveRevision,bankReviewToken:run.bankReviewToken,acknowledgeBankWarnings:true});
 return {actor,headers,request,parser,schema,queue,upload,detail,approve};
}
export async function cleanupBankFixtures(){for(const actor of accounts.splice(0)){await adminPool.query('delete from workspaces where id=$1',[actor.workspaceId]);await fs.rm(path.join(config.storageDir,actor.workspaceId),{recursive:true,force:true});await adminPool.query('delete from users where id=$1',[actor.userId]);}}
