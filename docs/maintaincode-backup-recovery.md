# Backup, retention and recovery operating note

Reviewed 6 September 2026, 21:41 UTC. Project: `mvzspyhwoqzcygekridy` / MaintainCode Ads / Tuesday. This was a read-only review; no backup, restore, export, credential change or plan change was performed. Source reviewed is the release associated with PR #11 (`7d5a4c7`); the domain still serves the prior product.

## Observed project settings

Authenticated Chrome dashboard evidence:

| Surface | Actual observation |
| --- | --- |
| [Scheduled backups](https://supabase.com/dashboard/project/mvzspyhwoqzcygekridy/database/backups/scheduled), tab `1284962924`, browser `1` | Organization is marked FREE. The project notice says “Free Plan does not include project backups.” The upgrade message offers up to seven days on Pro. No backup history or available restore point is shown. |
| [Point in time](https://supabase.com/dashboard/project/mvzspyhwoqzcygekridy/database/backups/pitr), tab `1284962927`, browser `1` | PITR is presented as a Pro add-on, starting at $100/month. No enabled recovery window or restore point is shown. |

The observed project has **no customer-accessible managed backup retention or PITR window**. A separately managed off-site backup was not verified. No recovery point objective (maximum tolerable data loss) or recovery time objective has been established or tested. Migration files can recreate schema; they do not recover customer data.

Official documentation, distinct from observed settings: [Supabase database backups](https://supabase.com/docs/guides/platform/backups) describes daily backups for paid plans (Pro seven days, Team fourteen, Enterprise up to thirty), recommends off-site CLI dumps for Free projects, and notes that restoration causes downtime. Custom-role passwords need resetting after daily-backup restoration. Storage object contents are excluded. Project deletion also deletes its associated backups. These are provider capabilities and limitations, not enabled protection for this project.

## What the application currently removes

| Control | Code behavior |
| --- | --- |
| Workspace retention, 1–90 days | Fixed locally after this review: settings persist a workspace default even with zero sites, apply it to existing sites, and cap existing submission expiry. New sites inherit the saved default. Legacy JSON falls back to its first site's value, then 90; the default survives deleting the final site. Increasing retention does not resurrect expired records. `workspaces/[id]/route.ts` settings and site actions. |
| Read an expired record | `store.server.ts:64` calls `pruneExpired` on the returned state. This hides expired data but does not write the cleaned state back to PostgreSQL. |
| Persist cleanup | Successful workspace mutations prune and save state. “Apply retention” invokes this path. Scheduled maintenance also does so for inactive workspaces. The daily scheduler processes at most eight workspaces within its work budget; backlogs may delay physical cleanup. Hosted execution remains unproved. |
| CRM snapshots | `model.ts:714` keeps records with remaining retained submission links. Otherwise contacts/deals are pruned according to expired links and a 90-day update-age threshold. Cost history, account settings, connector metadata and billing references are outside this expiry control. |
| Delete website data | Removes the site and its captured submissions; normal pruning then evaluates linked CRM records. The site registry is rebuilt in the same transaction. This does not delete the workspace, authentication account, original CRM records or billing relationship. |
| Disconnect provider | Removes the stored encrypted credential and marks the connection revoked. It does not revoke that token at the external provider or erase already imported history. |
| Export workspace | Downloads the current public workspace JSON. Click references and billing identifiers are protected/omitted, provider credentials are absent, and there is no restore/import control. This is a portability export, not a complete backup. |

Relevant implementation: `src/lib/attribution/{model,store.server,maintenance.server,tracker}.ts`, `src/app/api/attribution/workspaces/[id]/route.ts`, `src/components/attribution/setup.tsx`, and `vercel.json`.

Complete account deletion is an operator request, with no implemented self-service account/workspace deletion endpoint or tested full-deletion procedure. A reviewed operation must first establish requester authority and shared-workspace ownership, then scope application state, memberships, Auth identity, provider connections and applicable billing/log records separately. Workspace deletion cascades its sites, credentials and maintenance queue, but organization/membership and Auth cleanup are separate. Do not treat “Delete website data” as completion of an account deletion request.

## Privacy comparison

The new source notice correctly describes server-side expiry as read filtering followed by cleanup on update/maintenance. It correctly excludes costs/billing configuration and offers account deletion by request. Its statement that provider backups *may* have separate retention does not promise that backups exist; nevertheless, no specific provider-log or future-backup retention schedule is documented here.

The browser-expiry wording mismatch identified in this review is now corrected in local source: `src/app/(routes)/(landing)/privacy/page.tsx` distinguishes expiry for use from physical cleanup on later tracker activity or consent withdrawal. The tracker uses `localStorage`, which has no automatic expiry while the page is closed. Expired attribution is replaced on subsequent capture; expired pending delivery is filtered when the tracker restores or flushes its queue. The revised notice still needs deployment verification.

Local retention validation passed 53 tests across five targeted files, including 13 new tests for JSON persistence without sites, saved/legacy inheritance, last-site deletion, existing-site updates, expiry caps, input bounds and settings display. Targeted ESLint and TypeScript checks passed. These mocked-store/model/UI regressions are not hosted deletion or restore proof. No migration or provider write was required.

[The current public privacy page](https://maintainflow.io/privacy), fetched during this review, still identifies MaintainFlow's 30 August private beta and its prior snapshot/approval retention rules. It is not the new attribution notice. Confirm the replacement page on the exact deployed revision before collecting production attribution data.

## Pending recovery proof

1. Select and authorize a backup arrangement, encrypted destination, retention period and restore target. Establish who owns recovery and the acceptable data-loss/downtime limits. Keep backup access and credential keyring recovery in separate controlled secret storage.
2. Perform an authorized synthetic-data backup/restore drill into an isolated target. Include schema/roles, tenant state and Auth continuity; separately account for external Auth/SMTP settings, hosting configuration and the encryption key IDs needed to read restored credentials. Do not send provider requests or billing events during a restore test.
3. Verify migration checksums, tenant isolation, restored record counts, credential decryptability and application readiness. Apply expired-record cleanup and any deletion requests made after the backup before re-enabling ingestion or sync. Record measured restore time and actual recovery point, then remove the isolated fixture under the approved cleanup procedure.

All three steps remain pending. No tested recovery copy or complete account-deletion proof is claimed.
