# Production-safe PostgreSQL migrations

`npm run db:migrate` is the only application migration command. It applies the
SQL files in [`database/`](database/) by filename, beginning with the existing
`001` through `012` set. It connects to the database named by `DATABASE_URL`; it
never creates, renames, or drops a database.

## Safety contract

The runner refuses to connect or mutate unless
`MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS=true` is present for that invocation.
The value is exact and case-sensitive. Do not make this a permanent application
environment variable.

For a hosted `DATABASE_URL`, two additional gates are enforced:

1. The URL must include exactly one `sslmode=verify-full` parameter so the
   connection verifies both the provider's trusted certificate chain and the
   database hostname. `require`, `verify-ca`, `disable`, `allow`, `prefer`, a
   missing or duplicate mode, and non-PostgreSQL URLs are rejected.
2. `MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true` must attest that the
   recovery gate below has passed for the target release. The flag is an
   operator acknowledgement, not proof by itself.

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

1. create a provider snapshot or logical backup immediately before the release;
2. restore that backup into a separate, non-production PostgreSQL database;
3. verify the restored schema, critical row counts, account isolation, and one
   read path used by the application;
4. record the backup identifier/time, restore target, restore duration, checks,
   operator, and rollback decision point in the release evidence;
5. only then set `MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true` for the
   migration process.

A backup that has not been restored is not a verified recovery path. A newly
created disposable integration database has no customer data to recover, but
the integration harness still sets the acknowledgement only inside that child
process.

## Run the migration

Load `DATABASE_URL` from the deployment secret manager rather than putting it
in shell history. After the applicable recovery checks:

```bash
MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS=true \
MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true \
npm run db:migrate
```

The backup/restore flag is not required for a loopback URL such as
`postgres://localhost/maintainflow`, but the mutation opt-in is always required.

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
the next sequential file (for example, `013_description.sql`). If drift is
reported, restore the applied file byte-for-byte from the deployed revision and
add a corrective migration; do not update or delete ledger rows by hand.

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
