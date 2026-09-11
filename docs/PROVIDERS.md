# Provider adapters and release evidence

Updated 8 September 2026. Folio has native **OpenAI extraction**, **Resend inbound email** with custom-domain and managed-inbox verification, **Google Sheets OAuth**, and the user-requested **local billing mock**. The separate Stripe test adapter is retained; real Stripe testing is deferred by the user. Current verification passes **184 tests** and the build, including ten integrations-provider tests, seven managed receiving tests and nine mock backend/UI tests. OpenAI synthetic calls and receipt-browser acceptance are recorded separately. Resend account access is observed, but no real receiving intake, Google consent or spreadsheet write has completed. [PROVIDER-SETUP.md](PROVIDER-SETUP.md) records the exact source identity, prepared artifacts and pending approvals.

Stripe/Resend/Sheets implementation: `server/integrations/providers.ts`, `server/integrations/provider-policy.ts`, `server/integrations/mock-billing.ts`, `migrations/003_provider.sql`, and the provider/managed-receiving/mock tests. Parent integration delivery code calls `sendGoogleSheets(integration, {id, payload})`; the durable worker calls `tickProviders()`; the API calls `registerProviders(app)`.

## OpenAI extraction

`server/core/openai-provider.ts` implements `ExtractionProvider`; actual API/worker entrypoints explicitly initialize its factory after server configuration loads. The approved server credential is not exposed to the browser. `buildApp()` and worker-helper imports remain unconfigured until a provider is injected. AI availability is reported at `GET /api/presets` as `providers.ai.configured`, separately from the integration status endpoint below; configuration alone does not prove model access or quota.

The adapter pins `gpt-5.4-mini-2026-03-17` and `folio-openai-extraction-v2`, uses the Responses API with `store: false`, no tools and strict nullable JSON output, then recursively validates and normalizes locally. Original PDFs are always included as Base64 input; PNG/JPEG images use high detail; other supported formats use decoded text. Native quotes/raw values are checked against their stated page. Unmatched PDF/image quotations are labelled model-visual and require human comparison, not represented as independent OCR. Successful jobs enter review and preserve actual model/prompt, token/cached-token usage and estimated successful-response cost. Provider retention, failed-call charges and production operation are separate boundaries.

CSV normalization is now integrated through the bounded source-token helper: it decodes only exact whole quoted cells, protects ambiguous literal quotes, and preserves raw output/evidence. [AI-EXTRACTION.md](AI-EXTRACTION.md) contains the full request, evidence, normalization, retry/deadline and cost contract with primary OpenAI documentation.

The earlier v1 runs measured 62/62, 73/74 and 74/74 values; their original reports remain in [AI-EXTRACTION.md](AI-EXTRACTION.md). The separately authored [held-out evaluation](evidence/openai-heldout-evaluation-2026-09-07T08-30-01-014Z.json) measured **49/51** across six actual calls, including an identical duplicate; both misses were date selection on the same French image. Date-field instructions now select the literal calendar date without adjacent prose/time or metadata inference. The [v2 regression replay](evidence/openai-date-regression-evaluation-2026-09-07T08-34-10-311Z.json) measured **51/51**, with visual/required-field warnings retained and estimated successful-call cost **$0.01604925**. This replay is not held-out accuracy evidence or billed-cost reconciliation. After explicit user approval and Mac unlock, [AI receipt browser acceptance](AI-BROWSER-ACCEPTANCE.md) completed actual parser creation, PNG upload, worker extraction, image comparison, uncorrected approval, JSON download and persisted reload. Selected-run metadata displayed 1,021 input / 180 output tokens and $0.001576 estimated cost; Usage displayed $0.0016 with its billing limitations. The historical AI-browser [160-test aggregate](evidence/ai-browser-tests-results.txt) and [build](evidence/ai-browser-build-results.txt) pass on the [185-file source](evidence/ai-browser-final-integrity.json). Immutable nested/table source disclosures retain 15 controlled rendering tests and a separate completed desktop/mobile/keyboard browser pass after the targeted overflow fix; [review provenance](REVIEW-PROVENANCE.md) records the exact tested subset. Other provider account checks remain pending.

## Common configuration and data boundaries

Provider credentials are server environment variables. `INTEGRATION_ENCRYPTION_KEY` must be a base64-encoded 32-byte key in production. OAuth credentials and PKCE verifiers are encrypted with AES-256-GCM using the shared integration secret service. Development uses a private local key file; production rejects a missing key. Keep this key stable across restarts and preserve it with the encrypted database backup. No provider credential is returned by an API route.

