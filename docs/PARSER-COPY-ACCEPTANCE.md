# Parser copy acceptance — 13 September 2026

The local W05 copy contract passed controlled acceptance. The **394/394** aggregate passed in **89.084501167 seconds** on source `edcf568013a79440c1b46c027eca25b4b3a08d84044218ff039f9da608409e32`; **11/11 focused cases** passed in **2.950834458 seconds**. Both runs had zero failures, skips or cancellations. Only the mobile parser-row CSS changed after the aggregate, making final source **196 files**, fingerprint **`2a2a0fad0acb307fefb2a98f0e27b2a5fb3a909f212d1ee840ce6942fe0db30a`**. The final source passed production build/package checks and **12/12 controlled desktop/mobile browser groups**; the aggregate was not rerun after that CSS-only change. Exact-head CI/CodeQL, Git publication and hosted deployment remain separate checks, with no pass claimed here.

The [public-safe receipt](evidence/parser-copy-2026-09-13/verification.json) records test summaries, final source identity, browser timings, packaging and metering. Earlier W05 rename/archive/restore results remain separate from this copy-specific evidence.

Copy creates a new active parser in the same workspace from a ready source's saved extraction configuration and parser-specific export mappings. The source may be active or archived. The destination starts with no documents, jobs, processing history or copied connections. Copying does not call an AI provider or consume page credits.

## API and transaction contract

`POST /api/parsers/:id/copy` accepts a strict `{name?: string}` body and returns `201 {parser, schema, templates, mappings}`. It requires an owner, admin or editor. API keys require `parsers:write`, `parsers:read` and `results:read`, because the response includes copied export-mapping configuration. Session origin checks and normal workspace authorization remain in force. Foreign and missing source IDs return the same 404.

An explicit name uses the existing trimmed 1–100-character parser-name validation. The default adds ` (copy)` to a shortened source name while keeping the final name within 100 UTF-16 code units and preserving valid Unicode. Duplicate display names remain allowed, as they are for ordinary parser creation.

This is a non-idempotent create operation. Two separately accepted requests may create two copies, each subject to capacity. The UI uses a synchronous submission guard, keeps the dialog open while the request is pending, and prevents another submission after an uncertain transport/server response. It asks the user to inspect the parser list before retrying; there is no durable replay guarantee.

The copy transaction acquires the workspace advisory lock shared by create/restore/archive, then locks the source parser. It requires `field_setup_state='ready'`, validates the source's active schema and saved configuration, and checks the current active-parser allowance through the shared capacity helper. Copying an archived source does not restore it or bypass the destination's active-parser limit. A pending or failed setup source returns actionable 409; exhausted parser capacity returns 429.

The destination parser, version-1 schema, templates, mappings and one `parser.copied` audit event commit together. A validation, insertion or audit failure must leave no partial copy. The audit identifies the source parser/schema, copying actor and copied template/mapping counts without embedding configuration contents or credentials.

## Copied configuration and fresh identities

| Configuration | Destination |
| --- | --- |
| Parser settings | Preserve use case, extraction mode, instructions, locale, timezone and allowed formats, including null/all versus explicit format restrictions. Use the requested/default name; create a fresh parser ID and timestamp; set active state. |
| Active schema | Validate the stored JSON without replacing it with a parsed/stripped object. Persist that exact content under a fresh schema ID at destination version 1, attributed to the copying actor. Do not copy source version history. Response identity/version metadata must describe the new schema. |
| Setup metadata | Ready, with no copied suggestion pointer or setup error. No discovery request or old sample provenance is attached to the destination. |
| Text templates | Preserve names, phrases, ordered rules and enabled flags under fresh template IDs. Enabled rules must be valid for the copied schema. Structurally valid disabled legacy rules remain disabled and are not silently removed. |
| Export mappings | Copy only rows matching both the source parser and workspace, under fresh mapping IDs and the new parser. Preserve names, ordered columns/labels, empty-column behavior and nullable line-item expansion settings. |

Template priority remains consistent with X06. Source templates use the same `compareTemplatePriority` comparator as selection: JavaScript timestamp milliseconds followed by template ID after field count. Fresh template IDs are assigned in that source order, with a common new transaction timestamp, so equal-score winners keep their relative priority. Copies are not backdated and never reuse source IDs.

Export mapping validation is structural, matching the existing export API. Metadata sources such as `$filename` and `$documentId`, `$item.*` paths, nested values, repeated columns, and optional/stale field paths are retained. Empty columns continue to mean automatic columns. Mapping paths are not subjected to template-field validation. The current database requires every export mapping to have a parser ID; listing all workspace mappings does not make another parser's mappings part of this copy.

