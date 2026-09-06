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
   `MAINTAINFLOW_DATABASE_CA_CERT` must contain the provider's single current
   self-signed root CA for hosted connections; system trust alone is not used.
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

For the first initialization of a confirmed-empty hosted database, use the
separate [one-time empty hosted database bootstrap](empty-hosted-database-bootstrap.md).
That path refuses any existing public-schema object and is not valid for later
schema changes or a database that may contain customer state.

## Run the migration

Load `DATABASE_URL` from the deployment secret manager rather than putting it
in shell history. After the applicable recovery checks:

```bash
MAINTAINFLOW_DATABASE_CA_CERT='<secret-manager production root CA PEM>' \
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

Migration `018_supabase_data_api_hardening.sql` adds the three missing
organization foreign-key indexes, enables row-level security without Data API
policies on every MaintainFlow table and the migration ledger, and revokes
ambient schema, table, sequence, and function privileges from `PUBLIC` and any
present Supabase `anon`, `authenticated`, and `service_role` roles. It also
revokes matching default privileges for future public-schema objects.
MaintainFlow uses Clerk plus its server-only PostgreSQL connection rather than
Supabase Auth or PostgREST; keep the Supabase Data API disabled for this schema
and run hosted migrations as the privileged `postgres` migration role so its
defaults are hardened. Application traffic uses the separately reviewed
[`maintainflow_app` runtime role](runtime-database-role.md), whose exact grants
and deliberate zero-policy RLS boundary are documented independently from the
migration credential.

Migration `019_agency_change_approval_requests.sql` adds the credential-free
agency simulator decision queue. It stores an organization-scoped immutable
review packet containing the recommendation fingerprint and decision context,
exact request and rollback payloads, evidence, safeguard, requester snapshot,
and seven-day deadline. A partial unique index prevents a second awaiting packet
for the same exact recommendation, a monotonically increasing version fences
concurrent decisions, and the transition trigger permits only one move from
`awaiting_approval` to a terminal state. Approval and change requests require a
different agency owner or admin; simulator rows can never link to a live
`ads_approval_records` row.

Migration `020_live_change_approval_binding.sql` turns the reserved link into a
database-enforced live-write authorization boundary. Existing approval rows may
retain a null fingerprint for compatibility, while every new approval must carry
the exact 64-character approval fingerprint and an acting organization. A
deferred constraint requires each new agency approval to reach commit with
exactly one approved, unexpired, still-authorized request whose organization,
internal and external account, recommendation identity, fingerprint, mutation,
rollback, evidence, and safeguard match the pending unattempted approval.
Direct-advertiser approvals remain link-free and must match the active account
owner, current account-access grant, executor membership, and stored role
snapshots; an agency write cannot be disguised as a direct-account record.

The migration also rejects pre-decided request inserts, prevents duplicate
active unconsumed live packets, and freezes approval identity and evidence after
creation. Legacy live packets that lack the complete version-two review context
are expired while awaiting review or retired after approval, so they cannot
block a fresh executable packet. An approved packet is retired without changing
its decision when its database-timed window expires, its locked approver
membership is no longer owner/admin eligible, or its decision schema is not
executable; retirement is one-way, versioned, and mutually exclusive with an
execution link. The separately provisioned runtime role can insert only the
reviewed request-input columns, update only request lifecycle fields, and update
only Ads approval operation, rollback, reconciliation, and monitoring lifecycle
fields; deployment readiness verifies those exact column grants. Three authorization
tables expose one key column each solely so PostgreSQL can acquire their rows
with `SELECT ... FOR UPDATE`; enabled database guards reject every material
runtime update, and the restricted-login integration probe proves the lock and
rejection paths. RLS remains enabled with no browser Data API policy. The
application reads the selected agency in cursor-paginated 50-row pages,
ordering awaiting packets before newest history; each store page is bounded at
100 rows.

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
