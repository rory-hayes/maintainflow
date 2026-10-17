import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import {generateHybridIdentity, identityToRecipient} from 'age-encryption';
import {runBackup} from '../scripts/backup.js';
import {sealArchive} from '../scripts/backup/archive.js';
import {configDigest, pendingName, readConfig, receiptName, sha256} from '../scripts/backup/files.js';
import type {BackupConfig, BackupManifest} from '../scripts/backup/types.js';

const objectKey='00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002';
async function fixture(t:TestContext){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'folio-backup-cli-'));await fs.chmod(root,0o700);
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const payload=path.join(root,'payload'),storage=path.join(root,'target'),input=path.join(root,'backup.age'),identityFile=path.join(root,'identity'),configFile=path.join(root,'config.json'),key=Buffer.alloc(32,0x42),original=Buffer.from('Owned synthetic original');
 const files=new Map([['integration-key.bin',key],['tables/users.bin',Buffer.from('opaque COPY fixture')],['objects/'+objectKey,original]]);
 for(const [name,bytes] of files){await fs.mkdir(path.dirname(path.join(payload,name)),{recursive:true,mode:0o700});await fs.writeFile(path.join(payload,name),bytes,{mode:0o600});}
 await fs.mkdir(path.join(storage,objectKey.split('/')[0]),{recursive:true,mode:0o700});await fs.writeFile(path.join(storage,objectKey),original,{mode:0o600});
 const config:BackupConfig={version:1,database:{host:'127.0.0.1',port:1,database:'owned_restore',user:'owned_backup'},schema:'folio',adminRole:'owned_admin',appRole:'owned_app',storageDir:storage,integrationKeyFile:path.join(root,'target-key')};
 await fs.writeFile(config.integrationKeyFile,key,{mode:0o600});await fs.writeFile(configFile,JSON.stringify(config),{mode:0o600});
 const identity=await generateHybridIdentity(),recipient=await identityToRecipient(identity);await fs.writeFile(identityFile,identity,{mode:0o600});
 const manifest:BackupManifest={format:'folio-backup',version:1,id:'00000000-0000-4000-8000-000000000010',createdAt:'2026-10-17T00:00:00.000Z',capture:'quiesced-filesystem',database:{schema:'folio',postgresMajor:17,encoding:'UTF8',sourceIdentity:sha256('source'),securitySha256:sha256('security'),tables:[{name:'users',columns:[{name:'id',type:'uuid',generated:'',identity:''}],primaryKey:['id'],rows:1}],sequences:[],migrations:[{name:'001_core.sql',sha256:sha256('migration')}]},files:[...files].map(([name,bytes])=>({name,bytes:bytes.length,sha256:sha256(bytes)})),objects:[{key:objectKey,required:true,byteSize:original.length,present:true,bytes:original.length,sha256:sha256(original)}],integrationKeySha256:sha256(key),omittedObjects:[]};
 await sealArchive(payload,manifest,recipient,input);
 const markerFile=path.join(storage,pendingName),receiptFile=path.join(storage,receiptName),marker={format:'folio-restore',version:1,backupId:manifest.id,configSha256:configDigest(await readConfig(configFile)),ciphertextSha256:sha256(await fs.readFile(input))};
 const markerBytes=JSON.stringify(marker);await fs.writeFile(markerFile,markerBytes,{mode:0o600});
 let databaseAttempts=0,networkAttempts=0;
 t.mock.method(pg.Client.prototype,'connect',()=>{databaseAttempts++;throw new Error('Database must not be contacted by rejected verification');});
 t.mock.method(globalThis,'fetch',async()=>{networkAttempts++;throw new Error('No provider transport permitted');});
 const verify=(extra:string[]=[])=>runBackup(['verify','--config',configFile,'--input',input,'--identity-file',identityFile,...extra]);
 const rejected=async(code:string)=>{const before=await fs.readFile(input);await assert.rejects(verify(),(error:any)=>error.code===code);assert.deepEqual(await fs.readFile(input),before);assert.equal(databaseAttempts,0);assert.equal(networkAttempts,0);};
 return {root,payload,storage,input,identityFile,configFile,config,key,original,manifest,recipient,markerFile,receiptFile,markerBytes,verify,rejected};
}

test('inactive verification requires its bound private pending marker and cannot accept outbound consent',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.verify(['--allow-outbound']),(error:any)=>error.code==='BACKUP_ARGUMENTS');
 for(const bytes of ['not JSON',JSON.stringify({format:'folio-restore'}),JSON.stringify({...JSON.parse(f.markerBytes),ciphertextSha256:sha256('wrong')})]){await fs.writeFile(f.markerFile,bytes);await f.rejected('BACKUP_ACTIVATION');assert.equal(await fs.readFile(f.markerFile,'utf8'),bytes);}
 await fs.unlink(f.markerFile);await f.rejected('BACKUP_ACTIVATION');
 const sentinel=path.join(f.root,'sentinel');await fs.writeFile(sentinel,f.markerBytes,{mode:0o600});await fs.symlink(sentinel,f.markerFile);await f.rejected('BACKUP_ACTIVATION');assert.equal(await fs.readFile(sentinel,'utf8'),f.markerBytes);
 assert.equal(await fs.stat(f.receiptFile).then(()=>true,()=>false),false);
 assert.deepEqual(await fs.readFile(f.config.integrationKeyFile),f.key);assert.deepEqual(await fs.readFile(path.join(f.storage,objectKey)),f.original);
});

test('inactive verification refuses changed config, different authenticated ciphertext and interrupted activation',async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.configFile,JSON.stringify({...f.config,database:{...f.config.database,database:'other_restore'}}));await f.rejected('BACKUP_ACTIVATION');await fs.writeFile(f.configFile,JSON.stringify(f.config));
 const originalCiphertext=await fs.readFile(f.input);await fs.unlink(f.input);await sealArchive(f.payload,f.manifest,f.recipient,f.input);assert.notDeepEqual(await fs.readFile(f.input),originalCiphertext);await f.rejected('BACKUP_ACTIVATION');await fs.writeFile(f.input,originalCiphertext);
 await fs.writeFile(f.receiptFile,'existing interrupted activation',{mode:0o600});await f.rejected('BACKUP_ACTIVATION');assert.equal(await fs.readFile(f.receiptFile,'utf8'),'existing interrupted activation');
 assert.equal(await fs.readFile(f.markerFile,'utf8'),f.markerBytes);
});

test('inactive verification rejects altered recovered keys and original bytes before any database connection',async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.config.integrationKeyFile,Buffer.alloc(32,0x43));await f.rejected('BACKUP_KEY');await fs.writeFile(f.config.integrationKeyFile,f.key);
 const changed=Buffer.from(f.original);changed[0]^=1;await fs.writeFile(path.join(f.storage,objectKey),changed);await f.rejected('BACKUP_STORAGE');assert.deepEqual(await fs.readFile(path.join(f.storage,objectKey)),changed);
 assert.equal(await fs.readFile(f.markerFile,'utf8'),f.markerBytes);assert.equal(await fs.stat(f.receiptFile).then(()=>true,()=>false),false);
});
