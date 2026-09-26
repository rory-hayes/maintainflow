# Billing launch acceptance

Prepared 2026-09-26 against the `codex/launch-readiness` source. This is an execution checklist, not evidence that Stripe sandbox or live payments have passed. Preparing it did not contact Stripe, change an account or environment, send mail, or take a payment. Keep the existing mock preview until the relevant cutover is explicitly approved.

Billing is ready for customers only after the exact release passes local checks, the owned sandbox lifecycle below, the preview/test entitlement disposition, and a separately approved live cutover. Infrastructure account upgrades do not complete these gates.

## Current application contract

The authoritative implementation is [providers.ts](../server/integrations/providers.ts), [provider-policy.ts](../server/integrations/provider-policy.ts), [mock-billing.ts](../server/integrations/mock-billing.ts), [plans.ts](../shared/plans.ts), [workspace-routes.ts](../server/core/workspace-routes.ts), and [migration 038](../migrations/038_stripe_billing_modes.sql). The operator should bind the acceptance receipt to the deployed commit and current configuration; older screenshots or a preview build are not current billing evidence.

| Plan | Current monthly EUR price | Pages per calendar month | Active parsers | Concurrent jobs |
| --- | ---: | ---: | ---: | ---: |
| Explore | 0 | 50 | 1 | 1 |
| Standard | 19 | 300 | 10 | 2 |
| Team | 49 | 1,000 | 50 | 4 |

These launch prices were selected under the operator's authorisation on 26 September 2026. Combined monthly AI field/split suggestion allowances are 3 / 5 / 20 for Explore / Standard / Team; they are separate from page credits. Paid Prices must match the configured IDs, EUR amount, monthly interval with interval count 1, licensed/per-unit billing, and no quantity transformation. An entitled subscription has exactly one item with quantity 1. Checkout accepts a plan ID, never a client-supplied Price or quantity.

The older Stripe test catalogue at €29/€79 is not compatible with this offer and must be replaced with new Price objects before sandbox acceptance. Existing stored workspace allowances and provider objects are not silently rewritten by this source change. The 26 September hosted inventory found no paid entitlements or subscription rows; repeat that check before activation. The operator confirmed Rory Hayes, no current VAT registration, and no discretionary refunds, with mandatory statutory rights preserved. Postal address and telephone details are deferred by the operator and remain unfinished launch disclosures.

| Surface | Actual behavior |
| --- | --- |
| `POST /api/billing/checkout` | Browser session with **owner or admin** role; strict body `{"planId":"standard"}` or `{"planId":"team"}`. Returns a provider URL and mode. |
| `POST /api/billing/portal` | Same session/role requirements; body `{}`. Requires the workspace's customer in the selected mode. |
| `POST /api/billing/webhook` | Raw signed JSON, maximum 1 MiB. Supported matching-mode events return `202` after durable storage; a repeated ID returns `duplicate:true`. |
| `GET /api/providers/status` | Configuration status and mode. Stripe `verified:false` is deliberate: this endpoint does not certify payment acceptance. |
| `GET /api/workspace/usage` | Effective workspace plan, current usage and retained ledger. Use this, actual quota behavior and the reconciled subscription together. |

Billing management is not owner-only. Editor/viewer sessions, API keys and foreign-workspace access must be refused. Browser-origin checks still apply. If owner-only management is required commercially, that is a separate behavior change before launch.

### When access changes

The worker rereads the customer's current subscriptions under the local customer lock. It does not grant a plan from an incoming event's metadata, its invoice amount, or the Checkout return URL.

| Current verified subscription state | Effective access |
| --- | --- |
| `active` or `trialing`, one exact mapped Price and quantity 1 | Corresponding Standard or Team limits |
| `active` with `cancel_at_period_end:true` | Paid limits continue while the subscription remains active |
| `incomplete`, `incomplete_expired`, `past_due`, `unpaid`, `paused`, `canceled`, no subscription, or an unmapped/nonconforming plan | Explore limits |
| Wrong provider mode/customer, or an incomplete subscription listing (`has_more`) | Reconciliation fails without partially changing entitlements; durable worker retry/error handling applies |

`invoice.payment_failed` is a prompt to reconcile, not proof of `past_due`. If Stripe still reports an eligible active subscription, access remains paid. A recovered subscription remains paid when an older failure event is delivered later; an old success must not restore access after actual cancellation.

