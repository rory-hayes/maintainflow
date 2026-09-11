# Deploying the document application

The repository now contains a **container deployment candidate**, not a verified hosted deployment. The current application needs an HTTP server, a continuously supervised worker, PostgreSQL and durable private originals. Publishing `dist` alone does not supply those services.

## Deployment shape

`compose.yaml` defines four services:

| Service | Responsibility |
| --- | --- |
| `database` | Dedicated PostgreSQL 17 instance and persistent `database` volume. No database port is published on the host. |
| `migrate` | One-shot ordered migrations after PostgreSQL is healthy. API and worker wait for it to complete successfully. |
| `api` | Non-root Fastify process serving the frontend and `/api`, with a persistent `originals` volume. The host port is bound to loopback. |
| `worker` | Separately supervised extraction/integration/deletion/retention process using the same database, originals volume and encryption key. |

The image includes the locked Node dependencies, built frontend, server, schemas and migrations. `tsx` remains in the image because both the server and isolated decoder execute TypeScript. Local environment files, local database/files/secrets, Git metadata and recorded evidence are excluded from the build context. The runtime runs as `node`, with a read-only root, bounded temporary filesystem, no additional Linux capabilities and process/memory/CPU limits in Compose. Basic local container checks passed with those restrictions, but capacity and adversarial resource acceptance remain open; the decoder shares the service's OS identity and is **not** a separate security sandbox.

