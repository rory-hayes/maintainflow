import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {signupTermsStatusSchema,signupTermsRecordResponseSchema,signupTermsPolicyMaxBytes,canonicalSignupPolicy,type SignupPolicyInput} from '../shared/signup-terms.js';
import {validateSignupPolicy,currentSignupTerms,acceptSignupTerms,checkedSignupTermsSnapshot,renderSignupTermsRecord,signupTermsEvidenceNotice} from '../server/core/signup-terms.js';
import {closeDatabase} from '../server/core/db.js';

// Synthetic policy, not legal terms or an installed production catalogue.
const policy:SignupPolicyInput={version:'synthetic-v1',language:'en-IE',title:'Synthetic account terms',text:'SYNTHETIC TEST TERMS\nSecond literal line.',url:'https://example.test/synthetic-v1',agreementText:'I accept these synthetic test terms.'};
after(closeDatabase);
const status=(input=policy)=>({enabled:true as const,policy:validateSignupPolicy(input)});
const acceptance=(input=policy)=>({accepted:true as const,version:input.version,sha256:validateSignupPolicy(input).sha256});

test('digest binds every displayed field and literal whitespace with a fixed canonical serialization',()=>{
 const serialized='{"version":"synthetic-v1","language":"en-IE","title":"Synthetic account terms","text":"SYNTHETIC TEST TERMS\\nSecond literal line.","url":"https://example.test/synthetic-v1","agreementText":"I accept these synthetic test terms."}';
 assert.equal(canonicalSignupPolicy(policy),serialized);assert.equal(validateSignupPolicy(policy).sha256,createHash('sha256').update(serialized,'utf8').digest('hex'));
 for(const field of Object.keys(policy) as (keyof SignupPolicyInput)[]){const changed={...policy,[field]:policy[field]+(field==='language'?'-test':field==='url'?'?revision=2':' ')};assert.notEqual(validateSignupPolicy(changed).sha256,validateSignupPolicy(policy).sha256,field);}
 assert.equal(validateSignupPolicy({...policy,text:' '+policy.text+' '}).text,' '+policy.text+' ');
});

test('policy configuration rejects malformed, oversized, unsafe-link and unknown-field content with a fixed503',()=>{
 const variants:unknown[]=[undefined,{},null,{...policy,extra:'ignored?'},{...policy,url:'javascript:alert(1)'},{...policy,url:'https://user:secret@example.test/terms'},{...policy,url:'https://example.test/terms#hidden'},{...policy,text:'\u0000'},{...policy,text:'\ud800'},{...policy,title:'First\nSecond'},{...policy,text:'é'.repeat(9000)}];
 for(const value of variants)assert.throws(()=>validateSignupPolicy(value),(error:any)=>error.statusCode===503&&error.message==='Signup terms are temporarily unavailable. Please try again later.');
 assert.ok(Buffer.byteLength(canonicalSignupPolicy(policy))<signupTermsPolicyMaxBytes);
 assert.deepEqual(currentSignupTerms(),{enabled:false,policy:null});assert.deepEqual(currentSignupTerms({signupPolicy:()=>null}),{enabled:false,policy:null});
 for(const value of [undefined,{},false])assert.throws(()=>currentSignupTerms({signupPolicy:()=>value as any}),(error:any)=>error.statusCode===503);
 assert.throws(()=>currentSignupTerms({signupPolicy:()=>{throw Error('private config diagnostic');}}),(error:any)=>error.statusCode===503&&!error.message.includes('private'));
});

test('only affirmative acceptance of current complete policy yields an immutable independent snapshot',()=>{
 const current=status();for(const value of [undefined,null,{},false,{...acceptance(),accepted:false},{...acceptance(),accepted:'true'},{...acceptance(),acceptedAt:'2020-01-01T00:00:00Z'}])assert.throws(()=>acceptSignupTerms(current,value),(error:any)=>error.statusCode===400);
 for(const value of [{...acceptance(),version:'old-v0'},{...acceptance(),sha256:'a'.repeat(64)}])assert.throws(()=>acceptSignupTerms(current,value),(error:any)=>error.statusCode===409);
 const before=Date.now(),snapshot=acceptSignupTerms(current,acceptance())!;assert.ok(Date.parse(snapshot.acceptedAt)>=before&&Date.parse(snapshot.acceptedAt)<=Date.now());assert.deepEqual(snapshot.policy,current.policy);current.policy.text='Changed after request';assert.equal(snapshot.policy.text,policy.text);
 assert.deepEqual(checkedSignupTermsSnapshot(snapshot),snapshot);
 assert.throws(()=>checkedSignupTermsSnapshot({...snapshot,policy:{...snapshot.policy,title:'Changed title'}}),/integrity/);
 assert.throws(()=>checkedSignupTermsSnapshot({...snapshot,acceptedAt:'not a date'}));
 assert.equal(acceptSignupTerms({enabled:false,policy:null},undefined),undefined);
 assert.throws(()=>acceptSignupTerms({enabled:false,policy:null},acceptance()),(error:any)=>error.statusCode===409);
});

test('strict public schemas and download preserve exact content without adding payment or delivery evidence',()=>{
 const p=validateSignupPolicy(policy),record={policy:p,acceptedAt:'2026-09-26T12:00:00.000Z',recordedAt:'2026-09-26T12:01:00.000Z',evidenceNotice:signupTermsEvidenceNotice};
 assert.deepEqual(signupTermsStatusSchema.parse(status()),status());assert.deepEqual(signupTermsRecordResponseSchema.parse({record}),{record});assert.deepEqual(signupTermsRecordResponseSchema.parse({record:null}),{record:null});
 for(const value of [{enabled:false,policy:p},{enabled:true,policy:null},{enabled:true,policy:{...p,sha256:'bad'}}])assert.equal(signupTermsStatusSchema.safeParse(value).success,false);
 assert.equal(signupTermsRecordResponseSchema.safeParse({record:{...record,userId:'unrequested'}}).success,false);
 const download=renderSignupTermsRecord(record);assert.ok(download.includes(policy.text));assert.ok(download.includes(policy.agreementText));assert.ok(download.includes(p.sha256));assert.ok(download.includes(signupTermsEvidenceNotice));assert.match(download,/Acceptance request received: 2026-09-26T12:00:00.000Z/);assert.match(download,/Record saved: 2026-09-26T12:01:00.000Z/);
});
