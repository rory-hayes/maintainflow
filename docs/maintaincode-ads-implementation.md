# MaintainCode Ads implementation and operating guide

This checkout repurposes the existing Next.js app for source-to-CRM attribution. The authorized release replaces rory-hayes/maintainflow at the user-owned maintainflow.io domain and connects a new Supabase project. Implementation, deployment, provider acceptance and customer validation are separate evidence gates.

## Reused and replaced

Reused: Next.js 16.3 app routing, PostgreSQL transport/TLS, AES-GCM account credential encryption, the typed OpenAI Ads API client, pagination/deadline budgets and provider schemas. The previous app had no source collector, hidden-field form handoff, HubSpot reporting or sales-attribution ledger. Those are implemented under `src/lib/attribution`, `src/components/attribution` and `/api/attribution`.

The root route now opens the attribution application. The eight navigation views use the same workspace state. Sample data is generated separately and labelled on every view. Existing ad-operations APIs return 410 through the proxy. Old source modules remain for their reusable client code and tests; their documentation is historical, not the new product's deployment runbook.

## Run locally

`npm install`, then `npm run dev -- --hostname 127.0.0.1 --port 3217` opens the sample application at `http://127.0.0.1:3217/app`. `predev` and `prebuild` bundle the browser tracker.

For a disposable local database only, set `DATABASE_URL` to that database and `MAINTAINCODE_LOCAL_TEST=1`. The local identity is available only in development on a loopback host. It never activates in a production build. Local workspace creation and capture write real records into that disposable database; the sample workspace does not.

A disposable local database can use the committed migration manifest. Do not use its administrator connection as production runtime credentials. Migration 025 queue registration, restricted grants and lease recovery were verified in a rolled-back local transaction; that is separate from actual hosted migration and scheduled-run evidence.

## New deployment configuration

Use a NEW Supabase database/auth project and the explicitly user-owned existing domain https://maintainflow.io. Use the reviewed GitHub/Vercel deployment linkage for that domain. Configure fresh server secrets and Stripe test credentials; do not copy an unrelated production database or credential vault.

Apply the ordered manifest through migration 025 using a migration administrator. Migration 024 creates a `maintaincode_app` NOLOGIN role with no RLS bypass, plus the tenant membership policies. Separately provision LOGIN/password and database CONNECT through the hosting secret manager. Runtime `DATABASE_URL` uses this role (project-qualified where the pooler requires it), `sslmode=verify-full` and the appropriate `MAINTAINFLOW_DATABASE_CA_CERT`. Never use the legacy `maintainflow_app` role: it deliberately bypasses RLS for the old product.

Configure `MAINTAINCODE_APP_ORIGIN=https://maintainflow.io`, the new Supabase public URL/publishable key, the credential keyring/active-key ID and the new database. Set `MAINTAINFLOW_ADMISSION_MODE=open` and `MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED=true` for self-service sign-up. Existing agency-member provisioning remains an operator process; a customer invitation/role-management UI is not implemented.

`npm run build` creates the app. `npm start` checks the new configuration. `/api/attribution/ready` checks the dedicated runtime role, application table access and RLS. Provider access, payment configuration and the new domain revision require separate verification. `npm run probe:deployment` verifies the exact compiled revision at the target origin, protected readiness, app rendering, cross-origin tracker delivery and retired API boundary. Its output lists the user/provider/payment gates it does not cover. Legacy ad-operations readiness code is retained for historical tests and is not exposed by the new app.

## Website and form setup

