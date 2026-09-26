-- Dormant signup evidence only; no policy catalogue or activation is installed.
CREATE TABLE signup_terms_acceptances (
 user_id uuid PRIMARY KEY REFERENCES users ON DELETE CASCADE,
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object' AND octet_length(policy::text)<=20000),
 accepted_at timestamptz NOT NULL CHECK(isfinite(accepted_at)),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp() CHECK(isfinite(recorded_at))
);
CREATE FUNCTION preserve_signup_terms_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Signup terms acceptance record is immutable';
END $$;
CREATE TRIGGER signup_terms_acceptance_immutable BEFORE UPDATE ON signup_terms_acceptances FOR EACH ROW EXECUTE FUNCTION preserve_signup_terms_acceptance();
ALTER TABLE signup_terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE signup_terms_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY user_read ON signup_terms_acceptances FOR SELECT TO folio_app USING (user_id=nullif(current_setting('app.user_id',true),'')::uuid);
GRANT SELECT ON signup_terms_acceptances TO folio_app;
REVOKE INSERT,UPDATE,DELETE ON signup_terms_acceptances FROM folio_app;
-- Terms-bearing envelopes carry the immutable accepted snapshot. Admission
-- retains the existing global 5000*8192-byte storage budget and address caps.
ALTER TABLE account_registration_requests DROP CONSTRAINT account_registration_requests_payload_ciphertext_check;
ALTER TABLE account_registration_requests ADD CONSTRAINT account_registration_requests_payload_ciphertext_check CHECK(octet_length(payload_ciphertext)<=32768);
