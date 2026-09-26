# Google Drive → n8n → MaintainFlow

This recipe imports ordinary files from one Google Drive folder into an **existing MaintainFlow parser**, then waits for its current processing result. Review and approval stay in MaintainFlow. It uses the existing scoped API, private storage, processing jobs, duplicate protection and page accounting. It is an automation recipe, not a native marketplace connector or another account system.

Import [`google-drive-n8n.workflow.json`](../examples/automations/google-drive-n8n.workflow.json) into n8n. The file is inactive, has no credentials or pinned customer data, and targets n8n **2.40.7**. Its [generator and shared guards](../examples/automations/source-intake/google-drive-n8n.mjs) keep the downloadable graph and the tested validation logic together.

## Setup

1. Choose an existing ready parser in MaintainFlow. Bank-statement users should use the bank-statement setup in the app; this recipe does not create a parser or define fields. Record its UUID from the parser URL.
2. Import the JSON into n8n. Keep it inactive while configuring and testing it.
3. In **Drive file created**, **Drive file updated**, and **Configure import**, set the same owned folder ID. In **Configure import**, replace `REPLACE_WITH_EXISTING_PARSER_UUID` with the existing parser UUID. Keep the API origin `https://maintainflow.io`.
4. Select the same stored Google Drive credential in both triggers, both **Read/Recheck Drive metadata** nodes, and **Download Drive bytes**. The workflow reads files; the credential's actual granted permissions are determined by your Google/n8n setup.
5. Select a stored **Header Auth** credential in **Upload to MaintainFlow** and **Read document and jobs**. The header name is `Authorization`; its value is `Bearer ` followed by an existing MaintainFlow API key for the intended workspace. This workflow needs `documents:write` and `documents:read`. Keep the key in the credential store, never in the JSON, Code nodes or trigger data.
6. Test with a clearly labelled synthetic file placed directly in the folder. Inspect the final **Review receipt**, follow its document link, and compare the original with the extracted result in MaintainFlow. Approve only after review. Repeating the same file version should resolve the existing document without another page charge.
7. Activate the workflow only after checking its account-specific execution history and the resulting MaintainFlow document. Observe both a new file and an updated file, failure recovery and credential revocation before treating the account connection as accepted.

n8n provides native [Drive download operations](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.googledrive/file-operations/) and [HTTP multipart binary fields](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/). The recipe submits actual downloaded bytes in the `file` part, not a Drive link.

## Inputs and limits

| Item | Behaviour |
| --- | --- |
| Source | Ordinary stored files directly inside one folder; new and updated file events |
| Recipe size | **4 MiB per file**, leaving space for multipart framing below the hosted request limit; use MaintainFlow's upload screen for larger files within its own limits |
| Formats | PDF, PNG, JPEG, TIFF, TXT, EML, CSV, XLSX, DOCX and HTML with a recognized matching filename extension and MIME type; actual decoding and parser policy remain enforced by MaintainFlow |
| Google-native content | Google Docs, Sheets and Slides need a separate export workflow; folders, shortcuts and ZIP archives are not processed by this recipe |
| Processing limits | Existing parser policy, workspace page allowance, file/page limits and processing concurrency still apply |
| Bank locale | The existing bank parser's configured locale applies; the recipe does not override it per file |
| Polling | At most 60 document reads, with five-second waits; no new read starts after ten minutes. An in-flight read retains its 30-second request timeout. Network errors stop the execution |
| Output | Source file/version, verified byte count/checksum, idempotency key, document/job/run identities, current status and review link; no automatic approval or export |

The triggers do not backfill existing files, traverse subfolders or capture every intermediate historical version. They import the current stable downloadable version when processing an event. Two trigger observations of the same version are safe to replay, but the watcher is not a durable import queue.

## Identity, duplicates and changing files

Before download, the recipe requires the configured file and folder, permission to download, a supported binary format, a size and a version/checksum. After download it verifies the actual byte length and MD5 checksum, then rereads metadata. A changed name, version, checksum, size, location or download permission stops the import before upload. Google's file resource supplies the [version, checksum and download metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files); the version remains text, including values too large for a JavaScript number.

The intake key is `gd:<parser UUID>:<Drive file ID>:v<Drive version>`. Including the parser matters because MaintainFlow's intake keys are workspace-wide. A duplicate event or a lost upload response is retried with the **same parser, file version, bytes and key**. Do not replace the key just to make a failed request succeed.

