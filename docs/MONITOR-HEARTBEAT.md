# Independent monitor heartbeat

The optional `monitor-heartbeat.yml` workflow notifies a Healthchecks.io check after the existing operational monitor **finishes successfully**. The service can then detect missing heartbeats independently of GitHub. It watches monitor operation; a successfully delivered application-incident alert still counts as a working monitor.

Only an initial, completed scheduled run on this repository's `main` branch can send a heartbeat. Manual probes, initialization, delivery drills, disabled runs, failed runs and reruns cannot keep the check alive. Freshness uses the original schedule's creation time, including queue delay, with a maximum age of 20 minutes. The receiving workflow also rejects its own reruns. It checks out trusted default-branch code, never the triggering run's code or artifacts.

No account, check, notification channel or secret is created by this code. Without the repository secret `FOLIO_MONITOR_HEARTBEAT_URL`, the helper reports `inactive` and sends nothing. The secret must be a single check's exact `https://hc-ping.com/<uuid>` URL. Treat it as a credential: someone with it could forge a heartbeat. Do not put it in source, logs or public screenshots. The request contains no body, application data, diagnostic credentials or GitHub token. Redirects are prohibited, the deadline is ten seconds and response reads are bounded. Only HTTP200 with the exact body `OK` counts as acceptance; Healthchecks also returns HTTP200 for ignored requests.

## Activation and acceptance

1. Obtain operator approval for the account/terms and alert destination; choose the free account unless a paid upgrade is separately approved.
2. Configure one check with a five-minute period and fifteen-minute grace (20 minutes total), and the approved email recipient. This is a starting operational setting, not a delivery-time guarantee; GitHub schedules are best effort.
3. Install only that check's ping URL as the protected repository secret above. It does not grant access to documents or the Healthchecks management API.
4. Observe a genuine scheduled monitor, its successful completion, the corresponding heartbeat workflow and provider acceptance. A newly created check that has never received a ping is not proof of stoppage detection.
5. Exercise missing-heartbeat and recovery notifications through an approved separate synthetic check or controlled provider drill, without taking the application down. Record delivery and human inbox observation separately, then verify the production check's binding and notification settings.

If the schedule stops, fails, is disabled or arrives too late, no valid success ping is sent. If the heartbeat workflow or provider request fails, the next ping is likewise absent; inspect its fixed diagnostic reason. Queue delay can consume the source's 20-minute eligibility window before the provider's 20-minute silence window begins, so detection can take roughly 40 minutes plus notification delivery time. Never present this as an end-to-end 20-minute guarantee or use a manual success ping to manufacture schedule evidence. Preserve dated receipts outside the provider's limited event history. The existing read-only `stale-monitor.ts` checker remains available for explicit GitHub status inspection.

Local synthetic tests prove filtering, privacy and response handling; they do not prove the independent account, scheduled execution or alert delivery. Public launch still needs those observations.

Sources: [GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [Healthchecks ping responses](https://healthchecks.io/docs/http_api/), [check timing](https://healthchecks.io/docs/configuring_checks/).
