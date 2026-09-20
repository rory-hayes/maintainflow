-- Historical provider rows are test-mode only. Live state gets its own durable namespace.
ALTER TABLE subscriptions ADD COLUMN billing_mode text NOT NULL DEFAULT 'test' CHECK(billing_mode IN ('test','live'));
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_pkey;
ALTER TABLE subscriptions ADD PRIMARY KEY(workspace_id,billing_mode);
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_customer_id_key;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_subscription_id_key;
ALTER TABLE subscriptions ADD UNIQUE(billing_mode,customer_id);
ALTER TABLE subscriptions ADD UNIQUE(billing_mode,subscription_id);
ALTER TABLE billing_checkouts ADD COLUMN billing_mode text NOT NULL DEFAULT 'test' CHECK(billing_mode IN ('test','live'));
ALTER TABLE billing_checkouts DROP CONSTRAINT billing_checkouts_pkey;
ALTER TABLE billing_checkouts ADD PRIMARY KEY(workspace_id,billing_mode);
-- Existing paid provider entitlements must not masquerade as live after activation.
UPDATE workspaces w SET plan=w.plan||'{"billingMode":"test"}'::jsonb
 WHERE w.plan->>'billingMode' IS NULL AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.workspace_id=w.id AND s.customer_id IS NOT NULL);
-- Preserve the Stripe idempotency key for a pre-upgrade unresolved test Checkout.
ALTER TABLE billing_checkouts ADD COLUMN idempotency_version integer NOT NULL DEFAULT 1 CHECK(idempotency_version IN (1,2));
ALTER TABLE billing_checkouts ALTER COLUMN idempotency_version SET DEFAULT 2;
ALTER TABLE billing_checkouts ADD CHECK(billing_mode='test' OR idempotency_version=2);
