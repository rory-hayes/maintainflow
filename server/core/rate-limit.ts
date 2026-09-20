import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {FastifyRequest} from 'fastify';
import type {RateLimitPluginOptions,FastifyRateLimitOptions,FastifyRateLimitStore,FastifyRateLimitStoreCtor} from '@fastify/rate-limit';
import ipaddr from 'ipaddr.js';
import {adminPool} from './db.js';
import {privateIdentifier} from '../integrations/secrets.js';

type Database=Pick<Pool,'query'>;
type StoreOptions=FastifyRateLimitOptions&{timeWindow?:number;max?:number;groupId?:string};
type StoreDependencies={database?:Database;namespace?:string;cleanupIntervalMs?:number};
type Counter={current:number;ttl:number};
type Callback=(error:Error|null,result?:Counter)=>void;

const incrementSql=`WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS at),
 counted AS (
  INSERT INTO request_rate_limits(bucket_key,hits,expires_at)
  SELECT $1,1,at+($2::integer*interval '1 millisecond') FROM instant
  ON CONFLICT(bucket_key) DO UPDATE SET
   hits=CASE WHEN request_rate_limits.expires_at<=(SELECT at FROM instant) THEN 1
    ELSE least(request_rate_limits.hits+1,$3::integer+1) END,
   expires_at=CASE WHEN request_rate_limits.expires_at<=(SELECT at FROM instant)
    THEN (SELECT at FROM instant)+($2::integer*interval '1 millisecond') ELSE request_rate_limits.expires_at END
  RETURNING hits,expires_at
 ) SELECT hits AS current,greatest(1,ceil(extract(epoch FROM (expires_at-clock_timestamp()))*1000))::integer AS ttl FROM counted`;
const cleanupSql=`DELETE FROM request_rate_limits WHERE bucket_key IN (
 SELECT bucket_key FROM request_rate_limits WHERE expires_at<=statement_timestamp()
 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
)`;

function positiveInteger(value:unknown,name:string,maximum:number){
 if(!Number.isInteger(value)||Number(value)<1||Number(value)>maximum)throw new Error(`Invalid request rate limit ${name}.`);
 return Number(value);
}
function unavailable(){return Object.assign(new Error('Request protection is temporarily unavailable. Try again shortly.'),{statusCode:503,code:'REQUEST_RATE_LIMIT_UNAVAILABLE'});}

/** Normalize aliases and group IPv6 privacy addresses by /64 before HMAC. */
export function requestRateLimitKey(request:Pick<FastifyRequest,'ip'>){
 let normalized:string;
 try{
  const address=ipaddr.process(request.ip);
  if(address.kind()==='ipv6'){
   const bytes=address.toByteArray();bytes.fill(0,8);
   normalized=`${ipaddr.fromByteArray(bytes).toNormalizedString()}/64`;
  }else normalized=address.toNormalizedString();
 }
 catch{throw unavailable();}
 return privateIdentifier('folio:request-rate-limit:ip:v1',normalized);
}

/** A store constructor is shared by plugin children; every instance uses PostgreSQL. */
export function createPostgresRateLimitStore(dependencies:StoreDependencies={}):FastifyRateLimitStoreCtor{
 const database=dependencies.database??adminPool;
 const namespace=dependencies.namespace??process.env.FOLIO_RATE_LIMIT_NAMESPACE??'api:v1';
 if(!/^[a-zA-Z0-9:_-]{1,160}$/.test(namespace))throw new Error('Invalid request rate limit namespace.');
 const cleanupIntervalMs=positiveInteger(dependencies.cleanupIntervalMs??60_000,'cleanup interval',3_600_000);
 let nextCleanupAt=0,incrementsSinceCleanup=0;
 class PostgresRateLimitStore implements FastifyRateLimitStore{
  private readonly options:StoreOptions;
  constructor(options:FastifyRateLimitOptions){this.options={...options};}
  // The plugin supplies numeric window/max as runtime arguments; its types omit them.
  incr(key:string,callback:Callback,timeWindow=this.options.timeWindow,max=this.options.max):void{
   void this.increment(key,timeWindow,max).then(value=>callback(null,value),()=>callback(unavailable()));
  }
  private async increment(key:string,timeWindow:unknown,max:unknown):Promise<Counter>{
   const windowMs=positiveInteger(timeWindow,'window',86_400_000),maximum=positiveInteger(max,'maximum',1_000_000);
   // The plugin may append a trusted groupId to the already HMAC-protected IP.
   if(typeof key!=='string'||!/^[a-f0-9]{64}[a-zA-Z0-9:_-]{0,160}$/.test(key))throw unavailable();
   const bucket=createHash('sha256').update(JSON.stringify([namespace,this.options.groupId??'global',windowMs,maximum,key])).digest('hex');
   const {rows:[row]}=await database.query(incrementSql,[bucket,windowMs,maximum]);
   if(!row||!Number.isInteger(row.current)||!Number.isInteger(row.ttl)||row.current<1||row.ttl<1)throw unavailable();
   // Cadence is local; deletion eligibility and enforcement always use the DB clock.
   // Every cleanup deletes at most 100 expired rows and skips locked counters.
   incrementsSinceCleanup++;
   if(incrementsSinceCleanup>=50||Date.now()>=nextCleanupAt){
    nextCleanupAt=Date.now()+cleanupIntervalMs;incrementsSinceCleanup=0;
    try{await database.query(cleanupSql);}catch(error){nextCleanupAt=0;throw error;}
   }
   return {current:row.current,ttl:row.ttl};
  }
  child(options:Parameters<FastifyRateLimitStore['child']>[0]):FastifyRateLimitStore{
   return new PostgresRateLimitStore({...this.options,...options} as StoreOptions);
  }
 }
 return PostgresRateLimitStore;
}

/** Login, registration and password changes share one strict per-IP budget. */
export const authenticationRateLimit={max:30,timeWindow:15*60_000,groupId:'authentication'} as const;

export function requestRateLimitOptions(options:StoreDependencies&{max?:number;timeWindow?:number}={}):RateLimitPluginOptions{
 return {
  global:true,hook:'onRequest',max:options.max??300,timeWindow:options.timeWindow??60_000,
  skipOnError:false,continueExceeding:false,exponentialBackoff:false,ban:-1,
  keyGenerator:requestRateLimitKey,store:createPostgresRateLimitStore(options),
  errorResponseBuilder:(_request,context)=>Object.assign(new Error('Too many requests. Wait for the Retry-After interval, then try again.'),{statusCode:context.statusCode}),
 };
}
