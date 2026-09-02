# Production-safe PostgreSQL migrations

`npm run db:migrate` is the production application migration command. It
applies every SQL file in [`database/`](database/) by contiguous filename
order. `npm run db:restore:migrate` uses the same runner only for the explicitly
identified isolated restore rehearsal. Neither command creates, renames, or
drops a database.

## Safety contract

The runner refuses to connect or mutate unless
`MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS=true` is present for that invocation.
The value is exact and case-sensitive. Do not make this a permanent application
environment variable.

For a hosted `DATABASE_URL`, additional gates are enforced:

1. The URL must include exactly one `sslmode=verify-full` parameter so the
   connection verifies both the provider's trusted certificate chain and the
   database hostname. `require`, `verify-ca`, `disable`, `allow`, `prefer`, a
   missing or duplicate mode, and non-PostgreSQL URLs are rejected.
2. The credential-free endpoint and provider target reference are hashed and
   compared separately as well as through the reviewed composite target
   identity. An isolated restore must not reuse the production endpoint even
   under a different reference.
3. The full build SHA and a checksummed mode-`0600` evidence manifest must
   match the exact local migration manifest. The final evidence, sealed
   pre-backup capture, and backup recovery point must each be no more than 24
   hours old when production consumes them.
4. Production additionally requires
   `MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true`; that acknowledgement is
   never accepted without the bound passing restore manifest.

The runner does not print `DATABASE_URL`, usernames, passwords, provider keys,
tokens, or other configured secrets. Success output contains only migration
filenames and counts; failure output is redacted.

Application stores share one postgres.js pool per running instance, pin
`search_path=public`, and default to four connections. Set
`MAINTAINFLOW_DATABASE_POOL_MAX` to an integer from 1 through 10 only after
checking the hosted database connection budget; every horizontally scaled or
serverless instance has its own pool. Migration tooling continues to use a
separate, short-lived privileged connection.

## Backup and restore gate

Before changing a hosted database that contains data:

1. seal the hosted source state in the mode-`0600` pre-backup evidence
   manifest;
2. create a provider snapshot or logical backup immediately before the release;
3. restore that backup into a separate, non-production PostgreSQL database;
4. apply the current checkout migrations to that explicitly identified clone
   with `npm run db:restore:migrate`;
5. run the read-only verifier against the migrated restored target and preserve its
   mode-`0600` passing evidence manifest;
6. only then set `MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true` for the
   migration process.

A backup that has not been restored is not a verified recovery path. A newly
created disposable integration database has no customer data to recover, but
the integration harness still sets the acknowledgement only inside that child
process. Follow the executable
[hosted database backup and restore runbook](database-backup-restore-verification.md)
for exact target identities, read-only roles, schema/count/isolation checks,
required metadata, and the complete evidence boundary.

## Run the migration

Load `DATABASE_URL` from the deployment secret manager rather than putting it
in shell history. After the applicable recovery checks:

```bash
MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS=true \
MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true \
MAINTAINFLOW_DATABASE_TARGET_REFERENCE='<production provider target reference>' \
MAINTAINFLOW_PRODUCTION_DATABASE_IDENTITY_SHA256='<reviewed production identity>' \
MAINTAINFLOW_BUILD_SHA='<full Git SHA used by the evidence>' \
MAINTAINFLOW_DATABASE_RESTORE_EVIDENCE_PATH='/restricted/evidence/restore-verification.json' \
npm run db:migrate
```

The backup/restore manifest and flag are not required for a loopback URL such
as `postgres://localhost/maintainflow`, but the mutation opt-in is always
required. The isolated hosted-clone command and its pre-backup evidence inputs
are documented in
[`database-backup-restore-verification.md`](database-backup-restore-verification.md).

## Ledger, ordering, and concurrency

The first successful run creates
`public.maintainflow_schema_migrations`. Each row records the complete migration
filename, the SHA-256 checksum of its exact UTF-8 contents, and the database
apply time.

Within one PostgreSQL transaction the runner:

1. sets a fixed `public` search path;
2. acquires a transaction-scoped advisory lock dedicated to this application;
3. creates the ledger if needed and checks every recorded checksum;
4. rejects unknown files, missing sequence numbers, ledger gaps, and checksum
   drift;
5. applies only the contiguous pending suffix in filename order, recording each
   checksum after its SQL succeeds.

Concurrent runners therefore serialize on the same database. All pending SQL
and ledger inserts commit together or roll back together. Migration SQL must
remain transaction-safe: do not add `CREATE INDEX CONCURRENTLY`, `VACUUM`, or
other statements PostgreSQL forbids inside a transaction.

Never edit a migration after it has been applied. If behavior must change, add
the next sequential migration file. If drift is
reported, restore the applied file byte-for-byte from the deployed revision and
add a corrective migration; do not update or delete ledger rows by hand.

Migration `017_customer_retention_purge.sql` extends the immutable customer
lifecycle receipt with externally confirmed provider-revocation evidence, a
finite retention deadline, and purge completion evidence. Its constraints keep
pre-purge identifiers complete and require them to be null after purge; the
partial `(retain_until, id)` index supports bounded due-retention discovery.

The application compiles the same ordered names and SHA-256 checksums into its
deployment-readiness contract. `/api/ready` compares that immutable manifest
with `maintainflow_schema_migrations`; a missing, extra, reordered, or
checksum-drifted row returns `503`. The manifest parity test fails CI whenever a
migration file changes without the reviewed compiled contract changing with it.

## Verification

Run the fast safety and planning tests:

```bash
npm run test:db-migrations
```

With a local disposable PostgreSQL server available, run:

```bash
npm run test:db
```

The disposable harness—not the production migration runner—creates a uniquely
named test database. It starts two migration processes concurrently, verifies
all filename/checksum ledger rows, reruns the application persistence suite,
and drops only the generated test database in `finally` cleanup. See
[`database-integration.md`](database-integration.md) for the evidence boundary.

These checks do not prove that a hosted backup can be restored, that production
roles have the intended privileges, or that an application deployment is
healthy. Preserve those as separate release gates.
