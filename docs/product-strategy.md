# MaintainFlow product strategy

## Product promise

MaintainFlow is the independent change-control and assurance layer for ChatGPT Ads:

> Preflight every change, route it to the right approver, apply the exact reviewed request, verify provider state, monitor the agreed safeguard, and retain a rollback-ready evidence trail.

The product does not promise autonomous optimisation, causal lift, organic ChatGPT visibility, or universal attribution. It helps agencies and commerce operators reduce avoidable account mistakes, measurement gaps, wasted spend, and client-reporting risk.

## Primary customer

The first paid customer is an independent performance or ecommerce agency with 5–50 staff, 10–50 client ad accounts, and at least two advertisers adopting ChatGPT Ads. The secondary customer is a multi-brand DTC or retail operator with the same approval, measurement, and change-control needs.

Solo advertisers, pure SEO teams, and highly regulated verticals are not the initial focus.

## Paid workflow

1. Capture exact provider, campaign, storefront, feed, and measurement evidence.
2. Rank issues by money at risk, delivery impact, confidence, and evidence freshness.
3. Show the proposed request, reason, safeguard, and rollback before approval.
4. Record the named operator or client decision.
5. Apply with idempotency, reconcile the provider result, and fail closed on uncertainty.
6. Compare an equal post-change evidence window against the stored baseline.
7. Produce a client-ready record of what changed, what happened, and what still needs review.

## Product boundaries

- OpenAI Ads Manager remains the system of record for native campaign management.
- MaintainFlow does not replace advertiser verification, billing, business-logo
  setup, native team administration, initial feed connection/full-catalog upload,
  or Ads Manager's own AI text customization and generic recommendations.
- A control visible in Ads Manager is not assumed to exist in the public API.
  Platform selection, billing, native users, provider change history, and text
  customization remain read-only or out of scope until the official API exposes
  and the acceptance suite verifies a documented operation.
- Readiness scores are an acquisition and preflight surface, not the whole paid product.
- Organic ChatGPT product discovery and paid product-feed campaign eligibility are separate; MaintainFlow must not imply one guarantees the other.
- Attribution partners remain attribution systems. MaintainFlow consumes their evidence and flags breakage or disagreement.
- Human approval remains mandatory for provider writes and rollback decisions until real-account evidence supports a narrower automation policy.
- Simulator outcomes are always labelled and never presented as live customer performance.

## Current implementation boundary

The current foundation lets an admitted agency create a database-backed
workspace and route either an exact labelled simulator recommendation or a fresh
live recommendation to a durable maker-checker queue. It retains the request,
rollback, evidence, safeguard, rationale-bound fingerprint, and decision
context; expires an undecided packet after seven days; rejects duplicate active
packets; and prevents the requester from deciding their own change. For live
agency work, one approved packet is atomically consumed into one durable
execution record; direct advertiser organizations keep a separate one-person
owner/admin path.

This does not yet deliver the complete paid workflow above. The product has an
opt-in, organization-allowlisted approval-email outbox, but it is not production
evidence until the Resend domain, signed webhook, hosted migration, cron, and two
real recipients pass the [delivery runbook](approval-notifications.md). It cannot
invite or self-service provision a second member and exposes no search or saved
filters across a long approval history. A bounded
operator command can add one existing, separately admitted Clerk user for a
controlled private-beta test, but it is database membership provisioning rather
than account creation, invitation, or member lifecycle management. The queue
itself is cursor-paginated in 50-row pages, with awaiting work ordered before
history. Approval alone sends no OpenAI Ads request; a separate explicit Apply
action rechecks current roles, packet freshness, provider state, and the exact
single-use binding. Hosted migration/grant deployment, member lifecycle,
delivery, and real-account evidence remain launch work rather than demonstrated
capabilities.

The local foundation now also compares every completed fresh full Ads snapshot
with a credential-independent durable baseline. It retains material before/after
evidence, separates changes consistent with a recorded MaintainFlow operation
from uncertain and unexplained changes, and routes the open items into both the
selected-account Experiments view and agency portfolio queue. The comparison is
snapshot-based rather than real-time and cannot identify an actor. Hosted
migration `022`, a real provider account, repeated full-sync evidence, and pilot
operator review remain required before this can be sold as production-proven.

## Market access update

