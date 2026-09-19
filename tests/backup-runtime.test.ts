import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {createHmac,randomBytes} from 'node:crypto';
import {assertStorageRestoreReady,restorePendingMessage} from '../server/core/restore-state.js';
import {readMigrations,buildMigrationSql} from '../scripts/migration-sql.js';
const exec=promisify(execFile),root=process.cwd(),loader=import.meta.resolve('tsx');
async function temp(fn:(directory:string)=>Promise<void>){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'folio-backup-runtime-'));try{await fs.chmod(dir,0o700);await fn(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
async function child(directory:string,source:string,env:Record<string,string>={}){return exec(process.execPath,['--import',loader,'--input-type=module','-e',source],{cwd:directory,env:{PATH:process.env.PATH,NODE_ENV:'test',...env},timeout:15000,maxBuffer:64*1024});}
const secretModule=pathToFileURL(path.join(root,'server/integrations/secrets.ts')).href;
const identifierSource=`const s=await import(${JSON.stringify(secretModule)});process.stdout.write(s.privateIdentifier('backup-fixture','synthetic'));`;

test('pending filesystem restores fail closed for files, directories, symlinks and unreadable path state',async()=>temp(async dir=>{
 const marker=path.join(dir,'.folio-restore-pending.json');await assertStorageRestoreReady(dir,'filesystem');
 for(const kind of ['file','directory','symlink']){
  if(kind==='file')await fs.writeFile(marker,'{}');else if(kind==='directory')await fs.mkdir(marker);else await fs.symlink(path.join(dir,'missing'),marker);
  await assert.rejects(assertStorageRestoreReady(dir,'filesystem'),(error:any)=>error.code==='FOLIO_RESTORE_PENDING'&&error.message===restorePendingMessage);
  await assertStorageRestoreReady(dir,'supabase');await fs.rm(marker,{recursive:true,force:true});
 }
 const regular=path.join(dir,'regular');await fs.writeFile(regular,'owned');await assert.rejects(assertStorageRestoreReady(regular,'filesystem'),(error:any)=>error.code==='FOLIO_RESTORE_STATE_UNREADABLE');
}));

test('fresh API and all actual worker entry points refuse pending restores before database or network activity',async()=>temp(async dir=>{
 await fs.writeFile(path.join(dir,'.folio-restore-pending.json'),'{}');
 const source=`
 import assert from 'node:assert/strict';import {createRequire,syncBuiltinESMExports} from 'node:module';
 const require=createRequire(${JSON.stringify(pathToFileURL(path.join(root,'package.json')).href)});let attempts=0;
 const blocked=()=>{attempts++;throw new Error('No transports allowed');};
 const pg=require('pg');pg.Pool.prototype.query=blocked;pg.Pool.prototype.connect=blocked;pg.Client.prototype.connect=blocked;
 require('node:net').Socket.prototype.connect=blocked;globalThis.fetch=async()=>blocked();syncBuiltinESMExports();
 const app=await import(${JSON.stringify(pathToFileURL(path.join(root,'server/app.ts')).href)});
 const core=await import(${JSON.stringify(pathToFileURL(path.join(root,'server/core/worker.ts')).href)});
 const hosted=await import(${JSON.stringify(pathToFileURL(path.join(root,'server/hosted-worker.ts')).href)});
 for(const work of [()=>app.buildApp(),()=>core.startWorker(),()=>core.processOneCoreJob(),()=>hosted.wakeHostedWorker()])await assert.rejects(work(),e=>e.code==='FOLIO_RESTORE_PENDING');
 assert.equal(attempts,0);process.stdout.write(JSON.stringify({guarded:4,transports:attempts}));`;
 const result=await child(dir,source,{STORAGE_DIR:dir,STORAGE_DRIVER:'filesystem'});assert.deepEqual(JSON.parse(result.stdout),{guarded:4,transports:0});
}));

test('key files reproduce the same encryption identity for raw and canonical base64 in fresh production processes',async()=>temp(async dir=>{
 const key=randomBytes(32),expected=createHmac('sha256',key).update('backup-fixture').update('\0').update('synthetic').digest('hex');
 for(const [name,bytes]of [['raw',key],['encoded',Buffer.from(key.toString('base64')+'\n')]] as const){const file=path.join(dir,name);await fs.writeFile(file,bytes,{mode:0o600});const result=await child(dir,identifierSource,{NODE_ENV:'production',INTEGRATION_ENCRYPTION_KEY_FILE:file});assert.equal(result.stdout,expected);}
 const configured=await child(dir,identifierSource,{NODE_ENV:'production',INTEGRATION_ENCRYPTION_KEY:key.toString('base64')});assert.equal(configured.stdout,expected);
}));

test('key files reject conflicts, links, permissive modes, directories, malformed encoding and oversized input',async()=>temp(async dir=>{
 const good=path.join(dir,'good');await fs.writeFile(good,randomBytes(32),{mode:0o600});
 await assert.rejects(child(dir,identifierSource,{NODE_ENV:'production',INTEGRATION_ENCRYPTION_KEY_FILE:good,INTEGRATION_ENCRYPTION_KEY:randomBytes(32).toString('base64')}),/Configure only one/);
 const paths=[path.join(dir,'link'),path.join(dir,'wide'),path.join(dir,'bad'),path.join(dir,'huge'),path.join(dir,'unpadded'),dir];
 await fs.symlink(good,paths[0]);await fs.writeFile(paths[1],randomBytes(32),{mode:0o644});await fs.chmod(paths[1],0o644);await fs.writeFile(paths[2],'invalid',{mode:0o600});await fs.writeFile(paths[3],Buffer.alloc(257),{mode:0o600});await fs.writeFile(paths[4],randomBytes(32).toString('base64').replace(/=+$/,''),{mode:0o600});
 for(const file of paths)await assert.rejects(child(dir,identifierSource,{NODE_ENV:'production',INTEGRATION_ENCRYPTION_KEY_FILE:file}),/owner-only regular file/);
}));

test('pure migration construction preserves default transaction output and supports one external atomic transaction',async()=>temp(async dir=>{
 const migrations=await readMigrations(path.join(root,'migrations')),options={schema:'owned_template',adminRole:'owned_admin',appRole:'owned_app'};
 const wrapped=buildMigrationSql(migrations,options),inner=buildMigrationSql(migrations,{...options,transaction:false});assert.equal(wrapped,`BEGIN;\n\n${inner.slice(0,-1)}\n\nCOMMIT;\n`);assert.ok(inner.includes('CREATE TABLE IF NOT EXISTS schema_migrations'));assert.ok(/FORCE ROW LEVEL SECURITY/i.test(inner));
 await fs.writeFile(path.join(dir,'.env'),'BACKUP_PURE_IMPORT_CANARY=should_not_be_loaded\n');const source=`await import(${JSON.stringify(pathToFileURL(path.join(root,'scripts/migration-sql.ts')).href)});if(process.env.BACKUP_PURE_IMPORT_CANARY)throw new Error('Unexpected dotenv side effect');process.stdout.write('pure');`;assert.equal((await child(dir,source)).stdout,'pure');
}));
