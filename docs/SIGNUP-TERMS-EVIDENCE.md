# Signup terms evidence

This is dormant account-level evidence capture. There is no production policy catalogue, environment activation, signup privacy checkbox, payment change, assumed business-only eligibility, or message delivery. Normal `buildApp()` leaves capture disabled. The internal `signupPolicy` dependency supplies only reviewed synthetic policies in controlled tests until an actual catalogue is separately completed and authorised.

## Public registration contract

`GET /api/auth/signup-terms` returns either `{enabled:false,policy:null}` or `{enabled:true,policy}`. The exact displayed policy includes `version`, `language`, `title`, `text`, `url`, `agreementText` and `sha256`. Its digest is SHA-256 over the UTF-8 output of `canonicalSignupPolicy`: JSON with precisely those first six fields in that order. It binds all displayed fields, preserving literal strings and whitespace. It is not a digest of the text alone. Policy links must use HTTPS without credentials or fragments. Canonical displayed content is limited to 16,384 UTF-8 bytes; invalid supplied configuration returns a fixed 503. Only an absent dependency or explicit `null` disables capture.

When enabled, `POST /api/auth/register` requires `termsAcceptance:{accepted:true,version,sha256}` matching the current server policy. A missing, malformed or non-affirmative value returns 400. A stale version or changed digest returns 409 with instructions to review again. Acceptance submitted after capture is withdrawn also returns 409, allowing the client to refresh its displayed state. Disabled signup without acceptance retains its existing behavior and creates no evidence. No acceptance flag is inferred from account creation, privacy information, a payment, or an old account.

These checks happen before password hashing, queue admission or provisioning. Snapshot creation copies the exact server policy and a server-observed acceptance-request timestamp; the client cannot supply that timestamp or alternate terms. Policy rotation after a request has been accepted does not replace that request's snapshot.

## Immediate and queued creation

For immediate registration, the acceptance row is inserted in the same transaction as the new user, workspace and owner membership. Failure rolls them all back. An existing-account conflict cannot overwrite or backfill evidence.

Required-verification registration keeps the generic 202 reply and performs no account-existence lookup during admission. The existing encrypted queue envelope contains an optional strict `signupTerms:{policy,acceptedAt}` snapshot. Legacy envelopes without this property remain valid. A present invalid snapshot or digest is discarded by the worker; it is never downgraded to missing evidence. The worker reads no current policy and inserts the snapshot within its existing provisioning savepoint. An existing address, expiry, outbox failure or transactional rollback cannot attach evidence to an old account or leave a partial new record.

Legacy ciphertext retains the 8,192-byte application limit. A terms-bearing ciphertext may occupy at most 32,768 bytes. Under the existing global admission lock, both the existing 5,000-row cap and a total 40,960,000-byte ciphertext budget are enforced before consuming an address grant. The budget counts the new ciphertext as well as existing queued bytes. Capacity failure remains the same generic 503 for known and unknown addresses; address cooldown/five-per-hour behavior and bounded expiry cleanup remain unchanged. Migration 044 raises only the named row-size check; it does not raise the total queue storage budget.

## Personal record and database boundaries

`GET /api/auth/signup-terms/record` returns `{record:null}` for an account without evidence, or `{record:{policy,acceptedAt,recordedAt,evidenceNotice}}`. `GET /api/auth/signup-terms/record/download` returns the same preserved content and timestamps as a UTF-8 text attachment (`signup-terms.txt`); absent evidence returns 404. These routes require an ordinary browser session and are available to every workspace role. They resolve the user from the session actor and do not accept a target-user identifier. API keys and anonymous callers cannot read the record. Changing workspace or joining another workspace cannot expose another user's evidence.

The record belongs to `users`, not to a workspace or organisation contract. Migration 044 creates `signup_terms_acceptances` with a user primary key, exact policy JSON, acceptance-request timestamp and database recording timestamp. A forced-RLS SELECT policy uses only transaction-local `app.user_id`, set from the checked session. The application role has SELECT only; the migration builder explicitly reapplies that restriction after blanket grants. The immutable UPDATE trigger forbids replacement of any recorded field. User deletion cascades to this personal record. This does not invent a retention policy or independently authorise account erasure.

Public terms and personal responses use `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`, including when the authentication routes are mounted in a standalone test harness. The download is not an email or other proven durable-medium delivery. No IP address, user agent or password is added to this evidence.

## Verification boundaries

Synthetic policy tests cover canonical field binding, literal text, strict schemas, byte limits, unsafe URLs, fixed configuration errors, affirmative acceptance, rotation and withdrawal. Isolated backend tests cover immediate and queued records, original acceptance time across policy changes, existing-account nonenumeration/no-backfill, malformed ciphertext snapshots, rollback, the queue byte budget, session/API permissions, workspace-role independence, forced RLS, immutable updates, user deletion and exact text downloads. Existing registration regression tests remain part of the release check. The release task owns copied-source execution, populated backup/restore coverage, browser proof and recorded results.

This record states what the server received and preserved. It does not verify a person's identity, establish organisation authority, prove contractual information was delivered, record privacy consent, confirm payment, or establish legal completeness. Final policy wording, customer scope, operator disclosures, provider arrangements and delivery requirements remain separate launch work.