Downgrading preserves existing documents, original files, parsers and usage history. New work follows the resulting quotas; a workspace already above its new parser limit cannot create another parser. Renewal does **not** reset usage. The current monthly usage query starts at database `date_trunc('month', now())`, not the customer's Stripe renewal date. Approve and disclose this calendar-month model, including the production database timezone, or implement and verify an explicitly chosen billing-period model before selling a different promise.

## 1. Local release evidence

- [ ] Run the exact release in a disposable copied checkout with private socket-only PostgreSQL, or the explicitly isolated CI database. Never use the normal fixture database or load the hosted `.env` for this acceptance.
- [ ] Pass existing [Stripe mode tests](../tests/stripe-billing-modes.test.ts), [provider tests](../tests/providers.test.ts), [mock billing tests](../tests/mock-billing.test.ts) and [mock UI tests](../tests/mock-billing-ui.test.ts), plus [billing launch acceptance tests](../tests/billing-launch-acceptance.test.ts).
- [ ] Record TypeScript, relevant browser checks, the full release suite and build results against the same commit. A test using mocked Stripe transport is not a Stripe account or real-payment check.

Existing tests cover mode/key/catalog/portal validation, browser role and tenant boundaries, Checkout reservations and lost replies, signed receipt deduplication, and historical mode isolation. The new launch tests cover renewal failure/recovery, scheduled/final cancellation, stale-event reconciliation, trial/incomplete/unpaid states, refusal of unsafe provider snapshots, preserved sources/parsers/usage, and an unaffected second workspace.

The new tests submit real application webhook requests with synthetic signatures, then call reconciliation with controlled provider state. They intentionally do not claim an automatic hosted Stripe worker or successful real Stripe transport. The sandbox phase must prove durable events reach `completed` through the deployed worker. On 2026-09-26 the frozen source passed the combined isolated suite, **151/151 tests including these two new tests**, plus TypeScript, frontend build and package build. Bind that result to the combined-run source receipt in the release handoff; it is local evidence only.

## 2. Owned Stripe sandbox acceptance

Use only the explicitly approved Stripe sandbox/test account and dedicated owned workspaces. No customer data, live card, live key, live subscription, or outbound invitation is required. Arrange test membership fixtures through the approved local/account QA process rather than sending unsolicited mail. Choose the exact sandbox before configuring anything; sandbox approval does not authorize live cutover.

### Setup and evidence boundaries

- [ ] Record the exact app commit/origin, owned workspace identifiers, expected account and test mode, operator and UTC time. Keep secrets, cookies, card data, signing headers and reusable Checkout/portal links out of the receipt.
- [ ] Configure the approved test server key, `STRIPE_MODE=test`, test webhook signing secret, distinct Standard/Team Price IDs and exact `APP_ORIGIN` through the secure server configuration path. Disable mock billing only in this approved sandbox deployment. Client bundles must not contain these secrets.
- [ ] Verify both Prices against the table above. Configure an explicit test portal configuration even though test mode can operate without one; using the default portal would leave the live configuration contract untested.
- [ ] Verify the portal is active, allows cancellation, and, if plan changes are offered, permits only the approved plan Prices without quantity changes. Confirm the intended payment-method, proration, cancellation timing and customer-facing text in the actual provider UI. Application validation does not decide these commercial policies.
- [ ] Register the correct test webhook destination `/api/billing/webhook` with its own secret and all eight supported event types listed below. Verify the deployed worker can process provider events and that failed/exhausted processing is observable.
- [ ] Keep one owned second workspace as an isolation control. Capture initial plan, ledger/page totals, active parser count and hashes of a synthetic retained original. Do not reset usage to make assertions pass.

