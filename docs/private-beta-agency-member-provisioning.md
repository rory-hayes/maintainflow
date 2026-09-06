# Private-beta agency member provisioning

MaintainFlow does not yet provide teammate invitations or self-service member
administration. This operator-only command is a narrow bridge for a controlled
design-partner test: it adds one existing, admitted Clerk user to one existing
agency organization in PostgreSQL.

Every protected customer read and mutation requires both a valid Clerk identity
and current runtime admission before organization or account authorization is
evaluated. The provisioner treats admission as a human-verified precondition;
it does not inspect or change the deployment's admission configuration.

It inserts database membership only. It does not create or verify a Clerk
account, alter the private-beta admission list, send an invitation or email,
notify an approver, or authorize an OpenAI Ads request. Organization membership
does, however, inherit every advertiser-account grant held by the agency: an
`analyst` can read those accounts and an `admin` can receive live-write authority
when the agency has `manager` or `owner` account access and every release gate is
enabled. An approved agency-simulator packet still means approved for later
execution only.

## Preconditions

Before running the command, verify all of the following outside the command:

1. The target already has a real Clerk account with an exact `user_...` ID and
   can sign in to the same Clerk tenant used by the deployment.
2. The target is separately admitted to the closed deployment. While
   `MAINTAINFLOW_ADMISSION_MODE=private_beta`, include that exact Clerk user ID in
   `MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS` and deploy the reviewed configuration.
   Production admission lists accept only exact, unique, bounded `user_...` IDs;
   empty entries and wildcards are invalid. A membership row does not bypass
   this application admission gate.
3. The agency organization already exists and is active. Obtain its exact UUID
   from a trusted operator source rather than accepting an unverified customer
   value.
4. The acting Clerk user is the agency's current active `owner`, and the
   production operator has independently verified and recorded that owner's
   request through the approved support channel. An `admin` or `analyst` cannot
   be named as the acting user, even if they can perform other application
   actions.
5. Choose only `admin` or `analyst` for the target. Use `admin` when the second
   person must decide another member's approval request; an `analyst` can request
   a decision but cannot approve one. The command never creates another owner.
6. Treat either role as agency-wide access, not approval-queue-only access. The
   owner must confirm the target is trusted to see every current and future
   advertiser account held by the agency; for `admin`, they must also confirm the
   target is trusted with live-write authority wherever the account and release
   gates permit it. MaintainFlow does not yet support account-scoped teammates.
7. Migration `019` and the organization-membership store have passed readiness
   for the exact environment. Load a separate, short-lived privileged operator
   `DATABASE_URL` from the secret manager rather than placing it in a file,
   source control, or the application's deployment environment. Do not use the
   production runtime URL or its restricted `maintainflow_app` role.

For a hosted database, `DATABASE_URL` must contain exactly one
`sslmode=verify-full` parameter and `MAINTAINFLOW_DATABASE_CA_CERT` must contain
the matching provider root CA. The command uses the repository's shared database
TLS checks and will not weaken hostname verification.

Apply uses row locks to re-check the organization and membership state. The
restricted application role intentionally lacks the table privilege required by
those locks, and the CLI refuses `current_user=maintainflow_app`. Do not widen
the runtime role's grants to make this operator workflow run; issue a bounded,
short-lived operator credential for the procedure and revoke or expire it when
the run is complete.

The short-lived role needs `SELECT,UPDATE` on
`maintainflow_organizations`, `SELECT,INSERT,UPDATE` on
`maintainflow_organization_memberships`, and either `BYPASSRLS`, superuser, or
ownership of both zero-policy RLS tables. `UPDATE` is required only so
PostgreSQL permits `SELECT ... FOR UPDATE`; this command issues no `UPDATE` or
`DELETE`. Grant only the capability needed for this run and do not reuse the
credential as an application secret.

