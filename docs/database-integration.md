# Disposable PostgreSQL integration verification

The regular Vitest suite isolates application logic with mocks. The database
suite proves the production migration runner and persistence behavior against a
real PostgreSQL server without requiring Clerk or an OpenAI Ads credential.

## Run it

Start a local PostgreSQL server whose current user can create and drop
databases, then run:

```bash
npm run test:db
```

The runner connects to `postgres://localhost/postgres` by default. To use a
dedicated non-production admin connection instead:

```bash
MAINTAINFLOW_TEST_ADMIN_DATABASE_URL=postgres://user:password@host/postgres npm run test:db
```

Do not point this at a production database server. The supplied role must be
allowed to create and drop a temporary database.

## Safety boundary

The runner:

1. generates a unique database name beginning with
   `maintainflow_ads_test_`;
2. creates only that database, then starts two production migration processes
   concurrently with mutation permission scoped to those child processes;
3. verifies the migration ledger contains the filename and exact SHA-256
   checksum for every SQL file before passing the URL to isolated Vitest;
4. generates a temporary AES keyring and readiness HMAC secret, and removes
   provider Ads credentials from the child environment;
5. terminates connections to the exact generated database and drops only that
   database in a `finally` cleanup;
6. never contacts the OpenAI Ads API.

The production command in [`database-migrations.md`](database-migrations.md)
never creates or drops a database. Database creation/deletion exists only in
this explicitly disposable harness.

## What it proves

- migrations `001` through `013` apply together on PostgreSQL in filename
  order;
- concurrent migration runners serialize, record one immutable SHA-256 ledger
  row per file, and a subsequent runner is a checksum-verifying no-op;
- advertiser owners and agency managers receive their intended account roles;
- analysts/viewers can read but cannot write, unknown users are denied, and an
  already-claimed advertiser account cannot be claimed again;
- account keys are stored as ciphertext, decrypt for the correct account, and
  rotate with one active version;
- Pixel/CAPI pairs use a distinct purpose-bound encryption envelope, retain one
  active version per advertiser, preserve the direct/agency actor context, and
  cannot be replayed across accounts or substituted for an Ads API key; only a
  2xx status and 1–1,000 event count can be retained as validation evidence;
- a failed replacement insert rolls back the credential revocation;
- creative review baselines do not fabricate events, concurrent refreshes
  create one transition, stale provider snapshots cannot regress state, and
  histories stay isolated by advertiser account;
- request, rollback, evidence, provider-response, and rollback-response values
  remain JSONB objects rather than double-encoded JSON strings;
- successful and reconciled applies start an exact seven-day monitoring window,
  while one partial unique index allows only one active or uncertain approval
  for each account, recommendation, and entity;
- due monitoring rows stay account-scoped, concurrent workers claim a row once,
  abandoned claims become eligible after 15 minutes, and exactly one typed
  observation and safeguard outcome persists;
- concurrent public-audit checks enforce six requests per client and 30 per
  target host per fixed hour, reset at the next hour, retain only HMACed
  subjects, and prune expired buckets;
- concurrent recommendation dismissals produce one active, reason-backed row,
  remain isolated by advertiser account, retain the recommendation snapshot and
  actor roles, reject review-only restoration, and preserve a complete restore
  trail in the bounded account history query;
- readiness scans remain advertiser-account scoped, strip URL query strings
  before persistence, retain the scanner/ruleset provenance needed for safe
  comparison, and deny a review-only operator at the insertion query itself;
- only one concurrent rollback claim succeeds;
- ambiguous outcomes can be reconciled into a terminal audit state with the
  acting organization and roles preserved.

## What it does not prove

This suite does not prove a hosted PostgreSQL configuration, a real Clerk
session, a production proxy, deployment, or any OpenAI Ads read or write. Those
remain separate release gates.
