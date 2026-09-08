# MaintainCode Ads production audit

> Current evidence is on the reused Frankfurt backend `dhbevbimoajwkuzcunwz`. The 7 September and earlier sections below remain historical; their mvz observations do not establish current acceptance after that backend became unavailable.

## Current acceptance update — 8 September 2026

The domain was verified at revision `a1dcb1e525c6ce8cae7651a260b72199dd8b4f88` on 8 September at 21:30:57 UTC, without a Vercel protection bypass. Its exact-main CI and CodeQL pass, with 1,262 application tests and 85 PostgreSQL tests; public readiness confirms six tables, ten isolation policies, the restricted runtime, queue and recipient validator. The [release ledger](maintaincode-release-status.md) and [portable acceptance record](evidence/2026-09-08-reuse-acceptance.json) provide the current boundaries.

The authorized owner's normal signup, confirmation, session reopening, sign-out, recovery email and trial workspace/site creation passed on the reused backend. Password-update submission remains pending authorization. One genuine installation-health condition produced one approved aggregate report, delivered to the verified recipient's Gmail with SPF/DKIM/DMARC pass. The unchanged retry produced no duplicate.

The actual received unsubscribe link first exposed a native-form Origin failure. The deployed strict-origin header and exact-route CSP fix passed the real email-link retry: GET 200, native POST 200, no header rewriting, origin-only Referer, zero persisted subscriptions/pending reports and zero sends from the subsequent preference-off maintenance request. Across report acceptance there were three scoped manual requests, one accepted email, no global maintenance calls and no direct SQL data writes.

All 17 public functional check groups passed on `a1dcb1e`. The populated 16-page audit and two lead-detail pages report zero automated accessibility violation groups and zero overflow; all three table regions pass keyboard checks. Both final text colors now reach 5.03:1 on white, with desktop overview and mobile lead-detail visual review. Isolated deterministic Chromium was used after three CUA timeouts; no physical-device or complete WCAG claim is made.

Controlled visitor traffic on `f7f1029` passed through the real tracker/collector with consent, offline retry, duplicate-ID and withdrawal behavior. Authenticated lead details and actual JSON/CSV exports reconcile one production enquiry, one diagnostic, usage 1/500, no CRM verification and Unknown spend. On `a1dcb1e`, one exact-site UI deletion persisted across reload; exports show zero sites/captures and usage 0/500. The independent unauthenticated loader GET verified its inert 503 body. The browser could not read the 503 script body, but had no tracker state/fields/storage and its independent business form completed one local 200 POST with zero collector attempts. These are separate observations. Earlier failed helper attempts are retained, with zero business or collector posts, and excluded from passing acceptance.

Visitor browsers/profile and fixture resources were removed; the owner account, empty trial workspace and owner profile remain for the pending password decision. Phase-specific report delivery remains dated to `28ecfd3`, actual unsubscribe to `f7f1029`, and final accessibility/deletion to `a1dcb1e`. Later documentation-only commits do not invalidate these dated tests; verify unchanged app sources and run a fresh domain probe.

Real HubSpot/OpenAI Ads delivery, Stripe test billing, scheduled execution, weekly delivery, backup/hosted restore, current-backend natural-expiry cleanup, unrelated identities and an external customer's successful source-to-CRM journey remain open. The evidence proves the stated app flows; it does not establish commercial readiness.

## Current acceptance update — 7 September 2026

The deployed revision tested was `e86c4fddcb32eb075e9c23b461e630a543b5b38e`. These observations supersede the historical pending gates below only for their stated scope. The [release ledger](maintaincode-release-status.md) is the current operating record; this follow-up contains the loading-brand correction and its successful build/lint verification.

