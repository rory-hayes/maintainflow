import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {quoteIdentifier} from '../migration-sql.js';
import {backupAssert} from './errors.js';

/** Restore executes reviewed checkout SQL only, never a function body from an archive. */
export async function backupWatchdog(schema:string,adminRole:string,appRole:string){
 const file=await fs.readFile(new URL('../../deploy/supabase-worker.sql',import.meta.url),'utf8');
 const match=file.match(/CREATE OR REPLACE FUNCTION folio\.worker_has_runnable_work\(\)\s+RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER\s+SET search_path=pg_catalog AS \$folio_work\$([\s\S]+?)\$folio_work\$;/);
 backupAssert(match,'BACKUP_DATABASE','The checked-in watchdog definition is unavailable or unsupported.');
 const body=match[1].replaceAll('folio.',schema+'.');
 return {body,sha256:createHash('sha256').update(body).digest('hex'),sql:`CREATE FUNCTION ${quoteIdentifier(schema)}.worker_has_runnable_work() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog AS $folio_work$${body}$folio_work$; REVOKE ALL ON FUNCTION ${quoteIdentifier(schema)}.worker_has_runnable_work() FROM PUBLIC,${quoteIdentifier(adminRole)},${quoteIdentifier(appRole)};`};
}
