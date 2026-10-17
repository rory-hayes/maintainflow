# Independent check of the monitoring trigger

`scripts/stale-monitor.ts` is a read-only checker for the existing GitHub operational monitor. It closes a local tooling gap: a monitor cannot report its own permanent stoppage. It can observe the GitHub schedule or an explicitly selected external trigger. This file does **not** install an external runner, schedule checks, or send notifications. Hosted activation still follows [Monitoring activation](MONITORING-ACTIVATION.md).

An optional [Healthchecks heartbeat](MONITOR-HEARTBEAT.md) can notify an independent service after a genuine scheduled monitor finishes successfully. It remains inactive until its separately approved provider check and protected ping URL are configured. Neither tool alone proves independent alert delivery.

With Node 24, the default command is an offline plan:

```sh
node scripts/stale-monitor.ts --plan
```

For an actual check, provide `GH_TOKEN` through the runner's secret store, then run:

```sh
node scripts/stale-monitor.ts --check
```

Use a dedicated GitHub credential limited to **Actions: read** and repository metadata for `rory-hayes/maintainflow`. Do not give the observer the application's diagnostics credential, incident state key, mail key, document access or write access. In particular, keep it separate from an external dispatcher's Actions-write credential. No `.env` file is loaded; no values, provider errors, logs or artifact contents are printed. The checker makes only fixed GitHub GET requests for `operations-monitor.yml` and its latest 30 runs on `main`, filtered to `event=schedule` or `event=workflow_dispatch` according to the explicit mode. Both use a shared 20-second deadline, no redirects and a 1 MiB per-response limit. A disabled workflow needs only the first request. The API supports this [workflow, branch and event filtering](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).

Exit `0` from **`--check`** means the current workflow is active and there is sufficiently recent successful scheduled stateful work, without a newer completed scheduled failure or observed disabled gate. It reports `source: "github-schedule"` and remains schedule-only even when the external actor environment variable is present. Exit `1` covers unhealthy results and unavailable/unverifiable metadata; neither may be treated as healthy. Exit `2` rejects unsupported arguments. The offline plan exits `0` but is **not** a health result.

The default freshness limit is 20 minutes. `STALE_MONITOR_MAX_AGE_MINUTES` permits an explicit integer from 10 to 60; record the chosen threshold. Freshness uses the successful scheduled run's **creation time**, conservatively including queue/execution delay. Rerunning an old job or updating its metadata cannot make an old schedule fresh. A run exactly at the threshold passes; one older than the threshold does not. A pending run cannot conceal stale or failed prior work. A later successful scheduled run restores a healthy result.

Manual probes, drills and initialization are excluded by the server-side schedule filter, and are rejected if returned as scheduled evidence. The workflow's legacy `Folio monitor:` run names are exact operational identifiers. The observer verifies the workflow identity, `main`, both repository identities, status, conclusion, revision, timestamps and uniqueness. Unknown or contradictory metadata fails closed. Thirty recent runs may establish freshness; a truncated window with no successful scheduled run cannot establish health. The checker does not inspect job logs or prove email delivery, checkpoint recovery, application uptime or the current value of a repository variable before another scheduled attempt exposes it.

## Optional external-trigger mode

After the coordinator configures the supported external trigger and workflow gates, supply its approved GitHub actor's numeric ID as `FOLIO_MONITOR_TRIGGER_ACTOR_ID` and run:

```sh
node scripts/stale-monitor.ts --check-external
```

The actor setting must be a positive safe integer written in canonical decimal form, with no leading zero, sign, spaces or exponent. Missing or invalid settings return `observer_external_actor_invalid` before any network request. This opt-in command reports `source: "external-trigger"` and accepts only dispatched runs meeting all of these conditions:

- Exact title `Folio monitor: external-run <trigger_at>`, where `<trigger_at>` is a canonical UTC ISO timestamp with milliseconds, for example `2026-10-17T14:22:00.000Z`.
- The tick has zero seconds/milliseconds and its UTC minute satisfies `minute % 5 === 2`, matching `2-59/5 * * * *`.
- `event=workflow_dispatch`, `actor.id` exactly matches the configured numeric actor, and the fixed workflow, `main`, both repository identities and all ordinary run metadata validate.
- Creation occurs at or after the tick, within 120 seconds. The successful tick itself is within `STALE_MONITOR_MAX_AGE_MINUTES` of the check time. Queue/execution delay does not refresh it, and rerunning an old tick cannot refresh it.

Ordinary manual run, probe, delivery-drill, initialize, disabled and other unrelated titles are excluded before classifying external runs. They never refresh freshness or conceal an external failure. Any title starting `Folio monitor: external-run` claims this identity and fails closed if its title, tick, actor or metadata is invalid, even when another trusted success is present. A queued external run cannot conceal the most recent completed external failure; a later completed external success recovers it. Unknown or contradictory external metadata is unavailable, never healthy.

External healthy/stale/failure/no-success reasons are `external_monitor_fresh`, `external_monitor_stale`, `latest_external_run_failed` and `no_external_success`. A truncated 30-run dispatch window with no eligible success returns `no_success_in_bounded_history`; a page filled with ordinary manual runs cannot establish health. Existing JSON keys `latestScheduledRun` and `lastSuccessfulScheduledRun` are retained for compatibility: in external mode they describe the selected external trigger, and include `triggerAt` in addition to GitHub `createdAt`. Use `source` to distinguish the two modes. In schedule mode their meaning and creation-time freshness are unchanged.

External mode does not prove the dispatcher's dependable cadence, the current workflow gates before another attempt exposes them, checkpoint/notification behaviour or independent delivery. Those need separate hosted acceptance. A successful manual probe or delivery drill supplies none of this trigger evidence.

## Remaining external activation

Choose an operator-owned runner outside the monitored GitHub Actions scheduler and the application host, on the approved plan. Install the reviewed script and the dedicated metadata-only credential there. Run the explicitly selected `--check` or `--check-external` every five minutes and route nonzero checks or checker execution failures to the approved incident recipient. The runner must also detect failure of **this** checker to execute. If using an external dispatcher, its own process alone cannot independently detect its stoppage; place the observer and its missing-check detection in a separate failure domain. Hosting the observer in the same Actions schedule retains the original blind spot. Keep credentials in that provider's secret store.

Before considering this live, record:

- The provider, owner, selected source, fixed workflow binding, threshold, schedule, external actor ID when applicable and approved notification destination.
- Local synthetic fixture proof of disabled, failed, missing, overdue and recovered triggers; these tests cause no GitHub mutation or outage.
- Actual healthy runs from the selected trigger observed through the installed checker, with the full agreed cadence window recorded separately.
- Provider-side alert and recovery receipt from an approved controlled observer fixture or drill, including the provider's own missing-check detection.

No external provider or notification channel is created by this change. Until those records exist, independent stale-run alerting remains incomplete even when the local tests pass.
