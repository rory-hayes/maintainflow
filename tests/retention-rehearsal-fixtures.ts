import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {adminPool,appPool,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';

const runFile=promisify(execFile);
type OwnedDockerProof={kind:'owned-docker-postgres';containerId:string;containerName:string;nonce:string;lane:'09';port:5349;clusterId:string;storageRoot:string};

async function assertOwnedDockerNamespace():Promise<OwnedDockerProof>{
 const proofPath=process.env.FOLIO_RETENTION_REHEARSAL_PROOF;
 assert.ok(proofPath&&path.isAbsolute(proofPath),'Local rehearsals require an absolute FOLIO_RETENTION_REHEARSAL_PROOF JSON path.');
 const file=await fs.stat(proofPath);
 assert.ok(file.isFile()&&file.size>0&&file.size<=16_384,'Invalid rehearsal proof file.');
 const proof=JSON.parse(await fs.readFile(proofPath,'utf8')) as OwnedDockerProof;
 assert.ok(proof&&typeof proof==='object'&&!Array.isArray(proof),'Invalid rehearsal proof.');
 assert.equal(proof.kind,'owned-docker-postgres');assert.equal(proof.lane,'09');assert.equal(proof.port,5349);
 assert.ok(typeof proof.containerId==='string'&&/^[a-f0-9]{64}$/.test(proof.containerId),'Invalid owned rehearsal container ID.');
 assert.ok(typeof proof.containerName==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(proof.containerName),'Invalid owned rehearsal container name.');
 assert.ok(typeof proof.nonce==='string'&&/^[A-Za-z0-9_-]{16,128}$/.test(proof.nonce),'Invalid owned rehearsal nonce.');
 assert.ok(typeof proof.clusterId==='string'&&/^[1-9][0-9]{0,19}$/.test(proof.clusterId)&&BigInt(proof.clusterId)<=18_446_744_073_709_551_615n,'Invalid rehearsal database cluster identity.');
 assert.ok(typeof proof.storageRoot==='string'&&path.isAbsolute(proof.storageRoot),'Invalid rehearsal storage root.');
 const storageRoot=path.resolve(proof.storageRoot);
 assert.ok(storageRoot.startsWith('/private/tmp/'),'Local rehearsal storage must be a private temporary directory.');
 assert.equal(config.storageDir,storageRoot,'Configured storage must match the owned rehearsal proof.');
 assert.ok((await fs.stat(storageRoot)).isDirectory(),'The owned rehearsal storage directory must exist.');
 assert.equal(await fs.realpath(storageRoot),storageRoot,'Rehearsal storage must not resolve through symbolic links.');
 // Inspect only the fields used for fencing. Never return container environment
 // variables, where a disposable database password may be configured.
 const format='{"id":{{json .Id}},"name":{{json .Name}},"running":{{json .State.Running}},"lane":{{json (index .Config.Labels "maintainflow.lane")}},"rehearsal":{{json (index .Config.Labels "maintainflow.rehearsal")}},"portBindings":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"binds":{{json .HostConfig.Binds}}}';
 let inspected:any;
 try{
  const {stdout}=await runFile('docker',['inspect','--format',format,proof.containerId],{encoding:'utf8',timeout:10_000,maxBuffer:32_768});
  inspected=JSON.parse(stdout);
 }catch{throw new Error('The owned rehearsal Docker namespace could not be verified.');}
 assert.equal(inspected.id,proof.containerId);assert.equal(inspected.name,`/${proof.containerName}`);assert.equal(inspected.running,true);
 assert.equal(inspected.lane,'09');assert.equal(inspected.rehearsal,proof.nonce);
 assert.deepEqual(inspected.portBindings?.['5432/tcp'],[{HostIp:'127.0.0.1',HostPort:String(proof.port)}],'The owned PostgreSQL container must bind only its assigned loopback endpoint.');
 assert.ok(inspected.binds===null||Array.isArray(inspected.binds)&&inspected.binds.length===0,'Rehearsal containers cannot have host binds.');
 assert.ok(Array.isArray(inspected.mounts)&&!inspected.mounts.some((mount:any)=>mount.Type==='bind'),'Rehearsal containers cannot mount host directories.');
 const dataMounts=inspected.mounts.filter((mount:any)=>mount.Destination==='/var/lib/postgresql/data');
 assert.equal(dataMounts.length,1);assert.equal(dataMounts[0].Type,'tmpfs','PostgreSQL rehearsal data must use disposable tmpfs.');
 return proof;
}

/** Every local claim must be fenced to the runner's owned Docker cluster and
 * storage namespace. Only the known ephemeral GitHub service bypasses proof. */
export async function assertRetentionRehearsalDatabase(){
 assert.equal(process.env.NODE_ENV,'test','Retention rehearsals require NODE_ENV=test.');
 assert.equal(databaseSchema,'public','Retention rehearsals require an isolated public schema.');
 const githubCI=process.env.GITHUB_ACTIONS==='true'&&process.env.CI==='true';
 let endpoint:string|undefined;
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  assert.ok(pool.options.connectionString,'Both rehearsal roles need explicit local database URLs; host/Unix-socket fallback is forbidden.');
  const url=new URL(pool.options.connectionString);
  assert.ok(['postgres:','postgresql:'].includes(url.protocol),'Unsupported rehearsal database protocol.');
  assert.ok((githubCI?['127.0.0.1','localhost','[::1]']:['127.0.0.1']).includes(url.hostname),'Retention rehearsals refuse unassigned database endpoints.');
  assert.equal(url.pathname,'/folio');assert.equal(decodeURIComponent(url.username),role);
  assert.ok(!url.search&&!url.hash,'Rehearsal database URLs cannot override their local endpoint through options.');
  const port=Number(url.port||'5432');assert.equal(port,githubCI?5432:5349,'Rehearsal database port must match its owned namespace.');
  const currentEndpoint=`${url.hostname}:${port}`;
  if(endpoint)assert.equal(currentEndpoint,endpoint,'Both rehearsal roles must target the same local database.');
  endpoint=currentEndpoint;
 }
 // No database connection is opened until both URL endpoints and, outside the
 // owned GitHub service, the actual container/storage namespace are checked.
 if(!githubCI){
  const proof=await assertOwnedDockerNamespace();
  const cluster=(await adminPool.query('select system_identifier::text cluster_id from pg_catalog.pg_control_system()')).rows[0];
  assert.equal(cluster?.cluster_id,proof.clusterId,'The configured database is not the owned rehearsal cluster.');
 }
 for(const [pool,role] of [[adminPool,'folio_admin'],[appPool,'folio_app']] as const){
  const identity=(await pool.query("select current_database() db,current_schema() schema,current_user role,inet_server_addr()::text address,current_setting('port')::int port")).rows[0];
  assert.equal(identity.db,'folio');assert.equal(identity.schema,'public');assert.equal(identity.role,role);
  assert.notEqual(identity.address,null,'Retention rehearsals require the verified TCP service.');assert.equal(identity.port,5432);
 }
}
