import fs from 'node:fs/promises';
import path from 'node:path';
import { adminPool, withWorkspace } from './db.js';
import { config } from './config.js';
import { deleteStoredFile } from './retention.js';

const uuid = /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i;
const graceMs = 60 * 60 * 1000;
const pageSize = 100;

async function statOrMissing(filename: string) {
  try { return await fs.lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Conservative recovery: persisted cursors, UUID originals, one-hour grace and intake locks. */
export async function reconcileInterruptedIntake(onlyWorkspaceId?: string) {
  if (onlyWorkspaceId && !uuid.test(onlyWorkspaceId)) throw new Error('Invalid reconciliation workspace');
  const root = path.resolve(config.storageDir);
  const rootStat = await statOrMissing(root);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(root) !== root)) {
    throw new Error('Private storage root must be a real directory without symbolic links');
  }
  // Rotate tenants by last service time, including empty directories. Each tenant has
  // independent file and expired-intent cursors so referenced files cannot starve recovery.
  const workspaces = (await adminPool.query(
    `select w.id from workspaces w left join reconciliation_cursors r on r.workspace_id=w.id
     where ($1::uuid is null or w.id=$1) order by r.updated_at asc nulls first,w.id limit 10`,
    [onlyWorkspaceId ?? null],
  )).rows;
  let examined = 0, queued = 0, removed = 0, expiredIntentsRemoved = 0;
  for (const workspace of workspaces) {
    const workspaceId = workspace.id as string;
    const workspacePath = path.join(root, workspaceId);
    const deletions = await withWorkspace(workspaceId, async c => {
      await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [workspaceId]);
      await c.query('insert into reconciliation_cursors(workspace_id) values($1) on conflict do nothing', [workspaceId]);
      const cursor = (await c.query('select * from reconciliation_cursors where workspace_id=$1 for update', [workspaceId])).rows[0];
      const directory = await statOrMissing(workspacePath);
      if (directory && (!directory.isDirectory() || directory.isSymbolicLink() || await fs.realpath(workspacePath) !== workspacePath)) {
        await c.query('update reconciliation_cursors set updated_at=clock_timestamp() where workspace_id=$1', [workspaceId]);
        return [] as string[];
      }
      // Directory metadata enumeration remains linear; only this page of originals is
      // inspected or mutated. Deployments with large object stores need provider paging.
      const names = directory ? (await fs.readdir(workspacePath, { withFileTypes: true }))
        .filter(file => file.isFile() && !file.isSymbolicLink() && uuid.test(file.name))
        .map(file => file.name).sort() : [];
      let files = names.filter(name => name > cursor.after_filename).slice(0, pageSize);
      if (!files.length) files = names.slice(0, pageSize);
      const pending: string[] = [];
      for (const name of files) {
        examined++;
        const filename = path.join(workspacePath, name), storageKey = `${workspaceId}/${name}`;
        const stat = await statOrMissing(filename);
        if (!stat?.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < graceMs) continue;
        const intent = (await c.query('select * from intake_files where storage_key=$1 for update', [storageKey])).rows[0];
        if ((await c.query('select id from documents where storage_key=$1', [storageKey])).rowCount) {
          if (intent && new Date(intent.lease_expires_at).getTime() < Date.now()) {
            await c.query('delete from intake_files where id=$1', [intent.id]);
            expiredIntentsRemoved++;
          }
          continue;
        }
        if (intent && new Date(intent.lease_expires_at).getTime() >= Date.now()) continue;
        if ((await c.query('select id from file_deletions where storage_key=$1', [storageKey])).rowCount) continue;
        await c.query('insert into file_deletions(workspace_id,storage_key) values($1,$2) on conflict(storage_key) do nothing', [workspaceId, storageKey]);
        if (intent) { await c.query('delete from intake_files where id=$1', [intent.id]); expiredIntentsRemoved++; }
        pending.push(storageKey);
      }
      // A process can stop after reserving a filename and before writing it. Give the
      // expired reservation an additional hour, and use a separate cursor for progress.
      let intents = (await c.query(
        `select * from intake_files where lease_expires_at<now()-interval '1 hour'
         and ($1::uuid is null or id>$1) order by id limit $2 for update`,
        [cursor.after_intent_id, pageSize],
      )).rows;
      if (!intents.length && cursor.after_intent_id) intents = (await c.query(
        "select * from intake_files where lease_expires_at<now()-interval '1 hour' order by id limit $1 for update", [pageSize],
      )).rows;
      for (const intent of intents) {
        const parts = String(intent.storage_key).split('/');
        if (parts.length !== 2 || parts[0] !== workspaceId || !uuid.test(parts[1])) continue;
        const referenced = (await c.query('select id from documents where storage_key=$1', [intent.storage_key])).rowCount;
        if (referenced || !await statOrMissing(path.join(workspacePath, parts[1]))) {
          await c.query('delete from intake_files where id=$1', [intent.id]);
          expiredIntentsRemoved++;
        }
      }
      await c.query(
        `update reconciliation_cursors set after_filename=$2,after_intent_id=$3,updated_at=clock_timestamp() where workspace_id=$1`,
        [workspaceId, files.at(-1) ?? '', intents.at(-1)?.id ?? null],
      );
      return pending;
    });
    for (const storageKey of deletions) {
      queued++;
      if (await deleteStoredFile(workspaceId, storageKey) === 'complete') removed++;
    }
  }
  return { examined, queued, removed, expiredIntentsRemoved };
}