| Scope | Direct live evidence | Limit |
| --- | --- | --- |
| Owner authentication | Approved signup/Terms, inbox confirmation and recovery with SPF/DKIM/DMARC pass, session/workspace reload, sign-out/back-navigation protection, password update, old-password rejection, new-password acceptance and consumed-link rejection; Secure/HttpOnly/SameSite=Lax cookies | One verified disposable owner; actual token-expiry refresh and unrelated-user permissions remain unproved |
| Workspace and installed tracker | Normal trial workspace/site persisted; production tracker and collector handled consent, successful HTML callback, navigation after a simulated 503, stable retries, duplicate callbacks and withdrawal | Authorized HTTPS loopback fixture with a browser-local certificate exception; controlled traffic, not paid-ad or CRM/provider proof |
| Captured evidence and exports | UI, workspace export and channel CSV reconcile one production enquiry, one diagnostic, usage 1/500 and one site; no CRM verification, zero qualified/won/value and Unknown spend | No connectors; non-empty click-reference masking and live scoped deletion not exercised. Paused-tracker revocation passed; the independent form still submitted and temporary visitor resources were cleaned up |
| Retention and manual maintenance | A naturally expired third diagnostic was physically removed; both original control rows stayed unchanged and the queue completed without failure or a lease | One owner-scoped manual run; no direct SQL data writes, no global call and no actual scheduled-cron observation |
| Workspace reports | Health-only opt-in, verified-recipient binding and installation-condition preflight passed; no report was sent, with explicit payload/recipient approval pending after automatic review rejected the send | Auth email delivery is separate; provider acceptance/inbox delivery/received-link opt-out and the first weekly delivery after seven days require their own evidence |

Evidence: `/tmp/maintaincode-live-auth-evidence.json`, `/tmp/maintaincode-live-visitor-evidence/evidence.json`, `/tmp/maintaincode-live-export-evidence.json` and `/tmp/maintaincode-owned-retention-evidence.json`. No account alias, password or token URL is included in this record.

Remaining external gates include Stripe MFA/new prices/webhook/test subscription lifecycle, real HubSpot and OpenAI Ads acceptance, actual scheduled execution, report delivery, production/offsite backup and hosted recovery, unrelated-user permissions and an external customer's successful use. Agency selection was not exercised after automatic approval review rejected it as potentially billable; the verified journey used the normal trial.

## Historical audit — 6 September 2026

All following sections preserve earlier observations and their then-open gates; they are not current deployment or acceptance status.

Audit snapshot: 6 September 2026, Europe/Dublin. This is a release working record, not a production-readiness certificate. The user has authorized replacing the MaintainFlow repository and domain with this product. Deployment and provider evidence must be recorded below as it becomes available.

## Judgment at the initial audit

The application demonstrates the intended source-to-CRM reporting product. Sample reporting, evidence drill-down, filters, responsive navigation and diagnostics are functional locally. The new Supabase project's 25 migrations and hosted runtime-role verification have passed, including tenant persistence, encryption and maintenance queue isolation. The replacement branch is published in PR #11; `main` and `https://maintainflow.io` still serve the old product. The first paying-customer journey is not yet proved: production authentication, persistent onboarding, destination CRM delivery, real Ads costs and Stripe test subscription administration need end-to-end evidence on the domain after deployment.

The audit found and fixed workspace-context and mobile-accessibility defects. It also found that a CRM contact identity match had been presented as complete field delivery. The implementation now separates those facts and compares the mapped CRM attribution fields; the correction is complete and tested locally. A visual dashboard or passing unit test cannot close the real CRM delivery gate.

## Environment and evidence

