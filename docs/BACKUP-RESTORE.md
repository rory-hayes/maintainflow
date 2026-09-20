# Encrypted backup and isolated restore

Folio's operator CLI captures one complete application schema, its referenced private filesystem objects and the stable integration encryption key. It restores into a different, fresh database and leaves that destination inactive until an explicit activation command succeeds. It does not start services, configure a backup destination or schedule backups.

This implements a local operating workflow toward the original [P0 backup/restore gate](PRODUCTION-READINESS-2026-09-11.md). It does not establish production restoration, off-host durability, a recovery-time objective or backup-retention enforcement. Keep those release gates separate.

## Prerequisites

- Run from an operator checkout with Node.js 24 and the locked development dependencies installed. Commands below use `node --import tsx scripts/backup.ts`; the packaged production runtime is not assumed to contain these operator tools. Keep the matching checked-in `migrations/` directory available.
- Source and destination must use PostgreSQL **17**, **UTF8**, and the same application schema name. The archive must match the checked-in migration filenames and hashes. There is no migration-on-restore compatibility path for an older or newer archive.
- Supply an explicit backup/migration database identity with `SUPERUSER` or `BYPASSRLS`, access to every selected application table and sequence, and permission to read the catalog/control information used by preflight, including `pg_control_system()`. Destination migration requires ownership/creation rights for its application schema. Do not use this identity for the API or worker.
- Both runtime roles must already exist and be distinct from each other and the backup identity: `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. They must have no role memberships or owned database objects. Provision these identities through the database administrator; the CLI does not create a database, runtime role or password.
- The destination is a **fresh, different database**, not merely an empty schema inside a populated database. Added extensions other than `plpgsql`, user relations, functions, types, collations and unexpected schemas are refused. Connection aliases cannot make the source database a valid restore target.
- Stop every API, worker, maintenance/deletion process and other storage writer for the selected source before capture. Close other database clients, including idle inspection sessions. The tool refuses other client connections and prepared transactions and takes table locks; `--quiesced` remains an operator assertion that filesystem writers are stopped too. Keep destination services stopped through restore and activation.
- Originals must be in a private filesystem directory. Each object uses `workspace-UUID/object-UUID`. Use real owner-only directories, normally mode `0700`, and owner-only configuration/key/password files, normally `0600`. Selected file arguments must be absolute paths. Symlink files and symlink storage directories are refused.
- Keep config, keys, artifacts and temporary directories outside the originals directory. Provide space for a plaintext working copy as well as the encrypted archive or restored files. Temporary working copies use private directories under the OS temporary directory; an operator may select a dedicated private `TMPDIR` outside originals. Successful and handled failed operations remove scratch contents; an interrupted process may leave private scratch files for controlled cleanup.

The backup CLI uses its explicit JSON configuration. It does not load the application's `.env` files. Normal API and worker startup still uses application configuration, so configure the restored runtime deliberately before starting it.

## Configuration

These paths and identities are examples, not existing resources. Create the private parent directories and provision the selected database identities before running commands. Save the source configuration as `/srv/folio/private/source.json` with mode `0600`:

```json
{
  "version": 1,
  "database": {
    "host": "127.0.0.1",
    "port": 5432,
    "database": "folio_source",
    "user": "folio_backup_owner",
    "passwordFile": "/srv/folio/private/backup-database-password"
  },
  "schema": "folio",
  "adminRole": "folio_runtime_admin",
  "appRole": "folio_runtime_app",
  "storageDir": "/srv/folio/source/originals",
  "integrationKeyFile": "/srv/folio/private/source-integration-key"
}
```

`database.host` can instead be an absolute Unix socket directory. `passwordFile` is optional when the selected database authentication does not require it. Remote database connections require `database.sslCaFile`, an absolute path to a trusted CA file, and certificate verification remains enabled. Database credentials are read from the selected file, not passed in command-line arguments.

For `/srv/folio/private/target.json`, copy this shape and set:

```json
{
  "version": 1,
  "database": {
    "host": "127.0.0.1",
    "port": 5432,
    "database": "folio_restore",
    "user": "folio_backup_owner",
    "passwordFile": "/srv/folio/private/backup-database-password"
  },
  "schema": "folio",
  "adminRole": "folio_runtime_admin",
  "appRole": "folio_runtime_app",
  "storageDir": "/srv/folio/restore/originals",
  "integrationKeyFile": "/srv/folio/private/restored-integration-key"
}
```

The target originals directory must be absent or empty; its parent must already be private. The target integration-key file must not exist. Neither target path should reuse a source path. Keep the exact target configuration unchanged between restore and activation: the pending marker binds the parsed configuration, backup ID and ciphertext digest.

## Keys, capture and inspection

From the operator checkout, generate a distinct age identity/recipient pair into new files:

```sh
node --import tsx scripts/backup.ts keygen \
  --identity-file /srv/folio/offline/restore.agekey \
  --recipient-file /srv/folio/private/backup-recipient.age
