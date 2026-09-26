# Launch status — 26 September 2026

**MaintainFlow is deployed and the hosted large-PDF workflow passes. Public launch is still not cleared: account upgrades alone do not complete the remaining work.**

This dated record supersedes deployment and branding statements in the [September 20 status](LAUNCH-STATUS-2026-09-20.md). Historical test records retain their original source and coverage. The [47-criterion capability inventory](PARITY-MATRIX.md) remains in scope.

## Current deployment and completed proof

- [PR45](https://github.com/rory-hayes/maintainflow/pull/45) merged the MaintainFlow rename. The canonical domain serves revision **`279f5d798c6871393e0aecca5eaaa1470723eb4c`** from Vercel deployment **`dpl_9hkogCEsGX1ey8AATybpDcZYSfVD`**. The merged source tree matches the checked `b7448ba` branch head. Website/account/workspace branding, new account emails and exports use MaintainFlow; stable internal identifiers and old queued-email requests retain compatibility.
- The branding release passed its CI and isolated backup/restore checks. Live public-page checks covered desktop and mobile; fresh canonical health, dependency readiness, private-preview and invitation configuration checks returned HTTP 200. These checks do not constitute full authenticated mobile workflow acceptance.
- At **10:11:43–10:11:54 UTC**, a dedicated owned QA account completed a real **5,243,969-byte PDF** workflow. Direct signed PUT bypassed the application request-body limit; automatic rules processing returned the exact invoice identifier, total `42`, raw total `42.00` and page-one evidence. No explicit worker wake was sent.
- Repeating the confirmed finalize request returned the same document and job. One completed job with one attempt, one extraction run and one upload ledger charge were observed. Downloaded original bytes and SHA-256 matched the local synthetic source exactly. Monthly usage rose from 3 to 4 on the Explore plan with mock billing.
- The owned document and its stored original were removed; the empty parser was archived. The created session was logged out and rejected with HTTP 401 afterward. Usage/audit history remains. Signed-upload staging expiry cleanup was **not observed** and is not claimed complete by this test.
- This was a padded **one-page native-text fixture**, not evidence for large scanned documents, arbitrary layouts or AI accuracy. No email, Sheets, approval, billing or direct database operation was performed by the test. Its owned rules run reported zero AI cost and no tokens; this is not a global provider-activity claim. [Sanitized receipt](evidence/hosted-oversized-pdf-2026-09-26/verification.json).

The September 20 hosted migration-journal readback through 038, authenticated core review/export/isolation acceptance, signup verification and controlled watchdog drill remain dated evidence. They were not all rerun during this PDF test. Free plans, mock billing, private preview and invitation requirements remain enabled.

## Work still required before public launch

| Area | Remaining evidence or implementation |
| --- | --- |
| Monitoring | Operations code in [draft PR44](https://github.com/rory-hayes/maintainflow/pull/44) is not deployed or enabled. Install specifically approved scoped credentials, approve the incident recipient, verify test outage/recovery inbox delivery, initialize protected state, observe a real scheduled run and establish an external stale-run check. Preparation and local tests are insufficient. |
| Backup and recovery | Obtain an owner-capable source connection; quiesce all database/object writers; capture the current hosted database and originals; restore into an isolated destination; establish encrypted off-host schedules, separate key custody, retention and recovery targets. Local/synthetic and historical pre-cutover restores do not prove current hosted recovery. |
| Accounts and integrations | Complete hosted password reset with session revocation and invitation acceptance/roles. Recheck inbound attachment intake through reviewed Google Sheets delivery, restart/refresh/revocation and independent destination readback. Previously delivered auth emails are not completed account workflows. Respect the exact owned fixture, quota and approved outbound-message scopes. |
| Product capabilities | Finish the open original matrix criteria: timestamp/timezone normalization; remaining document converters and archives; OCR/image/repeating regions and scaling; preprocessing/language coverage; structured address/geolocation; additional source-platform recipes; held-out AI extraction/split quality; remaining retention/quota and destination acceptance. Keep each local, hosted and provider result distinct. |
| Policies and support | Publish accurate approved privacy, terms, subprocessor, retention and processing-location disclosures; establish monitored support/privacy handling. Existing contact settings do not establish these policies or operational handling. |
| Billing and activation | Billing is mocked. Complete authorized test/live payment, cancellation and entitlement-transition acceptance before deliberately opening public registration. No paid upgrade or real charge has been performed. |

Account upgrades remain a separate final commercial/capacity step. None of the open rows above is closed by upgrading an account.
