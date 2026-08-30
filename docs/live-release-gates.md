# Live Ads release gates

MaintainFlow defaults to demo data and cannot perform an external mutation. A
live Ads write is eligible only when every gate below is true on the server.

Production configuration is also an executable startup/deployment gate. `npm
start` validates before Next.js starts, the standalone container validates
before loading `server.js`, and Vercel production builds validate before the
application build. Local builds and strict demo previews remain
secret-independent; a preview that declares any live, non-demo, or public
sign-up intent is validated before build. A non-Vercel production build can opt in with
`MAINTAINFLOW_ENFORCE_PRODUCTION_CONFIG=true`.

Next.js inlines `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` into the browser bundle.
`npm run build` records a SHA-256 digest of that key and the public Clerk auth
routes in non-secret metadata. Generic `npm start` and the standalone container
compare the runtime values with the compiled digest before loading the server.
For the container, pass those public values as Docker build arguments and use
the same values at runtime; keep `CLERK_SECRET_KEY` and every Ads/database secret
runtime-only. Vercel supplies the public values to its production build from the
project environment.

## Required gates

1. An account-scoped OpenAI Ads Manager key is available from the encrypted
   customer vault or the server-managed pilot environment.
2. `OPENAI_ADS_DATA_MODE=live` is enabled and the live account sync succeeds.
3. Clerk server and publishable keys are configured.
4. The signed-in Clerk user belongs to an active organization with owner or
   manager access to the connected advertiser account.
5. `DATABASE_URL` is configured and the approval/monitoring migrations are current.
6. `OPENAI_ADS_LIVE_WRITES_ENABLED=true` is deliberately enabled.
7. The recommendation was regenerated from the currently synced live account.
8. Its conversion campaign passed the live event-setting readiness check.
9. The documented response parses, matches the resource ID, and an
   account-scoped detail GET confirms the requested state.

The UI remains in review-only mode when any gate is missing. The mutation route
repeats the authorization and source checks on the server; hiding or enabling a
client button is never treated as authorization.

In production, every privileged browser mutation also requires HTTPS and an
exact match with `MAINTAINFLOW_APP_ORIGIN`, with a streamed body-size cap.
`MAINTAINFLOW_TRUST_PROXY_HEADERS` stays false unless the deployment proxy
overwrites `X-Forwarded-Proto` and preserves the canonical public `Host` before
traffic reaches the app.

## Conversions API validate-only gates

The Conversions API uses a separate Ads Manager measurement credential and does
not share `OPENAI_ADS_API_KEY`. Every provider dry run remains globally disabled
unless:

- `OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED=true`;
- Clerk identity and database write access resolve for the selected account;
- migration `010` contains that account's active encrypted Pixel/CAPI pair; or
- the optional pilot fallback's `OPENAI_CONVERSIONS_ACCOUNT_ID`,
  `OPENAI_CONVERSIONS_PIXEL_ID`, and `OPENAI_CONVERSIONS_API_KEY` all resolve.

The protected route repeats Clerk authentication and database write access,
requires a secure same-origin production request, validates the documented body
on the server, and refuses anything other than `validate_only: true`. The
current transport cannot send a saved production event.

The protected connection route checks storage readiness, validates the candidate
pair with a dry run, then rotates the encrypted active version in a separate,
short PostgreSQL transaction. A provider failure or uncertain transport result
never stores the candidate. Direct-advertiser and agency actor roles remain in
the version history.

The implemented store is structurally multi-customer, but public release still
requires hosted migration/role verification, consent and data-processing review,
and real Ads Manager ownership, receipt, and attribution evidence.

## Approval-store migration

Apply migrations `001` through `012` in filename order before enabling the full
live product. Migration `005` adds the typed monitoring baseline, seven-day
timestamps, and partial unique index that prevents a second active approval for
the same recommendation. Migration `006` adds an atomic outcome, observation,
and evaluation timestamp. Migration `007` adds short-lived evaluation claims
and account/global due indexes so concurrent schedulers cannot process the same
window. Migration `008` adds shared, hashed readiness-audit quota buckets.
Migration `009` adds reversible, reason-backed recommendation dismissals
scoped to the advertiser account and exact proposed change. Migration `010`
adds purpose-bound, versioned Pixel/CAPI ciphertext with a single-active partial
index and direct/agency actor context. Migration `011` adds account-scoped
readiness-audit history and comparison evidence. Migration `012` adds
account-and-credential-generation-scoped live workbench snapshots with bounded
payloads, expiring refresh claims, and retry cooldown metadata. The app verifies
the required approval, tenancy, credential, and monitoring structures before
showing or accepting the live-write state.

Each record stores:

- account, operator, acting organization, roles, recommendation, and entity
  identifiers;
- exact request and rollback payloads;
- the evidence and safeguard shown during approval;
- pending, applied, failed, reconciliation-required, rollback-pending,
  rolled-back, rollback-failed, or rollback-reconciliation-required status;
- provider response or error and relevant timestamps.

The pending record is inserted before the OpenAI Ads request. If the provider
returns an HTTP error, the record is failed. If the request times out or loses
its connection, the record is marked `reconciliation_required`: the operation
must not be retried automatically because the provider may already have applied
it.

An applied record can be rolled back only after an authorized operator confirms
the stored request in the product. The record is atomically claimed before the
rollback is sent, so two operators cannot send it concurrently. HTTP failures
remain eligible for a deliberate retry; a timeout or lost connection becomes
`rollback_reconciliation_required` and must not be retried automatically.