```

The CLI uses `age-encryption` to generate a hybrid identity and encrypt the standard binary age stream. It writes the private identity to its selected owner-only file and prints no key value. Keep that identity in separately controlled offline storage; capture needs only the recipient file. Mount or make the identity available for inspection/recovery, then return it to its controlled storage. Losing the private identity prevents decryption of its backups.

The age identity and Folio integration key serve different purposes. The archive contains the existing integration key because restored provider ciphertext requires that exact key. Do not generate a replacement integration key during recovery. Source `integrationKeyFile` accepts 32 raw bytes or their canonical base64 encoding; the archive and restored output contain the same **32 raw bytes**.

After stopping source writers and other clients, capture to a new artifact path:

```sh
node --import tsx scripts/backup.ts create \
  --config /srv/folio/private/source.json \
  --recipient-file /srv/folio/private/backup-recipient.age \
  --output /srv/folio/backups/folio-2026-09-20.age \
  --quiesced
```

Capture holds a repeatable-read database snapshot with write-conflicting table locks. It copies known tables in primary-key order, records sequence state, and checks referenced objects against their stored hashes. Filesystem inventory and integration-key checks repeat before publication. The final artifact name is published exclusively from a completed encrypted temporary file on the same filesystem; an existing output is never overwritten. Successful output reports `backup_created` with counts and limits-related metadata.

Authenticate an artifact without restoring a database:

```sh
node --import tsx scripts/backup.ts inspect \
  --input /srv/folio/backups/folio-2026-09-20.age \
  --identity-file /srv/folio/offline/restore.agekey
```

`inspect` fully decrypts into private scratch space, validates framing, manifest paths, payload lengths/digests and final age authentication, then removes scratch space. `backup_authenticated` confirms those checks. It does not connect to a database or prove that a functional restore has succeeded.

## Restore, verify and activate

Keep the fresh destination offline and run:

```sh
node --import tsx scripts/backup.ts restore \
  --config /srv/folio/private/target.json \
  --input /srv/folio/backups/folio-2026-09-20.age \
  --identity-file /srv/folio/offline/restore.agekey
```

The complete encrypted stream is authenticated before destination changes. Restore creates a pending marker, restores original files and the raw integration key, builds the schema from checked-in migrations, then loads binary table data. It does not execute SQL carried inside the backup.

The database transaction checks foreign keys, original constraint/trigger behavior, RLS and ACL definitions, table contents, sequence state, and the exact object-reference inventory. A declared object cannot be omitted or reclassified as optional while a restored document still requires it. Copying documents does not generate replacement journal events. A successful command returns `restored_inactive`; it starts no services.

Configure the normal API and worker to use the restored database with the restricted runtime roles, the restored originals directory and the recovered key file:

```dotenv
DATABASE_SCHEMA=folio
STORAGE_DRIVER=filesystem
STORAGE_DIR=/srv/folio/restore/originals
INTEGRATION_ENCRYPTION_KEY_FILE=/srv/folio/private/restored-integration-key
```

Set the normal `DATABASE_URL` and `DATABASE_ADMIN_URL` to the corresponding restored runtime accounts. Remove `INTEGRATION_ENCRYPTION_KEY` when using `INTEGRATION_ENCRYPTION_KEY_FILE`; configuring both is refused. The file option works with the raw restored key and avoids copying its contents into an environment value. Start fresh processes so an earlier in-memory key cannot mask a configuration error.

The filesystem runtime guard rejects API and worker startup while `.folio-restore-pending.json` exists in the selected originals directory. Keep the restored database, files and runtime configuration together; pointing a process at another storage directory is not a verification procedure. Do not delete the marker by hand to bypass activation.

Before activation, decide whether restored queued jobs, mail, webhooks, Sheets writes and configured integrations may resume. Clearing provider environment variables alone is not an outbound fence: restored database records can contain destinations and encrypted credentials. An isolated acceptance environment must block outbound transports or replace them with controlled transports. The activation flag permits later service execution; the CLI itself does not start services or send queued work.

When the destination is ready for that explicit transition:

```sh
node --import tsx scripts/backup.ts activate \
  --config /srv/folio/private/target.json \
  --input /srv/folio/backups/folio-2026-09-20.age \
  --identity-file /srv/folio/offline/restore.agekey \
  --allow-outbound
