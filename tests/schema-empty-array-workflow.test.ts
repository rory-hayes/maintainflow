import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {FastifyInstance} from 'fastify';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,closeDatabase,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {addDocument} from '../server/core/intake.js';
import {processOneCoreJob} from '../server/core/worker.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';

let app:FastifyInstance|undefined,workspaceId:string|undefined,userId:string|undefined;
const objects=new Map<string,Buffer>();
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},async remove(key){objects.delete(key);}};
before(async()=>{
  assert.equal(process.env.NODE_ENV,'test');assert.equal(databaseSchema,'public');
  const urlMode=Boolean(adminPool.options.connectionString||appPool.options.connectionString);
  let endpoint:string|undefined;
  for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
    const options=pool.options;
    if(urlMode){
      assert.equal(typeof options.connectionString,'string','Pin both pools to the disposable local database');
      const url=new URL(options.connectionString!);
      assert.ok(['postgres:','postgresql:'].includes(url.protocol));
      assert.ok(['localhost','127.0.0.1','[::1]'].includes(url.hostname),'Remote databases are forbidden');
      assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');
      const current=`${url.hostname}:${url.port||'5432'}${url.pathname}`;
      if(endpoint)assert.equal(current,endpoint,'Both pools must target the same disposable database');
      endpoint=current;
    }else{
      assert.ok(config.root.startsWith('/private/tmp/')||config.root.startsWith('/tmp/'),'Socket tests require a private copied checkout');
      assert.equal(path.resolve(options.host!),path.resolve(config.root,'.local/socket'));
      assert.equal(options.port,55432);assert.equal(options.database,'folio');assert.equal(options.user,role);
    }
  }
  setStorageForTests(storage);app=await buildApp();
});
after(async()=>{
  try{
    await app?.close();
    if(workspaceId)await adminPool.query('delete from workspaces where id=$1',[workspaceId]);
    if(userId)await adminPool.query('delete from users where id=$1',[userId]);
  }finally{objects.clear();setStorageForTests(undefined);await closeDatabase();}
});

test('invalid empty-array corrections stay reviewable but cannot be approved or exported; corrected values can',async()=>{
  const signup=await app!.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned empty-array regression',workspaceName:'Owned empty-array regression',email:`empty-array-${randomUUID()}@example.test`,password:'Owned empty-array validation password'}});
  assert.equal(signup.statusCode,201,signup.body);
  const account=signup.json();workspaceId=account.workspace.id;userId=account.user.id;
  const headers={origin:config.origin,cookie:signup.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ')};
  const request=(method:'GET'|'POST',url:string,payload?:unknown)=>app!.inject({method,url,headers,payload:payload as any});
  const parser=await request('POST','/api/parsers',{name:'Owned empty-array parser',useCase:'custom',mode:'rules',schema:{fields:[
    {key:'reference',label:'Reference',type:'string',required:true},
    {key:'amount',label:'Amount',type:'currency'},
    {key:'metadata',label:'Metadata',type:'object',fields:[{key:'note',label:'Note',type:'string'}]},
    {key:'items',label:'Items',type:'array',fields:[{key:'description',label:'Description',type:'string'}]},
  ]}});
  assert.equal(parser.statusCode,201,parser.body);
  const source=Buffer.from('Reference: OWNED-000127\nAmount: 12.50');
  const intake=await addDocument({userId:userId!,workspaceId:workspaceId!,role:'owner',authType:'session'},parser.json().parser.id,source,'owned-empty-array-regression.txt');
  assert.ok(intake.jobId);assert.equal(await processOneCoreJob(intake.jobId),true);
  const original=(await request('GET',`/api/documents/${intake.document.id}`)).json().runs[0];
  const usage=(await request('GET','/api/workspace/usage')).json();
  let revision=original.effectiveRevision;
  for(const [field,code] of [['amount','number'],['metadata','object']] as const){
    const invalid={...original.effectiveValues,[field]:[]};
    const correction=await request('POST',`/api/runs/${original.id}/corrections`,{values:invalid,expectedRevision:revision});
    assert.equal(correction.statusCode,200,correction.body);
    assert.deepEqual(correction.json().run.effectiveValues,invalid);
    assert.ok(correction.json().issues.some((issue:any)=>issue.field===field&&issue.code===code));
    revision=correction.json().run.effectiveRevision;
    const approval=await request('POST',`/api/runs/${original.id}/approve`,{expectedRevision:revision});
    assert.equal(approval.statusCode,422,approval.body);assert.match(approval.json().message,/Resolve validation issues/);
    const exported=await request('POST','/api/exports',{documentIds:[intake.document.id],format:'json'});
    assert.equal(exported.statusCode,400,exported.body);
    assert.equal((await adminPool.query('select id from approvals where run_id=$1',[original.id])).rowCount,0);
    assert.equal((await adminPool.query('select id from export_snapshots where workspace_id=$1',[workspaceId])).rowCount,0);
  }
  const saved=await request('POST',`/api/runs/${original.id}/corrections`,{values:original.effectiveValues,expectedRevision:revision});
  assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().issues,[]);
  const approved=await request('POST',`/api/runs/${original.id}/approve`,{expectedRevision:saved.json().run.effectiveRevision});
  assert.equal(approved.statusCode,200,approved.body);
  const exported=await request('POST','/api/exports',{documentIds:[intake.document.id],format:'json'});
  assert.equal(exported.statusCode,200,exported.body);
  const download=await request('GET',exported.json().downloadUrl);
  assert.equal(download.statusCode,200,download.body);
  assert.deepEqual(download.json().documents[0].values,original.effectiveValues);
  assert.equal(download.json().documents[0].approvalId,approved.json().approval.id);
  const final=(await request('GET',`/api/documents/${intake.document.id}`)).json().runs[0];
  assert.deepEqual(final.rawValues,original.rawValues);assert.deepEqual(final.normalizedValues,original.normalizedValues);assert.deepEqual(final.evidence,original.evidence);
  assert.deepEqual((await request('GET','/api/workspace/usage')).json(),{...usage,usage:{...usage.usage,needsReview:0,processed:1}});
  assert.deepEqual([...objects.values()],[source]);
});
