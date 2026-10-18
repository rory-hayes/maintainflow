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

function mutableTransport(initial:Map<string,Buffer>,hooks:{list?:(prefix:string,offset:number,objects:Map<string,Buffer>)=>void;read?:(key:string,objects:Map<string,Buffer>)=>void}={}){
 const objects=new Map(initial),ids=new Map<string,string>(),downloads:string[]=[],pages:Array<{prefix:string;offset:number}>=[];
 const fetch=(async(input,init={})=>{
  const target=new URL(String(input));assert.equal(target.origin,url);assert.equal(init.redirect,'error');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+credential);
  if(target.pathname.endsWith('/bucket/folio-originals'))return Response.json({id:'folio-originals',public:false,file_size_limit:10485760});
  if(target.pathname.endsWith('/object/list/folio-originals')){
   assert.equal(init.method,'POST');const {prefix,offset,limit}=JSON.parse(String(init.body));pages.push({prefix,offset});hooks.list?.(prefix,offset,objects);
   const items=prefix?[...objects].filter(([key])=>key.startsWith(prefix+'/')).sort(([a],[b])=>a.localeCompare(b)).map(([key,bytes])=>{if(!ids.has(key))ids.set(key,randomUUID());return {name:key.split('/')[1],id:ids.get(key),metadata:{size:bytes.length},updated_at:'2026-10-18T00:00:00Z'};}):[...new Set([...objects.keys()].map(key=>key.split('/')[0]))].sort().map(name=>({name,id:null}));
   return Response.json(items.slice(offset,offset+limit));
  }
  assert.equal(init.method,'GET');const key=target.pathname.split('/folio-originals/')[1];assert.ok(objects.has(key));downloads.push(key);hooks.read?.(key,objects);return new Response(new Uint8Array(objects.get(key)!));
 }) as typeof globalThis.fetch;
 return {fetch,downloads,pages,objects};
}
const numbered=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const declaration=(key:string)=>({key,recordType:'direct_upload' as const,recordId:key.split('/')[1]});

test('explicit staging capture tolerates late known PUTs including a new workspace folder and never reads their bytes',async()=>temp(async dir=>{
 const stable=new Map(Array.from({length:201},(_,i)=>[workspace+'/'+numbered((i+1)*2),Buffer.from('stable-'+i)]));
 const stage=workspace+'/'+numbered(199),newFolder=numbered(999)+'/'+numbered(1);let added=false;
 const mock=mutableTransport(stable,{read(_key,objects){if(!added){added=true;objects.set(stage,Buffer.from('late unfinalized upload'));objects.set(newFolder,Buffer.from('another late upload'));}}});
 const captured=await createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch,excludedUploadStaging:[declaration(stage),declaration(newFolder)]}).capture(dir);
 await captured.verify();assert.equal(captured.objects,201);assert.equal(mock.downloads.length,603);assert.ok(mock.downloads.every(key=>stable.has(key)));
 for(const [key,bytes]of stable)assert.deepEqual(await fs.readFile(path.join(dir,key)),bytes);
 for(const key of [stage,newFolder])assert.equal(await fs.stat(path.join(dir,key)).then(()=>true,()=>false),false);
}));

test('known staging insertions shifting child or root offset100/200 pages fail closed before downloads',async()=>{
 for(const level of ['child','root'] as const)for(const boundary of [100,200])await temp(async dir=>{
  const stable=new Map(Array.from({length:201},(_,i)=>[level==='child'?workspace+'/'+numbered((i+1)*2):numbered((i+1)*2)+'/'+numbered(1),Buffer.from('stable')]));
  const stage=level==='child'?workspace+'/'+numbered(boundary*2-1):numbered(boundary*2-1)+'/'+numbered(1);
  const mock=mutableTransport(stable,{list(prefix,offset,objects){if(prefix===(level==='child'?workspace:'')&&offset===boundary)objects.set(stage,Buffer.from('late'));}});
  await assert.rejects(createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch,excludedUploadStaging:[declaration(stage)]}).capture(dir),/repeated or changing/);
  assert.equal(mock.downloads.length,0);assert.deepEqual(mock.pages.filter(p=>p.prefix===(level==='child'?workspace:'')).map(p=>p.offset),boundary===100?[0,100]:[0,100,200]);assert.deepEqual(await fs.readdir(dir),[]);
 });
});

test('staging mode retains unknown object and nonexcluded content drift refusals',async()=>{
 for(const kind of ['unknown-addition','same-size-change','removed'] as const)await temp(async dir=>{
  const first=workspace+'/'+numbered(2),second=workspace+'/'+numbered(4),stage=workspace+'/'+numbered(6);let changed=false;
  const mock=mutableTransport(new Map([[first,Buffer.from('aaaa')],[second,Buffer.from('bbbb')]]),{read(key,objects){if(key===second&&!changed){changed=true;if(kind==='unknown-addition')objects.set(workspace+'/'+numbered(8),Buffer.from('unknown'));else if(kind==='same-size-change')objects.set(first,Buffer.from('xxxx'));else objects.delete(first);}}});
  await assert.rejects(createSupabaseBackupSource({url,serviceRoleKey:credential,fetch:mock.fetch,excludedUploadStaging:[declaration(stage)]}).capture(dir),/changed/);
 });
});