The CLI does not authenticate the human at the shell. It verifies that the exact
`--acting-operator-id` currently belongs to an active agency owner and binds that
database state into confirmation. Restrict command and database access to the
production operator; never treat possession of an owner's Clerk ID as the
owner's authorization.

In private-beta mode, runtime admission is the union of
`MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS` and
`MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS`; bootstrap IDs therefore remain admitted
after initial workspace claim for compatibility. Keep the bootstrap list
minimal, and atomically move an onboarded user from it to the private-beta list
in one reviewed configuration change when narrower bootstrap behavior is
desired. Removing a user from the runtime admission union blocks their existing
membership access, reviewer eligibility, approval links and notifications, and
execution of any unconsumed live packet they approved.

## Dry run

Dry-run is the default. Omit `--apply` and run against exactly one organization,
acting owner, and target user:

```bash
npm run agency:member:provision -- \
  --organization-id '00000000-0000-4000-8000-000000000000' \
  --acting-operator-id 'user_exact_current_owner_clerk_id' \
  --target-operator-id 'user_exact_existing_target_clerk_id' \
  --role 'admin'
```

The dry run opens a read-only transaction, validates the current organization
and membership state, and performs no mutation. Its bounded output contains the
action, requested role, hashed organization and target references, the explicit
no-Clerk/no-email limitation, and—when the request is unblocked—a confirmation
token bound to that observed state. It does not print raw organization or Clerk
user IDs.

Review the role and hashed references against the operator record. Do not
continue if the target identity, organization, admission status, or requested
role has not been independently verified. The dry-run output repeats the
agency-wide account-access warning before it emits a confirmation token.

## Apply

Repeat the exact four target flags from the latest dry run, then add `--apply`,
its exact token, and the explicit agency-wide access acknowledgement:

```bash
npm run agency:member:provision -- \
  --organization-id '00000000-0000-4000-8000-000000000000' \
  --acting-operator-id 'user_exact_current_owner_clerk_id' \
  --target-operator-id 'user_exact_existing_target_clerk_id' \
  --role 'admin' \
  --apply \
  --confirm 'PROVISION-AGENCY-MEMBER:<64-hex-dry-run-state-fingerprint>' \
  --acknowledge-agency-account-access
```

Apply locks and re-reads the agency and relevant memberships before accepting
the token. A changed or stale state invalidates confirmation. A successful new
apply inserts exactly one active membership; a retry with the same existing role
is idempotent and reports that the membership was already provisioned. Apply is
rejected unless the operator explicitly acknowledges that membership inherits
all current and future agency advertiser-account grants.

The command fails closed when the organization is not an active agency, the
acting user is not its current active owner, the acting and target IDs are the
same, the requested role is not `admin` or `analyst`, the target already has a
different role, or the confirmation does not match current state. It is not a
role-change, removal, suspension, or ownership-transfer tool. Stop and use a
separately reviewed operational process if any of those lifecycle changes are
required.

## Two-person simulator acceptance

After apply, keep the deployment in closed private-beta admission and complete
the test through two distinct real sessions:

1. Have the requester sign in and submit one labelled agency-simulator
   recommendation to the agency approval queue.
2. Confirm the requester cannot decide their own packet.
3. Have the separately provisioned `admin` sign in and record the decision.
4. Confirm the packet remains labelled as simulator evidence and that the UI
   states no OpenAI Ads request was sent.
5. Exercise cancellation, expiry, and concurrent-decision behavior. Expect no
   email unless the exact test organization has separately passed the
   [approval-email delivery runbook](approval-notifications.md).

Passing this procedure proves the database-backed maker-checker workflow for a
controlled private-beta test. It does not prove Clerk invitation delivery,
self-service team administration, a live advertiser-account session, OpenAI Ads
behavior, provider write acceptance, account-scoped member controls, paid
entitlement, or public launch readiness. The remaining release gates are tracked
in [`live-release-gates.md`](live-release-gates.md) and
[`release-stages.md`](release-stages.md).
