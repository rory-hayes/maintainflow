# Bank statement and timestamp release preparation

Prepared on 26 September 2026 for the **existing** Supabase project `dhbevbimoajwkuzcunwz`, private schema `folio`. These payloads have not been executed against a hosted database. Current hosted migration history, role permissions, runtime readiness and project selection require an independent read-only check before application.

## Reviewable SQL

Both files are generated from the checked-in migrations with the pure `scripts/migration-sql.ts` `buildMigrationSql` renderer and `bootstrap:false`. Generation reads no runtime environment or credentials and opens no database connection. Files are ignored local artifacts, owner-readable/writable only (`0600`) inside a `0700` directory.

| Payload | Bytes | SHA-256 |
| --- | ---: | --- |
| `.local/bank-statement-release-2026-09-26/migrations-039-040.sql` | 15986 | `388d7c793b6b73c1a62c21eb1417e0c4d944a11aec5f8478812460c2c4a717b2` |
| `.local/bank-statement-release-2026-09-26/migrations-039-040.delta.sql` | 13675 | `920972e95884428b0d762c11692a24275562176ecd4d8547d07a25db8f623f53` |

Source migration hashes:

- `039_timestamp_normalization.sql`: `b8c6179b9fbb67bed0eb2e429219a31bf3568945cd088eaee76db5cee4990a14`
- `040_bank_statements.sql`: `4bddda5135f5114ded58ffb1b52463dce9d2cf3357c76d718dcabd77a9f2742c`

The payload manifest and reproducible pure generator are in the same private directory. Regenerate and review the hashes if either migration changes.

## Prerequisites and transaction boundary

The target must already have all **29 checked-in migration names through 038** in `folio.schema_migrations`. Numbering has intentional gaps; checking only the highest number would miss prerequisites. The guard explicitly checks:

```text
001_core.sql
002_integrations.sql
003_provider.sql
004_storage_cleanup.sql
005_notifications.sql
006_intake_files.sql
007_reconciliation_cursors.sql
008_document_events.sql
017_schema_isolation_journal.sql
019_direct_uploads.sql
020_api_key_expiry.sql
021_request_rate_limits.sql
022_parser_intake_formats.sql
023_intake_source_rejections.sql
024_schema_suggestions.sql
025_ai_assisted_setup.sql
026_template_selection.sql
027_pdf_splitting.sql
028_account_recovery.sql
029_email_verification.sql
030_invitation_email.sql
031_pdf_marker_splitting.sql
032_archive_imports.sql
033_tiff_source_format.sql
034_stored_pdf_splitting.sql
035_tiff_splitting.sql
036_split_suggestions.sql
037_native_pdf_regions.sql
038_stripe_billing_modes.sql
```

Unknown journal entries cause refusal. Existing entries for 039/040 permit an idempotent replay. There is no bootstrap, role creation, password/verifier replacement, project creation, scheduler installation or billing change.

Use the separate existing migration owner. Both `folio_admin` and `folio_app` must already be restricted LOGIN roles with no superuser, database/role creation, inheritance, replication or RLS bypass; neither may own the application schema/relations. The tenant role must not belong to the backend role. The renderer also refuses inherited access to legacy `public`, `auth` or `storage` tables and executable legacy security-definer functions. Verify the existing schema ACLs, backend policies, absence of custom default privileges and owner-only watchdog separately before choosing the delta.

Both payloads use one transaction and the existing schema migration advisory lock, a five-second lock timeout and a 120-second statement timeout. They guard every prerequisite before any migration and verify required columns, forced RLS on both new index tables and the watchdog's owner-only execution boundary before commit. If any guard fails, the transaction must roll back; do not bypass the failed guard. Apply before deploying code that requires the new columns. A timeout or long-held lock calls for a quieter release window, not an unreviewed timeout removal.

## Additive changes and permission review

Migration 039 adds nullable `extraction_runs.normalization_context`. Existing rows stay null. Migration 040 adds nullable `extraction_runs.bank_statement_context`, nullable `approvals.bank_review`, nullable `direct_uploads.bank_locale` limited to the three supported bank locales and incompatible with split/archive reservations, a unique run/document/workspace identity constraint, and the two indexed tenant tables `bank_statement_accounts` and `bank_statement_transactions`. Foreign keys cascade with their original document/run. Native date columns retain calendar-only statement boundaries. No stored original, historic approval, credential, plan, existing schema definition or existing normalization value is rewritten.

Migration 040 itself grants CRUD only to the existing `folio_app` role and installs enabled/forced workspace RLS on the new tables. The private-schema runtime contract also requires explicit CRUD and `folio_backend_admin` policies for the existing restricted backend role `folio_admin`; that role still cannot bypass RLS globally. The new account index stores hashed matching keys, currency, statement boundaries and current revision; the transaction index stores fingerprints. Raw account identifiers, descriptions and money stay in the existing private run/approval values.

The **standard** renderer also re-grants CRUD across all existing `folio` tables, re-grants execution across existing functions, re-creates backend policies across its RLS tables, and reapplies existing protected-table, PUBLIC and Supabase Data API revocations. Its final watchdog revoke preserves the owner-only helper. This is the renderer's established permission normalization, but it is broader than these two additive migrations require.

The **delta variant is preferred for review on this existing installation**, provided the current ACL/policy readback matches the established contract. It uses the renderer's role/schema guards and identical migration bodies, then limits grants and backend policy changes to the two new bank tables. It revokes PUBLIC and existing `anon`, `authenticated`, `service_role` access only on those new tables, and reasserts the existing owner-only watchdog boundary. It grants no existing-table/function access, changes no Data API exposure settings and changes no cron schedule or Vault entry. It does not repair pre-existing permission drift; stop if preflight finds any.