`APP_ORIGIN` supplies trusted application return URLs. Reverse proxies must preserve raw webhook bodies, the Stripe signature header, and the three Svix headers. Only the two signed provider webhook endpoints are exempt from browser mutation-origin checks. They accept a maximum 1 MiB JSON body, verify the unmodified bytes, and then save a minimal event pointer before returning HTTP 202. A database failure does not acknowledge successful receipt.

`provider_events` is a global, administrator-only durable inbox. Stripe event IDs and Svix message IDs have provider prefixes and primary-key deduplication. Tenant event associations are stored separately. Worker leases last five minutes and renew every 30 seconds; crashed leases can be reclaimed. Failed processing retries up to five attempts with bounded exponential delay, then remains failed with a redacted diagnostic. Database rows retain status across worker restarts. The dashboard can read the last 50 associated event summaries through `GET /api/providers/events`; events that fail before a tenant can be established require operator inspection.

All new tenant tables force PostgreSQL row-level security. Document deletion and retention purge local Sheets payload reservations via the approval/run association in `server/core/retention.ts`; originals and extraction records follow the core deletion flow. Values already sent to a user's external spreadsheet remain in that spreadsheet. Queue rows can be processed again only within the documented retry/replay behavior; deleting an event ledger entry discards replay protection and is not a normal recovery operation.

## Billing: requested local mock

`FOLIO_BILLING_MOCK=true` explicitly enables local simulation when `NODE_ENV` is not `production`. It is off by default and cannot be enabled in production. The current local configuration enables it at the user’s request. UI copy says **Local mock billing** and **Mock mode · no payments**; provider status reports `mode: mock`, `configured: false`, and `verified: false`. No Stripe credential, Checkout or paid subscription is implied.

| Route | Behavior |
| --- | --- |
| `POST /api/billing/mock/plan` | Owner/admin browser session; strict body `{ "planId": "standard" }` or `team`; persists the selected local limits |
| `POST /api/billing/mock/cancel` | Owner/admin browser session; strict empty body; persists Explore limits and a canceled mock state |

Plan changes use the existing billing/quota locks and commit the plan with a bounded `billing.mock_plan_changed` or `billing.mock_canceled` audit event. Repeating the same state is inert. Downgrades preserve existing documents/parsers; new work follows the resulting limits. A workspace with existing Stripe customer/subscription or Checkout state is rejected to avoid overwriting that state. Mock mode blocks Checkout, portal, webhook processing and Stripe reconciliation before transport; queued Stripe provider events are not claimed while mock mode is enabled.

Six backend tests cover opt-in/production exclusion, persisted selection/change/cancel across app restart, no-op audit behavior, tenant/role/session/origin/input checks, Stripe-transport exclusion, existing billing-state rejection and rollback/concurrent selection. Three rendering tests cover truthful mock labels, viewer/error states and preservation of the separate real test-mode UI. The [actual browser workflow](evidence/provider-setup-2026-09-08/billing-browser.json) also passed Standard → Team → cancel to Explore → restore Team → reload. Team (local mock) persisted with 39/5,000 pages used, concurrency four and 50 parser capacity; eight documents remained. [DB/runtime readback](evidence/provider-setup-2026-09-08/runtime-and-billing-state.json) records four corresponding audit events and zero subscription/Checkout rows. Desktop/mobile layout checks passed; plan mutations were tested on desktop only.

## Stripe: deferred real test-mode verification

These variables are required only when returning to the real Stripe test adapter; they are not prerequisites for the currently requested mock:

| Variable | Required value |
| --- | --- |
| `STRIPE_SECRET_KEY` | A server `sk_test_` key; `sk_live_` keys are rejected |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this endpoint in Stripe test mode |
| `STRIPE_PRICE_STANDARD` | Test Price ID for EUR 29, recurring monthly, quantity one |
| `STRIPE_PRICE_TEAM` | Test Price ID for EUR 79, recurring monthly, quantity one |

The shared application plans define Standard as 1,000 pages/month and 10 parsers and Team as 5,000 pages/month and 50 parsers. Explore has 50 pages/month and one parser and needs no Checkout. Each paid plan is usable only when its own exact price mapping exists; the provider status being configured does not establish that every optional price mapping exists. Price currency, amount, monthly interval/count, active status at Checkout creation, and test/live mode are checked against `shared/plans.ts`.

