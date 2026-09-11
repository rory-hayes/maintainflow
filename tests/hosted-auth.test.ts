import test from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../server/app.js';
import {config} from '../server/core/config.js';
import {closeDatabase} from '../server/core/db.js';

test('hosted authentication rate limits distinguish Vercel client IPs and reject missing preview invitations',async()=>{
  const keys=['VERCEL','FOLIO_PREVIEW_MODE','FOLIO_BILLING_MOCK','FOLIO_PREVIEW_INVITE_CODE'] as const;
  const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{VERCEL:'1',FOLIO_PREVIEW_MODE:'true',FOLIO_BILLING_MOCK:'true',FOLIO_PREVIEW_INVITE_CODE:'owned-auth-preview-fixture-'.repeat(2)});
  const app=await buildApp();
  try{
    const request=(ip:string)=>app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin,'x-forwarded-for':ip},payload:{email:'owned-preview@example.test',name:'Owned preview',workspaceName:'Owned preview',password:'owned-preview-password'}});
    for(let i=0;i<30;i++)assert.equal((await request('192.0.2.10')).statusCode,403);
    assert.equal((await request('192.0.2.10')).statusCode,429);
    assert.equal((await request('192.0.2.20')).statusCode,403);
  }finally{
    await app.close();await closeDatabase();
    for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  }
});
