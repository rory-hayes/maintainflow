# External monitoring trigger — prepared, inactive

This optional timer dispatches the existing monitoring workflow on `main`, retaining its encrypted checkpoints, incident outbox and concurrency group. No account, credential, schedule or receiver is created by this source. The supplied Cloudflare config has no cron and its enable flag is `false`.

## Existing providers and the actual gap

On 17 October, natural runs were created at 09:40:46 and 13:12:03 UTC, a **211m17s** gap; both jobs waited about two seconds for a runner. The active GitHub cron already requests `2-59/5 * * * *`. This proves missing frequent execution, not GitHub's underlying cause. GitHub permits delayed or dropped events. [Schedule limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

| Option | Constraint and next action |
| --- | --- |
| Existing GitHub cron | Already active/off-peak. Preserve it; another expression or manual run does not prove cadence. |
| Existing Supabase cron/watchdog | Worker-watchdog SQL success is not monitor execution. The saved v2 dispatch-bridge ACL review blocks safely installing a GitHub bearer in the managed network boundary. Resolve supported owner/platform permission and caller compatibility, then review an updated signed-tick bridge. Do not activate the old mode=`run` candidate. |
| Existing Vercel Hobby | Daily cron cannot supply five-minute operation. A paid upgrade needs its own measured account decision. [Limits](https://vercel.com/docs/cron-jobs/usage-and-pricing) |
| Optional Cloudflare Worker | Supports UTC scheduled handlers. Actual owned account/access/quota remain unknown. Reuse an approved Free account if chosen, or leave this option inactive. [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |

An additional provider is an option, not a new launch requirement. Prefer an existing owned timer once its actual secure configuration supports the contract. `scripts/monitor-external-trigger.ts` uses Fetch and Web Crypto; Cloudflare is the supplied deployment adapter.

## Contract and secrets

Each tick is a canonical UTC ISO minute with zero seconds/milliseconds and `minute % 5 === 2`. The timer admits it for two minutes, verifies its GitHub user, and makes at most four fixed calls: `/user`, workflow metadata, latest 30 main dispatch records, then one dispatch POST. API version `2026-03-10` must return HTTP 200 and a positive `workflow_run_id`. This is acceptance, not completion. Redirects, response size and a shared deadline are bounded; there is no automatic POST retry. [GitHub API and required permission](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)

The fixed body is `ref: main`, mode `external-run`, `trigger_at` and an HMAC-SHA256 of `maintainflow-monitor-tick:v1:<tick>`. Exact run title is `Folio monitor: external-run <tick>`.

| Name | Destination |
| --- | --- |
| `FOLIO_MONITOR_TRIGGER_TOKEN` | Timer secret only: dedicated fine-grained **user** PAT for exactly `rory-hayes/maintainflow`, Actions write plus required metadata read. Record actual owner/expiry. Installation tokens cannot satisfy `/user`. |
| `FOLIO_MONITOR_TRIGGER_KEY` | Separate random 32-byte key encoded as 64 lowercase hex characters, in timer secrets and GitHub Actions repository secrets. Never reuse application, email or checkpoint keys. |
| `FOLIO_MONITOR_TRIGGER_ACTOR_ID` | Actual credential owner's canonical numeric user ID in timer and repository variables. Do not invent an account. |
| `FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED` | Exact `true` in timer and repository variables only after review. Existing `FOLIO_MONITOR_ENABLED` remains enabled. |

The workflow gates the actor before secret use. Its source-authenticated selector verifies flags, actor, freshness and HMAC before state selection. The assertion is read from GitHub's bounded event file without echoing it in step environment setup. Ordinary manual external runs without a valid provider assertion cannot succeed. The short-lived assertion can remain in provider event metadata; privileged operators with the secrets remain trusted. Rotate both stores together and preserve incident state. The timer receives no application, checkpoint, mail or receiver credentials.

Dispatch **can be duplicated; it is not exactly once**: recent matching metadata avoids ordinary resends, but concurrent GET→POST invocations can create duplicate runs. The shared workflow concurrency group serializes them. An authenticated prior observation whose `checkedAt` already reaches the tick wins, so duplicates cannot multiply failing polls or incident/recovery transitions. A native observation after that tick also counts.

Checkpoint selection can read ten pages / 300 runs under the existing shared 20-second deadline, only after proving intervening stateful failures harmless. This does not promise 25 hours of recovery: extra runs and API latency shorten coverage. Limits, expired/ambiguous/raced history and notices aged at least 23 hours require exact operator/provider reconciliation. Preserve evidence; never delete runs, reset initialization or select an arbitrary older artifact to get green.

## Exact coordinator actions

1. Integrate, run central CI and release this source through the normal private process. Preserve the current enable flag, checkpoint history and accepted two-message TEST drill.
2. Record the chosen owned timer/account/Free quota and responsible operator. The existing Supabase option needs its supported permission repair first. The Worker is an unactivated alternative.
3. If choosing the Worker, deploy the reviewed bundle/config with no cron, disabled variables, no routes, `workers_dev=false`, `preview_urls=false` and no fetch handler. Install token/key through protected secret UI; install only the signing key in GitHub. Record names/scope/expiry, never values. [Secret handling](https://developers.cloudflare.com/workers/configuration/secrets/)
4. Set the actual matching actor ID in both stores. Review/apply the two enable flags and change Worker `triggers.crons` to `["2-59/5 * * * *"]`. Root owns mutations. Allow up to 15 minutes for documented trigger propagation, recording when the observation window begins. [Propagation](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
5. Complete the **existing pending** independent receiver account/Terms step through normal access; do not invent another account or accept Terms on the user's behalf. Set the approved recipient, five-minute period and fifteen-minute grace; securely install its exact UUID capability as `FOLIO_MONITOR_HEARTBEAT_URL`.
6. Observe automatic provider tick → accepted run ID → initial successful stateful `external-run <tick>` → final delivered artifact → `completed_external_trigger_accepted` heartbeat → matching receiver event. A manual event, accepted POST or green inactive heartbeat job is insufficient.
7. Root coordinates an isolated receiver missed-ping/recovery drill on a separate synthetic check and confirms both inbox notices. Keep the production monitor operational. Actual hosted application incident/recovery/retry acceptance remains a separate isolated drill; do not cause global faults or repeat the accepted application TEST emails.

## Cadence and independent acceptance

Observe the first **12 automatic ticks**, then **24 hours / 288 expected ticks**. Retain provider scheduled event/time, tick, dispatch run ID, job start/end, revision, final checkpoint, heartbeat result and receiver event. Deduplicate tick counts while preserving duplicate runs and failures. Report missing ticks and min/median/p95/max creation and successful-observation gaps; label natural GitHub runs separately.

Require the intended cadence's actual distribution and no unexplained missing tick or progress gap beyond the existing 20-minute threshold. Explain every delay/failure rather than averaging it away. A day's evidence is not an SLA. Export receiver events at least every four hours because free history is limited. The shared receiver watches successful monitoring from either automatic path; a natural success can mask failure of the external timer itself, so source-specific cadence still needs its own inspection.

Runnable Node24 checks, with no `.env` loading:

```sh
node scripts/stale-monitor.ts --plan
node scripts/stale-monitor.ts --check
node scripts/stale-monitor.ts --check-external
node --import tsx --test --test-concurrency=1 tests/monitor-external-trigger.test.ts tests/monitor-artifact-state.test.ts tests/operations-monitor.test.ts tests/monitor-heartbeat.test.ts tests/stale-monitor.test.ts
```

The two `--check` commands contact GitHub and require a separately supplied metadata-read `GH_TOKEN`; external mode also needs the actor ID. They send no mail or dispatch. Source tests intercept all requests. No public/local CLI dispatch shortcut is provided.

The receiver must detect silence outside GitHub, the app and timer provider. Dispatch acceptance never pings it; only completed stateful monitoring may do so. Twenty-minute source eligibility plus twenty-minute receiver silence can mean roughly forty minutes plus delivery before notice; do not claim a twenty-minute end-to-end guarantee.

Rollback disables only the external timer cron/enable flag; preserve the existing natural monitor, checkpoint history and receiver. Reconcile in-flight runs before rotating credentials.

Local tests and a bundle close neither L16 nor L17. Hosted cadence, actual incident/recovery, receiver acceptance and delivered missed-run/recovery evidence remain open.
