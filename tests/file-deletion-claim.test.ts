/** Real database row locking; synthetic in-memory bytes; no external requests. */
import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {deleteStoredFile,processOneFileDeletion} from '../server/core/retention.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {assertRetentionRehearsalDatabase} from './retention-rehearsal-fixtures.js';

const workspaces:string[]=[],objects=new Map<string,Buffer>();
const originalFetch=globalThis.fetch;
let verified=false,networkCalls=0;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function within<T>(promise:Promise<T>,message:string){
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(message)),5_000);})]);}
 finally{if(timer)clearTimeout(timer);}
}
before(async()=>{
 await assertRetentionRehearsalDatabase();
 assert.equal((await adminPool.query('select count(*)::int n from file_deletions')).rows[0].n,0,'The global deletion worker requires an empty disposable queue.');
 verified=true;
 globalThis.fetch=async()=>{networkCalls++;throw new Error('External calls forbidden in deletion-claim fixtures');};
});
afterEach(()=>{setStorageForTests(undefined);assert.equal(networkCalls,0);});
after(async()=>{
 try{
  setStorageForTests(undefined);globalThis.fetch=originalFetch;
  if(verified)for(const workspace of workspaces)await adminPool.query('delete from workspaces where id=$1',[workspace]);
  objects.clear();
 }finally{await closeDatabase();}
});

async function staleClaim(initialAttempts:number){
 const workspace=randomUUID(),id=randomUUID(),key=`${workspace}/${id}`;
 const bytes=Buffer.from('SYNTHETIC ONLY abandoned write awaiting physical deletion');
 workspaces.push(workspace);objects.set(key,Buffer.from(bytes));
 await adminPool.query("insert into workspaces(id,name,slug) values($1::uuid,'Owned deletion-claim fixture',$1::text)",[workspace]);
 await adminPool.query("insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes,lease_expires_at) values($1,$2,$3,$4,4096,now()-interval '2 hours')",[id,workspace,key,randomUUID()]);
 await adminPool.query("insert into file_deletions(workspace_id,storage_key,attempts,available_at) values($1,$2,$3,now()-interval '1 second')",[workspace,key,initialAttempts]);
 const intent=async()=>(await adminPool.query('select * from intake_files where id=$1',[id])).rows[0];
 const deletion=async()=>(await adminPool.query('select * from file_deletions where workspace_id=$1 and storage_key=$2',[workspace,key])).rows[0];
 const intentBefore=await intent(),entered=deferred(),release=deferred(),secondSelected=deferred();
 let removals=0;
 const storage:PrivateStorage={
  kind:'supabase',
  async write(candidate,value){objects.set(candidate,Buffer.from(value));},
  async read(candidate){const value=objects.get(candidate);assert.ok(value);return Buffer.from(value);},
  async remove(candidate){
   assert.equal(candidate,key);removals++;
   if(removals===1){entered.resolve();await release.promise;}
   throw new Error('SYNTHETIC PRIVATE REMOVAL FAILURE');
  },
 };
 setStorageForTests(storage);
 const first=processOneFileDeletion(),claims=[first];
 const originalQuery=adminPool.query;
 try{
  await within(Promise.race([entered.promise,first.then(()=>{throw new Error('The first worker did not enter storage removal.');})]),'The first deletion claim did not reach its controlled removal.');
  // Observe the second candidate read while the first worker still holds the
  // actual deletion row lock. It must return that same still-pending candidate.
  adminPool.query=(function(...args:any[]){
   const result=(originalQuery as any).apply(adminPool,args);
   const sql=typeof args[0]==='string'?args[0]:args[0]?.text;
   if(typeof sql==='string'&&sql.startsWith('select workspace_id,storage_key from file_deletions')){
    return result.then((selected:any)=>{
     assert.equal(selected.rows[0]?.storage_key,key);
     secondSelected.resolve();return selected;
    });
   }
   return result;
  }) as typeof adminPool.query;
  const second=processOneFileDeletion();claims.push(second);
  await within(Promise.race([secondSelected.promise,second.then(()=>{throw new Error('The second worker did not read the locked candidate.');})]),'The second deletion candidate read did not finish.');
  release.resolve();
  assert.deepEqual(await Promise.all(claims),[true,true]);
  adminPool.query=originalQuery;
  const persisted=await deletion();
  assert.equal(removals,1,'The stale second claim must not bypass a newly persisted backoff or terminal failure.');
  assert.equal(persisted.attempts,initialAttempts+1);
  assert.equal(persisted.status,initialAttempts===9?'failed':'pending');
  assert.equal(persisted.last_error,'Private file removal failed. Check storage permissions and retry.');
  assert.equal((await adminPool.query('select available_at>clock_timestamp() future from file_deletions where id=$1',[persisted.id])).rows[0].future,true);
  assert.deepEqual(await intent(),intentBefore,'A failed removal retains the complete reserved-byte intent.');
  assert.deepEqual(objects.get(key),bytes);
  assert.equal(await processOneFileDeletion(),false);
  assert.deepEqual(await deletion(),persisted);assert.equal(removals,1);
  // Explicit/manual removal retains its existing immediate retry semantics.
  setStorageForTests({...storage,async remove(candidate){assert.equal(candidate,key);removals++;objects.delete(candidate);}});
  assert.equal(await deleteStoredFile(workspace,key),'complete');
  assert.equal(removals,2);assert.equal(await deletion(),undefined);assert.equal(await intent(),undefined);assert.equal(objects.has(key),false);
 }finally{
  release.resolve();adminPool.query=originalQuery;
  await Promise.allSettled(claims);setStorageForTests(undefined);
  await adminPool.query('delete from workspaces where id=$1',[workspace]);objects.delete(key);
 }
}

test('a concurrent stale deletion claim preserves the first failure backoff',{timeout:20_000},async()=>{
 await staleClaim(0);
});
test('a concurrent stale deletion claim preserves terminal failure until explicit retry',{timeout:20_000},async()=>{
 await staleClaim(9);
});
