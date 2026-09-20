# Launch status — 20 September 2026

**The current release is deployed and its core hosted workflow passes. It remains a private preview with mock billing, not a cleared public production launch.** Account upgrades alone do not close the remaining operational, integration and product requirements.

This dated status supersedes earlier *pending hosted migration/activation* statements in the [release evidence ledger](RELEASE-GATES.md), [parity matrix](PARITY-MATRIX.md) and earlier hosted-preview reports. Those records retain their original dates, test scopes and limitations; their historical evidence has not been rewritten.

## Deployed and verified

- The canonical [maintainflow.io](https://maintainflow.io) deployment reports revision **`6011f225ac9a767af6b7dd05809b0dbcdb35d52f`**. PR43 is merged; its `main` merge has the same source tree as this checked deployment. Exact-revision Linux CI passed **855/855 tests**, build/typecheck, **15 packaged runtime/decoder groups** and **11 synthetic encrypted restore groups**.
- Hosted migrations **021–038** were applied transactionally. Owner readback confirms **29 total migration-journal entries**, including 038. Health and readiness returned HTTP 200; authenticated diagnostics passed. The temporary maintenance pause was removed. Retired deployment hosts deny requests even with a valid automation bypass; the checked canonical deployment remains available.
- Wrong sign-in credentials, including short passwords, return the generic **“Email or password is incorrect”** message. The deployed desktop form was checked. Signup verification, password-reset and invitation emails reached the approved test inbox; signup verification and subsequent login passed. Mail delivery does not establish completed password-reset or invitation-acceptance workflows, and mobile was not rechecked during this cutover.
- A fresh owned synthetic rules workflow passed real signed upload, automatic extraction, exact source/result checks, correction, stale-revision rejection, approval, pinned **JSON/CSV/XLSX** downloads, original-byte verification and outsider isolation. One upload page was charged. Owned documents/exports and stored originals were removed, the empty test parser archived, and temporary sessions removed; usage and audit history were preserved.
- Private-preview/invitation controls and **mock billing** remain enabled. Existing free plans were preserved; no paid account upgrades or live charges were performed.

## Operational work still awaiting acceptance

| Area | Current evidence and remaining work |
| --- | --- |
| Watchdog recovery | **The controlled missed-immediate-wake drill passed.** A new owned rules job was scheduled 330 seconds ahead and became eligible at **15:40:40.088 UTC**. The minutely scheduler and worker request ran at **15:41:00**, and that exact job completed at **15:41:00.801**, with one attempt, one new extraction result and one reprocess page charge. Quiet-window platform logs showed only job-status reads and the single worker request, with no other mutation request paths. The prior result was preserved; owned fixture cleanup passed. This establishes the tested watchdog recovery path, not arbitrary crash or outage recovery. |
| Independent monitoring | Monitor code and an opt-in workflow pass **48 focused checks**, workflow lint and independent review. Deployment, credential/recipient setup, enablement, actual failure/recovery inbox delivery and an observed scheduled run remain pending. Scheduling limitations and external monitoring of missed runs remain operational gates. See [monitoring](INDEPENDENT-MONITORING.md). |
| Backup and recovery | The pre-cutover encrypted checkpoint was restored into an isolated local database. New managed-source backup code passes **24 focused tests** and **12 isolated acceptance groups**, covering **57 tables and 29 migrations**; independent read-only review found no blocking defect. These new changes are local preparation, not hosted backup proof. A direct owner-capable source connection, actual current-schema hosted capture/restore, database-and-object off-host scheduling, separate key custody, retention and recovery targets remain unproved. Every archive requires a restore rehearsal; ACL drift may be safely refused. See [backup/restore](BACKUP-RESTORE.md). |
| Policies and support | Approved privacy, terms and subprocessor notices, accurate retention/processing-location disclosures, and monitored support/privacy handling remain required. Existing identity/contact settings do not establish completed policies or legal review. |
| Providers and activation | Fresh inbound attachment intake and Google Sheets delivery/refresh/revocation acceptance on this release remain separate from auth-email delivery. Live billing, payment/cancellation and test-entitlement transition require their own acceptance when authorized. Public registration remains gated. |

The [operations runbook](OPERATIONS-RUNBOOK.md) supplies the checks and responsibilities. Prepared code, configured credentials, a passing local test or an empty queue does not by itself close these gates. Older filesystem-only backup descriptions in operational records should be read alongside the newer managed-source contract above; hosted recovery is still unproved.

## Original product scope remains intact

All **47 original capability identities and acceptance criteria** in the [parity matrix](PARITY-MATRIX.md), governed by the [build brief](../BUILD-BRIEF.md), remain in scope. The operational rows above do not replace that inventory or establish full Parseur parity.

Known broader gaps include remaining **C09** format converters, **C10** archive formats beyond the implemented ZIP subset and real AI split-boundary quality evaluation, **X07** image/OCR and repeating regions, automatic scaling and broader dynamic layouts, **X08** deskew/repair and measured language coverage, **R06** address/geolocation support, and **E08** additional source connectors. Arbitrary extraction accuracy, large/complex layouts, and customer-use evidence must retain their stated limits. Existing PDF/TIFF splitting, reviewed AI suggestions and native searchable-PDF regions have substantial local acceptance evidence; today's narrow hosted rules test does not revalidate every advanced workflow.

Use the dated [release ledger](RELEASE-GATES.md), [parity matrix](PARITY-MATRIX.md) and feature-specific acceptance records for exact coverage. Public launch clearance requires both the applicable operational gates and the intended product scope to be explicitly accepted.
