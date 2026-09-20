# Complete text-template selection acceptance — 13 September 2026

The local X06 implementation evaluates saved text templates before AI for newly configured jobs. A template must fully match source data before it can bypass the provider. The selected result still enters `needs_review`; approval and export remain explicit actions. This is deterministic native-text matching, not OCR-region extraction or parity with a managed template library.

The final source passed **383/383 serial tests**, zero failures/skips/cancellations, in **86.793232 seconds**, including **17 pure selector** and **11 controlled integration** cases. **Ten desktop/mobile browser checks** passed with one controlled AI fallback and **zero live provider calls**. The production build and packaged runtime passed six decoders, API startup and the preview invitation guard. Migration 026 is applied locally; hosted **021–026 remain unapplied**. [Public-safe verification receipt](evidence/template-precedence-2026-09-13/verification.json).

## Selection contract

Only enabled templates in the job's saved configuration participate. The literal document phrase is case-sensitive and may be empty. A matching phrase alone never qualifies a template.

Every configured anchor must occur in its supported source position, produce nonmissing raw data, and pass the saved schema's checks after normalization. All required schema fields also need source data, even when they have no explicit template rule. Defaults cannot establish a match. A required object needs a real source descendant; constructing an empty object wrapper is insufficient, and required descendants are checked separately. Unconfigured optional fields may remain missing.

Among qualifying templates, selection uses:

1. Most configured distinct leaf fields.
2. Oldest `created_at` timestamp.
3. Smallest template ID for equal timestamps.

Table columns count once each, irrespective of row count. A table-heading rule covers its direct scalar columns; additional column overrides are combined without counting the same leaf twice. Phrase length does not affect rank. Provenance records the number of qualified templates tied at the winning field count, including the winner. A resolved ranking does not add the old multiple-template warning.

| Decision | Behavior |
| --- | --- |
| Complete template | Use `text-template` / `deterministic-v3` / `folio-text-template-v1`. Skip the AI provider, including when it is unconfigured. |
| No complete template, AI mode | Use the existing AI extraction path and record the fallback reason on a successful run. An available provider is still required. |
| No enabled templates, rules mode | Use the existing field-label rules path. |
| Enabled templates but no complete match, rules mode | Fail permanently with an actionable message; do not silently extract using field labels. |
| No readable native text | Templates cannot qualify. AI mode requires its provider; rules mode reports the existing OCR/AI requirement. |
| A selection limit is exceeded | Record the limit decision; never pick a winner from only a truncated candidate set. AI mode may fall back; rules mode fails. |

Selection creates no additional job or page reservation. Template extraction records zero provider cost; an AI fallback records the cost returned by that extraction provider. Explicit reprocessing keeps its existing page charge. Releasing initial setup jobs reuses their original jobs and reservations.

## Pinned jobs and legacy compatibility

The three job-configuration writers stamp `templatePolicy: 'complete-v1'` and capture templates alongside the schema/configuration used for that job:

| Writer | Source | Boundary |
| --- | --- | --- |
| Accepted intake | `server/core/intake.ts` | New document job captures the policy and current saved templates. |
| Explicit reprocessing | `server/core/document-routes.ts` | New reprocess job captures current schema/configuration and keeps the established reprocess reservation. |
| Initial setup release | `server/core/parser-setup.ts` | Automatic discovery and manual setup completion release the original held jobs with the final initial schema and current configuration. |

The worker selects against the job's saved templates, mode, locale and immutable schema. It does not fetch current templates during extraction. Later template edits, disabling, deletion or schema changes therefore cannot rewrite the method chosen for an already configured job or completed run.

Queued jobs without the policy stamp retain their previous mode/template behavior through `extractRules`. The pure regressions explicitly preserve legacy scalar CSV key/selected-anchor/label matching and the legacy behavior that ignores table-column template overrides. Strict override behavior applies only to the new policy. Migration 026 adds nullable `extraction_runs.selection`; it does not backfill invented provenance for old runs.

## Saved-settings preview, mutations and privacy

`POST /api/parsers/:id/templates/check` accepts only `{documentId}`. It evaluates a same-workspace, same-parser document using a single current database snapshot of saved schema, templates, mode, locale and native source text. This is a preview of current saved settings, not a replay of an old job. Unsaved editor drafts are excluded.

The response contains only `selection`, `candidates` and `availableSourceText`. Candidate metadata includes names, counts, reason codes and unmatched field paths, but excludes extracted values, source quotes, evidence and original bytes. The route reads no original storage, calls no provider, writes no extraction result or audit, and consumes no page credits. Session viewers may check; API keys require both `parsers:read` and `documents:read`. Browser origin validation and workspace/parser ownership checks remain enforced.

