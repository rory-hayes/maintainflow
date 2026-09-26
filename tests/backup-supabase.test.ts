import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSupabaseBackupSource} from '../scripts/backup/supabase.js';

const url='https://owned-backup-fixture.supabase.co',credential='owned-synthetic-service-key';
const workspace=randomUUID(),key=workspace+'/'+randomUUID();
const object=(name:string,bytes=4)=>({name,id:randomUUID(),metadata:{size:bytes},updated_at:'2026-09-20T00:00:00.000Z'});
async function temp(fn:(dir:string)=>Promise<void>){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'folio-bucket-test-'));try{await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
function transport(options:{objects?:Map<string,Buffer>;changeRead?:number;response?:(route:string,init:RequestInit)=>Response|undefined}={}){
 const objects=options.objects??new Map([[key,Buffer.from('test')]]),calls:Array<{route:string;method:string}>=[];let reads=0;
 const records=new Map([...objects].map(([key,bytes])=>[key,object(key.split('/')[1]!,bytes.length)]));
 const fetch=async(input:URL|RequestInfo,init:RequestInit={})=>{
  const parsed=new URL(String(input));assert.equal(parsed.origin,url);assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+credential);assert.equal(new Headers(init.headers).get('apikey'),credential);
  const route=parsed.pathname;calls.push({route,method:init.method!});const custom=options.response?.(route,init);if(custom)return custom;
  if(route.endsWith('/bucket/folio-originals'))return Response.json({id:'folio-originals',public:false,file_size_limit:10485760,allowed_mime_types:null});
  if(route.endsWith('/object/list/folio-originals')){assert.equal(init.method,'POST');const {prefix,offset,limit}=JSON.parse(String(init.body));const values=prefix?[...records].filter(([key])=>key.startsWith(prefix+'/')).map(([,value])=>value):[...new Set([...objects.keys()].map(k=>k.split('/')[0]))].map(name=>({name,id:null}));return Response.json(values.slice(offset,offset+limit));}
  assert.equal(init.method,'GET');const stored=objects.get(route.split('/folio-originals/')[1]!);assert.ok(stored);reads++;return new Response(new Uint8Array(reads===options.changeRead?Buffer.alloc(stored.length,7):stored));
 };
 return {fetch:fetch as typeof globalThis.fetch,calls,get reads(){return reads;}};
}

test('private bucket capture preserves exact bytes across paginated listing and repeated byte verification without write endpoints',async()=>temp(async dir=>{
 const objects=new Map(Array.from({length:201},(_,i)=>[workspace+'/'+randomUUID(),Buffer.from(String(i))])),mock=transport({objects});
 const captured=await createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch}).capture(dir);assert.equal(captured.objects,201);await captured.verify();
 for(const [key,bytes]of objects)assert.deepEqual(await fs.readFile(path.join(dir,key)),bytes);
 assert.equal(mock.reads,603);assert.ok(mock.calls.every(c=>c.method==='GET'||c.route==='/storage/v1/object/list/folio-originals'));
}));

test('capture rejects a public or oversized-policy bucket and malformed object paths before download',async()=>{
 for(const value of [{id:'folio-originals',public:true,file_size_limit:10},{id:'folio-originals',public:false,file_size_limit:10485761},[{name:'../outside',id:null}], [{name:workspace,id:randomUUID(),metadata:{size:4},updated_at:'2026-09-20'}]])await temp(async dir=>{
  const mock=transport({response:route=>route.includes(Array.isArray(value)?'/object/list/':'/bucket/')?Response.json(value):undefined});
  await assert.rejects(createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch}).capture(dir));assert.equal(mock.reads,0);
 });
});

test('fixed origin and credentials are validated before any request',()=>{
 for(const origin of ['http://owned.supabase.co','https://other.example','https://a.supabase.co@other.example','https://a.supabase.co/path','https://a.supabase.co?token=x','https://a.supabase.co:444','https://a.supabase.co#x'])assert.throws(()=>createSupabaseBackupSource({url:origin,serviceRoleKey:credential}));
 assert.throws(()=>createSupabaseBackupSource({url,serviceRoleKey:'has whitespace'}));
});

test('same-size content changes are rejected even when provider inventory is unchanged',async()=>temp(async dir=>{
 const mock=transport({changeRead:2});await assert.rejects(createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch}).capture(dir),/changed/);
}));

test('later content verification catches post-capture mutation and does not erase staged evidence',async()=>temp(async dir=>{
 const mock=transport({changeRead:3}),captured=await createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch}).capture(dir);await assert.rejects(captured.verify(),/changed/);assert.equal(await fs.readFile(path.join(dir,key),'utf8'),'test');
}));

test('transport HTTP errors never reveal provider response contents or credentials',async()=>temp(async dir=>{
 const mock=transport({response:()=>new Response('SENSITIVE PROVIDER BODY '+credential,{status:403})});await assert.rejects(createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch}).capture(dir),error=>{assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/SENSITIVE|owned-synthetic/);return true;});
}));

test('whole-request deadlines bound stalled fetch and stalled response body even when injected transport ignores abort',async()=>{
 for(const body of [false,true,'error-cancel'] as const)await temp(async dir=>{
  const fetch=(async()=>body==='error-cancel'?new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}),{status:403}):body?new Response(new ReadableStream({start(){}})):new Promise(()=>{})) as typeof globalThis.fetch;
  const start=performance.now();await assert.rejects(createSupabaseBackupSource({url,serviceRoleKey:credential,fetch,timeoutMs:25}).capture(dir));assert.ok(performance.now()-start<1000);
 });
});

test('declared or actual oversized object responses reject and repeated pages cannot cause an unbounded inventory',async()=>{
 for(const variant of ['declared','actual','duplicate'])await temp(async dir=>{
  const mock=transport({response:(route,init)=>{
   if(route.includes('/object/authenticated/'))return variant==='declared'?new Response('test',{headers:{'content-length':'10485761'}}):variant==='actual'?new Response(new Uint8Array(10485761)):undefined;
   if(variant==='duplicate'&&route.includes('/object/list/')&&JSON.parse(String(init.body)).prefix)return Response.json([object(key.split('/')[1]!),object(key.split('/')[1]!)]);
  }});await assert.rejects(createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch}).capture(dir));
 });
});
