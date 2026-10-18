/** Fresh process for synthetic restored upload receipts; blocks every non-fixture transport. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import type {BackupConfig} from './types.js';

const [run]=process.argv.slice(2),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
assert.equal(path.dirname(run),path.join(root,'.local/managed-backup'));
assert.match(path.basename(run),/^[a-f0-9-]{36}$/);
assert.equal(process.cwd(),path.join(run,'empty-cwd'));assert.deepEqual(await fs.readdir(process.cwd()),[]);
const cfg:BackupConfig=JSON.parse(await fs.readFile(path.join(run,'staging_target.json'),'utf8'));
const fixture:Record<string,string>=JSON.parse(await fs.readFile(path.join(run,'staging-runtime.json'),'utf8'));
assert.equal(cfg.database.host,path.join(await fs.realpath(os.tmpdir()),'fmb-'+path.basename(run).slice(0,8)));
assert.equal(cfg.database.database,'staging_target');assert.equal(cfg.schema,'folio');assert.ok(cfg.database.port>=57000&&cfg.database.port<64000);
const require=createRequire(import.meta.url);require('dotenv').config=()=>({parsed:{}});
for(const key of Object.keys(process.env))if(/(?:API_KEY|TOKEN|SECRET|PASSWORD|^DATABASE_|^PG|^SUPABASE_|^RESEND_|^GOOGLE_|^STRIPE_|^OPENAI_|^VERCEL|^FOLIO_|^INTEGRATION_)/.test(key))delete process.env[key];
Object.assign(process.env,{NODE_ENV:'test',PGHOST:cfg.database.host,PGPORT:String(cfg.database.port),PGDATABASE:cfg.database.database,PGADMINUSER:cfg.adminRole,PGUSER:cfg.appRole,DATABASE_SCHEMA:cfg.schema,DATABASE_POOL_MAX:'2',STORAGE_DRIVER:'filesystem',STORAGE_DIR:cfg.storageDir,INTEGRATION_ENCRYPTION_KEY_FILE:cfg.integrationKeyFile,APP_ORIGIN:'http://127.0.0.1:4399',FOLIO_BILLING_MOCK:'true',FOLIO_PREVIEW_MODE:'false',FOLIO_REQUIRE_EMAIL_VERIFICATION:'false',LOG_LEVEL:'silent'});
let forbiddenNetwork=0;
const blocked=()=>{forbiddenNetwork++;throw new Error('Only the owned fixture socket is allowed');};
globalThis.fetch=async()=>blocked();
for(const name of ['node:http','node:https']){const mod=require(name);mod.request=blocked;mod.get=blocked;}
require('node:dgram').createSocket=blocked;require('node:dns').lookup=blocked;
const net=require('node:net'),connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args:any[]){const value=args[0],socket=typeof value==='string'?value:value?.path;if(socket!==cfg.database.host+'/.s.PGSQL.'+cfg.database.port)return blocked();return connect.apply(this,args);};
syncBuiltinESMExports();
const db=await import('../../server/core/db.js');
try{
 const {finalizeDirectUpload}=await import('../../server/core/upload-routes.js');
 const actor={workspaceId:fixture.workspaceId,userId:fixture.userId,role:'owner' as const,authType:'session' as const};
 for(const id of [fixture.completeId,fixture.cleanedId]){const result=await finalizeDirectUpload(actor,id);assert.equal(result.replayed,true);assert.equal(result.document.id,fixture.documentId);}
 await assert.rejects(finalizeDirectUpload(actor,fixture.failedId),(error:any)=>error.statusCode===410&&/Start a new upload/.test(error.message));
 // Missing unfinished staging cannot be recovered from a capability that points
 // at the old source bucket. It stays pending, releases its lease, and the user
 // must start a new upload. This is not evidence of a completed document loss.
 await assert.rejects(finalizeDirectUpload(actor,fixture.pendingId),(error:any)=>error.code==='ENOENT');
 const pending=await db.withWorkspace(actor.workspaceId,async client=>(await client.query('SELECT state,finalize_owner,finalize_lease_until FROM direct_uploads WHERE id=$1',[fixture.pendingId])).rows[0]);
 assert.deepEqual(pending,{state:'pending',finalize_owner:null,finalize_lease_until:null});
 assert.equal(forbiddenNetwork,0);
 console.log(JSON.stringify({completedReceiptsReplayed:2,failedUploadRequestsRestart:true,unfinishedUploadRequiresNewUpload:true,unfinishedLeaseReleased:true,forbiddenNetworkCalls:forbiddenNetwork}));
}finally{await db.closeDatabase();}