Use a maintained Linux container host and an HTTPS reverse proxy. It can serve the complete application at `https://maintainflow.io`, or provide a private-origin backend for Vercel's same-origin `/api/*` proxy while Vercel serves the frontend. Verify the latter proxy preserves cookies, `Origin`, streamed/multipart bodies and the application's 10 MB upload allowance. Do not route the upload through a Vercel Function: its documented 4.5 MB body limit is lower than the application contract. [Vercel function limits](https://vercel.com/docs/functions/limitations).

The existing Vercel project is intentionally held: `vercel.json` uses `scripts/vercel-release-hold.mjs` to cancel automatic Git builds, and a manual static-only build fails with an explanation. Replace that hold only after an accepted backend and routing configuration are ready. A Git push does not establish a new production deployment.

## Configure an empty, isolated installation

**Do not point these migrations at the legacy MaintainFlow Supabase database.** They create generic `public` tables and grant the `folio_app` role access to all tables in that schema before applying their explicit restrictions. An existing product database requires a separately designed, reviewed schema-isolation migration. This Compose stack instead starts a dedicated empty database and preserves the legacy backend unchanged.

1. Install a supported Docker Engine and Docker Compose v2 on the chosen host. No host or provider plan is provisioned by this repository.
2. Prepare a private environment file, retaining existing values if one already exists:

   ```sh
   mkdir -p .local
   cp -n deploy/production.env.example .local/deploy.env
   chmod 600 .local/deploy.env
   ```

3. Fill that file from a secret manager. Set the exact public HTTPS `APP_ORIGIN`; a local HTTP page cannot use the production secure session cookie. Generate distinct database passwords as 32 random bytes encoded in hex. Passwords must contain at least 32 URL-safe letters/digits/underscores/hyphens; the initializer rejects other characters and identical admin/app passwords. Use a fresh base64-encoded 32-byte `INTEGRATION_ENCRYPTION_KEY`. Keep that key stable and supply it to both API and worker. Production startup rejects missing/invalid keys; it never generates a fallback file key.
4. Set an immutable `MAINTAINFLOW_IMAGE_TAG` and the actual `MAINTAINFLOW_BUILD_SHA`. Fill only the provider settings whose accounts/callbacks are configured. Missing settings leave the relevant integration unavailable. Compose forces `FOLIO_BILLING_MOCK=false`; current Stripe support remains test-only and does not enable live charging.
5. Validate configuration without printing expanded secrets, then build and start:

   ```sh
   docker compose --env-file .local/deploy.env config --quiet
   docker compose --env-file .local/deploy.env build
   docker compose --env-file .local/deploy.env up -d
   docker compose --env-file .local/deploy.env ps
   ```

   The application is accessible only through the host's loopback port until the HTTPS proxy is configured. `/api/health` is **API process liveness only**. A healthy API container does not prove that jobs, private storage, migrations, external integrations or backups work.

The database initialization script runs only when the database volume is empty. Changing an environment password later does not rotate a stored PostgreSQL password. Use a coordinated database credential rotation; do not delete the database volume to repair authentication. Keep a failed first initialization private and investigate it before accepting traffic.

## Acceptance before switching the domain

- Identify the image/repository revision and confirm all migrations and the restricted `folio_app` role; verify tenant isolation against two populated workspaces.
- Create a fresh user through the HTTPS application. Verify the displayed plan and actual quota, sign-out/sign-in, account recovery/verification when implemented, invitation roles and session revocation.
- Upload native text/PDF and an AI image, observe a real worker run, compare original/results, correct and approve, then download CSV/XLSX/JSON. Test a file above 4.5 MB and below 10 MB through the final routing path.
- Restart API and worker. Confirm originals, approved revisions and usage remain available and an interrupted queued job resumes without duplicate records.
- Verify an original is denied to another workspace. Delete a document and confirm asynchronous private-file cleanup; verify configured retention and the associated backup erasure policy.
- Configure public provider callbacks and run actual Resend receiving, Google Sheets writes and Stripe test Checkout/webhook/portal lifecycle checks. Account credentials or a product catalog are not delivery evidence.
- Configure queue-age/failed-job monitoring, a worker heartbeat, dependency readiness, safe logs and alerts. The supplied worker has no health probe yet.
- Take an encrypted database backup plus a consistent originals backup and preserve the encryption key separately. Restore them on an isolated target and repeat account/document access checks. A Docker volume is not a backup.

## Rollback and operations

Keep the previous MaintainFlow repository revision and deployed version available while this replacement is accepted. Preserve its database and provider records separately. Switch the domain only after the above checks and a tested routing rollback are recorded.

For this application, retain immutable prior image tags and a database/files recovery point before migrations. Database changes are forward migrations; reverting the application image alone is not guaranteed to reverse or remain compatible with a migration. Plan a restore together with its corresponding originals and stable encryption key when necessary.

`docker compose down` stops/removes containers and the project network while retaining named volumes. **Do not use `down -v` or remove the database/originals volumes as routine deployment steps.** Single-host Compose is not high availability; host patching, off-host backups, TLS renewal, capacity, egress policy and restore ownership remain operating responsibilities.

## Verification of this packaging

On 11 September 2026, TypeScript checking, shell syntax, YAML parsing/deployment invariants and isolated production encryption-key startup/round-trip checks passed. The YAML check verifies API/worker volume sharing, private host binding, no published database port, disabled mock billing and migration ordering.

The existing Colima VM was subsequently started and the actual Docker image built. The initial build caught a TypeScript error in the new E2E runner, which was corrected. Initial container acceptance then found `GET /` returned 403 because the static directory disabled index serving; an explicit SPA root route and a temporary-dist production regression fixed it. Both failures remain preserved rather than replaced with a success-only record.

The corrected image `maintainflow-documents:qa-20260911`, ID `sha256:8ae3f985e7fb6873e5f4b61a5669e3dbc26f5465086263433e0d61fc7549523a`, passed bounded local container checks from **08:16:21 to 08:16:25 UTC**. They verified UID 1000, a read-only root, missing/invalid production-key rejection, encryption round-trip, private-volume write/read/delete with file mode 0600, native text/image decoder subprocess execution, absence of `.env`/`.local`/Git from the image, production API liveness and the served homepage. Temporary containers and the test volume were removed. [Container checks](evidence/production-packaging-2026-09-11/container-checks.json), [successful build](evidence/production-packaging-2026-09-11/docker-build-final.txt), [initial root-page failure](evidence/production-packaging-2026-09-11/container-checks-first.json).

**Docker Compose remains unavailable as a CLI plugin. No database container, Compose orchestration, real provider, hosted deployment or recovery exercise was tested in this pass.** The image is labelled as local packaging QA rather than a Git release SHA. The main task's dated readiness report records the repository and application E2E evidence separately.
