# Shared request limits

The API-key expiry pull request exposed a pre-existing request-control gap: CodeQL reported 61 route findings under one missing-rate-limiting rule. Registration and login had a process-local counter; other database-backed routes were unthrottled. The release is held until the new control passes regression and security checks.

The API now registers the official Fastify rate-limit plugin at `onRequest`, before body parsing and authentication. PostgreSQL stores atomic request counters shared by application instances. The general budget is 300 requests per minute per client IP. Registration, login and password changes share a stricter 30-request budget per 15 minutes. Rejected requests return HTTP 429 with `Retry-After`; counter-store failures stop the request with HTTP 503.

IPv4 aliases share one identity, and IPv6 clients share their /64 prefix budget. Only a domain-separated HMAC-derived identifier is persisted, using the existing server encryption key. Raw IP addresses and credentials are not stored in the counter table. Counters have a database-clock expiry and bounded cleanup. The table is backend-only with forced row-level security; tenant and public roles have no direct access.

These budgets apply to signed provider callbacks and the authenticated worker route too. Their normal authentication and signature checks remain in place. Existing page quotas, decoder concurrency, upload reservation limits and worker limits continue to constrain individual operations. This control does not establish protection against every distributed denial-of-service attack.

Migration 021 must be applied before deploying the limiter. No new paid service, credential, hosting upgrade or application environment transfer is needed. The existing server key must remain stable across instances; rotating it starts a new set of opaque rate-counter identifiers.

Tests receive explicit, separate counter namespaces. Application instances within a test share their namespace; the deployed default is stable. The database-free packaging smoke uses an explicitly injected test store and proves packaging/hook operation only. Shared-counter behavior requires the PostgreSQL integration tests.

Validation passed: **247 serial tests**, typecheck, hosted packaging, six packaged decoders and **14 desktop/mobile browser checks**. The isolated package test also proves its limiter invokes the supplied store and returns 429 for an unknown API route. A read-only query plan confirmed the expiry index is usable for bounded cleanup. [Verification receipts](evidence/request-rate-limits-2026-09-13/verification.json).

Migration 021 is prepared and reviewed; applying it requires the Mac to be unlocked for the existing SQL Editor. GitHub security checks are being rerun. The current domain remains on the earlier runtime. See [hosted status](HOSTED-PREVIEW-STATUS-2026-09-13.md).
