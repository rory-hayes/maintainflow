# Hosted database backup and restore verification

This workflow proves that a specific hosted backup was restored into a
different PostgreSQL target, migrated there to the current checkout, and kept
the source's critical aggregate and tenant-isolation state. Source capture and
final verification are read-only; the separately gated clone-migration step is
the only mutation and can target only the declared non-production restore.
None of these commands creates a provider backup, restores a database, calls
OpenAI, or makes another provider request.

`npm run test:db` remains the disposable persistence test. It cannot replace
this workflow because its generated database contains no hosted customer or
recovery state.

## Safety contract

Use two dedicated read-only secret-manager values for capture and verification,
never the application's `DATABASE_URL`:

- `MAINTAINFLOW_BACKUP_SOURCE_DATABASE_URL` is the hosted production source
  used only to seal the pre-backup evidence;
- `MAINTAINFLOW_RESTORE_DATABASE_URL` is the isolated restored target used only
  for verification.

Bind each URL to its own secret-manager trust root:

- `MAINTAINFLOW_BACKUP_SOURCE_DATABASE_CA_CERT` authenticates only the source
  evidence connection; and
- `MAINTAINFLOW_RESTORE_DATABASE_CA_CERT` authenticates only the restored
  verifier connection.

The clone-migration and production-migration commands use the operator-level
`MAINTAINFLOW_DATABASE_CA_CERT`. Keeping the verifier roots separate prevents a
source certificate change from silently changing which restore trust anchor is
used.

Both URLs must use `postgres://` or `postgresql://`, name exactly one hosted
database, and include exactly one `sslmode=verify-full`. Loopback targets and
looser TLS modes are rejected. The script derives one SHA-256 endpoint identity
from the credential-free hostname, port, and database name and a separate hash
of the provider database/project reference. The existing reviewed target
identity binds both values, while the separate hashes prevent a production
endpoint from being relabelled as a restore merely by changing the operator
reference. Raw references are never written to evidence. The restore must use a
different endpoint and target identity from both source and production.

Endpoint comparison normalizes the configured hostname, port, and database
name, but it cannot prove that two different DNS or direct-versus-pooler aliases
do not reach the same underlying database. Review both provider target records,
use a provider-issued distinct restore endpoint, and keep the restore isolated;
shared-pooler clones with the same endpoint are intentionally unsupported by
this fail-closed workflow.

Create separate verifier login roles with `USAGE` on `public` and `SELECT` on
the MaintainFlow tables only. Revoke `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`,
DDL, role-management, and superuser privileges. Verification fails if the
connected role has any of those table-write privileges, even though every
inspection also runs in one `REPEATABLE READ READ ONLY` transaction with:

- `search_path=pg_catalog, public`;
- `statement_timeout=30s`;
- `lock_timeout=5s`; and
- `idle_in_transaction_session_timeout=45s`.

Stop application writers, monitoring jobs, readiness-history writes, and
customer traffic before the pre-backup capture. Keep them stopped until the
provider backup's recovery point is recorded. Exact row-count comparison is
deliberately strict and should fail if the source changed between capture and
the backup.

## Evidence directory

Create a restricted evidence directory outside the repository and deployment
artifact. The two output files must be new absolute paths; the runner uses
exclusive, no-follow creation, fsyncs each file, and verifies mode `0600`. It
refuses to read a symlink, non-regular file, loose permissions, empty file, or
manifest larger than 256 KiB.

Do not put one-shot recovery variables in `.env`, CI artifacts, command
history, tickets, or chat. Inject them from the secret manager into the one
operator session. Retain the two evidence files according to the customer
agreement and incident policy.

## 1. Identify and capture the source

First derive the source identity. The command prints only the SHA-256 identity,
not the URL, database name, username, or password:

```bash
MAINTAINFLOW_BACKUP_SOURCE_DATABASE_URL='<secret-manager source URL>' \
MAINTAINFLOW_BACKUP_SOURCE_TARGET_REFERENCE='<provider database/project reference>' \
npm run db:backup:source-identity
```

Review that identity against the production inventory. Then capture evidence
immediately before requesting the backup:

