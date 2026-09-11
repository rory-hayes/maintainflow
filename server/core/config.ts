import dotenv from 'dotenv';
dotenv.config({path:['.env.local','.env'],quiet:true});
import path from 'node:path';
import {PLANS} from '../../shared/plans.js';
const root=process.cwd();
export const config={root,storageDir:path.resolve(process.env.STORAGE_DIR||path.join(root,'.local/files')),origin:process.env.APP_ORIGIN||'http://127.0.0.1:5178',production:process.env.NODE_ENV==='production',port:Number(process.env.PORT||4318),maxBytes:10*1024*1024,maxPages:30,sessionDays:14};
export const databaseConfig={host:process.env.PGHOST||path.join(root,'.local/socket'),port:Number(process.env.PGPORT||55432),database:process.env.PGDATABASE||'folio',max:10};
const explorePlan=PLANS.find(plan=>plan.id==='explore')!;
// New workspaces receive the same free entitlements advertised by the shared plan catalogue.
export const defaultPlan={id:explorePlan.id,name:explorePlan.name,monthlyPages:explorePlan.monthlyPages,maxConcurrent:explorePlan.maxConcurrent,maxParsers:explorePlan.maxParsers,maxBytes:config.maxBytes,maxPages:config.maxPages};
