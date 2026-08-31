# MaintainFlow

MaintainFlow is a human-controlled optimization layer for OpenAI Ads. It turns
account delivery data into evidence-backed recommendations, shows the exact API
change and rollback, and requires approval before any external write.

## Current status

- Prodexa is the visual baseline for the marketing site.
- `/app` contains the working MVP review, campaigns, experiments, readiness,
  and customer workspace flows.
- Campaigns includes a read-only creative watchlist that separates rejected and
  in-review provider decisions from approved delivery state. OpenAI-supplied
  review reasons, evidence screenshots, appeals, and serving issues are retained
  and mapped to practical checks; unknown provider codes remain visible rather
  than being turned into an invented diagnosis.
- Live account refreshes retain account-scoped creative review and delivery
  transitions after the first baseline sync. Demo history remains explicitly
  labelled and is never presented as provider evidence.
- Live sync also verifies each active conversion campaign against the documented
  conversion event-setting list. Missing, archived, malformed, or unavailable
  measurement evidence is shown in Readiness and withholds conversion-bid
  recommendations rather than guessing.
- The Readiness workflow audits a public landing page without an Ads API key. It
  checks OpenAI crawler rules, crawlability, indexability, product structured
  data, offer facts, metadata, and sitemap discovery.
- The same screen includes a clearly labelled, schema-valid sample storefront
  result for sales demonstrations. Loading it makes no network request, stores
  no history, suppresses the external-page link, and keeps every limitation in
  the downloadable client report.
- Connected account owners and managers can retain the bounded readiness result
  and compare a repeat scan of the same URL. Query strings are removed before
  persistence, manual URLs remain explicitly unverified against provider
  destinations, and comparisons pause when the ruleset or scanner version
  changes. Analysts and viewers remain review-only.
- The same public-page audit looks for the exact OpenAI Measurement Pixel SDK,
  a non-placeholder Pixel initialization, documented event calls or image tags,
  a consent-control signal, and the required CSP origins. It never fires an
  event, exposes a detected Pixel ID, or presents static HTML as proof of
  conversion delivery or attribution.
- Readiness also audits a Google-compatible product feed locally in the browser.
  It checks the stable OpenAI commerce fields and Ads eligibility flag without
  uploading catalogue rows or claiming that feed ingestion or serving succeeded.
- A separate local Conversions API preflight validates server-event JSON against
  OpenAI's published batch, timestamp, event, data, and user-matching contract.
  It never accepts a Pixel ID or API key, makes no request, and does not retain
  pasted values or claim that OpenAI received an event.
- Completed storefront, product-feed, Conversions API, and connected-account
  measurement checks can be assembled into a client-ready HTML report. The
  report is created and downloaded in the browser from bounded findings, marks
  every untested section, and excludes raw feed rows, event payloads, Pixel IDs,
  API keys, bearer tokens, and stored credential material.
- A protected server endpoint can perform the next controlled step with
  `validate_only: true`. It is disabled by default, requires authenticated write
  access, and resolves an independently encrypted Pixel/CAPI pair for each
  advertiser account; it cannot send a saved event or reuse the Ads API key.
- Authorized direct advertisers and agency managers can submit a replacement
  Pixel/CAPI pair through a protected connection route. MaintainFlow validates
  the pair with a dry-run request before a short transaction rotates the active
  ciphertext; rejected or unconfirmed candidates are never stored.
- Workspace shows a privacy-safe measurement status for the selected advertiser
  and exposes the connection form only when identity, write access, encrypted
  storage, and the validate-only switch are available. The browser receives
  bounded validation metadata, never the Pixel ID, CAPI key, ciphertext, or
  submitted event payload.
- Public readiness audits use a shared PostgreSQL quota before any outbound
  fetch: six per client per hour and 30 per target host. Identifiers are HMACed,
  oversized streams are rejected, and production fails closed if the quota or
  trusted client-address boundary is unavailable.
- A production demo therefore requires authenticated PostgreSQL transport, a
  strong readiness-quota secret, identified legal/privacy/support contacts, and
  closed public workspace admission even though it needs no Ads credential.
- The app runs in truthful demo mode when no Ads API key is configured.
- Live reads require `OPENAI_ADS_DATA_MODE=live`, an account-backed
  `MAINTAINFLOW_RELEASE_STAGE` of `private_read` or `live_write`, and an
  account-scoped key from either the encrypted customer vault or the
  server-managed pilot environment.
- Demo/provider-simulator and real-account reads converge on the same strict
  workbench schema. Live snapshots are versioned by advertiser and credential
  generation; concurrent requests share one refresh, dashboards may show a
  clearly marked last-confirmed snapshot for at most 15 minutes, and mutation
  routes always require a newly refreshed snapshot.
- Live writes additionally require `OPENAI_ADS_LIVE_WRITES_ENABLED=true` and a
  recommendation generated from the synced live account. They also require a
  Clerk-authenticated operator with database-backed advertiser-account access
  and a verified PostgreSQL approval store. Demo resource IDs are never eligible
  for an external request.
- Direct advertisers and agencies use separate organization and account roles.
  Advertiser owners and agency managers can operate; analysts and viewers remain
  review-only.
- Signed-in customers can connect the key for their own advertiser account. The
  server validates it with `GET /ad_account`, encrypts it with AES-256-GCM, and
  stores only ciphertext; authorized owners/admins can replace it with a key
  that resolves to the same account.
- Operators with more than one authorized advertiser account can switch the
  active account from desktop or mobile. Every read, approval, rollback, and
  reconciliation resolves that account independently.
- Every live request is written to the approval store with its evidence and
  rollback payload before the Ads API is contacted. Network failures, timeouts,
  HTTP 408, and 5xx outcomes are marked for manual reconciliation and must not
  be retried automatically.
