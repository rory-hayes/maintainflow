# Recovering an exhausted Stripe event

Use this operator-only procedure after diagnosing and correcting the cause of a failed billing event. It grants another bounded attempt cycle to the existing event. It does not contact Stripe, change an entitlement, create a subscription, resend a webhook or certify recovery. The normal worker must subsequently read current provider state and complete reconciliation.

Use a reviewed release and the approved database credentials through the secure environment configuration path. Explicitly set `DATABASE_ADMIN_URL`, `DATABASE_SCHEMA` and `STRIPE_MODE` in the process environment. Do not paste credentials into commands or receipts. Confirm the database, mode, customer and workspace against the incident before proceeding. The command refuses mismatched selectors, unbound events and conflicting workspace references.

1. Inspect the exact event using the following template, replacing the synthetic identifiers. This is read-only.

   ```sh
   node --import tsx scripts/recover-stripe-event.ts \
     --event stripe:evt_REPLACE --workspace 00000000-0000-4000-8000-000000000001 \
     --customer cus_REPLACE --mode test --database folio --schema public
   ```

2. Retain the safe inspection and review its `eligible` status, binding, attempt count and `snapshotDigest`. Only an exhausted `failed` event with both lease fields cleared can be recovered. Let the normal worker mark an expired final lease failed first. Do not clear a lease, edit the event payload or delete its history to bypass a refusal.

3. Run the same command with `--execute --expected REVIEWED_DIGEST --operator "Operator name" --reason "Incident reference and corrected cause"`. These fields must describe the actual incident; omit credentials and customer document data. Execution locks and rechecks the event and subscription binding. A changed or already-recovered event is refused; inspect again rather than reusing an old digest.

4. Retain the returned recovery ID. The event update and `billing.event_recovery_requested` audit entry commit together. The audit retains the previous attempt cycle and state. A database/audit failure rolls back recovery. The event identity and payload, subscriptions, entitlements, original files and usage history are not rewritten by this command.

5. Observe the normal worker's next attempt. Verify the same event reaches `completed`, a subsequent `billing.reconciled` audit links it to the intended workspace, and current provider state agrees with the effective limits. Check the control workspace and incident-specific retained records. If the failure remains, investigate it rather than repeatedly resetting attempts. A successful requeue alone is not a recovered customer.

Access to the administrative database authorizes this operation; an operator name is an audit label, not a replacement for database authentication. There is no HTTP recovery endpoint or customer-facing retry button. Actual provider resend, hosted transport, operational alert delivery and live billing acceptance remain separate checks.
