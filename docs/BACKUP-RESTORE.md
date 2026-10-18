# Encrypted backup and isolated restore

Folio's operator CLI captures one complete application schema, its referenced private filesystem or Supabase objects and the stable integration encryption key. It restores into a different, fresh database and leaves that destination inactive until an explicit activation command succeeds. It does not start services, configure a backup destination or schedule backups.

This implements a local operating workflow toward the original [P0 backup/restore gate](PRODUCTION-READINESS-2026-09-11.md). It does not establish production restoration, off-host durability, a recovery-time objective or backup-retention enforcement. Keep those release gates separate.

## Prerequisites

- Run from an operator checkout with Node.js 24 and the locked development dependencies installed. Commands below use `node --import tsx scripts/backup.ts`; the packaged production runtime is not assumed to contain these operator tools. Keep the matching checked-in `migrations/` directory available.
- Source and destination must use PostgreSQL **17**, **UTF8**, and the same application schema name. The archive must match the checked-in migration filenames and hashes. There is no migration-on-restore compatibility path for an older or newer archive.
- Supply an explicit backup/migration database identity with `SUPERUSER` or `BYPASSRLS`, access to every selected application table and sequence, and permission to read the catalog/control information used by preflight, including `pg_control_system()`. Destination migration requires ownership/creation rights for its application schema. Do not use this identity for the API or worker.
- Both runtime roles must already exist and be distinct from each other and the backup identity: `LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. They must have no role memberships or owned database objects. Provision these identities through the database administrator; the CLI does not create a database, runtime role or password.
- The destination is a **fresh, different database**, not merely an empty schema inside a populated database. Added extensions other than `plpgsql`, user relations, functions, types, collations and unexpected schemas are refused. Connection aliases cannot make the source database a valid restore target.
- Stop every API, worker, maintenance/deletion process and other storage writer for the selected source before capture. Close other database clients, including idle inspection sessions. The tool refuses other client connections and prepared transactions and takes table locks; `--quiesced` remains an operator assertion that filesystem writers are stopped too. Keep destination services stopped through restore and activation.
- Filesystem originals must be in a private filesystem directory. The explicit managed-source option below reads the private Supabase originals bucket instead. Each object uses `workspace-UUID/object-UUID`. Use real owner-only directories, normally mode `0700`, and owner-only configuration/key/password files, normally `0600`. Selected file arguments must be absolute paths. Symlink files and symlink storage directories are refused.
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

Compare the complete destination again while leaving that startup fence intact:

```sh
node --import tsx scripts/backup.ts verify \
  --config /srv/folio/private/target.json \
  --input /srv/folio/backups/folio-2026-09-20.age \
  --identity-file /srv/folio/offline/restore.agekey
