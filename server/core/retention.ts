import type { PoolClient } from 'pg';
import path from 'node:path';
import { adminPool, withWorkspace } from './db.js';
import {lockParserForDocument,detachSetupSource} from './parser-setup.js';
import { config } from './config.js';
import { privateStorage, validateStorageKey } from './storage.js';

/** Hold the document lock before removing local derived copies and immutable runs. */
export async function purgeDocument(c: PoolClient, workspaceId: string, documentId: string) {
  const parser=await lockParserForDocument(c,workspaceId,documentId);
  await detachSetupSource(c,parser,documentId);
  const { rows: [document] } = await c.query(
    'select id,storage_key,pdf_split_id from documents where id=$1 and workspace_id=$2',
    [documentId, workspaceId],
  );
  if (!document) return undefined;
  if(document.pdf_split_id)await c.query('select id from pdf_splits where id=$1 and workspace_id=$2 for update',[document.pdf_split_id,workspaceId]);
  await c.query('select id from documents where id=$1 and workspace_id=$2 for update',[documentId,workspaceId]);
  const tables = (await c.query("select to_regclass('export_snapshots') exports,to_regclass('webhook_deliveries') deliveries,to_regclass('sheet_writes') sheets")).rows[0];
  if (tables.exports) await c.query('delete from export_snapshots where workspace_id=$1 and $2::uuid=any(document_ids)', [workspaceId, documentId]);
  if (tables.deliveries) await c.query("delete from webhook_deliveries where workspace_id=$1 and payload->'document'->>'id'=$2", [workspaceId, documentId]);
  if (tables.sheets) await c.query('delete from sheet_writes where workspace_id=$1 and event_key in(select a.id::text from approvals a join extraction_runs r on r.id=a.run_id where r.document_id=$2)', [workspaceId, documentId]);
  await c.query('insert into file_deletions(workspace_id,storage_key) values($1,$2) on conflict(storage_key) do nothing', [workspaceId, document.storage_key]);
  await c.query('delete from documents where id=$1 and workspace_id=$2', [documentId, workspaceId]);
  const storageKeys=[document.storage_key as string];
  if(document.pdf_split_id){
    await c.query('update pdf_split_children set document_name=null where document_id=$1 and workspace_id=$2',[documentId,workspaceId]);
    const sourceKey=await releaseEmptyPdfSplit(c,workspaceId,document.pdf_split_id);
    if(sourceKey)storageKeys.push(sourceKey);
  }
  return {...document,storageKeys};
}

/** Caller holds the workspace/parser locks. Release is queued in the purge TX. */
async function releaseEmptyPdfSplit(c:PoolClient,workspaceId:string,splitId:string){
  const split=(await c.query('select source_storage_key from pdf_splits where id=$1 and workspace_id=$2 for update',[splitId,workspaceId])).rows[0];
  if(!split?.source_storage_key||(await c.query('select id from documents where pdf_split_id=$1 and workspace_id=$2 limit 1',[splitId,workspaceId])).rowCount)return undefined;
  await c.query('insert into file_deletions(workspace_id,storage_key) values($1,$2) on conflict(storage_key) do nothing',[workspaceId,split.source_storage_key]);
  await c.query('update pdf_splits set source_storage_key=null,source_name=null,source_released_at=now() where id=$1 and workspace_id=$2',[splitId,workspaceId]);
  return split.source_storage_key as string;
}

/** Atomic whole-group removal. The route owns its audit and postcommit I/O. */
export async function purgePdfSplit(c:PoolClient,workspaceId:string,splitId:string){
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[workspaceId]);
  const parser=(await c.query("select p.id from parsers p join pdf_splits s on s.parser_id=p.id and s.workspace_id=p.workspace_id where s.id=$1 and s.workspace_id=$2 and s.state='accepted' for update of p",[splitId,workspaceId])).rows[0];
  if(!parser)return undefined;
  await c.query('select id from pdf_splits where id=$1 and workspace_id=$2 for update',[splitId,workspaceId]);
  const documents=(await c.query('select id from documents where pdf_split_id=$1 and workspace_id=$2 order by pdf_split_index',[splitId,workspaceId])).rows;
  const storageKeys:string[]=[];
  for(const document of documents){const removed=await purgeDocument(c,workspaceId,document.id);if(removed)storageKeys.push(...removed.storageKeys);}
  const sourceKey=await releaseEmptyPdfSplit(c,workspaceId,splitId);if(sourceKey)storageKeys.push(sourceKey);
  return {id:splitId,removedDocuments:documents.length,storageKeys:[...new Set(storageKeys)]};
}

export async function deleteStoredFiles(workspaceId:string,storageKeys:string[]):Promise<'complete'|'pending'|'failed'>{
  let aggregate:'complete'|'pending'|'failed'='complete';
  for(const key of new Set(storageKeys)){
    const result=await deleteStoredFile(workspaceId,key);
    if(result==='failed')aggregate='failed';else if(result==='pending'&&aggregate!=='failed')aggregate='pending';
  }
  return aggregate;
}

export async function deleteStoredFile(
  workspaceId: string,
  storageKey: string,
  unlink?: (filename: string) => Promise<void>,
): Promise<'complete' | 'pending' | 'failed'> {
  let removed=false;
  const status=await withWorkspace(workspaceId, async c => {
    const { rows: [entry] } = await c.query('select * from file_deletions where storage_key=$1 for update', [storageKey]);
    if (!entry) return 'complete';
    try {
      validateStorageKey(entry.storage_key, workspaceId);
      if (unlink) await unlink(path.join(config.storageDir, entry.storage_key));
      else await privateStorage().remove(entry.storage_key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as {statusCode?:number}).statusCode !== 404) {
        const attempts = entry.attempts + 1;
        const status = attempts >= 10 ? 'failed' : 'pending';
        await c.query("update file_deletions set attempts=$2,status=$3,last_error=$4,available_at=now()+($5::int*interval '1 second') where id=$1", [
          entry.id, attempts, status, 'Private file removal failed. Check storage permissions and retry.', Math.min(3600, 2 ** attempts * 10),
        ]);
        return status;
      }
    }
    await c.query('delete from file_deletions where id=$1', [entry.id]);
    removed=true;
    return 'complete';
  });
  if(removed){
    // Release reserved split bytes only after physical removal commits. Do not
    // take an intake lock while holding file_deletions: acceptance/cleanup uses
    // workspace -> intent -> deletion ordering. A new deletion intent wins.
    await withWorkspace(workspaceId,async c=>{
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[workspaceId]);
      const intent=(await c.query('select id from intake_files where workspace_id=$1 and storage_key=$2 and split_attempt_id is not null for update',[workspaceId,storageKey])).rows[0];
      if(intent)await c.query('delete from intake_files where id=$1 and not exists(select 1 from file_deletions where workspace_id=$2 and storage_key=$3)',[intent.id,workspaceId,storageKey]);
    });
  }
  return status;
}

export async function processOneFileDeletion() {
  const { rows: [entry] } = await adminPool.query("select workspace_id,storage_key from file_deletions where status='pending' and available_at<=now() order by created_at limit 1");
  if (!entry) return false;
  await deleteStoredFile(entry.workspace_id, entry.storage_key);
  return true;
}
