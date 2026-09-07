# Workspace email reports

Tracking-health changes and weekly aggregate summaries are implemented as optional workspace reports. Both preferences default off, including existing workspaces. They are available to verified Supabase users with owner/admin workspace access; members can always turn their own reports off. The API accepts booleans only, never an arbitrary recipient address.

The recipient is the current authenticated user's confirmed account email at opt-in. Before every background attempt, migration 026's restricted boolean function checks the stored recipient against the current Supabase user, confirmed email, deletion/ban state, active organization and owner/admin membership. A removed or changed recipient is unsubscribed; lookup failures stop delivery. Disposable databases without `auth.users` return false. No Supabase admin key or direct runtime access to auth tables is needed.

## Configuration

For a fresh database, apply the current migration manifest through `026_maintaincode_notification_recipient.sql`. All 26 migrations are applied to the new hosted project, and current-recipient/runtime permission checks have passed. Existing migrations 001–025 are unchanged. Protected readiness checks that the function exists, uses its fixed safe search path and has the intended execution grants.

Reports stay disabled unless all of these server settings are configured:

- `MAINTAINCODE_REPORT_EMAILS_ENABLED=true`
- `MAINTAINCODE_REPORT_FROM`: one sender email address verified with Resend, without a display-name wrapper
- `RESEND_API_KEY`: an authorized Resend key held only by the server
- `MAINTAINCODE_APP_ORIGIN`: the exact HTTPS application origin

The approved report-mail settings are configured on the live deployment. Both per-user preferences remain off until explicitly enabled; server configuration does not subscribe anyone. The production configuration validator checks enabled report-mail settings. Missing configuration produces an unavailable state in Workspace & billing and still permits opt-out. No key is included in browser code, workspace exports or preference responses. Further hosting/provider credential changes require authorization for their destination. See [the release ledger](maintaincode-release-status.md) for current configuration and acceptance evidence.

## Content and preferences

Workspace & billing contains saved checkboxes for tracking-health changes and weekly summaries, the verified recipient and the last known provider-acceptance time. The first weekly summary becomes due seven days after enabling; the actual scheduled run can be later.

Messages contain a bounded single-line workspace name, static health guidance or aggregate counts, the exact UTC evidence window and links to the workspace report and preferences. They omit lead/contact names, contact identifiers, credentials, click references and raw source URLs. Weekly submission counts exclude attempts and diagnostics. Qualified-contact counts refer to the matched contacts in that window; won-deal counts use calendar close dates and do not claim an acquisition cohort or collected revenue.

Health changes are deduplicated by the set of actionable issue categories: installation, missing confirmation, unverified CRM fields, connector failure/freshness and unresolved deal associations. Unchanged categories generate no repeated email; clearing previously reported issues can produce one recovery message. These are scheduled observations, not real-time monitoring.

Each email includes an opaque per-subscription opt-out link. GET displays a confirmation page without changing preferences. The same-origin POST validates the token and removes that subscription's recipient and delivery state. Turning both app preferences off has the same effect. A message already accepted by the provider may still arrive. Opt-out is workspace-specific and does not affect security emails.

## Delivery and recovery

The existing daily maintenance worker processes reports after connector work, under the same parent cancellation signal. Email work allows at most two HTTP attempts per workspace run, five seconds per request and twelve seconds total, including a short abortable backoff for one immediate retry. Each workspace permits at most ten opted-in recipients; these limits and daily maintenance backlog can delay reporting.

Before sending, a locked workspace mutation persists an immutable message, stable provider idempotency key and thirty-second lease. Successful provider acceptance advances the weekly period or health baseline. Concurrent workers cannot claim the same live lease. Changing an unrelated preference preserves the pending message and deduplication state; disabling its category consumes that pending event. Opt-out and newer-consent versions fence stale completion/cleanup writes.

Retries keep the original payload/key. After three attempts or twenty-three hours from the initial reservation, an uncertain send requires review instead of an automatic resend. This stays inside Resend's twenty-four-hour idempotency window. **Resume future reports** deliberately skips the uncertain message, takes the current health baseline and starts a new seven-day weekly period. It does not resend the old message. Unresolved delivery is reflected as partial maintenance.

The app records **provider acceptance**, not inbox delivery. Report tests mock mail. Approved server configuration, hosted migration 026/current-recipient checks and production cron registration are complete. A separate TLS-verified SMTP authentication check passed without sending email; it does not prove report API acceptance or inbox receipt. Remaining operating gates are a controlled user-owned opt-in/provider-acceptance/inbox/opt-out test and actual hosted scheduled execution. No real report emails have been sent during verification.

Official references: [Resend send API](https://resend.com/docs/api-reference/emails/send-email), [Resend idempotency window](https://resend.com/docs/dashboard/emails/idempotency-keys), [Supabase Auth user model](https://github.com/supabase/auth/blob/master/internal/models/user.go).
