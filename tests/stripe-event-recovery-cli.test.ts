import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseRecoveryCommand} from '../scripts/recover-stripe-event.js';

const args=['--event','stripe:evt_SYNTHETIC','--workspace','00000000-0000-4000-8000-000000000001','--customer','cus_SYNTHETIC','--mode','test','--database','folio','--schema','public'];
const env={DATABASE_ADMIN_URL:'postgresql://synthetic:never-a-real-password@127.0.0.1:1/folio',DATABASE_SCHEMA:'public',STRIPE_MODE:'test'};
test('operator inspection requires an explicit matching database and mode before opening a connection',()=>{
 const command=parseRecoveryCommand(args,env);assert.equal(command.help,false);if(command.help)return;
 assert.equal(command.execute,false);
 for(const patch of [{DATABASE_ADMIN_URL:undefined},{DATABASE_SCHEMA:undefined},{DATABASE_SCHEMA:'folio'},{STRIPE_MODE:'live'},{DATABASE_ADMIN_URL:'postgresql://synthetic@127.0.0.1/wrong'}])assert.throws(()=>parseRecoveryCommand(args,{...env,...patch}));
 assert.throws(()=>parseRecoveryCommand([...args,'--execute'],env));
 assert.throws(()=>parseRecoveryCommand([...args,'--expected','a'.repeat(64)],env));
 assert.throws(()=>parseRecoveryCommand([...args,'--unknown','unsafe'],env));
 assert.throws(()=>parseRecoveryCommand([...args,'--event','stripe:evt_ANOTHER'],env));
 const recovery=parseRecoveryCommand([...args,'--execute','--expected','a'.repeat(64),'--operator','Synthetic operator','--reason','Synthetic corrected configuration'],env);
 assert.equal(recovery.help,false);if(!recovery.help)assert.equal(recovery.execute,true);
});
test('CLI help needs no database and failures never print secrets or raw arguments',()=>{
 const script=fileURLToPath(new URL('../scripts/recover-stripe-event.ts',import.meta.url));
 const run=(argv:string[])=>spawnSync(process.execPath,['--import','tsx',script,...argv],{encoding:'utf8',timeout:15_000,env:{PATH:process.env.PATH,NODE_ENV:'test'}});
 const help=run(['--help']);assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/Default: read-only/);
 const failure=run([...args,'--unknown','SYNTHETIC_SECRET_MUST_NOT_BE_PRINTED']);assert.equal(failure.status,1);assert.equal(failure.stdout,'');assert.match(failure.stderr,/recovery refused/);assert.doesNotMatch(failure.stderr,/SYNTHETIC_SECRET|postgresql|Error:/);
});
