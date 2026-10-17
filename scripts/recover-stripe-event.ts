/** Operator-only, exact-event recovery. No Stripe request or public endpoint. */
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const help=`Inspect one exhausted Stripe event before recovery.

Required: --event stripe:evt_ID --workspace UUID --customer cus_ID
          --mode test|live --database NAME --schema NAME
Default: read-only inspection. Review the returned snapshotDigest.
Recovery: add --execute --expected DIGEST --operator NAME --reason REASON

DATABASE_ADMIN_URL, DATABASE_SCHEMA and STRIPE_MODE must be explicitly set
in the process environment and match the selected target. Never pass secrets
as command arguments. Recovery only queues the existing event; the normal
worker must subsequently verify current Stripe state.
`;

export function parseRecoveryCommand(argv:string[],environment:NodeJS.ProcessEnv){
 const {values,tokens}=parseArgs({args:argv,allowPositionals:false,strict:true,tokens:true,options:{
  help:{type:'boolean'},event:{type:'string'},workspace:{type:'string'},customer:{type:'string'},
  mode:{type:'string'},database:{type:'string'},schema:{type:'string'},execute:{type:'boolean'},
  expected:{type:'string'},operator:{type:'string'},reason:{type:'string'},
 }});
 const flags=tokens.filter(token=>token.kind==='option').map(token=>token.name);
 if(new Set(flags).size!==flags.length)throw new Error('Repeated selectors are not allowed.');
 if(values.help){if(argv.length!==1)throw new Error('Help cannot be combined with an operation.');return {help:true as const};}
 const required=(key:'event'|'workspace'|'customer'|'mode'|'database'|'schema')=>{
  const value=values[key];if(!value||value.trim()!==value)throw new Error('Missing or invalid required selector.');return value;
 };
 const eventId=required('event'),workspaceId=required('workspace'),customerId=required('customer'),mode=required('mode'),database=required('database'),schema=required('schema');
 if(!/^stripe:evt_[A-Za-z0-9_-]{1,200}$/.test(eventId)||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(workspaceId)||!/^cus_[A-Za-z0-9_-]{1,200}$/.test(customerId)||!['test','live'].includes(mode))throw new Error('Invalid billing selector.');
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(database)||!/^[a-z][a-z0-9_]{0,62}$/.test(schema))throw new Error('Invalid database target.');
 if(!environment.DATABASE_ADMIN_URL||environment.DATABASE_SCHEMA!==schema||environment.STRIPE_MODE!==mode)throw new Error('Explicit environment does not match the selected target.');
 const url=new URL(environment.DATABASE_ADMIN_URL);
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.pathname.slice(1))!==database)throw new Error('Database URL does not match the selected database.');
 const execute=values.execute===true;
 if(execute){
  if(!values.expected||!/^[a-f0-9]{64}$/.test(values.expected)||!values.operator?.trim()||!values.reason?.trim())throw new Error('Recovery requires a reviewed digest, operator and reason.');
 }else if(values.expected!==undefined||values.operator!==undefined||values.reason!==undefined)throw new Error('Recovery options require --execute.');
 return {help:false as const,execute,database,schema,input:{eventId,workspaceId,customerId,mode:mode as 'test'|'live'},expectedDigest:values.expected,operator:values.operator,reason:values.reason};
}

export async function runRecoveryCommand(argv=process.argv.slice(2),environment=process.env){
 // Parse before importing database/config modules, which may load local env files.
 const command=parseRecoveryCommand(argv,environment);
 if(command.help)return help;
 const {adminPool,closeDatabase}=await import('../server/core/db.js');
 try{
  const {rows:[identity]}=await adminPool.query('select current_database() database,current_schema() schema');
  if(identity.database!==command.database||identity.schema!==command.schema)throw new Error('Connected database does not match the reviewed target.');
  const {inspectStripeEventRecovery,recoverStripeEvent}=await import('../server/integrations/stripe-event-recovery.js');
  const result=command.execute
   ?await recoverStripeEvent({...command.input,expectedDigest:command.expectedDigest!,operator:command.operator!,reason:command.reason!})
   :await inspectStripeEventRecovery(command.input);
  return JSON.stringify({database:command.database,schema:command.schema,operation:command.execute?'requeue':'inspect',...result},null,2)+'\n';
 }finally{await closeDatabase();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(await runRecoveryCommand());}
 catch{
  // Never print driver errors, connection URLs, payloads or user-supplied values.
  process.stderr.write('Stripe event recovery refused. Check the exact target, environment and reviewed inspection; no success is implied.\n');
  process.exitCode=1;
 }
}