MaintainFlow separately protects against identical content. A renamed file or newer metadata version with unchanged bytes can return an earlier document with its original name. The receipt preserves the current Drive filename separately. Legitimate different files are not deleted, merged by transaction contents or autoapproved by this recipe.

## Processing and failures

HTTP 202 proves intake acceptance, not extraction completion. A repeated upload can return `jobId: null`; the recipe reads the returned document and its current jobs. An active reprocess takes precedence over an older successful run. A failed current document is reported as failed even when older results still exist. Only a current result tied to a completed job produces a review receipt.

| Failure | Next action |
| --- | --- |
| Source changed while downloading | Restart from source metadata after the file stops changing; nothing was uploaded by that attempt |
| Decoder busy or transient request failure | Inspect the prior execution, then retry the same source version and key; do not change the file to force a new event |
| Quota/rate limit | Check the actual allowance or wait for the documented transient limit before retrying; an account upgrade is not performed automatically |
| Unknown upload outcome | Inspect MaintainFlow before retrying; preserve the original source version and key to recover an accepted request |
| HTTP 409 | Inspect the conflicting source key and bytes; do not invent a replacement key |
| HTTP 410 | The imported document was deleted and its intake receipt remains; the recipe does not silently recreate it |
| Waiting for parser fields | Complete the existing parser setup; do not upload again to create another job |
| Extraction failed | Open the document for its failure reason and any deliberate retry; this recipe never reprocesses automatically |
| Polling stopped | Processing may continue in MaintainFlow; inspect that existing document before restarting |
| Credential/permission failure | Check the selected credentials, key scopes and intended workspace/folder |

A failure stops the current n8n execution, including any later files in that trigger batch. Inspect its remaining input items and explicitly retry/reconcile them; the next scheduled trigger is not proof they were imported. Replaying the execution with unchanged source versions relies on the same durable API duplicate protection. Keep automatic node retries disabled unless their byte/version binding has been separately verified.

## Verification boundaries

On 26 September, **16/16 native n8n scenarios**, **12/12 focused real-API/outbound-regression tests** (including five new source-recipe cases), **11/11 recipe tests** and TypeScript checks passed. The final native run used unchanged workflow/generator/fixture hashes; all owned containers, network resources and synthetic keys were removed. [Dated source hashes, scenario results and limitations](evidence/source-intake-2026-09-26/verification.json).

The clearly labelled [source fixture](../fixtures/automations/google-drive-intake-source.json) and [response fixture](../fixtures/automations/google-drive-intake-results.json) contain invented data. The pure guards and generated graph are checked in [`source-intake-recipe.test.ts`](../tests/source-intake-recipe.test.ts). [`source-intake-api.test.ts`](../tests/source-intake-api.test.ts) exercises the real MaintainFlow API with owned local workspaces: concurrent retries, exact byte preservation, changed-version/content duplication, quota, key permissions, workspace isolation, stale results and deleted-file receipts.

[`verify-source-intake-n8n.mjs`](../scripts/verify-source-intake-n8n.mjs) imports and executes the graph in the pinned real n8n Docker image. It uses a temporary internal-only network, synthetic credentials and local TLS fixtures for Google Drive and MaintainFlow. The graph's actual native download, Crypto, HTTP, Code, branching and loop nodes run. Only the two external polling triggers are replaced with a manual seed and the five-second waits are shortened for the test. The source/byte guards and upload/polling logic remain unchanged.

Run from this checkout with Node 24 and the pinned image already present:

```sh
node --import tsx --test tests/source-intake-recipe.test.ts
node scripts/verify-source-intake-n8n.mjs --plan
node scripts/verify-source-intake-n8n.mjs --execute
```

Run the API tests only in the documented disposable database/CI environment; their guard refuses the normal shared local database. Engine receipts are written beneath `.local/source-intake-n8n/`, and only containers/network resources carrying that run's ownership label are removed. No existing n8n instance, Google account, hosted MaintainFlow data or payment setting is changed.

Controlled execution proves the tested graph and API behaviour. Real Google consent, scheduled trigger delivery, customer files, credential expiry/revocation and a user's n8n deployment remain separate acceptance steps. Dropbox, OneDrive and SharePoint source recipes remain open. This recipe adds no general extraction-accuracy or native-connector claim.
