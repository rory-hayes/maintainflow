# API-key expiry

Implemented locally on `codex/api-key-expiry`, based on `e446f6b`, on 13 September 2026. The **238-test serial suite**, typecheck and build passed. Fourteen local desktop/mobile browser checks then passed. After the browser fixes, the eight focused expiry tests, typecheck, hosted packaging, packaged runtime and six decoder checks passed. This feature is not yet deployed to the canonical hosted preview.

## Behavior

Workspace owners and administrators can create keys in Settings with **7 days, 30 days, 90 days, 1 year (365 days), or no expiry**. The initial selection is 30 days. The key is returned once; the reveal includes its expiry, and the list shows the expiry and server-derived Active, Expired or Revoked status. Revoked takes precedence over expired. The visible list polls every 30 seconds; authorization enforces the cutoff independently of that display interval.

`POST /api/workspace/api-keys` accepts optional `expiresAt` as a future ISO date/time with a timezone. Accepted offsets are normalized to UTC. Invalid, timezone-less or non-future values return HTTP 400 without creating a key or audit event. Omitted or explicit `null` retains the existing no-expiry API behavior; the Settings default does not impose a new default on older callers.

Bearer authentication permits an unrevoked key only when its expiry is absent or strictly later than the database clock. Equality and past expiry return HTTP 401 before updating last-use metadata or performing the requested operation. Cookie sessions, current membership roles, workspace boundaries and scopes retain their existing checks.

Expiry blocks subsequent API authentication. It does not cancel accepted worker jobs or shorten the separate lifetime of an already-issued storage URL.

The expiry is stored with the hashed key, and `api_key.created` records the expiry and deduplicated scopes in the same transaction. An audit failure rolls back creation. Neither list nor audit records expose the raw key. Automatic expiry does not delete or revoke the row, send a notification, or emit an expiry audit event. Existing keys retain no automatic expiry. Keys can be revoked, but their expiry cannot be extended; create and install a replacement before the cutoff.

The hosted additive migration was subsequently applied and verified in the existing SQL Editor: the ledger and nullable column are present, with zero pre-existing API keys. [Migration readback](evidence/api-key-expiry-2026-09-13/hosted-migration.json). The exact database-clock boundary also passed with a one-connection pool in an isolated private schema; its disposable database, roles and storage were removed. [Private-schema proof](evidence/api-key-expiry-2026-09-13/private-schema-boundary.json).

## Deployment and rollback

1. **Completed:** apply [migration 020](../migrations/020_api_key_expiry.sql) to the hosted `folio` schema using the separate migration identity, following [the existing-schema migration procedure](SUPABASE-DATABASE.md). Runtime roles do not own migrations.
2. **Completed:** verify the migration ledger and nullable `api_keys.expires_at` column before promoting this runtime. Vercel packaging does not apply database migrations. Authentication, listing and creation reference the column immediately.
3. Deploy and verify a future key, an expired key returning 401, and a preserved legacy key on the actual hosted runtime.

The migration is additive and compatible with the earlier runtime, but **rolling authentication back to pre-expiry code would accept expired, unrevoked keys**. Keep expiry enforcement in any rollback build, or explicitly revoke affected keys before restoring older authentication. Do not drop the column while expiry-aware code is running.

## Verification scope

The local browser check completed at **10:31:48 UTC on 13 September** with all 14 checks passing. It covered 7-day/no-expiry creation and revocation at 1440×1000 and 390×844, expired-key HTTP 401 without a last-use update, the 30-second status poll, reload, server redaction, help text, Escape focus return, and page/modal overflow. Browser testing also led to targeted focus-return and table-scroll fixes. [Browser results](evidence/api-key-expiry-2026-09-13/browser-results.json).

[The expiry tests](../tests/api-key-expiry.test.ts) cover invalid inputs, timezone normalization, creation/audit rollback, future and expired bearer requests, the exact database-clock boundary, legacy keys, scopes, tenant isolation, roles, session-only administration and redacted listing. These local results do not establish hosted migration or deployment acceptance. See [current hosted status](HOSTED-PREVIEW-STATUS-2026-09-13.md) for the separate provider and release states.