```bash
MAINTAINFLOW_BACKUP_SOURCE_DATABASE_URL='<secret-manager source URL>' \
MAINTAINFLOW_BACKUP_SOURCE_DATABASE_CA_CERT='<secret-manager source root CA PEM>' \
MAINTAINFLOW_BACKUP_SOURCE_TARGET_REFERENCE='<same provider target reference>' \
MAINTAINFLOW_BACKUP_SOURCE_IDENTITY_SHA256='<reviewed source identity>' \
MAINTAINFLOW_PRODUCTION_DATABASE_IDENTITY_SHA256='<same reviewed identity>' \
MAINTAINFLOW_BUILD_SHA='<full 40- or 64-character release-candidate Git SHA>' \
MAINTAINFLOW_RECOVERY_RUN_ID='<new UUID for this rehearsal>' \
MAINTAINFLOW_RECOVERY_OPERATOR_REFERENCE='<internal operator reference>' \
MAINTAINFLOW_BACKUP_REFERENCE='<planned provider backup reference>' \
MAINTAINFLOW_PRE_BACKUP_EVIDENCE_PATH='/restricted/evidence/pre-backup.json' \
npm run db:backup:capture
```

The source manifest seals the full build SHA, recovery-run identity, hashed
operator/backup references, exact source target identity, the exact
checksum-valid prefix of local migrations currently applied to production, the
full intended local migration-manifest hash, deterministic
table/column/constraint/index evidence, bounded critical table counts, and
zero-valued access/isolation/orphan checks. Production is allowed to be behind
the checkout by a contiguous pending migration suffix; unknown, reordered,
gapped, or checksum-drifted ledger rows fail capture.
It never contains the database URL, hostname, database name, credentials,
customer identifiers, row payloads, provider payloads, or raw operator/backup
references.

After the manifest exists, create the provider backup and record:

- provider and backup type;
- exact backup reference;
- backup creation time and recovery-point time in UTC;
- restore job reference, completion time, and duration; and
- the reviewed rollback decision time.

Every timestamp must use the exact JavaScript UTC ISO form, for example
`2026-09-02T10:02:00.000Z`.

## 2. Restore to a distinct target and verify

Restore the recorded backup through the hosting provider into an isolated,
non-production PostgreSQL database. Create a dedicated read-only verifier role
on that restored target, then derive its identity:

```bash
MAINTAINFLOW_RESTORE_DATABASE_URL='<secret-manager restore URL>' \
MAINTAINFLOW_RESTORE_TARGET_REFERENCE='<provider restore target reference>' \
npm run db:restore:target-identity
```

Review that it differs from production. Using the restored target's dedicated
migration role, apply the checkout's pending suffix to the isolated clone:

```bash
DATABASE_URL='<secret-manager restore migration URL>' \
MAINTAINFLOW_DATABASE_CA_CERT='<secret-manager restore migration root CA PEM>' \
MAINTAINFLOW_DATABASE_TARGET_REFERENCE='<same restore target reference>' \
MAINTAINFLOW_PRODUCTION_DATABASE_IDENTITY_SHA256='<reviewed production identity>' \
MAINTAINFLOW_RESTORE_TARGET_IDENTITY_SHA256='<reviewed restore identity>' \
MAINTAINFLOW_BUILD_SHA='<same full Git SHA>' \
MAINTAINFLOW_PRE_BACKUP_EVIDENCE_PATH='/restricted/evidence/pre-backup.json' \
MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS=true \
npm run db:restore:migrate
```

This command accepts the pre-backup evidence only while it is at most 24 hours
old. It recomputes the restore endpoint identity and provider-reference hash
independently, proves the endpoint differs from production even when a different
reference is supplied, binds the build to the pre-backup manifest's complete
local migration hash, and then uses the normal advisory-locked migration
transaction. It cannot be used against the source/production endpoint.

Return to the restored target's dedicated read-only verifier role and run the
complete verification:

