# Decoder and interrupted-intake recovery

Local implementation, with the decoder launch contract updated 13 September 2026. The original 6 September recovery evidence remains dated below. This is a bounded subprocess design, not an OS security sandbox or production isolation claim.

## Decoder contract

The API checks the input byte limit, then launches a fresh Node subprocess with original bytes on stdin and a single JSON result on stdout. Only the sanitized basename is an argument. The child imports the decoder engine and fixed limits; it does not load application configuration, dotenv, database clients, or provider adapters. Its environment contains only `NODE_ENV`, `TZ`, `LANG`, and `TSX_DISABLE_CACHE`; inherited database/provider credentials, `NODE_OPTIONS`, and other environment values are absent.

| Bound | Implemented behavior |
| --- | --- |
| Input | Empty files rejected; at most 10 MiB before child creation and again inside child |
| Concurrent decoders | At most two per calling process; excess intake returns 429 with retry guidance |
| Wall time | Parent kills the child after 30 seconds; active slot remains occupied until process close |
| V8 heap | Compiled JavaScript child: `--max-old-space-size=192`. TypeScript source child with the trusted TSX loader: `--max-old-space-size=256`. The parent selects the bound from the actual entrypoint, not request input. |
| Text / response | At most 2 MiB decoded text and 4 MiB ordinary JSON; PDF splitting has a separately validated 42 MiB response allowance. The parent independently bounds and validates responses. |
| Formats | Existing signature, 30-page/sheet, 40-megapixel image, Office expansion and row/column limits remain |
| Errors | Expected validation errors are bounded; unexpected dependency details become a generic public message |

The 13 September Node 24 compatibility investigation reproduced a V8 heap exhaustion in TypeScript/TSX PDF splitting at the former 192 MiB source limit. Source execution now receives 256 MiB for its loader/compiler overhead; compiled deployment execution retains 192 MiB. The 30-second deadline, two-process capacity, environment allowlist and input/output bounds are unchanged. [PDF-splitting acceptance](PDF-SPLITTING-ACCEPTANCE.md) records the separate Node 26 checkpoint, first failed Node 24 CI run and subsequent verification; a source-loader allowance is not a hosting-plan change or a larger production decoder allowance.

`tests/decoder-reconciliation.test.ts` uses a real two-page PDF and controlled child-process doubles to check environment allowlisting, selected heap arguments, pre-spawn byte rejection, output/deadline termination, concurrency and invalid response rejection. The actual generated PDF, EML, CSV, XLSX, DOCX, text and scan fixtures also pass through the subprocess during the separately recorded extraction evaluation. Controlled doubles prove the parent cancellation contract; they do not establish OS resource exhaustion behavior.

The child still runs as the same OS user with the project's working directory. Removing environment credentials does not deny filesystem or network access. V8 heap size does not cap native allocations, total RSS, CPU consumption or descendants; the concurrency bound is per API/worker process. A public untrusted-upload deployment still needs a dedicated identity/container with no application secrets or private storage mounted, blocked network egress, a read-only runtime, limited temporary storage, CPU/full-memory/process quotas, and supervised cancellation verified in that deployment. No such deployment was performed here.

## Durable original-write recovery

Before filesystem writes, intake commits a tenant-scoped `intake_files` reservation with a five-minute lease. A 30-second heartbeat renews it while intake is active. Attaching a document holds the workspace advisory lock and reservation row lock; it requires the reservation still to exist. A committed document protects the original even if the process stops before removing the reservation. Normal duplicate/failed intake queues unretained written originals in `file_deletions`.

Worker maintenance calls `reconcileInterruptedIntake()` after retention every 120 loop cycles, so it resumes automatically after a worker restart. It selects at most ten workspaces, oldest serviced first, and inspects at most 100 UUID-named regular originals per workspace. Persisted filename cursors advance past referenced and recent files; they wrap at the directory end. A separate 100-entry expired-reservation cursor prevents abandoned pre-write reservations from accumulating. Directory metadata enumeration itself remains linear; large object-store deployments need storage-provider pagination.

Recovery validates that the configured private root and workspace directory are real directories without symbolic-link aliases. Only known workspace UUID directories and UUID regular-file names qualify. Non-UUID files and symlinks are preserved. An original must be at least one hour old, unreferenced by any document, and without a live intake lease. These checks run under the same workspace/row locks used by intake. Deletion first commits a durable `file_deletions` record, then attempts unlink; normal bounded retry and admin inspection apply. Referenced originals survive, and stale reservations can be removed safely. A reservation with no file is removed only after its lease has been expired for an additional hour. Filesystem errors fail the pass instead of treating an unreadable path as missing.

Nine focused tests include benign files for expired, recent, live-reservation, referenced, symlink and unrelated-name cases; an orphan beyond 110 ordinary originals is reached on the second pass. A no-file expired reservation is removed while an active one survives. Tests create no jobs and restrict reconciliation to their own workspace. This establishes the tested local transitions and forward progress, not a crash/load soak or backup erasure guarantee.
