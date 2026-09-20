-- Existing keys retain their current non-expiring behavior. Expiry is checked
-- against the database clock whenever a bearer key authenticates a request.
ALTER TABLE api_keys ADD COLUMN expires_at timestamptz DEFAULT NULL;
