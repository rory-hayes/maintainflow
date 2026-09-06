# Change Integrity Guard

## Purpose

MaintainFlow compares material configuration from two confirmed full OpenAI Ads
snapshots. It answers a bounded operational question: is the newly observed
state explained by unambiguous latest recorded MaintainFlow operation evidence,
temporally indeterminate at detection time, or unexplained by the retained
evidence?

The guard does not identify an actor, monitor in real time, prove that no change
occurred between snapshots, or replace Ads Manager as the system of record.
“Unexplained” means only that MaintainFlow found no unambiguous latest recorded
explanation inside the evidence window. That includes absent evidence and
conflicting latest operations with the same recorded time; agreeing operations
with the same latest time remain unambiguous.

## Evidence boundary

The version-one projection includes user-controlled account, campaign, ad-group,
and ad configuration. Provider review decisions, serving issues, timestamps,
screenshots, generated delivery fields, and unknown extension fields are
excluded so provider-owned churn does not become a false configuration alert.
Arrays that represent sets are canonicalized before SHA-256 fingerprints are
created.

Each snapshot persists the start and completion of its full provider-read
interval. The next comparison begins its operation-evidence window at the prior
snapshot's start, rather than its completion, so a MaintainFlow write that may
have landed after a resource was read is not stranded behind an advanced
baseline. Snapshot intervals must be ordered and non-overlapping; a confirmed
operation inside the current read interval is recorded as timing-indeterminate
because its order relative to every resource read cannot be proven.

Every resource is account-scoped and retains its parent, label, optional
provider update time, projected configuration, and fingerprint. Created,
updated, and removed resources retain bounded before/after configuration and
the exact changed field paths. Repeating the same transition at a later
observation time creates a distinct event; retrying the same observation stays
idempotent.

## Classification

- `maintainflow_consistent`: every changed field matches a confirmed stored
  MaintainFlow apply or rollback that completed before the current provider-read
  interval.
- `indeterminate`: no field is unexplained, but at least one field matches only
  operation evidence that was either unconfirmed or overlapped the provider-read
  interval at detection time, so outcome or snapshot ordering was not proven.
- `unexplained`: at least one changed field lacks an unambiguous latest explanation;
  evidence may be absent or the latest same-time operations may conflict.

Failed operations, malformed payloads, non-canonical paths, account/resource
mismatches, and attempts outside the observation window cannot explain a
change. A matching operation establishes consistency only; it is not actor
attribution.

## Durable and atomic behavior

Migration `022_ads_change_integrity.sql` creates one credential-independent
baseline per advertiser account and an immutable event ledger. A fresh provider
refresh records the integrity comparison and publishes the matching workbench
snapshot in one PostgreSQL transaction. If baseline validation, event insertion,
or workbench publication fails, neither snapshot advances.

Event inserts derive `open` review state for unexplained and indeterminate
changes and `not_required` for consistent changes. The evidence columns cannot
be updated. The database rejects duplicate or empty field paths, paths longer
than 512 characters, incomplete or overlapping category assignments, and a
classification that conflicts with its exact field-path partition. An open item
can move once to `reviewed`; the database rechecks an active organization
membership and owner/admin plus account owner/manager authority at update time,
then derives role snapshots and database time.

The selected-account screen exposes bounded before/after evidence, labels each
field as explained, temporally indeterminate, or not unambiguously explained, and accepts a required
10–1,000 character review note. Open events are shown first and can be loaded in
bounded keyset pages. The same open classifications are aggregated as compact
counts for every active client in an agency portfolio; when only part of a
selected account is expanded, the compact remainder stays visible. A failed
load, missing baseline, stale snapshot, and confirmed zero are separate states.

## Simulator and live boundary

The simulator supplies deterministic schema-valid examples for all three
classifications and keeps review state in the current browser session. It does
not persist, contact OpenAI, or represent customer evidence.

Live evidence begins only after two fresh, complete provider snapshots have
advanced the durable baseline. Retained events may remain visible when a later
refresh fails, but the UI labels them as retained and does not infer a newer
comparison.

## Privacy and lifecycle

Integrity state and events are included in the account export without credential
secrets. Offboarding retains them with other historical account evidence until
the signed retention purge deletes event rows before baseline state. Account
deletion cascades only after the controlled lifecycle permits it.

## Verification and production gates

`npm test` covers projection, canonicalization, classifications, recurrence,
store behavior, route authorization, page wiring, action queues, and simulator
fixtures. `npm run test:db` applies all 22 migrations to disposable PostgreSQL
and proves exact field-path partitions, immutable evidence, current-role review
authorization, recurring events, narrow runtime grants, and live-sync rollback
atomicity.

This is still local/schema/simulator evidence. Production use additionally
requires a verified hosted backup and restore rehearsal, hosted migration and
runtime-role proof, a real OpenAI Ads account and credential, two fresh full
syncs, controlled provider changes, operator review, and repeated comparison
under production monitoring.