| Copy bound | Limit and failure behavior |
| --- | --- |
| Templates | At most 100. Read up to 101 to detect overflow; reject the entire copy with 409 rather than truncate. |
| Export mappings | At most 100 per copy. This is a copy-operation limit, not a new claim about the existing mapping-save endpoint. Overflow rejects with 409. |
| Total serialized configuration snapshot | At most 2 MiB, including copied parser settings, schema, templates and mappings. Reject oversized configuration with an actionable 409. |
| Template structure | Existing name/phrase/rule limits; at most 100 rules and 259-character field paths. Enabled unsupported/invalid anchors reject the copy. |
| Mapping structure | Name 1–100 characters; 0–100 columns, each source/label 1–120 characters; nullable line-item path up to 100 characters. Preserve valid stored values without trimming or rewriting them. |

Source parser/schema/template settings remain stable under the existing locks. Mapping collection is read in one query as a snapshot; a later source mapping deletion does not erase its already captured destination configuration. The implementation does not claim that the parser lock serializes every mapping deletion.

## Data and connection boundary

The copy includes no documents or originals, intake receipts/rejections, direct-upload reservations, jobs, extraction runs, corrections, approvals, export snapshots, usage records, delivery attempts or source audit history. Later edits or deletions of source and destination configuration must remain independent.

The new parser ID gives the destination its own authenticated upload route. No email route/address, domain verification, sender policy or provider intake identity is copied or created, and the source address is not redirected. No API key, OAuth state, secret, Google Sheets connection/cursor/write or parser-bound webhook is duplicated. Parser-specific intake and destination connections require separate setup.

Existing workspace-wide integrations remain applicable through their current rules. Copying no connection rows therefore does not imply that future approved exports from the destination are exempt from an already configured workspace-wide integration. Copy itself makes no delivery or provider request.

## Recorded acceptance evidence

| Layer | Verified evidence | Boundary |
| --- | --- | --- |
| Focused HTTP/database tests | **11/11 passed** in **2.950834458 seconds**; zero failures/skips/cancellations. | Owned local fixtures and controlled behavior; no live provider acceptance. |
| Aggregate | **394/394 passed** in **89.084501167 seconds**. | The final recovery implementation was present; the final mobile CSS adjustment followed this suite and is not represented as an aggregate rerun. |
| Final browser | **12/12 groups passed**, **16:37:06–16:37:27 UTC**; no page errors or external calls; owned fixtures cleaned. | Controlled local desktop/mobile workflow, including both lost-response cases and the final mobile name/action layout. |
| Copied-template workflow | Fresh IDs/schema v1, preserved configuration/tie winner, independent settings, source-only mapping, own upload and review. | No automatic approval/export. Copy adds no job/page charge; two synthetic uploads account for two pages. |
| Explicit export | Exact expected and persisted CSV bytes; **2 data rows** with verified approved-revision metadata. | The user action explicitly approved and downloaded using the copied mapping; no destination provider was used. |
| Final package | Production build, six packaged decoders, API startup and preview invitation guard passed on final source. | Local packaging/runtime evidence, not hosted deployment. |
| Source and release | 196 final application files, fingerprint recorded above and in the receipt. | Exact-head CI/CodeQL, Git/PR publication and hosted deployment require separate evidence. |

The final browser run at **16:37:06–16:37:27 UTC** passed **12 grouped checks**: copy/fresh identities, configuration independence, archived and setup/capacity cases, guarded pending requests, lost-response recovery from an active parser and the archived list, viewer controls, copied-template extraction, explicit approval/exact CSV download, desktop/mobile help and unchanged metering. The archive recovery opens the active list; the mobile layout places actions below the parser name. There were zero live extraction/suggestion calls, zero page errors and zero blocked external requests; all owned fixtures were cleaned up. Copy itself reserved no pages; the two synthetic uploads used two pages, with no suggestion or extraction cost. Browser navigation used a controlled non-throttling memory limiter, so this run is not rate-limit acceptance.

The first browser attempt passed seven groups before stopping on an incorrect assumption that a normal upload navigates away from the parser; it also encountered artificial fixture-limiter 429s. The second passed six groups before an immediate tab `aria-selected` assertion failed; the screenshot already showed the Archived view, so the harness needed to wait for the selection state. Owned fixtures were cleaned up after both attempts. Those earlier receipts remain preserved privately. The archived-list uncertain-response fix and the separate narrow-mobile-name CSS repair are included in the final browser result, rather than describing the earlier attempts as clean passes.

Configuration limits, fresh identities, schema-extension preservation, millisecond/ID template priority, mapping fidelity, scopes/tenant boundaries, capacity contention and atomic audit rollback are covered by the focused suite. This is bounded local feature acceptance, not broad document accuracy, managed-template parity or a new provider verification.

No new database migration is required solely for parser copy. Hosted migrations **021–026** and the matching runtime release remain separate pending gates. The canonical invite-only preview's last verified revision from the prior checkpoint is sign-in release **`676a61a`**; this document does not reverify it. Free hosting plans and mocked billing remain unchanged. No live provider acceptance, customer use, cross-workspace copy, OCR-region functionality or broader reference-product parity is established by this local feature.