```

`verify` authenticates the archive, requires its exact configuration-bound pending marker, checks the recovered key and originals before and after full database byte/security/sequence/reference comparison, and rechecks the marker before reporting `restored_verified_inactive`. It reports the ciphertext digest, retains the marker and creates no activation receipt. It accepts no `--allow-outbound` flag and starts no services. Repeated verification is allowed while the destination is pending; an already activated destination or any existing activation receipt is refused. Keep destination writers and other operator commands stopped throughout verification. This is a point-in-time comparison, not a lock against another operator changing the destination afterward.

Before activation, decide whether restored queued jobs, mail, webhooks, Sheets writes and configured integrations may resume. Clearing provider environment variables alone is not an outbound fence: restored database records can contain destinations and encrypted credentials. An isolated acceptance environment must block outbound transports or replace them with controlled transports. The activation flag permits later service execution; the CLI itself does not start services or send queued work.

Also settle post-snapshot deletion and access-revocation reconciliation before activation. Exact historical restoration can recreate deleted documents, old password/session state, revoked API or integration credentials, and removed memberships. Keep the current authorized deletion/revocation journal separately recoverable. Exact verification and activation expect the authenticated historical bytes; apply the authorized reconciliation only after that exact transition, inside the isolated fence and before starting services or permitting user/provider access. If the current decisions cannot be established, keep the destination inactive. Do not weaken byte verification or expose historical access while deciding what to revoke.

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
| `BACKUP_COMMIT_UNCERTAIN` | A lost COMMIT reply does not establish rollback. Preserve the pending destination. Use `verify` to compare the database/files without activating. If verification fails, keep it inactive and investigate; do not blindly rerun restore over it. |
| Interrupted activation with matching receipt and pending marker | Retry the identical activation command. A mismatched or unreadable marker/receipt is refused rather than overwritten. |
| Existing artifact, key file or populated restore target | Choose a genuinely new target or inspect the existing outcome. There is no force/overwrite option. |

The CLI emits small JSON status/error records, not database contents or key values. Retain the artifact's digest, command outcome and controlled recovery evidence separately. Private scratch copies and partially restored files are still sensitive; an interrupted run is not proof that all temporary plaintext has been erased.

## Inventory, limits and remaining gates

- Capture covers all workspaces/accounts in the selected application schema, including authentication state, encrypted integration records, queues, audit/usage records and receipt tombstones. There is no selective workspace merge or restore.
- Required objects are live document originals and retained PDF/ZIP parent sources. By default, pending intake, signed-upload and deletion reservations are included when their files exist; absence is allowed only for optional references. Restored optional bytes preserve their actual content, not an unverified upload declaration. The explicit managed staging-exclusion mode below omits only declared signed-upload staging bytes.
- Unreferenced physical objects are recorded as omitted metadata and are not restored. Deleting one PDF/ZIP child does not erase a parent still retained for a live sibling. Older backups can retain originals that were deleted later; live retention does not erase backup copies.
- Limits are **20 GiB combined payload**, **100,000 payload files**, **10 MiB per stored object**, **32 MiB manifest** and **64 KiB encrypted-header prefix**. Payload files include table streams and the integration key, so the file limit is not an additional 100,000 originals. The physical originals scan also has a 100,000-object limit. These are rejection bounds, not demonstrated recovery-time or capacity commitments.
- Supported capture is quiesced PostgreSQL 17 plus private filesystem storage, or the explicit managed-source/private Supabase bucket option below. Restoration remains a fresh dedicated PostgreSQL database plus filesystem storage. Restoring into a populated Supabase project or its object bucket, live concurrent capture, PostgreSQL major-version conversion, arbitrary schema/extension migration, general archive import, automatic failover and merge/overwrite restore are unsupported.
- Off-host storage, independently recoverable key custody, unattended schedules, retention enforcement, filesystem/power-loss durability and restoration on the actual deployment still need their own operational evidence. No production or customer-use proof follows from this tool or an authenticated local artifact. Free-plan and mock-billing decisions are unchanged.

## Managed PostgreSQL source and private Supabase bucket

The same `create --quiesced` command accepts two additive source settings. This is a source-to-isolated-recovery path; it does not provision a hosted restore target or a scheduled backup.

```json
{
  "version": 1,
  "database": {
    "host": "db.REPLACE_PROJECT.supabase.co",
    "port": 5432,
    "database": "postgres",
    "user": "postgres",
    "passwordFile": "/srv/folio/private/source-database-password",
    "sslCaFile": "/srv/folio/private/source-database-ca.pem"
  },
  "schema": "folio",
  "adminRole": "folio_admin",
  "appRole": "folio_app",
  "databaseProfile": "managed-source",
  "sourceStorage": {
    "kind": "supabase",
    "url": "https://REPLACE_PROJECT.supabase.co",
    "serviceRoleKeyFile": "/srv/folio/private/source-storage-service-key"
  },
  "storageDir": "/srv/folio/private/empty-source-directory",
  "integrationKeyFile": "/srv/folio/private/source-integration-key"
}
```

The uppercase project placeholders must be replaced with the actual project reference. Files remain explicit owner-only inputs; the CLI never reads the application's `.env` or saved preview credentials. In this additive configuration, `storageDir` remains a required, existing private local directory for path separation; its contents are not used as the object source. Downloaded objects go into the command's private temporary directory and are removed on handled completion/failure. Keep output artifacts, configuration, keys and temporary directories outside `storageDir` as with filesystem capture.

The source database connection must still be distinct from the runtime roles, have `SUPERUSER` or `BYPASSRLS`, SELECT access to **every** current application table including `schema_migrations`, direct SELECT of the identity sequence, `pg_control_system()` access, and privileges sufficient to acquire the application table SHARE locks. Managed-source mode does not accept the restricted API administrator as a backup identity or manufacture a row-count attestation. No role, grant, migration or credential is created or changed by capture. A schema-only SELECT account is insufficient for these checks. Provisioning a separate bypass identity requires an administrator's security review because `BYPASSRLS` is a role-wide attribute, even when object privileges are narrowly granted. The CLI deliberately provides no blanket grant script that disguises that scope.

Managed-source mode allows unrelated platform connections, schemas and other owners' default ACLs. It still refuses other connections under the configured backup and Folio runtime identities, prepared transactions, custom defaults belonging to the application schema owner, unknown application tables/types/sequences, missing migrations, or unsupported application security. Only the current checked-in migration catalogue is accepted; no historical hard-coded table count substitutes for it.

Stop all Folio API, worker, cron, cleanup and object writers before capture. In the default version-1 mode, drain all processing/sending/finalizing work and wait through outstanding signed-upload and write-lease expiry windows. These conditions are checked from the current queues/reservations in addition to the operator's `--quiesced` assertion. Application tables stay SHARE-locked in a repeatable-read transaction. This does **not** lock Supabase Storage or create a distributed database/object snapshot. Repeated inventory and byte hashing detect observed changes; they are not a substitute for stopping writers and allowing previously issued storage capabilities to expire. The opt-in version-2 mode below has a narrower exception for exact staging keys.

Current signed-upload retention is 130 minutes (`SIGNED_UPLOAD_RETENTION_SECONDS`); for version 1, use the actual maximum `direct_uploads.cleanup_after` and `split_suggestions.staging_expires_at`, plus active write/intake leases, to choose the pause window. A fixed short pause does not establish quiescence. Do not shorten timestamps or delete reservations to make capture pass. A recurring schedule must accommodate these capabilities or explicitly adopt the version-2 recovery boundary below after its own operational acceptance.

The storage transport accepts only the exact HTTPS `*.supabase.co` project origin and the fixed `folio-originals` bucket. It verifies a private bucket with a size limit no greater than 10 MiB, lists bounded UUID paths with pagination, downloads authenticated originals, and rechecks inventory, policy and every captured object's bytes before publication. Redirects are refused, each whole request including its body has a 45-second deadline, and arbitrary provider response bodies are excluded from errors. Only GET and the provider's read-only list POST are sent; no bucket/object/policy mutation or signed URL is requested. Authentication follows Supabase's [private bucket access model](https://supabase.com/docs/guides/storage/buckets/fundamentals).

By default, all physical originals are temporarily read and hashed to detect changes, including unreferenced objects. The encrypted archive retains required and present optional references; unreferenced objects remain recorded as omitted metadata, matching filesystem semantics. Allow private scratch space for the bucket mirror **and** prepared payloads. Repeated reads incur provider bandwidth and execution time; the configured byte/object bounds do not establish a recovery-time or free-quota guarantee.

If the operational `worker_has_runnable_work()` function exists, capture accepts only its exact current checked-in body, zero-argument SQL/STABLE/invoker signature, `pg_catalog` search path, schema ownership and owner-only EXECUTE. Its digest is authenticated in the archive. Restore recreates this reviewed checkout function before comparing the complete application security fingerprint. It never executes function SQL supplied by an archive. No cron job, Vault secret, `pg_net` extension or external worker URL is restored or enabled. Owners are mapped to the chosen destination migration identity, while runtime roles retain their explicit restricted grants and RLS behavior; arbitrary source ACL drift is refused against the canonical migration template.

Use a normal filesystem destination configuration without `databaseProfile` or `sourceStorage` for `restore` and `activate`. Managed-source configuration is capture-only. Both commands retain full row-byte, sequence, reference, owner/ACL/RLS/constraint/trigger checks and the inactive restore marker. Supabase platform-owned schemas, authentication/storage service internals, global roles, external credentials and platform configuration are outside this application archive. The restored application must be configured for its recovered filesystem originals; the tool does not write a replacement hosted bucket.

### Opt-in capture without waiting for signed-upload staging expiry

Add `--exclude-upload-staging` only when creating a managed-source Supabase backup:

```sh
node --import tsx scripts/backup.ts create \
  --config /srv/folio/private/source.json \
  --recipient-file /srv/folio/private/backup.agepub \
  --output /srv/folio/backups/folio-staging-excluded.age \
  --quiesced --exclude-upload-staging
