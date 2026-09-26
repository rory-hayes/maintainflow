# Launch capacity facts

**Status update — 27 September 2026:** the invocation-deadline correction described below shipped in [PR54](https://github.com/rory-hayes/maintainflow/pull/54), with canonical revision `2daa2022023600fee8da21f2011aad1bf10258fd` verified on 26 September at 19:55 UTC. It remains included in the subsequently verified [PR58](https://github.com/rory-hayes/maintainflow/pull/58) release, `b7ee471d407ad5f94766428020dc3bef1c65c8b0`, checked at 22:33 UTC. This closes the correction's deployment step; it does not establish hosted workload capacity, memory headroom or throughput.

## Original source audit — historical baseline

The deployment-pending statements below describe the original audit checkpoint and are superseded by the dated status update above. Preserve its source scope and measurement limits.

Audited 26 September 2026 against source commit `8757f8a3dbe78cf67350ba71e57ea70885eee4be`, with the local invocation-deadline correction described below. That correction has not yet been deployed. This is a source/configuration audit, not a load test, throughput promise, SLA or approval to upgrade accounts. No credentials, customer files or provider requests were used.

## Hosting and timing

| Boundary | Verified source/configuration | Interpretation |
| --- | --- | --- |
| API function | [build-vercel.mjs](../scripts/build-vercel.mjs) emits one `api.func`, `nodejs24.x`, `maxDuration:300`, `memory:2048`, region `fra1`, response streaming enabled | These are the requested Build Output API settings; effective hosted memory, CPU and Fluid settings were not independently read back in this audit. |
| Packaging | Build fails above 240 MiB of traced files; explicitly includes the compiled decoder and its native dependencies | A packaging guard, not runtime memory headroom. |
| Worker | [hosted-worker.ts](../server/hosted-worker.ts): local correction bounds work to 210 seconds after raw invocation start, one active drain per warm process | Stops/aborts work within the application; not a separate permanent worker or an extension of the hosting timeout. Canonical deployment still needs this correction. |
| New job admission | Requires more than 110 seconds remaining for each extraction/helper lane, 70 for delivery, 140 for provider events, 40 for deletion/email | Independent lanes run concurrently; these reserves are not per-document latency guarantees. |
| Extraction attempt | [worker.ts](../server/core/worker.ts): 90-second outer race; source storage read, optional geometry/TIFF preparation and provider extraction share that time; 120-second claim lease | Late extraction cannot save through the raced attempt; expired claims are recovered and writes are fenced by owner. Persistence follows the extraction race and still needs time. |
| AI HTTP | [openai-provider.ts](../server/core/openai-provider.ts): at most 80 seconds, composed with the outer abort signal | The 80 seconds is inside, not additional to, the 90-second extraction budget. |
| Storage HTTP | [storage.ts](../server/core/storage.ts): 45-second abort deadline per Supabase request, redirects rejected | Not all storage operations inherit the worker abort signal; bounded I/O can continue after a cooperative deadline. |
| Split/import intake | [pdf-split-intake.ts](../server/core/pdf-split-intake.ts), [archive-import-intake.ts](../server/core/archive-import-intake.ts), [upload-routes.ts](../server/core/upload-routes.ts): up to 120 seconds | Direct split/archive finalization subtracts elapsed preparation time from that operation's budget. |

Current official Vercel documentation lists a 300-second maximum on Fluid Hobby and up to 800 seconds on Pro/Enterprise. The current source continues to request 300 seconds after an upgrade. Standard functions default to 2 GB/1 vCPU; Pro/Enterprise can use 4 GB/2 vCPUs. The request/response payload limit is 4.5 MB, and file descriptors are limited to 1,024 per instance across concurrent executions. Platform concurrency ceilings are not evidence of MaintainFlow capacity. [Function limits](https://vercel.com/docs/functions/limitations), [memory/CPU configuration](https://vercel.com/docs/functions/configuring-functions/memory), [Build Output configuration](https://vercel.com/docs/build-output-api/primitives#serverless-function-configuration).

**Concrete deadline mismatch, fixed locally:** at the audited deployed commit, a permitted 120-second split/import can precede a full 210-second worker cycle, requiring up to 330 seconds before other overhead. Vercel's `waitUntil` remains inside the invocation timeout. This establishes a possible interruption/retry path, not an observed timeout or loss of data. [Vercel background-task lifecycle](https://vercel.com/kb/guide/troubleshooting-inconsistent-logs-in-vercel-functions).

The local correction records the raw request's start before cold app initialization in [hosted-entry.ts](../server/hosted-entry.ts), carries an absolute `start + 210 seconds` deadline through worker initialization, and arms the timer only for the time remaining. After a 120-second intake, the remaining 90 seconds are below the extraction lane's 110-second admission reserve; that work stays queued for another invocation. An expired budget performs no enqueue, maintenance or claims. A later request shares an existing drain without extending or aborting its deadline. The watchdog uses its own request clock and is excluded from the successful-mutation wake hook even when its URL has a query string. The nominal 90-second hosting grace remains for bounded I/O and durable retry updates; it is not a hard process termination guarantee. Merely buying Pro does not change the source's 300-second setting.

Local verification: **24/24** focused [hosted-worker tests](../tests/hosted-worker.test.ts) and TypeScript checking pass on Node 24.13.0. Six added cases cover slow successful intake, app/worker initialization, expired budgets, expiry before later lanes, coalescing, and the actual remaining-time abort timer using fake clocks. No database/provider calls or load exercise occurred. Deployment and canonical verification of this change remain separate.

## Decoder bounds and isolation

[decoder-limits.ts](../server/core/decoder-limits.ts), [source.ts](../server/core/source.ts), [decoder-input.ts](../server/core/decoder-input.ts) and [decoder-child.ts](../server/core/decoder-child.ts) establish:

- A separate Node child, same executable/user and application working directory. Production uses compiled JavaScript with `--max-old-space-size=192`; source/tsx development uses 256 MiB.
- Exactly four supplied environment values: `NODE_ENV=production`, `TZ=UTC`, `LANG=en_US.UTF-8`, `TSX_DISABLE_CACHE=1`. Application credentials, `PATH` and `NODE_OPTIONS` are not inherited through this environment.
- Original input at most 10 MiB and 30 pages. Split/archive IPC may add a 4-byte length plus a maximum 4 KiB specification. Original bytes/specifications travel through stdin, not a temporary input file or argv.
- A default 30-second deadline; timeout/abort/oversized output kills the child with `SIGKILL`. Its concurrency slot is held until the child closes. Two children per parent process; excess work receives backpressure (429), not another child.
- Ordinary stdout at most 4 MiB and extracted text at most 2 MiB. Output is bounded before parsing and schema-validated. Child stderr is drained/discarded and operational errors are sanitized.

Special modes have explicit larger bounds:

| Mode | Additional bounds | Source |
| --- | --- | --- |
| Native PDF geometry | 5,000 items/page, 20,000 total, 1 MiB text, 8 MiB IPC output | [pdf-regions.ts](../shared/pdf-regions.ts) |
| PDF/TIFF split | Up to 20 documents, 20 MiB aggregate derived bytes, 42 MiB IPC output | [pdf-split.ts](../shared/pdf-split.ts) |
| ZIP import | 256 directory records, 20 selected documents, 20 MiB expanded document bytes, 40 MiB Office expansion, 44 MiB IPC output | [archive-import.ts](../shared/archive-import.ts) |
| PNG/JPEG | 40 million input pixels; original is sent to AI when configured | [decoder-engine.ts](../server/core/decoder-engine.ts) |
| TIFF | 40 million pixels/page, 300 million aggregate pixels, 160 MiB decoded page-sample bound; derived JPEG edge at most 2,048 pixels and 2 MiB, PDF at most 10 MiB, IPC at most 14 MiB | [tiff.ts](../shared/tiff.ts), [tiff-engine.ts](../server/core/tiff-engine.ts) |

**These are resource controls, not an OS sandbox.** There is no child-specific filesystem jail, separate UID, network namespace/deny rule, RSS limit or independent CPU quota in the launcher. Removing secrets from its environment does not remove the child's ability to use available filesystem/network APIs. The V8 flag limits old-generation heap; native Sharp allocations, Buffers, parent memory and IPC copies are outside that number. Thus `2 × 192 MiB` is not a bound on total function memory. [Node's heap-option definition](https://nodejs.org/download/release/v24.20.0/docs/api/cli.html#--max-old-space-sizesize-in-mib).

The existing [20 September synthetic TIFF resource receipt](evidence/tiff-intake-2026-09-20/decoder-adversarial-resource.json) records a compiled 192-MiB-heap, 30-page/300-million-pixel fixture completing locally in about 2.6 seconds, and explicitly says native peak RSS was not measured. It is historical evidence for that fixture, not simultaneous decoder, hosted Linux or arbitrary input capacity proof.

## Shared service limits

| Scope | Current bound | Capacity consequence |
| --- | --- | --- |
| Workspace extraction | Explore 1, Standard 2, Team 4 processing jobs, shared across document extraction and both AI helper queues; DB locks and capacity rechecks fence concurrent claims | Applies across workers for that workspace. Does not limit the number of workspaces simultaneously using the provider. [Plans](../shared/plans.ts), [worker](../server/core/worker.ts), [schema suggestions](../server/core/schema-suggestions.ts). |
| Warm worker | One serial consumer per queue; three extraction/helper consumers can progress concurrently with delivery, provider, email, deletion and maintenance | Module-local coalescing does not prevent additional Vercel instances. |
| Database clients | Non-public application schema defaults to one connection in each of two pools (`appPool`, `adminPool`); configurable 1–20 per pool. Connection timeout 10 seconds, idle timeout 20 seconds | Two default pool clients per warm process, multiplied by instances. Actual deployed override was not read. [db.ts](../server/core/db.ts). |
| Database statements | Non-public schema wrapper sets transaction-local 10-second statement and 5-second lock timeouts, rejects named prepared statements | A statement bound, not a whole transaction deadline. Public/local schema bypasses this wrapper. |
| Requests | DB-backed 300 requests/minute per rate-limit identity; authentication 30/15 minutes | Abuse control, not a deployment-wide work/cost ceiling. [rate-limit.ts](../server/core/rate-limit.ts). |
| Uploads | 20 files/batch, 10 MiB/file and 30 pages/file; Supabase storage selects signed upload strategy. Multipart route buffers the submitted files before serial intake | Use the existing signed path on Vercel; a 10-MiB product file allowance does not fit its 4.5-MB function request allowance. This path already exists. [upload routes](../server/core/upload-routes.ts), [document routes](../server/core/document-routes.ts). |
| AI response | 16,000 output tokens, 1 MiB response, 512 KiB document text, 1,000 rows per array and 5,000 nested rows total | A statement within file/page limits can still exceed extraction limits; no guarantee that every 30-page document fits. [openai-provider.ts](../server/core/openai-provider.ts). |

Supabase recommends transaction pooling for serverless workloads, a small module-level pool and no named prepared statements. The source's non-public schema wrapper accommodates this, but does not prove the current hosted endpoint/override. Official Nano and Micro defaults both list 60 direct database connections and 200 pooler clients; Micro adds memory (1 GB versus Nano's up to 0.5 GB), not a larger default connection allowance. Upgrading an existing project does not automatically change its compute size. Current account/compute settings and remaining headroom were not queried. [Connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres), [compute table](https://supabase.com/docs/guides/platform/compute-and-disk).

Fluid compute may share an instance between multiple requests, so parent state, memory and decoder slots are shared within that instance. More instances multiply pools and decoder/provider concurrency; there is no source-level deployment-wide extraction semaphore. [Fluid concurrency](https://vercel.com/docs/fluid-compute#optimized-concurrency). Per-workspace monthly pages and helper counts are admission limits, not a hard provider-dollar spending ceiling.

## Egress boundaries

The parent intentionally connects to Supabase Storage/Postgres, OpenAI and configured integrations. OpenAI extraction uses a fixed HTTPS endpoint and rejects redirects. Storage restricts its configured origin to a Supabase project HTTPS host and rejects redirects. Custom HTTP destinations use [network.ts](../server/integrations/network.ts): HTTPS/443 without URL credentials, all DNS answers must be public, the chosen address is pinned to the socket, no redirect following, 8-second DNS/15-second request deadlines and a default 64-KiB response cap.

Those controls apply to these call sites. They are not a host-wide egress firewall and do not constrain arbitrary child/native-library network access. Vercel documents dynamic outbound IPs by default; Static IPs and Secure Compute are separate features. No account-level egress policy, Static IP or Secure Compute setting was verified here, and none is inferred from `fra1`. [Vercel outbound networking](https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address). This audit does not prescribe a new networking product or an upgrade for a hypothetical requirement.

## Initial operating assumptions and remaining evidence

For planning a small invited pilot, assume **at most two active workspaces**, one small batch per workspace (up to five documents), typically 1–10 pages and under 2 MiB per file, with users accepting asynchronous review-ready completion. These are proposed operating assumptions, not enforced restrictions, tested throughput or changes to the advertised input limits. Do not infer pages/minute, concurrent-customer capacity or availability from them.

1. **Release the locally verified invocation-budget correction above** through the existing review/CI/deployment process, then confirm the canonical revision and worker probe. The focused fake-clock regression is complete; a hosted load test is not claimed.
2. **Read back non-secret hosting settings** for the canonical deployment: effective runtime, region, maximum duration, memory/CPU and Fluid mode; Supabase compute, connection/pooler counts and pool size. The optional Vercel connector returned incompatible `projectId`/`idOrName` schema errors, so no effective-setting claim was made. No credential-file fallback was used.
3. **Measure before widening the pilot or advertising capacity:** representative and boundary synthetic files, two simultaneous decoders plus normal API traffic, parent+child peak RSS, CPU, intake/provider/queue latency, 429/timeout/retry rates, DB connection wait and queue age. Repeat in the packaged Linux runtime; preserve privacy and use an explicitly bounded budget before any paid provider/load exercise. Existing fixture correctness and functional CI are not this measurement.
4. **Observe real headroom after the last account upgrades:** storage/egress, DB/pooler clients, function duration/memory and provider rate limits. Keep existing operational alerts and stale-run checks as separate activation gates in [LAUNCH-BACKLOG.md](LAUNCH-BACKLOG.md). An upgrade alone proves neither throughput nor monitor delivery.

This audit has made no deployment, account, retention, billing or security-policy change. It records one concrete timing mismatch, its locally verified correction and the limits of existing evidence; unmeasured capacity and absent child OS isolation are not presented as newly discovered outages or a mandate to add unrelated product features.
