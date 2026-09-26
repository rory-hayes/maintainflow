# Monitoring activation handoff

**Status update — 27 September 2026:** the diagnostics credential and separate monitoring-state key were installed on 26 September at 16:30 UTC. The [PR58 monitor probe](https://github.com/rory-hayes/maintainflow/actions/runs/36276759352) subsequently passed on canonical revision `b7ee471d407ad5f94766428020dc3bef1c65c8b0`, observed at 22:36 UTC, with zero emails and zero monitoring-state writes. The scheduling switch remains absent/disabled; incident-recipient confirmation, inbox delivery, state initialization and genuine scheduled operation remain outstanding.

This is an activation checklist for the existing independent monitor, not a new monitoring service. Read [Independent operational monitoring](INDEPENDENT-MONITORING.md) for incident thresholds, encrypted artifact history and uncertain-delivery recovery. The implementation already has scoped probes, encrypted checkpoints, an outbox and idempotent incident/recovery notices. Those mechanisms do not establish hosted activation or receipt of an alert.

**Original preparation boundary — historical, superseded above:** installing the monitor credential and selecting/authorizing the incident recipient remain pending approvals. The checklist and offline preflight do not grant those approvals. No secret is installed, notice sent, state created or GitHub schedule activated by this work.

## Offline configuration preflight

With Node 24 and only the intended monitor settings supplied through a secure environment, run:

```sh
node scripts/monitor-readiness.ts --check
```

The command reads the supplied environment only. It does not read `.env` files, contact any endpoint, open an existing checkpoint or write files. It emits fixed check names, requirements and pass/blocked results; it never emits values, hashes, recipient addresses or secret lengths. Do not paste credentials into command arguments, the repository, screenshots or a shared transcript.

Exit status `0` means the supplied local configuration has the expected shape for **controlled preparation**. Status `1` lists missing or unsuitable configuration; status `2` rejects unsupported arguments. It always returns `hostedActivationVerified: false`. A valid recipient syntax is not recipient consent; a valid key shape is not verified scope, randomness or successful installation.

The configuration is intentionally bound to the current workflow:

| Setting | Required value or handling | Destination |
| --- | --- | --- |
| `FOLIO_MONITOR_ORIGIN` | `https://maintainflow.io` exactly | Already fixed in the workflow |
| `FOLIO_MONITOR_ENABLED` | Unset or `false` during preparation | GitHub repository **variable**; pass its inspected value to this local preflight |
| `FOLIO_MONITOR_SECRET` | Independently generated diagnostics-only credential, at least 32 characters | Sensitive server setting and matching GitHub secret |
| `FOLIO_MONITOR_STATE_KEY` | Separate random 32-byte key, encoded in canonical base64 | GitHub secret; retain securely for checkpoint recovery |
| `FOLIO_MONITOR_EMAIL_API_KEY` | Dedicated verified-domain Resend sending credential | GitHub secret |
| `FOLIO_MONITOR_EMAIL_FROM` | `no-reply@maintainflow.io` | Already fixed in the workflow; verify provider acceptance |
| `FOLIO_MONITOR_EMAIL_TO` | One approved, monitored incident inbox | GitHub secret |
| `FOLIO_MONITOR_STATE_FILE` | `.monitor/state.enc`, or omit for the runtime default | Already fixed in the workflow |

Keep `FOLIO_WORKER_SECRET` out of this environment. The offline check rejects its presence and detects direct reuse of the state key as another monitor credential. It cannot prove that independently generated values were used or that the server and GitHub installations match. The server's dedicated monitor bearer must permit diagnostics only; retain the existing worker-denial regression as evidence. Do not send a successful worker request to test it.

The local flag does not read or change the GitHub repository variable. A locally disabled result therefore cannot prove that the hosted schedule is disabled. The workflow remains the enforcement point: only `main` can use these secrets, with `contents: read` and `actions: read`; while disabled, explicit `probe`, `delivery-drill` and `initialize` dispatches are permitted, but ordinary `run` dispatches and schedules are skipped.

## Activation order and evidence

| Order | Action after the required approval | Evidence needed before proceeding |
| --- | --- | --- |
| 1 | Record the authorized incident recipient, sender and secret-installation scope. Confirm the intended application revision and workflow are deployed on `main`. | Private approval record and revision; no credential values in the record. |
| 2 | Independently generate and install the scoped diagnostic credential and state key; install the approved sending credential and recipient. Leave the repository variable disabled. | Settings names/scope, installed revision, verified sending domain and actual disabled repository variable. Do not export secret values to collect evidence. |
| 3 | Run this offline preflight with only the intended monitor environment. Dispatch the existing `probe` mode on `main`. | A clean local report, workflow run link, and healthy health/readiness/authenticated-diagnostics results. A probe does not initialize incident state or send mail. |
| 4 | Dispatch the approved `delivery-drill` using a fresh UUID and fixed current UTC timestamp. | Two provider acceptances **and** separate observations of the `[TEST]` incident and recovery messages in the approved inbox. No production outage or application mutation is needed. |
| 5 | Dispatch `initialize` through the existing workflow. | Authoritative history selection and the final encrypted `delivered` checkpoint. Initialization preserves an existing checkpoint instead of resetting it. It is stateful and may send genuine notices when observed conditions require them. |
| 6 | Set `FOLIO_MONITOR_ENABLED=true` only after the earlier checks pass. | Observe a genuine scheduled run, exact prior-artifact selection, resumed/prepared/delivered checkpoints and quiet healthy operation. A manually dispatched run is insufficient scheduling evidence. |
| 7 | Configure and test the independent stale-run check described below. | A missing/failed-run alert and recovery observed by the operator through an independent path. |

Use the existing GitHub workflow's dispatch form and `main` reference. Do not run local `--run` as a substitute: it lacks the workflow's remote checkpoint ordering. The drill reads/writes no incident artifacts, but sends real test email and needs the approved recipient. On an uncertain drill retry, reuse **both** the UUID and timestamp within the permitted window; notices at least 23 hours old require reconciliation. Do not change recipient/sender/origin during uncertain delivery.

Initialize promptly after the probe and drill. The selector inspects at most 30 recent runs; hidden older state cannot authorize a fresh start. Missing, expired or ambiguous authoritative artifacts, incomplete prior runs and an older pending notice require reconciliation. Never delete history, fall back to an older checkpoint or invent a new notice identity to bypass these failures.

## External stale-run check remains necessary

The existing monitor notices a gap over 20 minutes only when it runs again. Permanent GitHub stoppage, disabled scheduling or repeated pre-checkpoint failure needs an independently operated check. An ordinary uptime check of the application does not cover that failure.

Before launch, choose an external runner/provider and a responsible incident recipient, within the agreed account plan. Configure it to check the last **successfully completed scheduled, stateful** monitor run on `main`, not a successful probe, drill, disabled run or arbitrary repository activity. Watch workflow failure as well as elapsed time. A practical initial stale threshold is over 20 minutes, allowing for best-effort scheduling; agree and record the actual threshold and recovery rule. This is a proposed operational setting, not a delivery-time guarantee.

Give that observer only read access to the necessary workflow metadata. Do not give it application diagnostics credentials, the checkpoint key or customer document access. Test missing-run and recovered conditions using a controlled observer fixture or an approved controlled drill, without taking the application down. Record the observed alert and recovery, then verify the real workflow binding. A stale-run provider, its credentials, configuration and delivery evidence have **not** been supplied by this runbook or preflight.

## Closeout record

Keep a private record containing the application/workflow revisions, actual repository variable status, probe/drill/initialize/scheduled-run links, selected artifact IDs, provider acceptance references, inbox observation times, authorized recipient, stale-run observer, alert threshold and operator ownership. Record current runner and artifact allowances separately; the workflow's requested 90-day artifact retention is not permanent recovery storage.

Monitoring is complete only after the hosted evidence is collected. It does not certify worker recovery, backups, extraction accuracy, customer policies, billing or public registration readiness. Those remain separate launch checks.
