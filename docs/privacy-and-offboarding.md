# Privacy and offboarding gate

MaintainFlow must not run any production stage, including `demo`, without an
identified legal entity and monitored privacy and support contacts. The
executable production configuration gate requires:

- `MAINTAINFLOW_LEGAL_ENTITY_NAME`;
- `MAINTAINFLOW_PRIVACY_CONTACT_EMAIL`;
- `MAINTAINFLOW_SUPPORT_CONTACT_EMAIL`.

The public privacy and private-beta terms pages describe only behavior that is
implemented or explicitly constrained. They are an operational baseline, not a
replacement for Irish/EU legal review or a signed customer pilot agreement.

Before a public readiness fetch, the quota layer derives independent
HMAC-SHA-256 identifiers from the source IP address and target hostname. The
quota table stores those derived identifiers, counts, and hourly window times,
not the raw IP address or hostname. Its bounded daily cleanup targets buckets
older than 48 hours and surfaces a cleanup backlog or failure for operator
retry.

## Live-pilot admission checklist

Before connecting an advertiser account, record the customer controller/contact,
processor list, transfer mechanism where applicable, retention schedule,
support route, breach-notification route, and the authorized people who may
request export or deletion. Confirm whether readiness URLs, advertising data,
approval evidence, and monitoring records contain personal or commercially
sensitive information for that customer.

## Executable private-pilot offboarding

Self-service deletion is not implemented. Private pilots use the operator-only
`customer:offboard` command after verifying the requester and the exact Ads
account, acting organization, and Clerk operator ID. The command never accepts a
wildcard or list target. The acting operator must still be an active organization
owner, and the organization must be the advertiser owner or the sole manager of
an ownerless agency-managed account.

Load `DATABASE_URL` from the deployment secret manager. First run the command
without `--apply`; dry-run is the default:

```bash
npm run customer:offboard -- \
  --account-id 'adacct_exact_provider_id' \
  --organization-id '00000000-0000-4000-8000-000000000000' \
  --operator-id 'user_exact_clerk_id' \
  --export-file '/absolute/new/path/customer-offboarding-dry-run.json'
```

The dry run performs no database mutation. It writes a new mode-`0600` JSON
export instead of printing customer records, refuses to overwrite existing
evidence, excludes encrypted credential bytes and key material, inventories all
account-scoped retained evidence, and prints a confirmation token bound to the
current inventory observed by the command. Apply re-locks and re-inventories the
same exact account before accepting that token. It does not emit a token
while an Ads mutation is pending, ambiguous, or has a failed/unconfirmed
rollback. Reconcile that record first. A legacy `connection_mode=environment`
account is also blocked because a shared environment key cannot be removed
account-by-account; rotate or remove it
at the host before continuing.

Readiness-history writes and offboarding share an advertiser-account row lock.
If a scan is saving first, offboarding waits and includes that evidence; if
offboarding is already running, the later save is rejected after the account is
disconnected. Offboarding also refuses to start while any monitoring evaluation
or live account refresh holds a database claim, or while a scheduled monitoring
account attempt holds an unexpired lease. An expired scheduler lease remains in
the export as crash-recovery evidence but cannot block offboarding permanently;
scheduler completion is fenced to active accounts and cannot settle it after
disconnect. Live refresh claim, renewal,
completion, failure, and invalid-snapshot cleanup statements take a short shared
lock on the active advertiser row, while offboarding takes an exclusive lock.
The worker must finish or its expired claim must be recovered, ensuring the
final locked inventory includes its outcome before an export is accepted and a
new refresh claim cannot cross a completed disconnect.

Review the export and agreement-specific retention scope. If the target and
counts are correct, run apply with the unchanged token and a second new export
path:

```bash
npm run customer:offboard -- \
  --account-id 'adacct_exact_provider_id' \
  --organization-id '00000000-0000-4000-8000-000000000000' \
  --operator-id 'user_exact_clerk_id' \
  --export-file '/absolute/new/path/customer-offboarding-final.json' \
  --apply \
  --confirm 'OFFBOARD:adacct_exact_provider_id:<dry-run-state-fingerprint>'
```

Apply locks and re-inventories the exact account. A changed inventory among the
rows covered by those locks invalidates the token. The export must be durably
written before the transaction deletes all locally encrypted Ads and Conversions
credential rows, removes every account access grant, marks the account
disconnected, and inserts one non-secret
`maintainflow_customer_lifecycle_records` completion record with the export hash
and deletion counts. Organizations and memberships are preserved because an
agency organization may serve other accounts. Approval, monitoring, creative,
decision, readiness, and live-snapshot evidence is retained until its signed
schedule authorizes a separate deletion; disconnected accounts are excluded from
scheduled monitoring claims.

The command cannot revoke the source credentials held by OpenAI. Immediately
instruct the customer to revoke Ads and Conversions keys in Ads Manager, record
that external confirmation with the pilot evidence, remove Clerk access where
the organization itself is ending, and record backup-expiry implications. Test
the full procedure on a disposable hosted customer fixture and independently
verify the export hash, authorization denial, credential-row deletion, retained
history, source-key revocation, and recovery evidence before treating hosted
offboarding as production-proven.
