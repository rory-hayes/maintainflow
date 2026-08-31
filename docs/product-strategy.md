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
- Readiness scores are an acquisition and preflight surface, not the whole paid product.
- Organic ChatGPT product discovery and paid product-feed campaign eligibility are separate; MaintainFlow must not imply one guarantees the other.
- Attribution partners remain attribution systems. MaintainFlow consumes their evidence and flags breakage or disagreement.
- Human approval remains mandatory for provider writes and rollback decisions until real-account evidence supports a narrower automation policy.
- Simulator outcomes are always labelled and never presented as live customer performance.

## Integration order

1. **OpenAI Ads API** — account hierarchy, insights, conversion settings, exact writes, readback, monitoring, and rollback.
2. **Shopify** — catalog/PDP/order truth, feed freshness, and revenue reconciliation.
3. **Google Ads** — read-only import of proven landing pages, conversion definitions, creative hypotheses, and comparable baselines.
4. **Meta Ads** — read-only creative evidence, event health, and cross-channel outcome context.
5. **Slack or Microsoft Teams** — approval delivery and exception escalation.
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

## Current evidence limits

Until a real advertiser credential is available, OpenAI Ads behavior is validated against the published schema and the stateful simulator only. Production claims still require a controlled live read, validation-only request where supported, reversible write, readback, monitoring window, rollback exercise, and an external pilot.