1. Create a workspace and add the exact website origin, adapter, form selector and consent policy.
2. Create dedicated mapped properties in HubSpot, then add them as hidden fields to the selected form. The default contact submission property is `mc_submission_id`; the deal primary-contact property is `mc_primary_contact_id`. This connector reads CRM properties; it does not create them or overwrite salespeople's CRM values.
3. Install the `/t/SITE_ID` snippet on every required page. Permit the application origin in the site's CSP `script-src` and `connect-src`. Do not put an API key in a website script.
4. Connect the consent manager after the tracker has loaded: `window.MaintainCode.setConsent(true)` on a valid grant and `setConsent(false)` on withdrawal. Required-consent sites collect and populate nothing before a grant. Withdrawing clears queued collection, local evidence and tracker-owned fields. Already delivered CRM records are not erased by browser withdrawal; use the data deletion process where required.
5. Standard same-origin HTML forms need an existing successful-submit callback calling `window.MaintainCode.confirm(form)`, or a later exact CRM match. A submit event alone is an attempt, not a billable lead. After a completed form is reset for a genuinely new enquiry, call `window.MaintainCode.newSubmission(form)`. Repeated callbacks/retries retain the same ID. HubSpot updated-editor V4 uses documented ready and successful-submission events and public field methods. Legacy embeds and cross-origin HTML submissions need their own adapter.
6. Add `?test=1` to the tracker script for a diagnostic submission. Inspect its hidden properties in the actual destination CRM, sync HubSpot and inspect the test lead. Only that handoff marks CRM verification complete. Remove the test flag for production capture.

