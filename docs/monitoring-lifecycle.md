# Durable monitoring lifecycle

Verified against the official OpenAI Ads Insights and ad-group references on
30 August 2026.

## Purpose

MaintainFlow must not show the same live optimization again immediately after it
was applied, and a browser reload must not erase the promised monitoring window.
The durable lifecycle therefore begins before the provider write and remains
account-scoped through apply, reconciliation, rollback, and review.

## Stored baseline

The first live rule is the conversion-campaign CPA bid reduction. Its monitoring
plan stores:

- the exact Unix start and end used for both delivery and conversion Insights;
- spend and click-attributed conversions for the ad group;
- the derived click-attributed CPA;
- the pre-change `bidding_config.max_bid_micros` and account currency;
- a seven-day duration; and
- the explicit rule to review rollback when click-attributed conversions fall
  more than 15%.

OpenAI documents `impressions`, `clicks`, and `spend` as general Insights metrics.
Conversion Insights return click-through and view-through conversions separately,
and view-through remains reporting-only for CPA and bidding. MaintainFlow does
not mix the two attribution types.

## State transitions

1. A pending approval and its monitoring plan are inserted before the Ads API
   request.
2. A confirmed apply starts at the next full UTC hour, matching the Insights
   API boundary, and sets `monitoring_ends_at` exactly seven days later.
3. An ambiguous provider outcome remains `reconciliation_required` and has no
   monitoring start until an operator verifies that it was applied.
4. A verified `mark_applied` reconciliation starts a fresh full window because
   the true provider apply time is unknown.
5. Rollback-pending and rollback-uncertain records retain the original baseline
   and window for auditability.
6. Failed applies and completed rollbacks close the active recommendation slot;
   a later synced account review may produce a fresh recommendation.

## Completed-window evaluation

A protected daily job selects the oldest due advertiser accounts and claims a
bounded number of unevaluated records for each account. For each record it
requests the stored ad group over the exact completed full-hour range from
`GET /ad_groups/{id}/insights`, then requests the same range and entity from
`POST /conversions/insights` using that account's own encrypted credential.

The evaluator compares only `click_through_conversions` with the stored
seven-day baseline. A decline strictly greater than the stored 15% threshold
produces `safeguard_triggered`; exactly 15% remains `within_safeguard`. A
missing delivery row, missing conversion row, or invalid low-volume baseline is
stored as `insufficient_evidence` rather than converted to zero.

OpenAI's current conversion setup uses a 30-day attribution window. The
seven-day comparison is therefore a directional delivery guardrail, not a
causal incrementality claim: early post-change conversions can relate to prior
clicks, and later conversions can relate to clicks near the end of the window.

The outcome, full observation, and evaluation timestamp are inserted together.
An atomic `FOR UPDATE SKIP LOCKED` claim gives each worker a 15-minute lease;
the provider requests happen after that short transaction. Only the matching
account and claim can persist the result. A handled provider-read or persistence
failure releases only that record's matching claim so a bounded scheduler retry
can select it again. If the process is interrupted before it can release the
claim, the row becomes eligible after the 15-minute lease expires. The result
may recommend human rollback review, but the evaluator never calls an Ads
mutation endpoint.

The scheduler route returns HTTP 503 with a bounded `Retry-After` whenever any
selected account or window fails, while retaining successfully completed work.
This makes partial failure visible to deployment alerting rather than hiding it
inside a successful 2xx run. Logs contain aggregate counts and bounded error
class names, not account or approval identifiers, raw error messages, provider
bodies, credentials, or submitted event data.

The same protected run prunes live workbench payloads once their confirmed
`synced_at` age exceeds 24 hours (or an empty row's creation age does), without
letting failed refresh metadata extend that lifetime. Active refresh leases are
preserved; cleanup failure or a bounded cleanup backlog is reported as HTTP 503
instead of silently extending the documented retention window.

## Duplicate-write boundary

A partial unique index permits only one active or unresolved row for each
`(account_id, recommendation_id, entity_id)`. Concurrent approval attempts race
on that index: one inserts the pending record and the other stops before any
provider request.

## Evidence boundary

The local MVP proves the baseline, elapsed window, exact provider request shape,
pure threshold calculation, protected scheduler, expiring claim lease,
durable/idempotent result, rollback state, and duplicate-write boundary against
simulators and disposable PostgreSQL. It does not prove that a real OpenAI Ads
account returns the expected completed-window rows, that the production cron is
configured, that conversion attribution has matured at first evaluation, or
that a human rollback succeeds. A real eligible advertiser account and full
observed window remain release gates; automatic rollback is intentionally out
of scope.

## Official sources

- [Insights](https://developers.openai.com/ads/api-reference/insights)
- [Ad groups](https://developers.openai.com/ads/api-reference/ad-groups)