Verified 4 September 2026: OpenAI now lists Ireland as available for
self-service Ads Manager access. The [European rollout
update](https://openai.com/index/chatgpt-ads-expands-across-europe/) says
self-service opened across the announced European markets on 31 August 2026,
and the current [Ads Manager availability
table](https://help.openai.com/en-us/articles/20001245-ads-manager-availability)
marks Ireland as available.

This removes geography as the reason to defer real-account acceptance. An owned
advertiser account is now accessible, but it still requires billing completion
and a business logo before serving, and no API key has been created. OpenAI's [Advertiser API
overview](https://developers.openai.com/ads/api-overview) says keys are issued
from Ads Manager Settings and each key is scoped to one ad account; programmatic
brand updates and conversion management can still require account-specific
enablement. The next external milestone is therefore to finish the account setup,
deliberately issue its account-scoped key, vault it server-side, and execute the
documented read-only acceptance run before any write test.

## Integration order

1. **OpenAI Ads API** — account hierarchy, insights, conversion settings, exact writes, readback, monitoring, and rollback.
2. **Shopify** — catalog/PDP/order truth, feed freshness, and revenue reconciliation.
3. **Google Ads** — read-only import of proven landing pages, conversion definitions, creative hypotheses, and comparable baselines.
4. **Meta Ads** — read-only creative evidence, event health, and cross-channel outcome context.
5. **Slack or Microsoft Teams** — exception escalation after the email delivery
   path is proven; neither chat connector exists in the current build.
6. **Measurement partners** — consume evidence from products such as Fospha or Triple Whale instead of rebuilding multi-touch attribution.

Direct OAuth connectors should only be built when a paid design partner needs them. Before that, prefer narrow imports or established connector partners so engineering stays focused on the evidence and control workflow.

## Commercial model

- Free: one credential-free readiness scan and report.
- Launch: $299/month for up to 5 connected advertiser accounts.
- Agency: $799/month for up to 20 accounts, approval workflows, monitoring, and rollback evidence.
- Scale: $1,499/month for up to 50 accounts, SSO, white-label evidence, and audit exports.
- Additional accounts: approximately $25/month each.

A portfolio of 100 Launch, 300 Agency, and 100 Scale customers equals approximately $5.03m ARR. This is target arithmetic, not evidence of current demand.

## Commercial proof gate

Do not treat code completion or market growth as product-market fit. Continue broad product investment only after five agencies pay at least $500/month, three complete the end-to-end workflow from issue discovery through a live monitored change and client report, and those three renew.

## Competitive lessons

- Mature PPC operations products set the baseline for multi-account triage, rules, pacing, alerts, permissioned changes, and client reporting.
- Native campaign creation, generic AI creative, AEO dashboards, feed optimisation, and attribution are already crowded or becoming platform features.
- The defensible asset is the evidence graph: observed state, proposed change, approval, exact request, provider acknowledgement, reconciliation, post-change outcome, and rollback history.
- The long-term moat comes from agency operating-procedure adoption, failure-pattern knowledge, and trusted audit history—not an API wrapper by itself.

### Direct-product benchmark reviewed 4 September 2026

- [AI-Advisors AI Ads](https://www.ai-advisors.ai/platform/ai-ads) presents a
  full OpenAI Ads campaign manager with campaign creation, write-back, creative
  preview, recommendations, site-readiness checks, and Google Ads import.
- [aematic](https://www.aematic.ai/) presents an autonomous, daily optimisation
  layer that creates campaigns and changes bids and pacing through the Ads API.
- [Serge](https://www.serge.ai/) presents a managed launch path with advertiser
  application support, campaign preparation, first-party tracking, and site
  readiness at a flat monthly price.
- OpenAI also says its partner ecosystem now includes more than 50 technology
  and measurement partners. Generic campaign CRUD and a one-off site scan are
  therefore not a credible standalone moat.
- [Optmyzr](https://www.optmyzr.com/) remains a useful cross-platform operations
  benchmark for investigation, budget alerts, repeatable routines, experiments,
  stakeholder reporting, and notification delivery.

MaintainFlow should not try to win by becoming another generic campaign builder
or by promising unsupervised optimisation. The paid wedge is agency-grade
change assurance: two-person approval, exact request and rollback capture,
fail-closed reconciliation, post-change safeguards, unexplained-change
detection, and client-defensible evidence across many accounts. To make that
wedge operationally complete, the next parity work is queue ownership and SLA,
search and saved views, production notifications, scheduled client reports,
self-service team administration, and Shopify-backed revenue evidence.

## Current evidence limits

Until a real advertiser credential is available, OpenAI Ads behavior is validated against the published schema and the stateful simulator only. Production claims still require a controlled live read, validation-only request where supported, an approved live packet enforced at the mutation boundary, reversible write, readback, monitoring window, rollback exercise, and an external pilot.