```

Activation reauthenticates the artifact, verifies the bound pending marker, checks the recovered key and exact originals, and compares the restored database to the backup. It writes a matching activation receipt and removes the pending marker. `restore_activated` still reports `servicesStarted: false`; service startup remains an operator step.

If activation was interrupted after writing the receipt, retrying the same command verifies the pending destination and completes marker removal. If a matching receipt exists and the marker is already absent, it returns `restore_already_activated`. That status acknowledges the recorded transition; it does not reverify a database that may have changed during subsequent use.

## Failure and recovery boundaries

| Result | Operator action |
| --- | --- |
| Missing/corrupt required source original, changed source inventory/key, open clients or conflicting locks | Keep the source safe, resolve the reported prerequisite, and retry capture to a new artifact path. Do not edit hashes merely to make backup pass. |
| Wrong age identity, malformed/truncated artifact, invalid paths, missing declared payload or failed authentication | The rejected input remains unchanged. Authentication fails before destination setup. Use a verified artifact and matching identity. |
| Failure after destination setup begins | The owned destination deliberately retains its pending marker and may retain copied files/key. Keep it inactive. Diagnose the database outcome before cleaning only that exact owned destination or selecting a new fresh target. Restore does not overwrite an existing attempt. |
| `BACKUP_COMMIT_UNCERTAIN` | A lost COMMIT reply does not establish rollback. Preserve the pending destination. When activation is intended, the same `activate --allow-outbound` command verifies the database/files before proceeding. If verification fails, keep it inactive and investigate; do not blindly rerun restore over it. |
| Interrupted activation with matching receipt and pending marker | Retry the identical activation command. A mismatched or unreadable marker/receipt is refused rather than overwritten. |
| Existing artifact, key file or populated restore target | Choose a genuinely new target or inspect the existing outcome. There is no force/overwrite option. |

The CLI emits small JSON status/error records, not database contents or key values. Retain the artifact's digest, command outcome and controlled recovery evidence separately. Private scratch copies and partially restored files are still sensitive; an interrupted run is not proof that all temporary plaintext has been erased.

## Inventory, limits and remaining gates

- Capture covers all workspaces/accounts in the selected application schema, including authentication state, encrypted integration records, queues, audit/usage records and receipt tombstones. There is no selective workspace merge or restore.
- Required objects are live document originals and retained PDF/ZIP parent sources. Pending intake, signed-upload and deletion reservations are included when their files exist; absence is allowed only for optional references. Restored optional bytes preserve their actual content, not an unverified upload declaration.
- Unreferenced physical objects are recorded as omitted metadata and are not restored. Deleting one PDF/ZIP child does not erase a parent still retained for a live sibling. Older backups can retain originals that were deleted later; live retention does not erase backup copies.
- Limits are **20 GiB combined payload**, **100,000 payload files**, **10 MiB per stored object**, **32 MiB manifest** and **64 KiB encrypted-header prefix**. Payload files include table streams and the integration key, so the file limit is not an additional 100,000 originals. The physical originals scan also has a 100,000-object limit. These are rejection bounds, not demonstrated recovery-time or capacity commitments.
- Supported capture is quiesced PostgreSQL 17 plus private filesystem storage. Supabase/other hosted object-bucket backup, live concurrent capture, PostgreSQL major-version conversion, arbitrary schema/extension migration, general archive import, automatic failover and merge/overwrite restore are unsupported.
- Off-host storage, independently recoverable key custody, unattended schedules, retention enforcement, filesystem/power-loss durability and restoration on the actual deployment still need their own operational evidence. No production or customer-use proof follows from this tool or an authenticated local artifact. Free-plan and mock-billing decisions are unchanged.

## Verification record

`tests/backup-archive.test.ts` covers actual hybrid age round trips, corruption, wrong identities, hostile manifests, bounded declarations, input preservation and failed extraction cleanup. `scripts/verify-backup-restore.ts` and its fresh runtime helper provide the owned PostgreSQL/filesystem acceptance workflow, including application behavior and controlled outbound transports. Run that harness only against the isolated targets it creates; it is not a command for inspecting or changing the ordinary development or hosted database.

Encrypted operator backup and isolated restore pass **610/610 serial tests** on **Node 24.13.0** in **187.222 seconds**, with no failures, skips or cancellations. **11/11 restore groups** and **13/13 restored-runtime assertions** pass on PostgreSQL 17: all **54 tables, 116 rows and one sequence** match before application startup; six live originals, retained PDF/ZIP sources and three saved typed exports match. Inactive startup, exact file/database-reference binding, malformed artifacts, wrong identities, activation interruption and separate existing-target refusals pass. One queued rules job and one injected webhook delivery complete without duplicate charges; pending email is preserved without sending. No external provider calls occurred, and the isolated databases, storage, keys and credential fixtures were removed. Build, hosted packaging and isolated runtime checks pass on the same **278 source files**, fingerprint **`7a5a878d331c87bb591c3959ae18f132c065bdd33a64f3f07380fc8217cf7a7a`**.

This is quiesced local PostgreSQL/filesystem acceptance. Hosted database/object recovery, off-host storage and key custody, schedules, backup retention and power-loss durability remain operational gates. Hosted **021–032** and matching runtime activation remain pending. Free plans and mock billing remain unchanged; all **47 original capability criteria** are preserved.

[Operator contract](BACKUP-RESTORE.md) · [Verification](evidence/backup-restore-2026-09-20/verification.json) · [Restore receipt](evidence/backup-restore-2026-09-20/acceptance.json) · [Source manifest](evidence/backup-restore-2026-09-20/source-manifest.json).

The full suite includes 11 archive and five runtime regressions. An independent isolated database-helper pass adds 25 checkpoints for binary values, cyclic references, sequence state, RLS/grants, mutation refusal and uncertain commit recovery. Linux CI is required separately on the pull request; this local receipt does not claim its result.