```

This writes an authenticated **version-2 manifest**, with capture type `quiesced-supabase-excluding-staging` and exact `excludedUploadStaging` declarations. Omitting the flag preserves the version-1 default and its strict expiry checks. The flag is rejected for filesystem capture and all other commands. Updated readers still accept version-1 archives; older readers reject version 2 rather than treating its omissions as a complete storage copy. The age container framing remains unchanged.

The locked database snapshot derives every retained `direct_uploads.storage_key` and non-null `split_suggestions.staging_storage_key`, including completed, failed, cleaned, cancelled and expired reservations. Each declaration binds an exact UUID object key to its record type and ID. There are no prefixes or operator-supplied exclusions. Any alias with a document original, PDF/ZIP parent, suggestion source (including optional or historical source references), intake reservation or another staging declaration is refused. A deletion reservation may refer to staging because that is how ordinary staging cleanup is queued.

All application writers must still stop. Processing/sending/finalizing work and active split-write/intake leases still prevent capture. Only writes through previously issued capabilities to the derived staging keys may continue. Their bytes are neither downloaded nor hashed nor included in the archive; their database reservations remain byte-exact and appear as explicitly excluded, absent optional objects. Accepted originals are separate immutable keys and retain the same full byte checks. The command summary reports the exclusion count separately from other absent optional objects.

The storage listing still validates every raw page before filtering exclusions. A staging insertion that shifts an offset page into a duplicate causes safe refusal, even if that object would be excluded. Resolve or wait for that upload and retry to a new artifact path. Unknown objects, nonexcluded additions/deletions, changed policy and changed original bytes continue to fail capture. The stable nonexcluded baseline is never silently reset. This may reduce the capability-expiry wait, but it is not an online snapshot, a promised fixed pause duration, or protection against an uncooperative administrator changing originals during capture.

Restore, inactive verification and activation rederive the full staging declarations from the recovered database and require an exact match, including record identity. Missing or misbound declarations fail before the restore database transaction commits; the destination stays fenced and may retain copied files/key for diagnosis. All rows, queued work, audit/usage data and completed upload receipts remain unchanged. The version-2 fixture confirms that completed and cleaned direct-upload receipts still replay the original document without staging bytes.

**Unfinished uploads require recovery handling.** An upload that had not become an accepted document is deliberately not recoverable from its omitted staging bytes. An old signed URL still targets the old provider bucket, so the user must start a fresh upload against the restored service. A stale direct-upload finalize call can report a missing file; its finalize lease is released and the reservation remains pending. Do not repeatedly retry that old reservation. Failed reservations already tell the caller to start a new upload. An `uploading` split suggestion similarly needs a new upload/suggestion; users can cancel the unfinished draft through the existing workflow. Queued or ready suggestions retain their separate accepted source bytes. Do not rewrite these states inside the archive or weaken exact verification; apply any authorized post-restore reconciliation only after the exact activation transition, inside the existing isolation fence and before exposing the service. This mode makes no promise to resume unfinished browser uploads.

### Managed-source verification

Run `node --import tsx scripts/verify-managed-backup.ts --execute` only as an owned local acceptance fixture. It creates a separate socket-only PostgreSQL 17 cluster, uses generated identities/data and an injected in-memory Supabase transport, and cleans its cluster, originals, keys and encrypted test artifacts. It never reads application credentials or contacts a hosted provider. `FOLIO_BACKUP_QA_PG_BIN` can select an existing PostgreSQL 17 binary directory.

The staging-exclusion increment passed **27/27 isolated acceptance groups** on Node 24.13.0 with **62 application tables and 36 migrations**: the 20 existing groups plus seven version-2 groups. These cover actual encrypted create/restore/verify/activate, required and optional-source alias refusal, all eight seeded direct/split staging reservations, late known uploads without staging downloads, active-writer refusal, exact table/source preservation, declaration mismatch rollback, completed/cleaned receipt replay and pending finalize-lease release. A separate **36/36** focused test run covers archive/CLI/runtime guards, storage mutation and both root and child offset-100/200 pagination shifts. TypeScript checking passes.

The host drill could not start because macOS had exhausted its SysV shared-memory IDs; it supplied no acceptance evidence. The successful drill used fresh labelled Docker resources, cached Node24/PostgreSQL17 images, a separate dependency preparation step, then a network-none test container with no published ports. It made zero hosted/provider calls and removed its isolated cluster, synthetic keys, originals and archives; the three owned containers and one volume were removed separately. These are synthetic local proofs, not hosted capture, actual Supabase recovery, scheduling, off-host durability or provider availability evidence. The actual installation still requires a separately available owner-capable backup connection before this capture path can run; SQL Editor access is not such a connection. The historical pre-038 private checkpoint and its archive remain unchanged.

## Historical verification record

The following record describes the earlier filesystem-only increment and its then-current release state. It does not describe today's hosted migration or runtime activation status.

`tests/backup-archive.test.ts` covers actual hybrid age round trips, corruption, wrong identities, hostile manifests, bounded declarations, input preservation and failed extraction cleanup. `scripts/verify-backup-restore.ts` and its fresh runtime helper provide the owned PostgreSQL/filesystem acceptance workflow, including application behavior and controlled outbound transports. Run that harness only against the isolated targets it creates; it is not a command for inspecting or changing the ordinary development or hosted database.

Encrypted operator backup and isolated restore pass **610/610 serial tests** on **Node 24.13.0** in **187.222 seconds**, with no failures, skips or cancellations. **11/11 restore groups** and **13/13 restored-runtime assertions** pass on PostgreSQL 17: all **54 tables, 116 rows and one sequence** match before application startup; six live originals, retained PDF/ZIP sources and three saved typed exports match. Inactive startup, exact file/database-reference binding, malformed artifacts, wrong identities, activation interruption and separate existing-target refusals pass. One queued rules job and one injected webhook delivery complete without duplicate charges; pending email is preserved without sending. No external provider calls occurred, and the isolated databases, storage, keys and credential fixtures were removed. Build, hosted packaging and isolated runtime checks pass on the same **278 source files**, fingerprint **`7a5a878d331c87bb591c3959ae18f132c065bdd33a64f3f07380fc8217cf7a7a`**.

This is quiesced local PostgreSQL/filesystem acceptance. Hosted database/object recovery, off-host storage and key custody, schedules, backup retention and power-loss durability remain operational gates. Hosted **021–032** and matching runtime activation remain pending. Free plans and mock billing remain unchanged; all **47 original capability criteria** are preserved.

[Operator contract](BACKUP-RESTORE.md) · [Verification](evidence/backup-restore-2026-09-20/verification.json) · [Restore receipt](evidence/backup-restore-2026-09-20/acceptance.json) · [Source manifest](evidence/backup-restore-2026-09-20/source-manifest.json).

The full suite includes 11 archive and five runtime regressions. An independent isolated database-helper pass adds 25 checkpoints for binary values, cyclic references, sequence state, RLS/grants, mutation refusal and uncertain commit recovery. Linux CI is required separately on the pull request; this local receipt does not claim its result.