- Live recommendation dismissals require a reason and persist the account,
  operator, organization roles, full recommendation snapshot, and a stable
  fingerprint of the exact proposed change. Dismissals can be restored, and a
  materially changed action or priority surfaces as a new review item.
- Confirmed live changes start a durable seven-day monitoring window with the
  exact click-attributed baseline that produced the recommendation. Active or
  unresolved approvals suppress the same recommendation and block concurrent
  duplicate writes.
- A protected daily job evaluates due windows across connected advertiser
  accounts without requiring someone to open the app. A short PostgreSQL lease
  prevents duplicate workers; missing rows remain insufficient evidence and a
  safeguard breach only creates human rollback review.
- The Experiments view includes account-scoped approval history, confirmed
  rollback execution, note-backed reconciliation, elapsed monitoring state,
  reason-backed dismissal and restore history, and observed outcomes without
  fabricating missing performance.
- No Ads API credential or live advertiser account is included in this repo.
- `/api/health` reports process liveness and deployment revision, while the
  `MAINTAINFLOW_READINESS_PROBE_SECRET`-protected `/api/ready` separately fails
  closed on missing revision provenance, migration drift, or required storage.
  Neither endpoint contacts OpenAI.
- Server operations emit allowlisted one-line JSON events that exclude raw error
  messages, stacks, customer identifiers, URLs, payloads, and secrets. A manual
  hosted-smoke workflow proves the exact revision, readiness authentication,
  complete dependency checks, and one protected maintenance run.

The account-free demo, first read-only pilot, and controlled live-write release
are separated by explicit deployment gates documented in
[`docs/release-stages.md`](docs/release-stages.md).

## Run locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000` for the public site or
`http://localhost:3000/app?tab=review` for the product, or
`http://localhost:3000/app?tab=readiness` for the no-key commerce audit.

## Verification

```bash
npm run lint
npm run typecheck
npm run build
npm test
npm run test:ads-contract
npm run test:ads-simulator
npm run check:openai-ads-contract
npm run check:production-config
```

The Ads contract suite runs the complete live-read adapter and the Conversions
API validate-only transport against strict in-process simulators. It validates
production URLs, distinct authentication headers, resource pagination, insight
projections, conversion request encoding, fail-closed account binding, and
documented response schemas without a real advertiser credential. The
Conversions API response body is deliberately ignored because OpenAI does not
publish a stable schema for it; only the HTTP result is treated as evidence.

The simulator command separately verifies stateful provider mutations and
failure injection, the shared provider-to-workbench transformation, and the
direct-merchant and five-client agency sales workspaces.
The browser suite builds and serves the same standalone Next.js artifact used by
the production container; it does not substitute `next start` for the configured
standalone runtime.

The explicit OpenAI contract check downloads the current official Ads OpenAPI
document and compares all 88 reviewed operations, the base URL, authentication
and account headers, idempotency surface, core schemas, version, and checksum
with the checked-in manifest. It is a development/CI drift gate and is never
called by the application at runtime.

To verify the migrations and server stores against a disposable PostgreSQL
database rather than mocks:

```bash
npm run test:db
```

The database runner requires a local PostgreSQL server with database-creation
permission. Its safety boundary and coverage are documented in
[`docs/database-integration.md`](docs/database-integration.md).
The hosted migration command, checksum ledger, concurrency lock, TLS rule, and
backup/restore acknowledgement are documented separately in
[`docs/database-migrations.md`](docs/database-migrations.md).

The Ads contract and source documentation are recorded in
[`docs/openai-ads-contract.md`](docs/openai-ads-contract.md).
The stateful local scenarios and their evidence boundary are recorded in
[`docs/provider-simulator.md`](docs/provider-simulator.md).

The browser demo includes both a direct merchant and an explicitly labelled
five-client agency portfolio. The agency entry point is
`/app?tab=campaigns&account=adacct_sim_northstar`; it does not create tenant
access, persist credentials, or contact OpenAI.
The Readiness entry point also includes a `Load sample audit` action so the
storefront findings and client-report export can be demonstrated without
requesting a real shop URL.
The read-only first-key procedure is recorded in
[`docs/first-account-acceptance.md`](docs/first-account-acceptance.md).
The reviewed OpenAPI manifest and drift workflow are documented in
[`docs/openai-ads/README.md`](docs/openai-ads/README.md).
The readiness checks and their evidence boundary are documented in
[`docs/storefront-readiness.md`](docs/storefront-readiness.md).
Account-scoped scan persistence and comparison are documented in
[`docs/readiness-history.md`](docs/readiness-history.md).
The local catalogue checks and Ads Manager boundary are documented in
[`docs/product-feed-readiness.md`](docs/product-feed-readiness.md).
The local server-event contract and privacy boundary are documented in
[`docs/conversions-api-readiness.md`](docs/conversions-api-readiness.md).
The client-report composition and export boundary are documented in
[`docs/client-readiness-report.md`](docs/client-readiness-report.md).
The live-write interlocks and approval migration are documented in
[`docs/live-release-gates.md`](docs/live-release-gates.md).
The advertiser/agency access model is documented in
[`docs/customer-tenancy.md`](docs/customer-tenancy.md).
The dry-run-first customer export, access revocation, credential removal, and
retention boundary are documented in
[`docs/privacy-and-offboarding.md`](docs/privacy-and-offboarding.md).
The post-approval lifecycle is documented in
[`docs/monitoring-lifecycle.md`](docs/monitoring-lifecycle.md).
The secret-safe event contract, exact-revision smoke probe, alert policy, and
incident containment sequence are documented in
[`docs/production-operations.md`](docs/production-operations.md).
The account-side conversion checks are documented in
[`docs/conversion-measurement-readiness.md`](docs/conversion-measurement-readiness.md).