Only mapped fields are touched; visible HTML fields and non-empty customer values are preserved. The dedicated submission identity is refreshed for a new enquiry. Source fields manually corrected after population are preserved. HubSpot V4 reads only mapped fields through `getFieldValue`, then populates hidden fields using string arrays as its documentation specifies. See [HubSpot global form events](https://developers.hubspot.com/docs/api-reference/latest/marketing/forms/global-form-events).

The lightweight collector stores URL origin/path, referrer host and an attribution parameter allowlist. It does not read the form's names, emails, phone numbers or free text. Campaign parameter values and URL paths can still contain information supplied by the site; use non-sensitive tagging. `oppref` remains opaque, protected in the server and redacted in normal exports. A ChatGPT referrer alone remains unknown; tagged organic AI and paid ChatGPT evidence are distinct. Browser evidence is observed input, not authenticated proof of an ad purchase.

Retries are bounded to 20 queued records, three sends per flush, a five-second request timeout and a 15-second/online retry trigger. The queue is memory-only and can be lost on navigation or browser exit. Hidden fields still travel with the underlying form. Storage denial, script errors and capture limits never call `preventDefault()` on business forms.

## Connectors and maintenance

HubSpot uses a private-app token with contact/deal read access and access to the configured custom contact property. Read only lifecycle stages, record IDs, submission-property history, deal associations, amounts, currency and dates. Property history supports repeated submissions from one contact. The portal ID is supplied for CRM links; verify that it matches the intended portal during setup. Custom-property limits and available form features depend on the customer's HubSpot account; the real account-tier matrix is not yet verified.

ChatGPT Ads uses the eligible advertiser's Ads Manager account key, not an OpenAI Platform key. Set `OPENAI_ADS_DATA_MODE=live` and `MAINTAINFLOW_RELEASE_STAGE=private_read` for authorized read testing. The account identity is checked before importing campaigns, ad groups, ads and daily campaign costs/clicks/impressions. Insights cover a rolling 30-day provider window in its account timezone, including potentially partial boundary days. The UI exposes coverage and last success. Previous data remains when a bounded sync fails or pagination is incomplete. Connecting read-only reporting does not send conversions or change campaigns. Provider conversion totals and conversion feedback are explicitly unavailable in this release.

CSV costs require `date,campaign_id,campaign,channel,currency,spend`. Invalid rows, negative spend, missing IDs, duplicate rows and overlapping native OpenAI rows fail before import. Reimport replaces the same stable records. Other ad networks have tagged source capture and CSV spend, not native spend connectors.

Vercel's production configuration schedules `GET /api/attribution/maintenance` daily at `15 2 * * *` (02:15 UTC) with a separate 32+ character `CRON_SECRET`. Fluid compute is enabled and the route allows 300 seconds. The worker reserves time for completion/database work, processing at most eight workspaces within a 210-second active work budget and allowing at most 45 seconds per provider. Hobby scheduling is daily with imprecise timing; this implementation does not promise frequent or real-time refresh. See [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) and [function duration limits](https://vercel.com/docs/functions/configuring-functions/duration).

Migration 025 stores only workspace IDs, due times, lease metadata, status and failure counts in a scheduling registry. A fixed trigger registers workspace creation; runtime receives SELECT/UPDATE only on that registry. Customer state and credential reads still use the existing per-workspace RLS context. Workers atomically claim the oldest due row with `FOR UPDATE SKIP LOCKED`, use a ten-minute lease and a unique completion token, and retain recoverable progress if the host stops. Completed attempts become due after 23 hours to tolerate daily scheduler timing drift. Old due rows stay ahead of later completed rows, preventing starvation. Failed/partial workspaces are recorded independently and do not discard another workspace's successful progress.

Retention is applied to every claimed workspace, including inactive subscriptions. Provider sync skips inactive/expired plans and revoked connections, retains prior successful snapshots on errors, and cancels paging/requests at the work budget. The response reports processed records, per-provider results and due/leased/failed backlog; partial work returns HTTP 207 with `ok:false`. With more than eight due workspaces or slow providers, daily runs may take several days to drain the queue. Before exceeding that capacity, provide a more frequent scheduler or larger execution capacity; do not claim daily freshness for every workspace until the backlog proves it.

An authorized operator can still POST `/api/attribution/maintenance?workspace=WORKSPACE_UUID` with the independent `MAINTAINCODE_MAINTENANCE_SECRET`. It uses the same lease boundary. Website owners can refresh connected providers manually in the app between daily runs. Actual hosted cron registration/execution, errors and backlog must be inspected after deployment. No outbound email summary or external alert destination is configured by this code. Expired source records are also excluded on reads and pruned on writes; backups need a matching retention policy.

## Reporting contract

Confirmed production submissions, distinct contacts and unique deals are separate. Contacts receive one source assignment per selected model. A deal requires an explicit associated primary contact; ambiguous associations remain unattributed. Reopened/amended deals update a stable record and retain bounded history, rather than adding revenue again.

First observed and latest non-direct models are alternate views. Acquisition cohorts use the selected source date; calendar sales use deal close dates. Enquiry counts still describe the acquisition window. Qualified contacts use their current configured lifecycle stage. Won deals and booked amounts are scoped to the selected original currency; unknown amounts stay flagged. No collected-payment value, FX conversion, CPL or ROAS is inferred. Costs with no enquiries remain visible. Every top metric and channel row opens contributing submission/contact/deal/cost evidence.

## Billing and current limits

Hosted Stripe Checkout supports EUR 49/month or 490/year (starter), and 149/month or 1490/year (agency), subject to paid validation. The configured Stripe price must match the displayed amount, currency and interval. The portal supports subscription management/cancellation once configured. The webhook verifies signatures and retrieves canonical subscription state before applying changes; old subscription events cannot cancel a newer subscription.

Use Stripe test credentials during verification. Live Stripe keys are refused in development. Missing configuration never claims checkout success. The local 14-day trial captures up to one/five websites and 500/2,500 confirmed monthly production submissions. New captures pause at an inactive/expired subscription or known usage limit, with no automatic overage charges. Diagnostic submissions and retries are excluded. Pending attempts later confirmed in CRM may take final usage past a limit; underlying forms remain unaffected.

This first implementation keeps one locked JSON state record per workspace (12 MB maximum), at most 10,000 retained submissions, and bounded CRM snapshots of 10,000 contacts/deals each. Load/concurrency testing and normalized storage are release gates before larger accounts. Operational invitation management, emailed summaries, provider conversion totals, additional CMS adapters and collected-payment reporting remain incomplete.

## Verification gates

Local automated tests cover source rules, consent/storage failures, HTML/V4 method behavior, stable identities, CRM matching, currencies/cohorts, cost validation, role checks and billing failure conditions. The sample browser verification script covers metric evidence, lead filters, details, all views, reporting controls, exports, a 390px mobile layout and keyboard focus. It deliberately does not write workspace or lead data.

Still required: persistent migrations through 025 application and effective-role tests with two populated workspaces, persistent onboarding and duplicate-capture browser tests, two-workspace database isolation tests, real HubSpot form delivery/custom-property behavior, an authorized Ads account sync, Stripe test checkout/webhook/cancellation, hosted scheduler execution, privacy/deletion/backup policy review, load testing, deployment revision proof and an external customer's successful use. These gates are separate; a passing local build proves none of the provider or commercial outcomes.