- Checkout: `/Users/rory/Documents/Ideation/maintaincode-ads`.
- Historical baseline at initial inspection: `2f2970a5d51f7ebd75cf770954883072e0962195`, branch `codex/change-integrity-release`. The replacement branch is published in [PR #11](https://github.com/rory-hayes/maintainflow/pull/11). Merge and deployment are pending; the target `main` branch and domain still show the old product.
- New Supabase project: `mvzspyhwoqzcygekridy`. The root release task reports all 25 migrations applied and a fresh hosted verifier run with `--require-queue` returning `ok: true`; exact checked boundaries are recorded below.
- Local URL verified: `http://127.0.0.1:3217/app`, HTTP 200.
- Browser: Codex in-app browser; desktop plus 390×844 mobile viewport. Temporary viewport override reset after verification.
- Data operated by this audit: labelled example workspace only. Component tests use mocked responses and create no persisted customers, emails or charges.
- Evidence files: `/tmp/maintaincode-customer-ui-tests.log`, `/tmp/maintaincode-audit-mobile-empty.png`, `/tmp/maintaincode-audit-lead-handoff.png`.
- New focused checks: seven component regression tests passed; targeted ESLint passed. The full release verification and production build also passed; exact results are recorded below. Any subsequent source or configuration changes need the relevant checks rerun.

## Confirmed findings and fixes

| ID | Severity | Finding and customer impact | Evidence / fix | Status |
| --- | --- | --- | --- | --- |
| CUSTOMER-01 | Major | Changing clients while Workspace & billing is open retained the previous client's uncontrolled form values. Saving could overwrite the selected client's settings with the previous client's values. Website and integration draft state had the same lifetime problem. | `src/components/attribution/app.tsx`: scope the active view subtree to workspace mode and ID. Regression switches clients with an unsaved name and verifies the next save targets the correct ID and values. | Fixed locally; production two-client verification pending |
| CUSTOMER-02 | Major | Creating a second workspace did not record its ID in the URL; refresh could reopen the previous/first client. | `app.tsx`: creation writes the selected workspace and live mode before navigating to setup. Component test verifies refreshable URL. | Fixed locally |
| CUSTOMER-03 | Major | Slow workspace loads/saves could overwrite a newer client selection or a return to sample mode. | `app.tsx`: request generation guards discard responses from a previous context. Two delayed-response tests verify both selection and save paths. | Fixed locally |
| CUSTOMER-04 | Major | Closed mobile navigation remained keyboard-focusable offscreen. First Tab focused the brand at x=-236 on a 390px screen. | `styles.css`: closed sidebar is hidden; open state restores visibility. `app.tsx`: expanded/control semantics, visible close action and Escape/focus return. Browser now focuses the visible toggle, opens/closes navigation and reaches Leads. | Fixed and browser verified |
| CUSTOMER-05 | Major | A CRM submission-ID match marked the site and lead verified without reading any source fields. A mis-mapped form could look successfully installed. | `model.ts` / `connectors.server.ts`: compare mapped fields independently from contact history. `reporting.tsx` and `setup.tsx`: distinguish contact identity, field delivery, missing/different fields and recovery steps. Sample fixture explicitly declares its example verification evidence. | Fixed and tested locally; real HubSpot proof pending |
| CUSTOMER-06 | Minor | Lead view rendered every retained submission and had no bounded pagination. | `reporting.tsx`: 50-row pages, newest first, filter changes reset the page. Test verifies 50 rows from 128 records; browser verifies page 2 then a one-record search. | Fixed locally |
| CUSTOMER-07 | Major | Independently generating sample timestamps during SSR and hydration could change sorted lead order and trigger a hydration error. | `app/page.tsx` passes one serializable sample snapshot to `AttributionApp`. A fresh browser tab verified filtered navigation and no warning/error logs after the correction. | Fixed and browser verified |

## Open implementation and operating gaps

| Priority | Gap | Evidence and required closure |
| --- | --- | --- |
| P0 | Production first-user authentication and recovery not proved | Supabase authentication is now implemented and locally verified below. Verify actual account creation, email delivery/confirmation, sign-in, refresh, sign-out, recovery and expired links on the deployed domain. |
| P0 | No real destination CRM handoff observed | Private-app read code and V4 event tests are not a tested HubSpot account/form. Verify the customer can create dedicated properties, include hidden fields in the exact supported form editor, submit a diagnostic lead, and inspect matched first/latest values in HubSpot. |
| P0 | Deployed authenticated tenant isolation remains unproved | New project schema and hosted runtime-role checks passed: 25 migrations, two-tenant persistence, credential encryption, queue RLS/grants and rollback. Still test two unrelated populated workspaces through the deployed app with distinct authenticated users and permitted roles; direct database fixtures do not prove this customer journey. |
| P0 | Replacement branch is not yet on the domain | PR #11 contains the replacement; `main` and `maintainflow.io` still show the old product. Complete the merge/deployment and record a domain response tied to the deployed revision, then exercise real app routes. |
| P1 | Live Ads account and native reporting acceptance missing | Use an authorized eligible advertiser key. Verify account identity, inventory, campaign IDs, original currency/timezone, costs/clicks/impressions and recovery after denial/rate limit. Never treat sample rows as this evidence. |
| P1 | Stripe test subscription lifecycle missing | Test configured price validation, checkout, webhook replay, portal cancellation, failed payment and capture-limit effects without real charges. |
| P1 | Consent wiring remains an integration task | Onboarding describes the policy and callback, but a stored setting alone does not prove the customer's CMP actually delays collection or handles withdrawal. Verify before grant, grant, page navigation, direct return and withdrawal on the installed site. |
| P1 | Hosted maintenance execution not yet observed | Scheduler configuration, maintenance processing and the tenant queue are implemented. Hosted verification passed queue RLS/grants and rollback. After deployment, observe the actual scheduled run, coverage for new workspaces, last success and failure monitoring, physical retention cleanup and connector refresh. |
| P1 | Customer team/agency administration incomplete | Membership access is enforced, but customer invitations and role administration are an operator process. Verify isolated clients now; complete the self-service management flow before advertising it. |
| P1 | Opted-in health/summary email delivery not observed | Default-off preferences, aggregate reports, current-recipient checks, opt-out and bounded delivery are implemented and tested with mocked mail. Migration026, authorized mail configuration, provider acceptance, inbox receipt and actual hosted execution remain pending. |
| P1 | Updated legal notices not yet verified on the domain | `/privacy` and `/terms` have been rewritten for the attribution product, including tracker/CRM/billing handling and operating notices. The domain still serves the old product. Verify the deployed pages, links and actual configured retention/deletion behavior after release. |
| P1 | Hosted capacity remains unproved | Owned local PostgreSQL checks now pass concurrent captures/retries/settings at the advertised 500/2,500 limits, quota enforcement, 10,000 retained records and atomic UTF-8 storage-limit failures. These local measurements do not establish hosted throughput or justify larger-account capacity claims. |
| P2 | CRM setup is technical | Customers must know private-app scopes, internal property names, stage IDs, JSON mapping and successful-submit callbacks. Narrow supported compatibility and concise exact setup instructions are essential; an account-tier matrix remains unverified. |

## Production acceptance coverage matrix

"Local pass" applies only to the indicated code/UI scope. Hosted database verification applies only to the explicitly checked database boundaries. "Pending" requires the authoritative evidence in the final column; it is not a claim that the feature is broken.

| Requirement | Implementation and verification evidence | Production status | Evidence needed to close |
| --- | --- | --- | --- |
| New code replaces target GitHub repository | Replacement branch published in PR #11 | Branch pushed; merge pending | Merge accepted replacement into target `main` and record final commit |
| New Supabase project, complete schema and runtime role | Project `mvzspyhwoqzcygekridy`; 25 migrations; fresh hosted verifier with `--require-queue` returned `ok: true` | Hosted database pass for checked scope | Deployed application connectivity remains a separate gate |
| Domain serves intended deployed revision | Local `/app` responds; domain still serves old product | Pending | `maintainflow.io` deployment/commit linkage and route/browser checks |
| Public sign-up and email confirmation | Supabase implementation, route tests and browser entry form pass | Pending | New user registers, receives confirmation, completes session on domain |
| Sign-in, session refresh and sign-out | Supabase authoritative identity, cookie propagation and sign-out tests pass | Pending | Browser session survives refresh and sign-out removes data access |
| Recovery and invalid/expired links | Supabase recovery/callback tests and browser entry form pass | Pending | Recovery mail and password update; expired-token error with retry |
| Empty workspace → website configuration | Actual local database/browser creation and reload passed with a dedicated test identity | Pending | Persisted new-user flow, refresh and validation errors |
| Script loading and independent installation status | Cross-origin installed loader and actual capture passed locally; resource-policy defect fixed | Pending | Real installed script and capture receipt from configured origin |
| Required-consent capture / withdrawal | Actual local browser storage, fields and network checks passed before grant, after grant and withdrawal | Pending | Browser storage/fields/network before grant, after grant and withdrawal |
| First source across navigation/direct return | Existing tracker/model tests reviewed | Pending | Installed browser flow retains evidence in actual destination fields |
| Paid ChatGPT / organic AI / ambiguous visits | Explicit rule logic and tests present | Pending | Controlled tagged/referral visits through installed form |
| HTML successful-submit handoff | Adapter code/tests present | Pending | Actual supported business form succeeds independently and CRM receives fields |
| HubSpot V4 successful-submit handoff | Public-method test double present | Pending | Supported editor/account-tier form and real CRM properties verified |
| CRM attribution-field delivery verification | Explicit mapped-field comparisons and missing/mismatched diagnostics complete and tested locally | Pending | Real HubSpot first/latest property values match the captured submission; contact identity alone is insufficient |
| Retries do not multiply successful submissions | Actual local browser outage/navigation recovery and duplicate callbacks passed without extra usage or requests | Pending | Duplicate callbacks/retries through deployed collector, one usage record |
| Tracker/network/quota failure leaves form working | Fail-open adapter logic/tests present | Pending | Deployed controlled failure with underlying form delivery observed |
| Native HubSpot outcomes | Connector/parser/reconciliation inspected | Pending | Real contact lifecycle, association, amount, currency and close-date changes |
| Deal primary contacts/reopened deals do not inflate | Stable IDs and reconciliation tests present | Pending | Real controlled CRM changes reconcile exactly once |
| Native ChatGPT costs/inventory | Connector read path inspected | Pending | Authorized account sync with reconciled provider records |
| CSV spend import and reimport | Validation logic present; sample import UI inspected | Pending | Persisted valid/invalid/duplicate/overlap import and row reconciliation |
| Overview/channel/campaign evidence | Local browser pass: channel campaign evidence and lead drill-down | Pending | Same paths with persisted captured and CRM data |
| Lead search, stage/date/evidence filters and pages | Local pass; 50-row pagination and one-record search | Pending | Live result consistency and empty state |
| Booked versus collected, models/cohorts/currencies | Explicit labels and model tests present | Pending | Live source-record reconciliation in each selected scope |
| Missing spend and unsupported ratios | Local sample correctly labels Unknown; ratios unavailable | Pending | Partial-provider/CSV records remain explicitly incomplete |
| Freshness/failure/recovery diagnostics | States and recovery UI inspected | Pending | Actual expired credential, partial sync and successful retry |
| Two unrelated workspaces read/write/export isolation | Membership/RLS and UI tests; hosted runtime verifier passed two-tenant persistence, encrypted credentials, queue RLS/grants and rollback | Database checks passed; authenticated app journey pending | Distinct authenticated users exercising the deployed app with populated records, including export and permitted-role behavior |
| Subscription/trial/usage/cancellation | Code tests present; sample billing disabled | Pending | Stripe test lifecycle and quota behavior, zero real charges |
| Export, retention, site deletion and revocation | Persistent local export and scoped deletion passed; retention inheritance and UTF-8 storage guards fixed and tested | Pending | Persisted exact export, scoped deletion, cleanup and revoked-key behavior |
| Scheduled maintenance and connector refresh | Scheduler/processing/queue implemented; hosted queue RLS/grants and rollback passed | Execution pending | Actual deployed scheduled run, retention cleanup, connector refresh, new-workspace coverage and failure monitoring |
| Opted-in health/summary reports | Default-off preferences, safe aggregate mail, current-recipient validation, opt-out and bounded retries passed focused tests | Pending | Approved migration026, sender configuration, scheduled execution, provider acceptance and inbox receipt |
| Attribution-product privacy and terms | Source pages rewritten for current product | Domain pending | Correct deployed pages/links and consistency with actual retention/deletion configuration |
| Desktop/mobile/keyboarding | Local pass; mobile overflow 390=390 and hidden focus corrected | Pending | Deployed fresh-user flow at desktop and mobile widths |
| Production logs and runtime health during journey | Local post-fix browser warning/error logs empty | Pending | Domain request IDs, logs, no relevant runtime failures |
| External customer's first value | No observation by this audit | Pending | New customer completes source-to-CRM workflow and understands report |

## Focused verification commands and interactions

`npx vitest run src/components/attribution/app.test.tsx src/components/attribution/reporting.test.tsx` passed seven tests. Targeted ESLint passed for the changed UI/tests/sample files. Tests cover cross-client unsaved settings, selected client URL, stale loads/saves, CRM field-status wording, actionable diagnostics and bounded lead rendering.

Browser loop: Overview → Campaigns → AI discovery evidence → lead detail; mobile closed sidebar → first Tab → visible toggle → open → close → Leads → no-match state; fresh desktop Leads → Next page → search `lead-0081` → contact identity and field verification. The final fresh-tab loop had no warning/error console entries. An earlier hydration error was investigated and fixed by sharing the server-generated sample snapshot; it must remain part of regression verification.

This report deliberately leaves account/provider/deployment gates open until the corresponding real evidence exists. Hosted database results below close their stated scope only. Append exact deployment, payment and customer-journey results as they become available.

## Hosted database and repository evidence update

The root release task reports a fresh successful run of `scripts/verify-maintaincode-database.mjs` with `--require-queue` against new Supabase project `mvzspyhwoqzcygekridy`, returning `ok: true`. All 25 migrations are applied. Checked scope includes the restricted runtime role, two-tenant persistence, stored credential encryption, maintenance queue RLS and grants, and rollback behavior. These are hosted database checks using controlled verification fixtures; they are not evidence of two real authenticated customers using the domain.

Maintenance scheduler configuration, processing and queue implementation are complete. The hosted queue checks establish database access boundaries; scheduled execution, external connector refresh and customer-facing failure recovery must still be observed after deployment.

The replacement source is published in [PR #11](https://github.com/rory-hayes/maintainflow/pull/11). This is branch publication evidence. `main` and `maintainflow.io` still show the old product, so neither merge nor production deployment is recorded as complete. This document reconciliation did not rerun tests or perform provider actions.

## Authentication implementation update

The release now includes Supabase email/password signup, sign-in, resend confirmation, password recovery/update and browser sign-out. `/auth/action` performs the operations on the server with an origin check and validated input. Provider errors are translated into customer messages without returning tokens. Session cookies are HttpOnly, SameSite=Lax and secure in production; proxy refresh propagates cookies to both the current request and outgoing response. Workspace identity comes from Supabase `getUser`, with open admission required. Legacy Clerk behavior is retained only when Supabase is not configured, so providers are not mixed.

`/auth/confirm` supports token hashes for email/signup/recovery links; `/auth/callback` supports PKCE codes. Successful callbacks remove authentication parameters and restrict redirects to the application or explicit password-update page. Expired links return to a recovery-capable screen. Returning authenticated customers open their actual workspace by default; explicit sample mode remains labelled and survives refresh.

Focused auth/UI verification passed **62 tests across nine files**, including invalid/missing identity, Supabase precedence, provider errors, signup release gates, neutral recovery messages, callback destinations, token removal, cookie propagation and failed cookie writes. Targeted ESLint and `npx tsc --noEmit` passed. The subsequent full verification also passed, as recorded below.

Local browser proof with the new project's public URL/key: sign-in → create account → required email/password/confirmation/terms controls; password recovery entry; 390px recovery width equals 390px document width. Screenshots: `/tmp/maintaincode-auth-signup-desktop.png` and `/tmp/maintaincode-auth-recovery-mobile.png`. No signup, recovery email, password change or third-party account mutation was submitted in this audit. Earlier dev-server restart logs were not treated as production failures; the final sample handoff fresh-tab loop was free of warning/error entries.

## Supabase authentication deployment settings

- Configure only `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` as public auth values. No database password, runtime password or service/secret key belongs in a public variable. The code rejects a non-publishable key in the public slot.
- Enable both `MAINTAINFLOW_ADMISSION_MODE=open` and `MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED=true`. These govern customer admission and public registration separately.
- Set the Supabase Site URL to `https://maintainflow.io`, with the configured application origin and exact callback/confirmation/password-update destinations in its redirect allowlist.
- Preferred signup email link: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`. Preferred recovery link: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`. Token-hash links support confirmation in another browser. The standard provider confirmation URL also works through the PKCE `/auth/callback` path when the initiating browser retains its verifier cookie.
- Configure and verify the actual SMTP sender, email confirmation, password requirements and rate limits. The default email service is a testing facility, not delivery proof. Keep real email/account/payment tests separate from mocked application tests.

Implementation references: [Supabase SSR client and proxy guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [Supabase password and recovery flow](https://supabase.com/docs/guides/auth/passwords). The repository's installed Next.js cookie and proxy guides were read before implementation.

### Saved Supabase email templates

The new project `mvzspyhwoqzcygekridy` now has saved, branded confirmation and recovery templates. The audit navigated away and reopened each template, verified the persisted subject/body, and inspected the rendered destination links:

- Confirmation subject: `Confirm your MaintainCode Ads account`; link `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`.
- Recovery subject: `Reset your MaintainCode Ads password`; link `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery`.

`Allow new users to sign up` and `Confirm email` are both enabled, and Email authentication remains enabled. No email was sent and no customer account was changed in this settings pass.

SMTP remains incomplete. Reopening its saved form showed custom SMTP enabled, sender name `MaintainCode Ads`, host `smtp.resend.com` and port `465`, but an empty sender address and username. Automatic approval review rejected saving the prepared Resend SMTP credential to this Supabase project because that specific credential transfer needs explicit user authorization. The rejected save was not retried or bypassed; its unsaved edits were discarded on navigation. Intended remaining settings are sender `accounts@maintainflow.io`, username `resend` and the privately held Resend API key as SMTP password. Successful save, persistence and a controlled delivery test remain open gates.

## Earlier full release verification

On 6 September 2026, `npm run verify` completed with exit code **0** against the current shared source checkout. Log: `/tmp/maintaincode-full-verify.log`.

| Check | Result |
| --- | --- |
| ESLint | Pass |
| Next route type generation and TypeScript | Pass |
| Full Vitest suite | 138 files, 1,166 tests passed |
| Ads contract suite | 3 files, 28 tests passed |
| OpenAI Ads contract checker | 1 file, 4 tests passed |
| Production/deployment configuration suites | 4 files, 87 tests passed |
| Tracker bundle | Pass, 67.9 kB generated output |
| Next.js production build | Pass; compilation, TypeScript, all 35 generated pages and build traces completed |
| Public build metadata | Generated successfully |

The dedicated suites intentionally repeat tests included in the full suite; their totals are not a unique-test sum. No functional code or tests needed modification to make this run pass. No server was restarted and no port was changed.

Artifact checks found no `.env` files in `.next` and no occurrences of the two new-project private password values across 3,174 build files. `.env.local` remains Git-ignored and contains the local public auth configuration. This verifies those specific artifact boundaries, not every conceivable secret. Production runtime environment, deployed revision, real auth email/session behavior and provider workflows still require their own evidence.

## Latest integrated verification

The later combined source check, recorded in `/tmp/maintaincode-final-verify.log`, passed 1,246 tests in 144 files, ESLint, TypeScript, contract/configuration checks and the 36-page production build. The separate owned PostgreSQL fixture passed all 26 migrations and 85 database tests. The hosted project remains at 25 migrations because automatic approval review rejected the new recipient-validator permission; migration026 has not been applied.

`node scripts/verify-maintaincode-persistent.mjs` passed the full local browser journey against an isolated PostgreSQL database: workspace/site creation and reload, an installed tracker on another origin, consent and withdrawal, delivery failure with navigation recovery, duplicate callbacks, diagnostic exclusion, protected export and scoped site deletion. No external provider requests or unexpected browser errors occurred. It uses a dedicated local identity, so it does not establish hosted Supabase authentication. Evidence is in `/var/folders/cz/_dzpxrc91nj3g6nkpzhs761c0000gn/T/maintaincode-persistent-evidence-uiKbrW`.

The bounded local concurrency verifier also passed capture/retry/settings preservation at the 500 and 2,500 monthly limits, quota responses, the 10,000-record cap and atomic oversized-write rejection using UTF-8 byte counts. These measurements are local evidence, not a hosted capacity guarantee. CI now includes Docker versions of both verifiers; their exact-head result belongs in the release PR.
