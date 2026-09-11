# Private originals and direct uploads

The filesystem remains the default. Hosted deployments select `STORAGE_DRIVER=supabase` and provide `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`) plus `SUPABASE_SERVICE_ROLE_KEY` only to the server. The adapter uses the fixed `folio-originals` bucket. Provision it with:

- `public: false`
- `file_size_limit: 10485760`
- `allowed_mime_types: ["application/octet-stream"]`

The adapter verifies the private flag and size cap before upload, download, or signing, caching that check for 60 seconds. The server never creates or changes buckets. Existing local originals are not migrated by changing the driver. The deployed database must reference objects that exist in its selected backend.

## Browser and API upload contract

`GET /api/uploads/config` reports `signed` or `multipart`; it requires an editor with `documents:write`. Local multipart intake remains available. Hosted clients should use the direct-upload contract to avoid the platform's request-body limit:

1. Compute the file's SHA-256 and call `POST /api/parsers/:id/uploads` with `{ "filename": "receipt.pdf", "size": 12345, "sha256": "<64 lowercase hex characters>" }`. The request must belong to the active parser's workspace. Declared size is bounded by 10 MiB and the workspace plan; exhausted page quota and excessive active/recent reservations are rejected before signing.
2. Upload the raw file with `PUT` to the returned `uploadUrl`, `Content-Type: application/octet-stream`, and `x-upsert: false`. Send no app cookies, workspace headers or provider credentials to that request.
3. Call `POST /api/uploads/:uploadId/finalize` with an empty JSON object. It requires the same user's current editor access and `documents:write` scope. Finalization must start within 15 minutes.

The server reads only the reserved UUID object, rejects declared or streamed bytes beyond 10 MiB, verifies exact length and SHA-256, and runs the existing isolated source decoder and actual page/quota checks. It writes the validated bytes to a different immutable original UUID; a browser capability can never modify the object read by extraction workers. A durable intake event prevents additional jobs or usage charges after retries or an interrupted response. Concurrent finalization uses a three-minute attempt lease.

Supabase signed-upload tokens last two hours and cannot be revoked through this application. The staging object and its database reservation remain tracked for **two hours and ten minutes** after reservation, including successful and failed uploads. This prevents an otherwise-valid token from recreating an untracked object immediately after cleanup. At most 20 pending uploads and 100 recent reservations, totaling at most 250 MiB of potential staging bytes (each unfinished or failed capability reserves the full 10 MiB maximum until cleanup), are admitted per workspace.

## Private reads and cleanup

`GET /api/documents/:id/original` checks current access and redirects to a 60-second signed download when remote storage is selected. Signed URLs request a sanitized attachment filename, and the redirect is private/no-store with no referrer. Local storage continues to return the original bytes directly.

`GET /api/documents/:id/original-url` provides the authorized URL for the React preview/download helper. The helper fetches remote bytes without credentials or workspace headers, avoiding a cross-origin redirect carrying application headers. Preview rendering still uses the original bytes and stored source MIME type.

Every server write commits an `intake_files` record before transport begins. Successful intake binds its immutable original to the document. Failed writes, including a lost acknowledgement after bytes were stored, remain in the deletion queue; uncertain writes receive a five-minute delay before automatic deletion. Crashed writes with expired intents are reconciled after an additional hour. Direct-upload staging uses its longer capability-expiry window. The remote reconciler uses bounded database batches and queues deletion rather than listing the whole bucket or running unbounded network cleanup. The hosted worker must run both reconciliation and `processOneFileDeletion`; metadata and queued deletion survive invocation failure.

These checks use application-owned UUID keys and a fixed provider endpoint. User-supplied object URLs and bucket names are not accepted. Service-role credentials never reach the browser. No public storage policy is needed.

## Verification boundary

The local controlled-provider suite covers authenticated reservation, tenant/viewer rejection, declared and actual limits, checksum mismatch, concurrent/replayed finalization, immutable copies, failed-write tracking, expired staging, original redirects and preserved filesystem retention. Actual hosted bucket permissions, browser upload/CORS, large-file intake, and object removal remain separate deployment acceptance checks.

Provider contracts were checked against [Supabase signed-upload documentation](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl), [uploading to a signed URL](https://supabase.com/docs/reference/javascript/file-buckets-uploadtosignedurl), and [signed downloads](https://supabase.com/docs/reference/javascript/file-buckets-createsignedurl).
