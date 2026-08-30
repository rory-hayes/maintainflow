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

## Failure injection

Tests can queue one-shot `401`, `403`, `429`, `500`, timeout, or ambiguous-write
faults. An ambiguous write commits the simulated provider state and then loses
the response, allowing MaintainFlow's no-retry and reconciliation behavior to
be verified without pretending to know the external result.

Full live-read simulations share one request-scoped usage budget: at most 256
provider attempts, 10,000 returned resources, and five concurrent requests.
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

```bash
npm run test:ads-simulator
```

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
