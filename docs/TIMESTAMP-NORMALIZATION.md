# Timestamp normalization

This additive field type implements the timestamp/timezone part of W06/R02. Existing `date` fields remain calendar dates; text identifiers keep leading zeros. It does not claim full capability parity, hosted acceptance, or general extraction accuracy.

## Values and interpretation

- Choose **Timestamp (date & time)** for an instant. Normalized output is a UTC ISO string such as `2026-09-17T13:30:00Z`; fractional seconds are retained up to nine digits, with trailing zeros removed. JSON, CSV, XLSX and outgoing integrations receive the approved string without a second conversion.
- Input must contain a date and a 24-hour time (`HH:mm`, optionally `:ss` and one to nine fractional digits). Supported date forms are `YYYY-MM-DD`, the existing Gregorian regional numeric order, and unambiguous localized written month names. `en-US` numeric dates are month/day/year; the other existing numeric-date locales use day/month/year. Use ISO dates when the source's order is uncertain.
- A trailing `Z` or numeric offset (`+01:00`, `-04:00`) specifies the instant and overrides configured timezone settings. `-00:00` is treated as a known UTC instant, as specified by RFC 3339, rather than as missing offset information.
- Without an offset, use the timestamp field's optional source-timezone override, otherwise the job's saved parser timezone. This is not the browser or server operating system timezone. Missing/invalid historical settings never silently borrow the current parser's settings.
- Date-only and time-only strings, rollover dates, leap seconds, time-zone abbreviations, bracketed zone annotations, years outside 0001–9999, and more than nine fractional digits are rejected for timestamps. The original value remains visible for correction; no precision is silently truncated.

## Clock changes and review

Temporal conversion uses `disambiguation: 'reject'`. If a local time occurs twice, the field has a `timestamp_ambiguous` issue. If it never occurs because the clock jumps, it has `timestamp_nonexistent`. The original string remains unchanged. Neither an earlier/later occurrence nor a shifted time is selected automatically.

The reviewer compares the source and enters the intended time with an explicit numeric offset. Saving the correction normalizes it to UTC. Approval rejects any populated timestamp that is still invalid, ambiguous or unconverted, including optional fields. Blank optional values keep existing semantics. Defaults and nested/table timestamp fields follow the same conversion rules.

A matching text/native-PDF template retains its captured timestamp and review issues rather than rejecting the entire source match solely because timestamp conversion is unresolved. Required-source/anchor checks, other field validation and template priority remain unchanged. AI receives instructions to return the complete literal timestamp and offset; only the application normalizes it.

## Saved settings and compatibility

New jobs record `normalizationPolicy: 'timestamp-v1'` in their existing pinned configuration. Unsupported policy versions fail explicitly. Intake, reprocessing, archive/PDF child jobs and first-sample setup already share that snapshot function.

Migration **039** adds nullable `extraction_runs.normalization_context` containing the normalization policy, locale, timezone and runtime timezone-database version. Each new run records the exact job settings; this survives deletion of its originating job. Legacy runs remain `NULL` and are never backfilled from current parser settings. Date-only schemas and stored raw/normalized values are not rewritten.

Timestamp corrections use only the selected run's context and its immutable schema's field override. Other manual field values retain their previous semantics; applying a timestamp correction does not reapply text transforms, defaults or regional number conversion. Existing approvals and exported bytes stay immutable. Locale/timezone edits affect new jobs and explicit reprocessing, not previously queued jobs/runs.

The saved timezone-database version is provenance, not an embedded historical rules database. Already-normalized UTC values remain stable. Reinterpreting new offset-free corrections after a future runtime timezone-data update may use revised rules; enter an explicit offset when an exact historical interpretation must be retained.

Native-template preview requests and browser check caches include timezone in their stale-state checks. Runtime readiness includes the new run column, so an unmigrated runtime cannot report database readiness.

## Verification and remaining acceptance

Focused automated checks cover winter/summer conversion, Dublin gaps/folds, Lord Howe half-hour transitions, Samoa's skipped date, fractional offsets/precision, invalid input, raw/date/identifier preservation, nested/default fields, controlled AI transport, both text-template generations, native regions, immutable job/run settings, job deletion, corrections, approval and export bytes. The isolated database check also rejects malformed migration contexts and unknown policy versions.

On 26 September 2026, **173/173 focused tests passed** on Node 24.13.0 in a fresh PostgreSQL 17 cluster using a private Unix socket; migration 039 was applied there. The copied source remained unchanged and the private cluster and checkout were removed afterward. TypeScript, frontend build, deployment bundle, and the packaged timestamp module's dependency/runtime check passed. This does not verify an unmigrated hosted readiness failure or a rendered UI. The complete private test receipt is retained with the implementation handoff.

Remaining acceptance is the rendered desktop/mobile schema/settings/review flow, hosted migration/deployment with readiness, and a source-to-review-to-approved-export walkthrough on the target deployment. No real AI, Google, mail or billing request is needed for or implied by the local proof. W06/R02 must not be marked fully complete solely from unit tests.

Implementation references: [Temporal timezone ambiguity](https://tc39.es/proposal-temporal/docs/timezone.html), [Temporal ZonedDateTime conversion options](https://tc39.es/proposal-temporal/docs/zoneddatetime.html), [Temporal polyfill 0.5.1](https://github.com/js-temporal/temporal-polyfill/releases/tag/v0.5.1), and [RFC 3339 unknown local offset](https://www.rfc-editor.org/rfc/rfc3339.html#section-4.3).
