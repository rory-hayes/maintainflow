# Checkout terms records

This increment provides dormant evidence capture, not published terms, legal approval, payment verification, or delivery of contractual information. No production policy catalogue, environment switch, signup acceptance change, email or new billing system is installed. Mock billing is unchanged. Real policy content and customer eligibility remain unresolved; synthetic policies appear only in controlled tests.

## Stored evidence

Migration 043 adds `checkout_contracts` and `checkout_contract_receipts`, with UUID keys, forced row-level security, tenant-scoped reads and backend writes. The terms snapshot retains exact UTF-8 text, version, language, title, version-specific URL, content SHA256 and agreement wording. Text is limited to 16,000 UTF-16 code units/60,000 UTF-8 bytes; controls other than tab/newline are rejected. Version/title/agreement and URL lengths are bounded. Database JSON sizes are independently limited. Records use existing workspace deletion semantics; this is not a new retention-period promise.

Before a terms-enabled Session request, the application commits the policy, displayed plan allowance/price, initiating user and every Stripe creation parameter under the durable request UUID. Retry uses those same parameters and the namespaced contract key, even if policy, valid price configuration or application origin changes, or current policy is removed/invalid. Invalid current Stripe credentials/mode/configuration still block transport safely. Existing v1/v2 reservations retain their original request shape and idempotency keys. A new `billing_checkouts.contract_capture` marker defaults false for legacy rows and prevents absent evidence from silently selecting a different transport key. A legacy Session has **unknown** terms evidence; it is never backfilled as accepted. Historical snapshots survive replacement of the current billing reservation.

Core snapshots cannot be updated. A previously unknown Stripe Session ID can be bound once; deletion of the initiating user can clear that reference. Completion records are immutable. Application tenant-role writes are excluded by read-only RLS policies; the migration wrapper's backend policy supplies server access. This is application/database immutability, not a claim against a database owner or backup restoration.

## Stripe boundary

New enabled attempts use Stripe's required terms checkbox and version-specific agreement text. The fully composed Markdown message is escaped and checked against Stripe's 1,200-character limit before reservation. Capture is available through the internal `registerProviders` policy dependency, used by synthetic fixtures. The normal application supplies no such dependency. An invalid supplied policy blocks a new terms-enabled Checkout; missing production policy does not silently assert acceptance for existing legacy billing.

Only a correctly signed, configured-mode Checkout completion event can enqueue the bounded completion pointer. That pointer is durable before any Session retrieval. Its identifiers must match the pre-existing local request, workspace, customer, mode and content hash. The existing provider worker retrieves that Session with expanded line items and checks the pinned offer, quantity, consent configuration, agreement wording, URLs and metadata before recording the consent result. Arbitrary event metadata cannot create a terms snapshot. A completion arriving before the Session creation response can bind the durable request; duplicate or out-of-order completion events retain the first record.

Capture and subscription reconciliation are independently attempted; either failure leaves the durable event retryable under the existing provider attempt/backoff limit without preventing the other operation from progressing. `accepted`, `not_recorded`, and no completion record are distinct from paid, failed-payment or entitlement states. Stored event-created and observation timestamps are labelled as such; neither is represented as the actual checkbox-click time. Full Stripe payloads, card data and customer contact details are not retained in this evidence table or completion pointer.

## Read API

All routes require a workspace owner/admin **session**. API keys and editor/viewer roles are rejected; foreign records return 404. Responses are private/no-store.

- `GET /api/billing/contracts?cursor=…` returns `CheckoutTermsList` from `shared/checkout-contracts.ts`: capture status, up to 20 summaries, an opaque validated next cursor, and current selected-mode legacy evidence status when applicable. Exact database timestamp precision is retained in pagination cursors.
- `GET /api/billing/contracts/:id` returns the immutable policy/offer and bounded completion evidence.
- `GET /api/billing/contracts/:id/download` returns a self-contained **Checkout terms record** as UTF-8 plain text, attachment disposition and `nosniff`. It includes the exact policy text and explicitly does not claim payment, entitlement, delivery or legal completeness.

Capture may be inactive while older records remain readable, including during invalid current policy/billing-mode configuration. An invalid selected mode produces no invented current-mode legacy summary. No production policy bytes are served or invented by these routes in the absence of an actual stored record. A future published policy URL must independently serve the same approved versioned bytes; storing a URL does not prove that it did.

## Remaining activation decisions and proof

The owner still needs to settle business-only versus personal-customer eligibility, approve actual contract terms and publication, choose the applicable start/cancellation arrangements, and determine evidence retention. Postal address and phone remain deferred. Privacy-notice presentation is distinct from contract acceptance and must not become blanket processing consent. Free signup acceptance is a separate gap, not closed here.

Prefer Stripe's existing invoice/receipt capabilities where their verified content and delivery satisfy the chosen requirements. This increment sends no contract confirmation. Before paid activation, verify actual disclosures, the payment-obligation display, any required start-of-supply request, durable confirmation content/timing, receipt delivery, and portal changes. A local download renderer does not establish any of those outcomes. See [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create), [Stripe receipts](https://docs.stripe.com/receipts), and the existing [policy draft](LAUNCH-POLICY-DRAFTS.md).

Focused synthetic tests cover absence/invalid policy, immutable pre-transport storage, lost-response configuration drift, legacy keys, concurrent creation, callback-before-save, duplicate/out-of-order events, incorrect bindings/offers, missing consent, owner/admin/session and tenant boundaries, plain-text download, and bounded historical pagination. Actual execution evidence is recorded separately; this document does not assert hosted migration or Stripe acceptance.
