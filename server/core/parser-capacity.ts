import type {PoolClient} from 'pg';
import {badRequest} from './db.js';
/** Caller holds the workspace advisory lock shared by create, restore and copy. */
export async function requireParserCapacity(c:PoolClient,workspaceId:string){
 const {rows:[usage]}=await c.query('select count(*)::integer count from parsers where workspace_id=$1 and archived=false',[workspaceId]);
 const {rows:[workspace]}=await c.query('select plan from workspaces where id=$1',[workspaceId]);
 if(usage.count>=workspace.plan.maxParsers)badRequest('The workspace parser limit has been reached',429);
}
