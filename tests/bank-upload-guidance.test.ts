import test from 'node:test';
import assert from 'node:assert/strict';
import {bankUploadFailure} from '../src/features/bank-statements/bank-upload';
import {ApiError,uploadDocuments} from '../src/lib/api';
import {SourceValidationError,sourceValidationReasons,type SourceValidationReason} from '../server/core/source-validation';

test('proven source-validation failures need a corrected file for every supported intake format',()=>{
  for(const reason of Object.keys(sourceValidationReasons) as SourceValidationReason[]){
    const original=new SourceValidationError(reason);
    // Direct uploads flatten the server reason/status into the fixed message.
    const failure=bankUploadFailure(new Error(original.message));
    assert.equal(failure.retryable,false,reason);assert.equal(failure.error,original.message);
  }
  for(const message of ['Choose a non-empty file of 10 MB or less.','Each file must contain data and be 10 MB or smaller.','File exceeds 10 MB limit','Document exceeds the workspace file limit'])assert.equal(bankUploadFailure(new Error(message)).retryable,false,message);
});

test('temporary and ambiguous upload failures remain retryable without broad status/message guesses',()=>{
  for(const error of [
    new TypeError('Failed to fetch'),new Error('The upload could not be confirmed. Retry this file.'),
    new Error('The file could not be uploaded. Please retry.'),
    new ApiError('Private storage is temporarily unavailable. Retry shortly.',503),
    new ApiError('Too many recent uploads. Finish pending uploads or retry after their cleanup window.',429),
    new ApiError('This upload is being verified. Retry shortly.',409),
    new ApiError('Uploaded bytes do not match this reservation. Start a new upload.',400),
    new ApiError('An unknown file check failed',400),new Error('The file does not contain a valid PDF (temporary upstream error)'),
  ])assert.equal(bankUploadFailure(error).retryable,true,error.message);
  for(const status of [408,429,500,503])assert.equal(bankUploadFailure(new ApiError('The file does not contain a valid PDF',status)).retryable,true);
  assert.deepEqual(bankUploadFailure(null),{error:'Upload failed. Please retry.',retryable:true});
});

async function controlledUpload(strategy:'signed'|'multipart',outcome:{status:number;body:unknown}|Error){
  const previousFetch=globalThis.fetch,storage=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');
  const calls:{path:string;method:string}[]=[];
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=> 'synthetic-workspace'}});
  globalThis.fetch=(async(input,init)=>{
    const path=String(input),method=init?.method||'GET';calls.push({path,method});
    if(path==='/api/uploads/config')return Response.json({strategy,maxBytes:10*1024*1024});
    if(strategy==='signed'&&path==='/api/parsers/synthetic-parser/uploads')return Response.json({uploadId:'synthetic-upload',uploadUrl:'https://synthetic.supabase.co/synthetic-only'});
    if(strategy==='signed'&&path==='https://synthetic.supabase.co/synthetic-only')return new Response(null,{status:200});
    const finalPath=strategy==='signed'?'/api/uploads/synthetic-upload/finalize':'/api/parsers/synthetic-parser/documents?bankLocale=de-DE';
    assert.equal(path,finalPath,'No other transport calls are permitted in this synthetic fixture');
    if(outcome instanceof Error)throw outcome;
    return Response.json(outcome.body,{status:outcome.status});
  }) as typeof fetch;
  try{
    try{
      const response=await uploadDocuments('synthetic-parser',[new File(['synthetic malformed bytes'],'synthetic.pdf',{type:'application/pdf'})],{bankLocale:'de-DE'});
      const result=response.results[0];
      return {result,failure:result.error?bankUploadFailure(new Error(result.error)):null,calls};
    }catch(error){return {failure:bankUploadFailure(error),calls};}
  }finally{globalThis.fetch=previousFetch;if(storage)Object.defineProperty(globalThis,'sessionStorage',storage);else Reflect.deleteProperty(globalThis,'sessionStorage');}
}

test('the existing signed-upload transport classifies malformed PDF results without re-uploading',async()=>{
  const {failure,calls}=await controlledUpload('signed',{status:400,body:{error:'The file does not contain a valid PDF',code:'source_validation_failed',reason:'pdf_invalid'}});
  assert.deepEqual(failure,{error:'The file does not contain a valid PDF',retryable:false});
  assert.deepEqual(calls.map(call=>call.method),['GET','POST','PUT','POST']);
});

test('the existing multipart transport classifies malformed PDF results without re-uploading',async()=>{
  const {failure,calls}=await controlledUpload('multipart',{status:400,body:{error:'The file does not contain a valid PDF'}});
  assert.equal(failure?.retryable,false);assert.deepEqual(calls.map(call=>call.method),['GET','POST']);
});

test('both upload transports retain retry for network loss, storage failure and admission backoff',async()=>{
  for(const strategy of ['signed','multipart'] as const){
    for(const outcome of [new TypeError('Failed to fetch'),{status:503,body:{error:'Private storage is temporarily unavailable. Retry shortly.'}},{status:429,body:{error:'Too many recent uploads. Finish pending uploads or retry after their cleanup window.'}}]){
      const {failure,calls}=await controlledUpload(strategy,outcome);assert.equal(failure?.retryable,true);assert.equal(calls.length,strategy==='signed'?4:2);
    }
  }
});

test('exact-file duplicate receipts stay successful and retain the existing document identity',async()=>{
  const duplicate={document:{id:'synthetic-existing-document'},duplicate:true,jobId:null};
  for(const strategy of ['signed','multipart'] as const){
    const {result,failure}=await controlledUpload(strategy,{status:202,body:strategy==='signed'?duplicate:{...duplicate,results:[duplicate]}});
    assert.equal(failure,null);assert.deepEqual(result,duplicate);
  }
});
