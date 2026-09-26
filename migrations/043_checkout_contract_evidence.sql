-- Dormant evidence storage: no policy catalogue or billing activation is installed.
-- Do not infer the transport key generation from a possibly missing evidence
-- row. All historical v1/v2 reservations retain their exact legacy behavior.
ALTER TABLE billing_checkouts ADD COLUMN contract_capture boolean NOT NULL DEFAULT false;
CREATE TABLE checkout_contracts (
 id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 initiated_by uuid REFERENCES users ON DELETE SET NULL,
 billing_mode text NOT NULL CHECK(billing_mode IN ('test','live')),
 customer_id text NOT NULL CHECK(customer_id ~ '^cus_[A-Za-z0-9_-]{1,200}$'),
 plan_id text NOT NULL CHECK(plan_id IN ('standard','team')),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object' AND octet_length(policy::text)<=70000),
 offer jsonb NOT NULL CHECK(jsonb_typeof(offer)='object' AND octet_length(offer::text)<=2048),
 create_params jsonb NOT NULL CHECK(jsonb_typeof(create_params)='object' AND octet_length(create_params::text)<=12000),
 params_sha256 text NOT NULL CHECK(params_sha256 ~ '^[0-9a-f]{64}$'),
 session_id text CHECK(session_id ~ '^cs_[A-Za-z0-9_-]{1,200}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,workspace_id), UNIQUE(billing_mode,session_id)
);
CREATE INDEX checkout_contracts_history ON checkout_contracts(workspace_id,created_at DESC,id DESC);
CREATE TABLE checkout_contract_receipts (
 contract_id uuid PRIMARY KEY,
 workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
 session_id text NOT NULL CHECK(session_id ~ '^cs_[A-Za-z0-9_-]{1,200}$'),
 event_id text NOT NULL CHECK(event_id ~ '^evt_[A-Za-z0-9_-]{1,200}$'),
 state text NOT NULL CHECK(state IN ('accepted','not_recorded')),
 provider_event_created_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(contract_id,workspace_id) REFERENCES checkout_contracts(id,workspace_id) ON DELETE CASCADE
);
-- The only mutable binding is a previously unknown Session ID; user deletion
-- may anonymise the initiating-user reference. No UPDATE can replace evidence.
CREATE FUNCTION preserve_checkout_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'session_id'-'initiated_by') IS DISTINCT FROM (to_jsonb(OLD)-'session_id'-'initiated_by')
 OR (NEW.initiated_by IS DISTINCT FROM OLD.initiated_by AND NEW.initiated_by IS NOT NULL)
 OR (NEW.session_id IS DISTINCT FROM OLD.session_id AND (OLD.session_id IS NOT NULL OR NEW.session_id IS NULL)) THEN
  RAISE EXCEPTION 'Checkout terms record is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER checkout_contract_immutable BEFORE UPDATE ON checkout_contracts FOR EACH ROW EXECUTE FUNCTION preserve_checkout_contract();
CREATE FUNCTION preserve_checkout_contract_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Checkout terms completion record is immutable';
END $$;
CREATE TRIGGER checkout_contract_receipt_immutable BEFORE UPDATE ON checkout_contract_receipts FOR EACH ROW EXECUTE FUNCTION preserve_checkout_contract_receipt();
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['checkout_contracts','checkout_contract_receipts'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',relation);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',relation);
  EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT TO folio_app USING (workspace_id = nullif(current_setting(''app.workspace_id'',true),'''')::uuid)',relation);
  EXECUTE format('GRANT SELECT ON %I TO folio_app',relation);
 END LOOP;
END $$;