The integration uses hosted Checkout Sessions in subscription mode and the hosted customer portal. The installed Stripe SDK is 22.6.1; its bundled API default is `2026-08-26.dahlia`. Configure the test webhook endpoint's event version compatibly and validate fixtures whenever upgrading the SDK. The implementation follows Stripe's subscription Checkout, webhook, and portal APIs. [Checkout subscriptions](https://docs.stripe.com/billing/subscriptions/build-subscriptions?payment-ui=checkout&ui=stripe-hosted), [subscription events](https://docs.stripe.com/billing/subscriptions/webhooks), [customer portal](https://docs.stripe.com/billing/subscriptions/integrating-customer-portal), [API versioning](https://docs.stripe.com/api/versioning).

| Route | Behavior |
| --- | --- |
| `POST /api/billing/checkout` | Owner/admin session; body `{ "planId": "standard" }` or `team`; returns test Checkout URL |
| `POST /api/billing/portal` | Owner/admin session; returns portal URL for the workspace's existing test customer |
| `POST /api/billing/webhook` | Raw-body signature verification, rejection of live events, durable acknowledgement |

Enable `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, and `invoice.payment_action_required` for the webhook endpoint. Other valid signed events are acknowledged as ignored.

Checkout creation serializes per workspace. Customer creation uses a stable idempotency key. A Checkout reservation UUID is committed **before** creating the external Session, so a process interruption can retry with the same key. An existing open Session is reused for its plan; switching plans expires that open Session. Any current subscription other than canceled/incomplete-expired sends the user toward the portal. An unresolved reservation older than 23 hours requires operator reconciliation before another Session is created, avoiding reliance on indefinite provider idempotency retention.

Returning from Checkout does not grant a plan. Events are associated only with a previously persisted customer/workspace mapping. Under that customer row's lock, the worker asks Stripe for its **current** subscriptions and derives entitlements from the configured exact Price IDs. It never grants access from webhook metadata, client reference metadata, event names, or a stale event payload. Only an active/trialing, test-mode, single-item, quantity-one subscription with the allowed currency/amount/interval is entitled. Otherwise the workspace returns to Explore. The greatest observed event timestamp is retained for diagnostics; even older arriving events reconcile current Stripe state. The adapter stops reconciliation for customers with more than 100 subscriptions rather than silently using an incomplete result.

Deferred real-Stripe verification: provision test prices and portal settings; supply test credentials and webhook secret; forward/register the endpoint; complete a real test Checkout; verify subscription/usage limits after the webhook; replay the same event; exercise a portal change and cancellation and confirm current-state reconciliation. This adapter deliberately has no production billing activation path.

## Resend: custom-domain or managed-inbox verification

Server settings are listed in [`.env.example`](../.env.example):

| Variable | Required value |
| --- | --- |
| `RESEND_API_KEY` | Server API key authorized to retrieve the chosen domain/probe and received emails/attachments |
| `RESEND_WEBHOOK_SECRET` | Svix signing secret for this receiving webhook |
| `RESEND_INBOUND_ENABLED` | Literal `true`, set after the receiving prerequisites are complete |
| `RESEND_RECEIVING_MODE` | `custom` (default) or explicitly `managed`; any other value fails closed |
| `RESEND_INBOUND_DOMAIN` | Exact custom receiving domain or the team’s single-label `<id>.resend.app` inbox |
| `RESEND_DOMAIN_ID` | Existing Resend domain ID for `custom`; unused for `managed` |
| `RESEND_MANAGED_PROBE_EMAIL_ID` | For `managed`, UUID of the exact **received** probe email, not a sent-email ID |
| `RESEND_MANAGED_PROBE_RECIPIENT` | For `managed`, `folio-probe-<32 lowercase random hex characters>@<id>.resend.app` matching the configured inbox |
| `RESEND_MANAGED_PROBE_NONCE` | For `managed`, 32–64 lowercase random hex characters matching the probe subject/body |

In **custom** mode, the adapter reads the configured domain from Resend. Its name must match, receiving must be enabled, and its Receiving MX record must be verified. The existing custom-domain path is preserved. [Receiving setup](https://resend.com/docs/dashboard/receiving/introduction), [domain response](https://resend.com/docs/api-reference/domains/get-domain).

In **managed** mode, first send a dedicated plain-text probe to the fresh random recipient. Both subject and body must be exactly `Folio receiving probe <nonce>`; do not add an email signature or other content. Set the received-email UUID after actual receipt. The adapter retrieves that exact message with `html_format: cid` and requires `object: email`, matching UUID, exactly the configured `received_for` recipient, exact subject, and the trimmed plain-text nonce body. HTML alone, mismatched/multiple recipients, another message ID or appended text fails verification. A successful result reports `verification: managed-probe` and `deliveryVerified: false`: it proves retrieval of that challenge, not custom MX verification, signed webhook delivery or parser intake. The local provider reference `managed:<domain>` is a Folio routing identifier, not a Resend custom-domain ID.

Status checks cache verification for up to 60 seconds, keyed to the mode, credentials and probe settings; address creation forces a fresh check. A failed forced check invalidates earlier success. The adapter does not create domains, change DNS or register webhooks. Current configuration selects the observed managed inbox, but inbound is disabled and credentials/probe completion are absent. No usable parser address or verified managed receipt is claimed.

| Route | Behavior |
| --- | --- |
| `GET /api/providers/email-routes` | Session; parser routing status, hides addresses when the configured custom/managed verification fails or routing is disabled |
| `POST /api/providers/email-routes` | Owner/admin; `{parserId, parseBody?, parseAttachments?, allowedSenders?}`; creates a random opaque address only after provider verification |
| `DELETE /api/providers/email-routes/:id` | Owner/admin; disables that route |
| `POST /api/providers/resend/webhook` | Validates `svix-id`, `svix-timestamp`, `svix-signature`; accepts signed `email.received` event |

Both body and attachments default to enabled; at least one must be enabled. The signed event must contain `data.email_id` and provider-supplied `data.received_for`. The worker retrieves the complete received email separately and intersects the signed values with the API’s `received_for`. Resend derives these values from Received headers; this is not independently proven SMTP-envelope identity. Visible `To`/`Cc` fields never authorize routing. Missing/mismatched `received_for` data fails closed. Svix validates the original body before JSON parsing. [Signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests), [retrieving received content](https://resend.com/docs/api-reference/emails/retrieve-received-email).

Body processing produces a text MIME `.eml`, converts HTML-only messages to text, and strips header newlines. Attachments require a separate metadata request and download; the webhook does not contain their bytes. Inline attachments are skipped. Download URLs pass the shared HTTPS/public-address check, pinned DNS resolution, no-redirect policy, response-size limit, and timeout. Each document then passes the same inspected format, page quota, private-file storage, and durable intake path as a browser upload. [Receiving attachments](https://resend.com/docs/dashboard/receiving/attachments), [attachment retrieval](https://resend.com/docs/api-reference/emails/retrieve-received-email-attachment).

Limits: 20 attachment metadata entries/email, 25 MiB aggregate body plus downloaded attachments, 10 MiB/core document, and 30 pages/core document. The SDK calls time out after 15 seconds. The receiving route needs an active parser and a current owner/admin. Optional sender allowlists compare the normalized `From` address exactly; this is a routing filter, not evidence of sender SPF/DKIM identity. The provider signature authenticates the webhook payload as a Resend event; it does not independently establish sender or SMTP-envelope identity.

Intake idempotency keys use received-email ID, parser ID, and `body` or attachment ID. A retry may re-fetch provider content but cannot reserve usage or create the same document twice. Partial success is retained: if an attachment fails after the body was accepted, retry deduplicates that accepted body. Unsupported or oversized attachments create a persistent event failure after bounded retries; they are not silently treated as extracted content.

External release gates: complete the selected custom-domain MX or managed probe path; register a publicly reachable HTTPS signed webhook; supply the server settings and enable inbound; confirm `/api/providers/status` verifies the selected mode; create a parser address; send a separate real email with body and attachment; verify both documents, jobs, originals, audit history and metering; replay the same event and confirm rejected routing/retry visibility. The current account is accessible, but key creation and probe sending await explicit approval. No probe was sent or retrieved and no real webhook/parser intake is verified; [setup status](PROVIDER-SETUP.md) records the exact blockers.

## Google Sheets: explicit workspace consent and fixed-range delivery

Required variables are `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`. Register the exact callback URL, normally `https://<app-host>/api/google/callback`, in the OAuth client; HTTP is accepted only for localhost/127.0.0.1 development. Enable the Sheets API and configure the OAuth consent screen/test users as appropriate. The requested scope is `https://www.googleapis.com/auth/spreadsheets`; no Drive scope is requested. This Sheets scope authorizes broad spreadsheet access, and the Google consent screen must accurately describe it. [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server).

| Route | Behavior |
| --- | --- |
| `POST /api/google/start` | Owner/admin; creates disabled integration or reconnects an existing one; returns authorization URL |
| `GET /api/google/callback` | Requires the initiating user's session and current workspace admin membership; exchanges code with PKCE |
| `POST /api/google/:id/disconnect` | Owner/admin; clears credentials, disables delivery, invalidates outstanding consent, attempts provider revocation |

For a new integration, send `{parserId, name?, spreadsheetId, sheetName, columns?, lineItems?}`. `columns` is an ordered array of `{source,label}`; default columns are Document ID plus the active parser schema fields. Reconnect uses `{integrationId}` and preserves the existing mapping. The mapping is immutable after creation: generic integration updates must only change name/enabled, never Google destination or columns.

State is random, stored only as a hash, tied to the initiating user/workspace/integration, expires after ten minutes, and is single-use. PKCE uses S256; the verifier is encrypted. Starting a new connection invalidates its previous pending states. Callback completion requires the state still to exist after the token exchange, so a concurrent disconnect cannot reconnect it. Offline access and explicit consent are requested, and a returned refresh token plus the granted Sheets scope are required. OAuth codes and query strings are excluded from callback logging. Tokens remain encrypted per integration/workspace and refreshed server-side; an optimistic credential update stops stale in-flight refresh results from replacing a newer connection.

Use a dedicated existing blank worksheet. Folio owns row 1 for headers and reserves rows from row 2 for data. Sources can use parser paths, `$documentId`, `$filename`, `$runId`, `$revision`, or `$item.<path>` with `lineItems` naming a parsed array. Limits are 50 mapped columns, 1,000 rows per approval event, and 49,000 characters per cell. A missing/empty line-item array produces one parent row with empty item cells.

Each immutable approval ID reserves a durable row range once under an integration row lock. The cell values and range are saved before the remote write. Every retry uses `spreadsheets.values.batchUpdate` on that same range with `valueInputOption: RAW`. This avoids duplicate append rows even if Google accepted a request whose response was lost; RAW preserves leading-zero identifiers and literal formula-like strings. New approval revisions receive new rows. [Batch range writes](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/batchUpdate), [RAW value semantics](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueInputOption).

The operator/user must not insert/delete/sort the owned rows or share the same range with another writer while delivery is active, because stable coordinates are the idempotency mechanism. Failed reservations can leave gaps. Disconnect disables local delivery immediately and attempts token revocation; the response states whether revocation succeeded. A request already submitted to Google can still finish. Manual deletion of external data is the spreadsheet owner's responsibility.

External release gates: register OAuth client and callback, enable Sheets API, authorize an account through the real consent screen, choose a real blank worksheet the account can edit, approve a document and verify header/value cells, simulate a retry without duplicate rows, refresh an expired access token after worker restart, disconnect and confirm blocked delivery. These gates remain unverified. The user consented to creating a destination Sheet, but only a private empty Drive folder and local workbook are currently prepared; no native Sheet exists. Import is blocked by connector file-reference validation and Chrome file-URL permission; the subsequent native picker fallback encountered a new 8 September Mac lock. Earlier AI and completed billing browser evidence are unaffected. Automatic approval review rejected creation of the separate Folio Cloud project; that exact approval remains pending. Destination creation and Folio OAuth consent/delivery are distinct steps.

## Local verification

Start/migrate the local database with `npm run setup`. Run `node --import tsx --test --test-concurrency=1 tests/providers.test.ts`; the fixture creates unique workspaces and removes its database/file records. Tests make no provider account changes or external requests. Local socket access may require the execution environment's normal approval.

Current result: **10 provider tests passed**, zero failures/skips, within the [184-test aggregate](evidence/provider-setup-2026-09-08/verification.json). Seven separate managed receiving tests and nine mock billing backend/UI tests also pass. Verified behaviors include raw Stripe/Svix rejection and replay, live Stripe rejection, exact allowed price enforcement, stale-event current reconciliation, custom-domain verification, managed probe/route behavior and signed provider-recipient intersection, real database/file intake deduplication for body plus attachment, RLS isolation, RAW deterministic Sheets requests, concurrent durable row reservations, encrypted secrets, and OAuth state user/expiry/replay/disconnect checks. TypeScript typecheck also passed. The first fixture run exposed and fixed compatibility with Svix 2's verifier returning no JSON value; parsing now occurs only after successful signature verification.

`GET /api/providers/status` distinguishes the local billing mock from the real Stripe test adapter, configured receiving/Sheets adapters, custom-MX versus managed-probe verification, and unverified external outcomes. A passing local test suite does not change the external release gates above.


The historical [redacted runtime/configuration check](evidence/ai-browser-runtime.json), recorded `2026-09-07T17:19:42.405Z`, confirms web/API health/presets HTTP 200, observed worker startup and OpenAI configuration. At that checkpoint Stripe test, Resend and Google OAuth settings were absent, with Resend inbound disabled. The later [8 September setup](PROVIDER-SETUP.md) supersedes its current-status interpretation. No credential values were printed.
