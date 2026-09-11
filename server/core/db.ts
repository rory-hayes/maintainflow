import pg,{type PoolClient} from 'pg';
import {databaseConfig} from './config.js';
export const adminPool=new pg.Pool(process.env.DATABASE_ADMIN_URL?{connectionString:process.env.DATABASE_ADMIN_URL,max:10}:{...databaseConfig,user:process.env.PGADMINUSER||'folio_admin'});
export const appPool=new pg.Pool(process.env.DATABASE_URL?{connectionString:process.env.DATABASE_URL,max:10}:{...databaseConfig,user:process.env.PGUSER||'folio_app'});
export async function transaction<T>(pool:pg.Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function withWorkspace<T>(workspaceId:string,fn:(client:PoolClient)=>Promise<T>):Promise<T>{return transaction(appPool,async c=>{await c.query("select set_config('app.workspace_id',$1,true)",[workspaceId]);return fn(c);});}
export function notFound(message='Not found'):never{throw Object.assign(new Error(message),{statusCode:404});}
export function badRequest(message:string,statusCode=400):never{throw Object.assign(new Error(message),{statusCode});}
export async function audit(c:PoolClient,workspaceId:string,userId:string|null,action:string,entityId:string|null,metadata:unknown={}){await c.query('insert into audit_events(workspace_id,user_id,action,entity_id,metadata) values($1,$2,$3,$4,$5)',[workspaceId,userId,action,entityId,JSON.stringify(metadata)]);}
export const camel=(row:any):any=>row&&Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
export async function closeDatabase(){await Promise.all([appPool.end(),adminPool.end()]);}