## Runtime behavior and limits

Timestamp fields convert explicit offsets or the pinned field/parser timezone to UTC. Clock gaps and repeated local times remain review issues. Date-only values, raw values, leading-zero identifiers and previous approvals retain their existing meanings. Legacy runs never borrow today's parser settings. [Timestamp contract](TIMESTAMP-NORMALIZATION.md).

Bank setup reuses an active fixed-schema AI parser under the existing workspace quota. Existing upload, page charging, private originals, worker leases, authentication and roles remain in use. The hub pins its chosen `bankLocale` on each multipart upload or signed reservation, so another member changing the parser default cannot alter the batch. Signed finalization and retries retain the reservation's stored locale. Exact duplicate bytes retain their existing document/job/usage even if a different locale is submitted; an explicit re-extraction with `bankLocale` changes interpretation and charges the normal page usage. Re-extraction without that field retains the latest immutable bank result's locale, then the prior bank job's locale if no result exists. Generic documents reject bank locale overrides; split/archive overrides are rejected until every child can be pinned. Bank runs normalize provider raw strings with exact decimal arithmetic and server-owned account/transaction source identities. Corrections retain original rows or exclude them with a reason; no automatic duplicate removal occurs. Approvals reject errors and require explicit warning acknowledgement plus a token binding the current revision, checks and matching files' indexed revisions. Index updates and approvals share the workspace lock. Cross-file comparisons query matching indexed identities/fingerprints in the current workspace and exclude the same document; masked identity remains unresolved. Exports retain the exact approved snapshot.

Existing limits remain: 20 files per batch, at most 10 MiB and 30 pages per document, plus the current workspace quota. Domain admission caps a statement at 100 account groups and 20,000 transactions; HTTP/provider limits can be lower. No account upgrade, live billing, mail, real AI quality or universal bank compatibility is implied. [Bank workflow contract](BANK-STATEMENTS.md).

## Backup and restore acceptance

The backup catalogue discovers tables from the current migration set and captures all live columns, so both new bank indexes and all new run/approval JSONB columns are included automatically. Its type allowlist originally omitted PostgreSQL DATE (OID 1082); this release adds that built-in type. Binary COPY preserves native dates directly without a JavaScript timestamp conversion.

The acceptance fixture now includes two processed bank statements, nonempty source contexts, stable transaction IDs, a correction, an acknowledged approval, two bank CSV/XLSX snapshots, two account-date rows and four transaction fingerprints. An aged cleaned signed-upload reservation also verifies exact preservation of its selected bank locale without leaving a live upload capability. Fresh restored API checks compare exact contexts/values/indexes/approval metadata/download bytes, enforce outsider access denial, and prove that editing a matching restored statement invalidates an old review token while preserving historic downloads.

Local results including the final per-upload locale change:

- **11/11 isolated filesystem backup/restore groups, 28/28 restored-runtime checks passed**, including the three new bank checks and exact signed-upload locale retention. Every table and sequence matched before runtime mutation. Source fingerprint stayed unchanged. The owned cluster, objects and private fixture keys were removed.
- **12/12 controlled managed-backup groups passed**, including complete ACL/RLS/constraint comparison, watchdog-owner enforcement, tenant isolation, no scheduler activation, rejection of arbitrary ACL drift, and clean rollback. Its storage responses were controlled locally; no hosted bucket was contacted.
- **5/5 backup-runtime tests** passed before the final scalar locale fixture addition; the updated complete recovery drill above passed. TypeScript and whitespace checks passed.
- **321/321 focused bank, timestamp, upload, split/archive, export and intake regression tests passed** after the locale fix in a copied private checkout. The broader 982-test suite passed before that final fix; current final CI remains a separate gate.

Private receipts are retained at `.local/backup-restore-2026-09-20/runs/38822149-8087-4132-a130-fc718ceb68f8/results.json` and `.local/managed-backup/23dab77a-cbdb-4c52-8c1c-b9dfabd0a47d/receipt.json`. These are local recovery proofs. Hosted capture/recovery, final combined regression, rendered acceptance, hosted migration/runtime readiness and real document extraction quality remain separately verified gates.

## Exact migration-delta rehearsal

The exact delta payload with SHA-256 `920972e95884428b0d762c11692a24275562176ecd4d8547d07a25db8f623f53` was executed only on a fresh socket-only local PostgreSQL 17 cluster with the existing private-schema contract through migration 038, a separate migration owner, restricted `folio_admin`/`folio_app`, existing Data API role names and an owner-only watchdog. **7/7 acceptance groups passed**:

- Missing migration 036 and an unexpected journal entry each refused before DDL and rolled back cleanly.
- The restricted backend role could not apply the owner-only payload.
- Both migrations applied, and exact payload replay was idempotent.
- Every existing relation ACL, RLS policy, schema ACL, role, membership, default privilege and function definition/ACL matched its pre-application snapshot.
- Both new bank indexes enforced tenant isolation, supported the existing backend policy, denied Data API roles and preserved owner-only watchdog execution.

The private receipt is `.local/bank-statement-release-2026-09-26/delta-qa-eecf983b-4d29-4292-8b7b-2423a05a2431/receipt.json`. Its cluster was stopped and removed. A first harness attempt incorrectly queried a privileged diagnostic setting through the restricted role; that harness-only failure was recorded and its stopped cluster removed before the corrected rehearsal. No payload was executed against the hosted project by this preparation task.
