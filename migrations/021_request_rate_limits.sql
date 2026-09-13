-- Global request budgets contain only keyed IP digests, never raw IP addresses.
-- Runtime access is backend-only; the migration wrapper supplies its admin policy.
CREATE TABLE request_rate_limits (
 bucket_key text PRIMARY KEY CHECK(bucket_key ~ '^[0-9a-f]{64}$'),
 hits integer NOT NULL CHECK(hits BETWEEN 1 AND 1000001),
 expires_at timestamptz NOT NULL
);
CREATE INDEX request_rate_limits_expiry ON request_rate_limits(expires_at);
ALTER TABLE request_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_rate_limits FORCE ROW LEVEL SECURITY;
REVOKE ALL ON request_rate_limits FROM PUBLIC,folio_app;
