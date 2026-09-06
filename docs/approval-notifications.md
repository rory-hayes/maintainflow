# Approval email delivery

MaintainFlow can notify eligible agency reviewers and requesters without putting
client, campaign, payload, evidence, note, or email-address data in its outbox.
The feature is fail-closed and allowlisted per organization; applying migration
`021` alone does not enable it.

## Delivery boundary

- A request transition and its delivery rows commit in the same PostgreSQL
  transaction. If the outbox is unavailable while email is enabled, the approval
  transition fails instead of creating an unnotified paid-pilot workflow.
- The worker resolves the recipient's current verified primary Clerk address in
  memory, rechecks active membership and request state, and sends only a
  privacy-safe authenticated deep link.
- Resend receives a deterministic idempotency key. PostgreSQL owns the immutable
  first-attempt time, attempt counts, two-minute claim leases, retry times,
  terminal states, and event ordering.
- The webhook verifies the signed raw body and records delivery, delay, bounce,
  complaint, suppression, or failure. Persistence outages return a retryable
  response rather than acknowledging lost evidence.
- Offboarding cancels unsent work, blocks on an active send lease, retains
  provider-accepted and terminal evidence, and includes delivery state in the
  export and retention purge.

## Recovery and alert semantics

- A send is attempted at most five times. The fifth transient identity or
  provider failure becomes a terminal operator-attention state instead of
  asking PostgreSQL for an invalid sixth attempt.
- An expired send lease or ambiguous transport failure is retryable only inside
  Resend's documented 24-hour idempotency window, measured from the first send
  attempt rather than the most recent failure. After that boundary MaintainFlow
  fails closed rather than risk sending a duplicate email after the provider
  forgets the idempotency key.
- Provider-accepted email waits 48 hours for a signed terminal event. This is
  longer than Resend's roughly 27.5-hour automatic webhook retry schedule; a
  later signed terminal replay may still replace the provisional missing-
  confirmation failure.
- A valid signed webhook that races ahead of the provider-acceptance commit gets
  a retryable response. Provider event ordering uses provider timestamps only;
  it is not rejected because a provider timestamp predates MaintainFlow's later
  local commit time.
- Every recovery path is bounded to one organization and follows the same lock
  order as offboarding: organization, memberships, approval requests, then
  delivery rows. Permanent recovery outcomes make the protected worker return a
  non-success status and emit privacy-safe aggregate alert counts.

These timings track Resend's current
[idempotency-key retention](https://resend.com/docs/dashboard/emails/idempotency-keys)
and [webhook retry schedule](https://resend.com/docs/webhooks/retries-and-replays).

## Required configuration

1. Apply every migration in the current checked-in manifest and refresh the restricted
   `maintainflow_app` runtime grants.
2. Verify a Resend sending domain and create a server-only API key.
3. Create a Resend webhook for `https://maintainflow.io/api/webhooks/resend` and
   subscribe to `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`, `email.suppressed`, and `email.failed`.
4. Configure these server variables while keeping the feature off:

   ```text
   MAINTAINFLOW_APPROVAL_EMAIL_ENABLED=false
   MAINTAINFLOW_APPROVAL_EMAIL_ORGANIZATION_IDS=<exact agency UUID>
   MAINTAINFLOW_APPROVAL_FROM_EMAIL=approvals@maintainflow.io
   RESEND_API_KEY=<server-only Resend key>
   RESEND_WEBHOOK_SECRET=<signed webhook secret>
   ```

5. Keep `MAINTAINFLOW_APP_ORIGIN=https://maintainflow.io` exact. Use a Vercel
   plan that supports the configured five-minute cron; [Vercel's current cron
   limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) restrict Hobby
   to daily execution, so Hobby is not sufficient for this retry schedule.
6. Run `npm run check:production-config`, the full verification suite, and the
   authenticated deployment readiness probe before enabling one organization.

The exact-revision deployment smoke now checks anonymous denial and one clean,
authenticated notification-worker run against an explicit expected enablement
state. An enabled run with zero claimed rows is worker-liveness evidence only;
the two-recipient delivery and signed-webhook exercise below remains required.

## Pilot acceptance

Use two distinct, real Clerk users in the same allowlisted agency:

1. Confirm both users have verified primary email addresses and neither account
   is locked or banned.
2. Enable the feature for only that agency and deploy an immutable revision.
3. As the requester, create one labelled simulator packet. Confirm the other
   owner/admin receives an email with no customer or change details, signs in,
   and lands on the exact approval dialog.
4. Approve once and request changes once. Confirm the requester receives the
   correct result email and that approval itself performs no external Ads write.
5. Remove or demote a reviewer before a queued retry and confirm the delivery is
   cancelled rather than sent.
6. Exercise provider timeout, rate limit, invalid recipient, delayed delivery,
   bounce, complaint, webhook replay, and an early webhook arriving before the
   provider-acceptance commit. Confirm every outcome is visible in the outbox and
   no duplicate email is produced.
7. Run customer offboarding during a send claim and confirm it blocks until the
   lease resolves; then verify export, cancellation, restore, and retention
   evidence.

Only after these checks pass is approval email proven for that organization.
They do not prove teammate invitation, self-service membership, OpenAI Ads
provider acceptance, or public launch readiness.
