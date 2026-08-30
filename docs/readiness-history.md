# Account-scoped readiness history

Verified locally on 30 August 2026.

## Purpose

MaintainFlow can retain a landing-page readiness result for an authenticated
advertiser account and compare a later scan of the same final URL. This turns a
one-off checklist into bounded evidence of which checks improved or regressed
before an OpenAI Ads launch.

Public URL audits still work without an Ads API key or connected account. A
scan is saved only when the operator has current account-manager or owner
access, the PostgreSQL history migration is ready, and the optional
`accountId` is authorized again when the row is inserted.

## Stored contract

Migration `011_readiness_audit_history.sql` stores:

- the advertiser account, operator, acting organization, and roles observed at
  insertion;
- the bounded readiness result, score, verdict, and scan time;
- payload-schema, ruleset, scanner, and source-review versions;
- the query-redacted requested and final URLs;
- whether query parameters were removed;
- a target-association marker.

Manually entered URLs are recorded as `manual_unverified`. They are not claimed
to be the destination of a campaign, ad group, or ad until a future live Ads API
sync binds the URL to a provider resource.

The store excludes response bodies, page HTML, cookies, request headers, raw
measurement values, Pixel IDs, API keys, and URL query strings. URL fragments
are also removed. Rows currently have no automatic time-based expiry; deleting
the advertiser-account row cascades to its saved readiness runs.

## Comparison rules

The newest entry is compared with the prior saved scan of the same final URL
after query strings and fragments are removed. Score, verdict, and check-state
changes are shown only when both entries use the same payload schema, readiness
ruleset, and scanner version.

If any version differs, MaintainFlow keeps both results visible but pauses the
numeric comparison. This avoids presenting a changed scoring model as a real
site improvement or regression.

## Access boundary

- Owners and managers can save and read history for their authorized account.
- Analysts and viewers can read account history but cannot add a new row.
- Both reads and writes re-check active organization membership and exact
  advertiser-account access in PostgreSQL.
- Anonymous audits never fabricate a saved account history.

Local database tests prove account isolation, review-only write denial,
provenance retention, and the real migration/query path. They do not prove a
hosted database, Clerk session, live OpenAI advertiser account, or provider URL
association.
