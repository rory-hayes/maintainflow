# Independent check of the monitoring schedule

`scripts/stale-monitor.ts` is a read-only checker for the existing GitHub operational monitor. It closes a local tooling gap: a monitor cannot report its own permanent stoppage. This file does **not** install an external runner, schedule checks, or send notifications. Hosted activation still follows [Monitoring activation](MONITORING-ACTIVATION.md).

With Node 24, the default command is an offline plan:

```sh
node scripts/stale-monitor.ts --plan
```

For an actual check, provide `GH_TOKEN` through the runner's secret store, then run:

```sh
node scripts/stale-monitor.ts --check
```

Use a dedicated GitHub credential limited to **Actions: read** and repository metadata for `rory-hayes/maintainflow`. Do not give the observer the application's diagnostics credential, incident state key, mail key, document access or write access. No `.env` file is loaded; no values, provider errors, logs or artifact contents are printed. The checker makes only fixed GitHub GET requests for `operations-monitor.yml` and its latest 30 scheduled runs on `main`, with a shared 20-second deadline, no redirects and a 1 MiB per-response limit. A disabled workflow needs only the first request.

Exit `0` from **`--check`** means the current workflow is active and there is sufficiently recent successful scheduled stateful work, without a newer completed scheduled failure or observed disabled gate. Exit `1` covers unhealthy results and unavailable/unverifiable metadata; neither may be treated as healthy. Exit `2` rejects unsupported arguments. The offline plan exits `0` but is **not** a health result.

The default freshness limit is 20 minutes. `STALE_MONITOR_MAX_AGE_MINUTES` permits an explicit integer from 10 to 60; record the chosen threshold. Freshness uses the successful scheduled run's **creation time**, conservatively including queue/execution delay. Rerunning an old job or updating its metadata cannot make an old schedule fresh. A run exactly at the threshold passes; one older than the threshold does not. A pending run cannot conceal stale or failed prior work. A later successful scheduled run restores a healthy result.

Manual probes, drills and initialization are excluded by the server-side schedule filter, and are rejected if returned as scheduled evidence. The workflow's legacy `Folio monitor:` run names are exact operational identifiers. The observer verifies the workflow identity, `main`, both repository identities, status, conclusion, revision, timestamps and uniqueness. Unknown or contradictory metadata fails closed. Thirty recent runs may establish freshness; a truncated window with no successful scheduled run cannot establish health. The checker does not inspect job logs or prove email delivery, checkpoint recovery, application uptime or the current value of a repository variable before another scheduled attempt exposes it.

## Remaining external activation

Choose an operator-owned runner outside the monitored GitHub Actions scheduler and the application host, on the approved plan. Install the reviewed script and the dedicated metadata-only credential there. Run `--check` every five minutes and route nonzero checks or checker execution failures to the approved incident recipient. The runner must also detect failure of **this** checker to execute; hosting it in the same Actions schedule would retain the original blind spot. Keep credentials in that provider's secret store.

Before considering this live, record:

- The provider, owner, fixed workflow binding, threshold, schedule and approved notification destination.
- Local synthetic fixture proof of disabled, failed, missing, overdue and recovered schedules; these tests cause no GitHub mutation or outage.
- An actual healthy **scheduled** run observed through the installed checker.
- Provider-side alert and recovery receipt from an approved controlled observer fixture or drill, including the provider's own missing-check detection.

No external provider or notification channel is created by this change. Until those records exist, independent stale-run alerting remains incomplete even when the local tests pass.