Supported events are `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, and `invoice.payment_action_required`. Unsupported types or events without a customer are acknowledged as ignored. This account billing endpoint rejects connected-account (`event.account`) events.

### Checkout and permissions

1. As the owned owner, open Standard Checkout from the application. Confirm mode, currency/amount, monthly cadence, exact workspace-bound customer and configured Price. Merely creating the session must leave Explore limits unchanged.
2. Cancel/abandon Checkout and revisit `/app/usage?checkout=canceled`; then visit a success-shaped return without paying. Neither navigation may grant paid access.
3. Repeat the same Checkout request while the session is open. It must reuse the session. Exercise simultaneous clicks and a controlled lost response: the durable reservation must recover one customer/session using the same idempotency identity, rather than create a second purchase. Use a fault-injection setup approved for this sandbox, not an uncontrolled production interruption.
4. Change the selected plan with a known open session; the old session should be expired before replacement. An unresolved reservation for another plan must return `409`. An unresolved reservation older than 23 hours must stop for operator reconciliation, not silently mint another idempotency key. Preserve historical test reservations using their original key format.
5. Confirm an existing nonterminal subscription, including incomplete or past-due state, directs the customer to the portal instead of offering another subscription (`409`).
6. Confirm owner and admin browser sessions can manage their workspace; editor/viewer, API-key, wrong-origin and outsider requests fail without creating a provider customer or session. Switching workspaces during a pending billing request must not redirect to the previous workspace's billing session.

### Successful payment, failures and renewals

1. Complete one Standard sandbox payment using Stripe's test payment mechanism. Correlate the exact provider event with its durable `provider_events` row, automatic worker completion, local subscription and `billing.reconciled` audit, and the application's Standard limits. HTTP `202`, a redirect or an active-looking Checkout page alone is insufficient.
2. Exercise a declined payment and an authentication/action-required payment. Record actual provider subscription state. Verify access follows the state table, no duplicate subscription appears, and correction/retry can recover normally. If asynchronous payment methods are enabled, also complete their actual pending/success path; otherwise record them as intentionally not offered.
3. Create synthetic retained sources and more than one parser while paid. Record exact usage/ledger and original hashes before renewal tests.
4. Exercise a successful renewal, failed renewal, payment recovery and action-required renewal on the **same owned subscription**. Choose and document a sandbox-supported time-advancement or invoice method that changes that subscription's real provider state. The application creates customers without a test-clock parameter; do not claim a generic CLI event or fabricated invoice alone proves a renewal or clock-linked lifecycle.
5. For each failure, reconcile against the observed current status. An active subscription may keep paid access; `past_due`/`unpaid` must yield Explore. Recovery to a valid active plan must restore the corresponding limits. Existing original bytes, parsers and usage ledger must remain intact, and renewal must not erase calendar-month usage.
6. Verify new parser/page/concurrency admissions follow the resulting plan. Keep the second workspace unchanged. Do not delete existing customer work to force a downgraded workspace below quota.

### Replay, ordering and worker recovery

1. Redeliver an actual accepted sandbox event through the provider's supported resend path, with a current signature. The same event ID must produce one durable row and `duplicate:true`; it must not duplicate usage or a subscription. A stale signature should be rejected, so replaying a captured header indefinitely is not the test.
2. After recovery, redeliver an older failure. After cancellation, redeliver an older success. Verify each rereads current state and cannot resurrect or remove the wrong entitlement. The local event timestamp watermark must not move backward.
3. Verify tampered signatures, wrong-mode events and connected-account events are rejected with `400` and no new provider row or entitlement change. Use owned synthetic/controlled checks; never copy a live event into the sandbox to test isolation.
4. In controlled acceptance infrastructure, demonstrate a transient provider failure retries the existing durable event and eventually completes. Demonstrate the exhausted/final expired lease surfaces a failed state and the documented operator recovery path. The worker has five attempts, a five-minute lease and bounded backoff; repeated HTTP delivery alone does not reset an exhausted existing row. Agree an audited, exact-event recovery procedure before operating paid billing; no public billing replay endpoint is provided here.

### Portal changes and cancellation

1. Open the portal from the owned workspace and verify customer/mode and return URL. Exercise the offered payment-method update and each enabled Standard↔Team plan change. Confirm effective access only after real provider state is reconciled; a portal return alone is not proof.
2. Schedule cancellation at period end. Verify paid access remains while the eligible subscription is active, then Explore after the actual terminal state is delivered and processed. If immediate cancellation is part of the approved policy, verify that separate path too.
3. Verify original files, review/approval history, parsers and usage survive downgrade; future work respects the lower limits. Confirm outsiders cannot open this customer's portal.
4. Confirm a temporary loss of account charging eligibility does not prevent the portal's cancellation path, provided the approved account/customer/portal still validate. Refund, dispute, tax and proration policies need separate operational sign-off; the app does not implement a refund workflow or grant access from those events.
5. End only the owned test subscriptions according to the agreed cleanup plan. Retain minimal sanitized acceptance evidence and usage/audit history. Do not delete real customer objects or attempt to reuse test objects in live mode.

## 3. Explicit mock/test entitlement disposition

This is a launch gate, not an automatic effect of changing environment variables. `subscriptions` and Checkout reservations are separated by billing mode, but the effective `workspaces.plan` is one stored JSON value. Turning off mock mode or switching test to live does not automatically remove a previously granted mock/test Standard or Team plan. Migration 038 labels relevant older provider plans as test; it does not revoke those limits.

- [ ] Inventory exact owned preview/test workspaces and their stored effective plan, test/live subscription bindings and Checkout reservations through a bounded read-only operator report. Keep that report private.
- [ ] Approve a disposition for each: retained isolated fixture, intentionally granted nonpaid entitlement with documented policy, or a return to Explore followed by an independently established live subscription. Preserve originals, usage and audit provenance.
- [ ] Prepare and review the concrete workspace-scoped transition before applying it. There is no general-purpose entitlement cleanup command supplied by this checklist. The mock endpoint refuses Stripe-linked workspaces, so it is not a universal reset tool. Never delete subscription/Checkout/event history to bypass the guard.
- [ ] Verify effective quotas and visible mode for every affected workspace after transition. No unexplained mock/test paid grant may become publicly usable merely because preview restrictions were removed.
- [ ] Demonstrate legacy queued test pointers remain test-only and cannot overwrite an established live entitlement. Do not change their stored mode or event identity.

## 4. Approved live cutover and commercial launch

Only start after the sandbox receipt and entitlement disposition are accepted. This document does not authorize a live payment, refund, provider plan purchase, environment change, or opening public registration.

- [ ] Approve final pricing, calendar-month usage promise, taxes/invoicing, renewal/cancellation, trial availability, prorations/refunds, failed-payment behavior, terms and billing support ownership. Current code treats `trialing` as entitled; offering a trial remains a product/configuration decision.
- [ ] Verify the exact live account identity and account readiness (`charges_enabled`, `payouts_enabled`, `details_submitted`) and the intended live Standard/Team Prices. Use matching live credentials; no test customer, price, session, subscription, key or signing secret is transferable by renaming its mode.
- [ ] Securely configure `STRIPE_MODE=live`, the matching server key and webhook secret, both live Price IDs, approved `STRIPE_ACCOUNT_ID`, explicit `STRIPE_PORTAL_CONFIGURATION_ID`, and the exact production HTTPS origin. `FOLIO_BILLING_MOCK` and `FOLIO_PREVIEW_MODE` cannot be true. Coordinate this with the separately approved registration/access rollout; it must not accidentally open the product before the other launch gates pass.
- [ ] Verify live catalog/portal configuration, webhook delivery, automatic worker operation, monitoring and an owned workspace's effective limits on the exact production revision. Configuration status alone still reports `verified:false` and is not the acceptance receipt.
- [ ] Carry out only the separately approved bounded live payment/cancellation/refund check, with an agreed amount, owned payer, cleanup and accounting treatment. Record real provider and application outcomes without exposing card details or reusable tokens. Sandbox success does not replace this gate.
- [ ] Confirm support can correlate a customer's workspace, provider event, current subscription and safe worker error; handle failed renewals, accidental duplicates, exhausted events and customer cancellation without altering unrelated workspaces.
- [ ] Complete the application's other production gates from [the launch backlog](LAUNCH-BACKLOG.md). Upgrade paid infrastructure/provider plans only when the validated capacity or production policy requires them; an upgrade cannot substitute for payment or worker verification.

## Acceptance receipt and current external blockers

Keep a private receipt with exact source/deployment revision, test mode/account reference, owned workspace/customer/subscription/event references, timestamps, before/after plan and usage counts, retained source hashes, worker terminal outcomes, browser observations, cleanup and deviations. Store no server keys, webhook secrets, cookies, signing headers, card details or reusable provider URLs. Summarize redacted outcomes in the release handoff.

Still required beyond this local preparation: an approved and configured sandbox, actual provider lifecycle/worker/browser proof, explicit preview/test entitlement disposition, commercial decisions above, and separately approved live configuration/payment acceptance. No new migration, grant, readiness script or automatic entitlement rewrite was added by this billing preparation.
