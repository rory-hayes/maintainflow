# Stateful OpenAI Ads provider simulator

The local provider simulator exercises MaintainFlow before a real advertiser
account is available. It is a fetch-compatible test harness, not an alternate
Ads API host and not evidence of live account behavior.

## Scenarios

- `healthy`: normal hierarchy and delivery with no urgent optimization;
- `overspending`: campaign, ad-group, ad, delivery, conversion, and event-setting
  data that produces an evidence-backed recommendation;
- `creative_review`: deterministic in-review, rejection, appeal, and approval
  transitions; and
- `empty`: a valid account with no campaign hierarchy, used for creation and
  empty-state coverage.

Each scenario is schema-validated before it can serve a request. Pagination,
account isolation, detail reads, delivery and conversion insights, reversible
updates, activate/pause actions, creates, and idempotent create replays are
stateful rather than fixed response snapshots.

## Browser sales workspaces

The public workbench also has two explicitly labelled, provider-free sales
workspaces. They never create `AccountAccess`, never store credentials or
approval records, and simulated approvals remain inside the browser session:

- `/app?tab=review` opens a single direct-merchant workspace;
- `/app?tab=campaigns&account=adacct_sim_northstar` opens a five-client agency
  portfolio, starting on a roughly EUR 20,000 month-to-date account.

The agency selector changes only schema-valid fixture data. A signed-in,
connected advertiser always takes precedence over a simulator account query,
and every simulator recommendation retains `source: demo` with external writes
disabled. The CPA bid example mirrors the request shape and safeguard used by
the current deterministic live rule. Creative, context-hint, and destination
examples remain illustrative simulator workflows until equivalent live rules
are implemented and account-tested.

The existing-agency connection flow is also testable without a real key. Route
tests substitute the provider account lookup while keeping the production
authorization, request schema, encryption boundary, and response contract;
PostgreSQL integration tests then prove idempotent attachment, cross-agency
conflicts, lifecycle rejection, and concurrent-claim serialization. This does
not prove that OpenAI will accept a future key or return the expected account.

## Failure injection

Tests can queue one-shot `401`, `403`, `429`, `500`, timeout, or ambiguous-write
faults. An ambiguous write commits the simulated provider state and then loses
the response, allowing MaintainFlow's no-retry and reconciliation behavior to
be verified without pretending to know the external result.

Full live-read simulations share one request-scoped usage budget: at most 256
provider attempts, 10,000 returned resources, five concurrent requests, and 45
seconds for the complete sync.
Those limits accommodate a moderate advertiser hierarchy while bounding the
current per-campaign and per-ad-group fan-out. Larger accounts fail closed and
need a deliberately redesigned sync (for example, durable incremental import),
not a partially labelled snapshot or a higher environment-variable limit.

Safe reads retry at most twice after `429`. A valid `Retry-After` is honoured
only when it fits the bounded two-second retry window; a longer provider delay
is returned as an error without retrying early. Timeouts and all mutation
requests are not retried. Any page, dataset, or budget failure aborts sibling
reads and discards the entire assembled result, including conversion settings.
No live response or in-flight promise is cached across requests, so advertiser
data cannot be reused under another account or credential.

The production parser also enforces response-byte ceilings independently of
pagination: 16 MiB for a read and 1 MiB for a mutation acknowledgement. Tests
cover both a declared oversized body and a chunked body with no
`Content-Length`; an oversized apply or rollback response is not retained and
enters manual reconciliation because the provider may already have committed
the write.

```bash
npm run test:ads-simulator
```

That command verifies the fetch-compatible provider, the shared provider-to-UI
workbench builder, and both browser workspace fixture families.

The browser acceptance suite exercises the compiled simulator as an agency
operator, including account isolation, local-only recommendation approval,
reload reset behavior, hostile deep-link fallback, and the 390 x 844 mobile
workspace:

```bash
npm run test:e2e
```

When `PLAYWRIGHT_BASE_URL` is unset, the suite builds and starts a sanitized
`demo` release on `127.0.0.1:3100`. CI points the same tests at the production
container after its database readiness checks pass.

The simulator accepts only requests to
`https://api.ads.openai.com/v1`, never records bearer tokens, has no environment
or base-URL switch in production code, and refuses construction when
`NODE_ENV=production`.

## Evidence boundary

The simulator can prove local request encoding, response parsing, state
transitions, pagination, account scoping, bounded local retry/concurrency
behavior, failure handling, and guarded reconciliation. It cannot prove real
authentication scopes, provider review timing, the provider's actual rate-limit
policy, delivery, auction outcomes, attribution, or account permissions. Those
remain gates in the first-account acceptance runbook.