For uncertain apply or rollback outcomes, an operator first verifies the live
account in Ads Manager and then records one of the allowed terminal outcomes
with a mandatory note. Reconciliation updates the internal audit record only;
it never sends an OpenAI Ads API request.

## Creative-history migration

Apply
[`database/004_creative_review_history.sql`](database/004_creative_review_history.sql)
to retain creative review and delivery transitions between live syncs. This
read-only history is not a write-authorization gate: if the migration is absent
or unavailable, current Ads data can still load and eligible approval writes
remain governed by the independent gates above. The Campaigns view reports the
history limitation rather than inventing or reconstructing missing events.

## Recommendation dismissal migration

Migration `009` makes a review decision durable without contacting OpenAI. A
dismissal stores the authorized operator and organization roles, a required
reason, the full recommendation snapshot, and a SHA-256 fingerprint covering
the recommendation rule, entity, priority, exact request, and rollback.

The fingerprint deliberately excludes the rolling measurement window so minor
metric refreshes do not recreate the same dismissed action. If the underlying
Ads setting changes, the proposed request changes, or severity moves between
medium and high, the fingerprint changes and the recommendation returns to
active review. An owner/admin with owner/manager account access can restore the
original decision; both actions are internal audit events and never send an Ads
API request. Active or unresolved approvals take precedence and cannot be
dismissed. Experiments reads the latest 100 decisions using an account-scoped
keyset-ready index and shows both the dismissal and restoration actor contexts.

## Local database proof

`npm run test:db` now applies all twelve migrations to a uniquely named,
disposable PostgreSQL database and exercises the real tenancy, credential, and
approval stores. It covers direct-advertiser and agency roles, review-only
access, duplicate account claims, encrypted key rotation with transaction
rollback, account-scoped creative transitions, stale snapshot rejection, typed
JSONB approval payloads, concurrent approval deduplication, exact monitoring
windows, account-scoped single-write monitoring outcomes, evaluation lease
expiry/recovery, concurrent readiness quotas, concurrent and account-scoped
recommendation dismissals, reversible decision audit data, concurrent rollback
claims, and manual reconciliation.
See [`database-integration.md`](database-integration.md) for the exact boundary.

## Scheduled monitoring

`vercel.json` invokes `GET /api/jobs/monitoring/evaluate` once daily at 01:15
UTC, a cadence compatible with Vercel Hobby. The route requires the server-only
`CRON_SECRET`, verifies monitoring storage, processes the oldest due accounts
in bounded batches, independently attempts retention cleanup, and returns
aggregate counts without account identifiers.
Vercel schedules run only on production deployments; a non-Vercel host must
invoke the same route with `Authorization: Bearer $CRON_SECRET`.

A worker atomically claims due rows with `FOR UPDATE SKIP LOCKED`, then releases
the database transaction before calling OpenAI. Successful observations clear
the claim as they are persisted. A failed or interrupted provider read remains
unevaluated and becomes eligible again after the 15-minute lease expires; it
does not trigger a rollback.

The same protected daily invocation independently prunes readiness rate-limit
buckets older than 48 hours and live workbench payloads whose confirmed sync age
exceeds 24 hours. Each cleanup is capped at 5,000 rows per invocation; reaching
that cap is treated as a visible backlog and returns HTTP 503 with a bounded
retry signal, without discarding completed monitoring outcomes.

## Current authorization model

The MVP uses Clerk for identity and PostgreSQL for authorization. A user must be
an owner, admin, or analyst in an active organization and that organization must
hold owner, manager, or viewer access to the advertiser account. Writes require
both an owner/admin membership and owner/manager account access.

`MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS` is deliberately narrower: it only permits
listed Clerk users to claim a newly connected, unowned account and create the
first workspace. It is not consulted for ongoing account access.

Public account creation is independently closed unless admission mode is
`open` and `MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED=true`. A private-beta deployment
therefore shows sign-in only and provisions invited Clerk users directly. The
Clerk tenant must also disable unrestricted hosted sign-up; that external
setting is verified separately from this application gate.

## Still required before public production

- Configure Clerk and apply the database migration in a non-production test
  environment.
- Configure a strong `CRON_SECRET` and verify one protected production cron run.
- Verify a real authenticated session and database record end to end.
- Configure and exercise the encryption keyring and credential migration in a
  non-production environment, including a real client-key rotation.
- Configure `READINESS_RATE_LIMIT_SECRET`, apply migration `008`, and test the
  trusted client-IP boundary on the production host.
- Configure a Vercel WAF rate-limit rule for the public readiness route, first
  in log mode and then in enforcement mode after observing real traffic.
- Run the contract suite against a real OpenAI Ads test account.
- Apply migration `010` on a disposable hosted database and exercise one direct
  advertiser and one agency-managed credential rotation through real Clerk
  sessions without relaxing account roles.
- Exercise one Conversions API `validate_only` request with the exact selected
  account, Pixel ID, and separately issued CAPI key; confirm ownership and the
  result in that account's Ads Manager before enabling broader measurement.
- Confirm the event-setting list shape and archived/source behavior against that
  account before relying on measurement-ready status.
- Observe one complete monitoring window against a real account before relying
  on the evaluator's result operationally. The implemented evaluation is
  non-mutating; keep rollback human-approved.
