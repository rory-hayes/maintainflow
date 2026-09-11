import pg,{type PoolClient,type PoolConfig} from 'pg';
import {databaseConfig} from './config.js';

export function databaseIdentifier(value:string,kind='schema'){
 if(!/^[a-z][a-z0-9_]{0,62}$/.test(value)||value.startsWith('pg_')||['information_schema','auth','storage','extensions','realtime','graphql','graphql_public','supabase_functions'].includes(value))throw new Error(`Invalid application database ${kind}.`);
 return value;
}
export const databaseSchema=databaseIdentifier(process.env.DATABASE_SCHEMA??'public');
export const quoteIdentifier=(value:string)=>`"${databaseIdentifier(value)}"`;

/** Preserve certificate verification even when a connection URL contains sslmode. */
export function secureDatabaseConfig(input:PoolConfig,ca=process.env.DATABASE_CA_CERT):PoolConfig{
 const result={...input};
 const url=input.connectionString?new URL(input.connectionString):undefined;
 const host=url?.hostname??input.host??'';
 const remote=Boolean(host&&!host.startsWith('/')&&!['localhost','127.0.0.1','::1','[::1]'].includes(host));
 if(ca||remote){
  if(url){for(const key of ['sslmode','sslrootcert','sslcert','sslkey'])url.searchParams.delete(key);result.connectionString=url.toString();}
  result.ssl={rejectUnauthorized:true,...(ca?{ca:ca.replaceAll('\\n','\n')}:{})};
 }
 return result;
}

/**
 * Transaction pooling cannot retain session SET state. Every standalone query
 * gets a short transaction; explicit transactions set the path after BEGIN.
 * Checked-out clients are wrapped too. No unawaited connection hook is used.
 */
export function scopeDatabasePool(raw:pg.Pool,schema:string):pg.Pool{
 databaseIdentifier(schema);
 if(schema==='public')return raw; // Preserve the existing dedicated local database.
 const searchPath=`${quoteIdentifier(schema)},pg_catalog,pg_temp`;
 function wrapClient(client:PoolClient):PoolClient{
  const rawQuery=client.query.bind(client) as (...args:any[])=>Promise<any>;
  let open=false,released=false,queue:Promise<unknown>=Promise.resolve();
  const setPath=()=>rawQuery("select set_config('search_path',$1,true),set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)",[searchPath]);
  async function run(args:any[]){
   if(released)throw new Error('Database client has already been released.');
   const query=args[0],sql=typeof query==='string'?query:query?.text;
   if(typeof sql!=='string'||(typeof query==='object'&&query.name))throw new Error('Scoped database queries must use unnamed SQL statements.');
   const control=sql.trim().replace(/;\s*$/,'').toUpperCase();
   if(/^(BEGIN|START TRANSACTION)(\s|$)/.test(control)){
    if(open)throw new Error('Nested database transactions are not supported. Use a savepoint.');
    const result=await rawQuery(...args);open=true;
    try{await setPath();return result;}catch(error){await rawQuery('ROLLBACK');open=false;throw error;}
   }
   if(/^(COMMIT|END|ROLLBACK|ABORT)(\s|$)/.test(control)&&!/^ROLLBACK\s+TO\b/.test(control)){
    const result=await rawQuery(...args);open=false;return result;
   }
   if(open)return rawQuery(...args);
   await rawQuery('BEGIN');open=true;
   try{await setPath();const result=await rawQuery(...args);await rawQuery('COMMIT');open=false;return result;}
   catch(error){await rawQuery('ROLLBACK');open=false;throw error;}
  }
  return new Proxy(client,{get(target,key){
   if(key==='query')return (...args:any[])=>{
    const callback=typeof args.at(-1)==='function'?args.pop():undefined;
    const pending=queue.then(()=>run(args));queue=pending.catch(()=>{});
    if(callback){void pending.then(result=>callback(null,result),error=>callback(error));return;}
    return pending;
   };
   if(key==='release')return (error?:Error|boolean)=>{released=true;target.release(error||open);};
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
 }
 const connect=()=>raw.connect().then(wrapClient);
 return new Proxy(raw,{get(target,key){
  if(key==='connect')return (callback?:any)=>{const pending=connect();if(callback){void pending.then(client=>callback(null,client,client.release),error=>callback(error));return;}return pending;};
  if(key==='query')return (...args:any[])=>{
   const callback=typeof args.at(-1)==='function'?args.pop():undefined;
   const pending=(async()=>{const client=await connect();try{return await (client.query as any)(...args);}finally{client.release();}})();
   if(callback){void pending.then(result=>callback(null,result),error=>callback(error));return;}
   return pending;
  };
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
}
export function createDatabasePool(input:PoolConfig,schema=databaseSchema){return scopeDatabasePool(new pg.Pool(secureDatabaseConfig(input)),schema);}
const max=Number(process.env.DATABASE_POOL_MAX??(databaseSchema==='public'?10:1));
if(!Number.isInteger(max)||max<1||max>20)throw new Error('DATABASE_POOL_MAX must be an integer from 1 to 20.');
const poolOptions={max,...(databaseSchema==='public'?{}:{connectionTimeoutMillis:10_000,idleTimeoutMillis:20_000})};
export const adminPool=createDatabasePool(process.env.DATABASE_ADMIN_URL?{connectionString:process.env.DATABASE_ADMIN_URL,...poolOptions}:{...databaseConfig,user:process.env.PGADMINUSER||'folio_admin',...poolOptions});
export const appPool=createDatabasePool(process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL,...poolOptions}:{...databaseConfig,user:process.env.PGUSER||'folio_app',...poolOptions});
export async function transaction<T>(pool:pg.Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function withWorkspace<T>(workspaceId:string,fn:(client:PoolClient)=>Promise<T>):Promise<T>{return transaction(appPool,async c=>{await c.query("select set_config('app.workspace_id',$1,true)",[workspaceId]);return fn(c);});}
export function notFound(message='Not found'):never{throw Object.assign(new Error(message),{statusCode:404});}
export function badRequest(message:string,statusCode=400):never{throw Object.assign(new Error(message),{statusCode});}
export async function audit(c:PoolClient,workspaceId:string,userId:string|null,action:string,entityId:string|null,metadata:unknown={}){await c.query('insert into audit_events(workspace_id,user_id,action,entity_id,metadata) values($1,$2,$3,$4,$5)',[workspaceId,userId,action,entityId,JSON.stringify(metadata)]);}
export const camel=(row:any):any=>row&&Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
export async function closeDatabase(){await Promise.all([appPool.end(),adminPool.end()]);}