Template mutations retain the existing endpoints and require an owner, admin or editor, plus `parsers:write` for API keys. They acquire the workspace advisory lock before the parser lock, validate against the active schema, and enforce the 100-template capacity under that lock. Full mutation bodies carry name, phrase, enabled state and rules. Invalid legacy templates can still be disabled or deleted. The editor retains unsupported saved rows until the user explicitly removes them; it offers controls only from the shared supported-field catalogue.

The preview UI labels its use of current saved settings and detects changed selection inputs. Completed History instead renders the selection recorded on that run, including the selected template, field count, tie explanation or fallback reason, and policy. Old runs say that selection was not recorded. A template run does not claim AI was used or charged.

## Text-engine scope and limits

Supported rules target scalar leaves, including nested object leaves, flat scalar table columns, or flat-table headings. Object-container anchors and nested object/table columns are unsupported and cannot qualify. Explicit scalar and column overrides do not fall back to parser labels, including when recognizing multiline boundaries. A configured table heading must match before first capture; matching repeated headers can continue a table across pages.

| Bound | Limit |
| --- | --- |
| Saved templates per parser | 100 |
| Rules per template | 100 |
| Rule field path | 259 characters |
| Native text for selection | 2 MiB, measured as UTF-8 bytes |
| Schema descriptors | 600, including containers |
| Estimated line × descriptor × candidate checks | 5,000,000 |
| Estimated source-character × descriptor × candidate checks | 100,000,000 |
| Rows in a strict text table | 1,000 across captured sections/pages |
| Multiline capture | 100 lines or 65,536 characters; capture is page-bounded |

Zero rules, duplicate paths, unknown or unsupported fields, malformed settings, missing anchors, missing source values and validation failures prevent qualification. A detected table or multiline truncation prevents a complete match. These controls do not make the text engine a general table-layout recognizer: it uses text anchors and supported CSV, tab or pipe-style structure, rather than visual regions, arbitrary nested tables or OCR coordinates. This checkpoint makes no claim of a managed template catalogue, automatic template training, OCR-region parity or broad document accuracy.

## Evidence and remaining release gates

| Evidence | Checkpoint status |
| --- | --- |
| `tests/template-selection.test.ts` | 17 pure cases passed; ranking, strict source/default rules, CSV/table overrides, continuations, malformed rules, fallbacks, limits and legacy compatibility. |
| `tests/template-precedence.test.ts` | 11 controlled integration cases passed; provider bypass/fallback and cost, pinned jobs/history, all three writers, mutation validation, privacy/scopes/origin, legacy cleanup and concurrent template capacity. |
| Local migration 026 | Applied; local journal totals 17 migrations. |
| Full aggregate suite and final typecheck | 383/383 pass, zero failures/skips/cancellations in 86.793232 seconds; typecheck passes. |
| Rendered desktop/mobile preview and History checks | Ten checks pass at 1440×1000 and 390×844, including saved edits/stale preview, deleted-template history, one controlled fallback, explicit approval and exact JSON snapshot bytes. |
| Production packaging and source identity | Build and six decoders/API/preview guard pass. 189 implementation/test/script/public files have fingerprint `216ca57403b06e24cd56552c2ede8bb199bda5d47be699892128266f0b9331cb`; this excludes documentation, build output and private runtime data. Git/CI evidence is separate. |
| Live provider acceptance for X06 | Not established by the controlled tests. |

The successful browser run was **15:43:39.449–15:43:50.429 UTC**. Template extraction made zero provider calls and kept the original pinned name/rank after the saved template was edited and deleted. Partial matching made exactly one controlled call. Both documents retained one upload/job/run each; only the template result was explicitly approved/exported. Downloaded JSON matched the persisted snapshot bytes. There were no page errors, unexpected console entries or external requests; the expected signed-out `/api/auth/me` 401 is recorded separately. Owned fixtures were removed afterward.

The first browser attempt stopped on an exact label selector before template creation, with zero provider calls; that failed evidence and cleanup are preserved privately. Only the harness selectors and expected signed-out 401 classification changed for the successful run. A separate native-text acceptance check matched two distinct synthetic document families to their respective templates with exact values, and rejected an unknown family. These checks do not establish general extraction accuracy.

Hosted migrations **021–026 remain unapplied**, and the matching runtime release remains pending. The canonical invite-only preview remains separately identified by the sign-in release **`676a61a`**; its deployment is not proof of this template feature. Free hosting plans and mocked billing remain unchanged. Local tests, Git synchronization and a prepared migration are separate from deployment, hosted database acceptance, live provider behavior and customer use.

The selector also limits estimated source-character × schema-descriptor × candidate work to **100 million**. This rejects a pathological long single line before repeated regex/CSV scans. It is a conservative work estimate, not a CPU deadline; the existing 5-million line-work bound also applies.
