# Workspace capacity and membership audit integrity

Recorded 7 September 2026. A completion audit found two gaps: an archived parser could be restored after a replacement had filled the active-parser allowance, and some membership/invitation changes did not record an audit event in their mutation transaction. Both fixes now pass the focused regressions, **167-test aggregate** and build. Earlier 160-test results and AI browser acceptance remain separate historical checkpoints.

## Active parser allowance

[parser-routes.ts](../server/core/parser-routes.ts) uses the same transaction-scoped workspace advisory lock for parser creation and settings changes, including archive/restore. Creation and an actual archived-to-active transition check the stored plan's `maxParsers` against the current count of active parsers while holding that lock. A full workspace receives HTTP 429 before any requested parser changes or audit event commit. Archiving releases an active slot. Ordinary edits to active or archived parsers remain usable at capacity, including an explicit `archived: false` on a parser that is already active.

Restoring preserves the parser's mode, instructions, locale, timezone and active schema when those settings are omitted from the patch. The check counts active parsers only; it does not delete archived records or automatically deactivate parsers after a plan change. This is a route-level transactional invariant for the cooperating create/archive/restore operations, not a database constraint against arbitrary administrative SQL or a concurrent billing-plan change.

Two new cases in [core.test.ts](../tests/core.test.ts) exercise restoration after a replacement fills the only slot, rollback of a simultaneous rename and false audit event, ordinary edits at capacity, slot release and preservation of configuration/schema. A second case runs three rounds in which two restores and a new creation compete for one active slot; each round expects exactly one success, two capacity rejections and one active parser. These are controlled local HTTP/database checks, not a distributed load benchmark.

## Atomic membership and invitation events

[workspace-routes.ts](../server/core/workspace-routes.ts) records the event on the same database transaction as the corresponding membership or invitation mutation. Role changes lock the existing membership and emit an event only when the role actually changes. Removal records the previous role together with the existing membership deletion, workspace-key revocation and workspace-session deletion. Invitation acceptance consumes the invitation and records whether it created a membership; an existing membership keeps its current role.

| Action | Event | Bounded metadata |
| --- | --- | --- |
| Invitation issued | `member.invited` | Requested role |
| Invitation accepted | `member.invitation_accepted` | Member ID, effective role, whether membership was created |
| Role changed | `member.role_changed` | Previous and new roles |
| Member removed | `member.removed` | Previous role |
| Unaccepted invitation deleted | `member.invitation_revoked` | Invitation role |
| Already accepted invitation record deleted | `member.invitation_deleted` | Invitation role |

Events retain workspace, actor and entity identifiers through the shared audit helper. Their metadata excludes email addresses, names, raw invitation tokens and credentials. Rejected operations and a role update that leaves the role unchanged must not create a success event. Deleting an accepted invitation record is distinct from revoking an outstanding invitation; it does not remove the accepted membership.

Five cases in [membership-audit.test.ts](../tests/membership-audit.test.ts) check successful event metadata and tenant/read-role boundaries; wrong-recipient/replayed invitations and preserved existing roles; denied, missing and unchanged role requests; member removal with revoked keys/sessions and retained target identity after user deletion; pending versus accepted invitation deletion; and transaction rollback when a workspace-scoped database fault rejects the audit insertion. The temporary fault is removed in a `finally` block. All five cases passed in the focused run and final aggregate. The four safe Request failed log entries in the focused output are the intentionally injected audit-write failures; their rollback assertions passed. These changes do not add invitation email delivery, new roles, a general certification of all audit paths, or retroactive events for historical mutations.

## Evidence boundary

The earlier [AI browser receipt](AI-BROWSER-ACCEPTANCE.md), [source-disclosure checks](REVIEW-PROVENANCE.md), and independent **49/51** held-out / **51/51** prompt-v2 regression reports retain their original scope. No new provider call or model-accuracy result follows from these workspace changes. The final source identity and completed checks are recorded below. Resend, Sheets and Stripe test account configuration and production gates remain in [RELEASE-GATES.md](RELEASE-GATES.md).


## Verified source and commands

The current source passed **167/167 tests**, zero failures/skips, from `2026-09-07T17:30:36.845509Z` to `17:31:00.277777Z`; TypeScript/Vite build passed from `17:31:00.278492Z` to `17:31:01.952573Z`. [Test output](evidence/workspace-integrity-tests-results.txt), [test timing](evidence/workspace-integrity-tests-run.json), [build output](evidence/workspace-integrity-build-results.txt) and [build timing](evidence/workspace-integrity-build-run.json) are preserved. The [final integrity record](evidence/workspace-integrity-final.json) identifies **186 files**, fingerprint `a4641915d5042524908c4e98efe14945ac15df13923f27c9307f7733264ed4f0`, unchanged during verification. Only parser/workspace routes and the two associated test files changed from the previous AI-browser source checkpoint. Extraction/model code and the existing UI are unchanged; no additional model calls were needed.

Focused output: [two parser-capacity cases](evidence/parser-quota-targeted-results.txt) and [five membership-audit cases](evidence/membership-audit-targeted-results.txt). These use owned local HTTP/database fixtures. The broader existing browser creation/archive/restore/member controls remain historical UI evidence; the new capacity-race and injected-audit-failure cases were not browser scenarios.


After the final 167-test/build run, the local services restarted and a read-only browser reload confirmed the existing AI receipt remained **Run 1 · Approved / Exported**. Document/body widths were 1280px at the default 1280×720 viewport; captured browser warnings/errors were empty. [Browser checkpoint](evidence/workspace-integrity-browser.json), [DOM](evidence/workspace-integrity-browser.txt), [screenshot](evidence/workspace-integrity-browser.png). This is persistence/smoke evidence, not a new browser membership or parser-capacity mutation test. The [current redacted runtime check](evidence/workspace-integrity-runtime.json), `2026-09-07T17:33:01.314Z`, confirms web/API health/presets HTTP 200 and observed API/worker/Vite startup. OpenAI is configured; required Stripe test, Resend and Google OAuth settings remain absent, with Resend inbound disabled.