```bash
MAINTAINFLOW_RESTORE_DATABASE_URL='<secret-manager restore URL>' \
MAINTAINFLOW_RESTORE_DATABASE_CA_CERT='<secret-manager restore root CA PEM>' \
MAINTAINFLOW_RESTORE_TARGET_REFERENCE='<same provider restore target reference>' \
MAINTAINFLOW_RESTORE_TARGET_IDENTITY_SHA256='<reviewed restore identity>' \
MAINTAINFLOW_PRODUCTION_DATABASE_IDENTITY_SHA256='<reviewed production identity>' \
MAINTAINFLOW_BUILD_SHA='<same full deployed Git SHA>' \
MAINTAINFLOW_RECOVERY_RUN_ID='<same recovery UUID>' \
MAINTAINFLOW_RECOVERY_OPERATOR_REFERENCE='<same operator reference>' \
MAINTAINFLOW_BACKUP_REFERENCE='<same provider backup reference>' \
MAINTAINFLOW_BACKUP_PROVIDER='hosted_postgres' \
MAINTAINFLOW_BACKUP_TYPE='physical_snapshot' \
MAINTAINFLOW_BACKUP_CREATED_AT='<exact UTC instant>' \
MAINTAINFLOW_BACKUP_RECOVERY_POINT_AT='<exact UTC instant>' \
MAINTAINFLOW_RESTORE_REFERENCE='<provider restore job reference>' \
MAINTAINFLOW_RESTORE_COMPLETED_AT='<exact UTC instant>' \
MAINTAINFLOW_RESTORE_DURATION_SECONDS='<0 through 86400>' \
MAINTAINFLOW_ROLLBACK_DECISION_AT='<exact reviewed UTC instant>' \
MAINTAINFLOW_PRE_BACKUP_EVIDENCE_PATH='/restricted/evidence/pre-backup.json' \
MAINTAINFLOW_RESTORE_VERIFICATION_EVIDENCE_PATH='/restricted/evidence/restore-verification.json' \
npm run db:restore:verify
```

Final verification must run while both the pre-backup capture and the recorded
backup recovery point are at most 24 hours old. Verification succeeds only when:

1. the pre-backup manifest is an intact mode-`0600` file with a valid internal
   checksum;
2. the full build SHA, recovery run, hashed operator/backup references, and
   declared production identity match the sealed source evidence;
3. the restore target is not the source or production target;
4. recovery timestamps are ordered and not in the future;
5. the database confirms the exact database name and read-only session
   controls;
6. the source ledger is the same exact local prefix sealed before backup and
   the restored ledger contains the full current local migration set;
7. before-and-after table/column/constraint/index evidence is recorded (schema
   fingerprints may legitimately differ because the clone was migrated);
8. every source critical-table count is preserved after restore and migration;
   newly introduced tables may add separate after-count evidence; and
9. all role, owner, cross-tenant access, approval, dismissal, conversion, and
   readiness-audit orphan invariants are zero.

The passing restore manifest contains separate hashed endpoint and provider
reference identities, the sealed pre-backup capture time, full non-secret
backup/restore timing metadata, the source manifest checksum, explicit
`before` and `after` ledger/schema/count/invariant evidence, and
`result: "passed"`. Preserve both manifests together.

## 3. Bind the production migration to the evidence

`db:migrate` will not connect to a hosted production target based on the
boolean acknowledgement alone. While the final verification, sealed
pre-backup capture, and backup recovery point are all still within 24 hours,
provide the passing mode-`0600` restore manifest and the same exact build and
production target identity:

```bash
DATABASE_URL='<secret-manager production migration URL>' \
MAINTAINFLOW_DATABASE_CA_CERT='<secret-manager production root CA PEM>' \
MAINTAINFLOW_DATABASE_TARGET_REFERENCE='<production provider target reference>' \
MAINTAINFLOW_PRODUCTION_DATABASE_IDENTITY_SHA256='<reviewed production identity>' \
MAINTAINFLOW_BUILD_SHA='<same full Git SHA>' \
MAINTAINFLOW_DATABASE_RESTORE_EVIDENCE_PATH='/restricted/evidence/restore-verification.json' \
MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS=true \
MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true \
npm run db:migrate
```

Before opening the database connection, the runner rechecks the manifest
checksum and mode, final evidence age, pre-backup capture age, backup
recovery-point age, passing result, separate endpoint/reference bindings,
source/production/restore separation, full Git SHA, exact current migration
filenames and checksums, and preserved counts/invariants. A copied boolean,
stale capture or recovery point, different build, different production target,
or incomplete clone ledger fails closed before any migration SQL runs.

## Failure handling and release boundary

Any failure leaves the restore unverified. Do not set
`MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true`, do not migrate the hosted
production database, and do not promote the release. Keep the restored target
isolated,
investigate through the provider's secure console, correct the backup or role,
and repeat the entire capture-backup-restore sequence with new evidence paths
and a new recovery-run UUID.

Run the workflow tests with:

```bash
npm run test:db-restore
```

Those tests prove local validation, read-only transaction construction,
manifest permissions/checksums, evidence comparison, and secret-safe failures.
Only a passing run against the actual hosted source backup and distinct restore
target proves the operational recovery gate. It still does not prove the web
deployment, OpenAI Ads behavior, provider key access, alert delivery, or an
external customer's workflow.
