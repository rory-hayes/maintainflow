import type { PoolClient } from 'pg';
import path from 'node:path';
import { adminPool, withWorkspace } from './db.js';
import { config } from './config.js';
import { privateStorage, validateStorageKey } from './storage.js';

/** Hold the document lock before removing local derived copies and immutable runs. */
export async function purgeDocument(c: PoolClient, workspaceId: string, documentId: string) {
  const { rows: [document] } = await c.query(
    'select id,storage_key from documents where id=$1 and workspace_id=$2 for update',
    [documentId, workspaceId],
  );
  if (!document) return undefined;
  const tables = (await c.query("select to_regclass('export_snapshots') exports,to_regclass('webhook_deliveries') deliveries,to_regclass('sheet_writes') sheets")).rows[0];
  if (tables.exports) await c.query('delete from export_snapshots where workspace_id=$1 and $2::uuid=any(document_ids)', [workspaceId, documentId]);
  if (tables.deliveries) await c.query("delete from webhook_deliveries where workspace_id=$1 and payload->'document'->>'id'=$2", [workspaceId, documentId]);
  if (tables.sheets) await c.query('delete from sheet_writes where workspace_id=$1 and event_key in(select a.id::text from approvals a join extraction_runs r on r.id=a.run_id where r.document_id=$2)', [workspaceId, documentId]);
  await c.query('insert into file_deletions(workspace_id,storage_key) values($1,$2) on conflict(storage_key) do nothing', [workspaceId, document.storage_key]);
  await c.query('delete from documents where id=$1 and workspace_id=$2', [documentId, workspaceId]);
  return document;
}

export async function deleteStoredFile(
  workspaceId: string,
  storageKey: string,
  unlink?: (filename: string) => Promise<void>,
): Promise<'complete' | 'pending' | 'failed'> {
  return withWorkspace(workspaceId, async c => {
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
    return 'complete';
  });
}

export async function processOneFileDeletion() {
  const { rows: [entry] } = await adminPool.query("select workspace_id,storage_key from file_deletions where status='pending' and available_at<=now() order by created_at limit 1");
  if (!entry) return false;
  await deleteStoredFile(entry.workspace_id, entry.storage_key);
  return true;
}
