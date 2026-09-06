# MaintainCode Ads

MaintainCode Ads connects marketing-source evidence to form enquiries, CRM qualification and won deals. This code replaces the previous ad-operations product in `rory-hayes/maintainflow`; the user-owned production target is **https://maintainflow.io**.

The product scope and data contract are in [the product brief](docs/maintaincode-ads-product-brief.md). The [implementation guide](docs/maintaincode-ads-implementation.md) covers tracking, HubSpot, attribution rules, billing, retention and the remaining acceptance gates. Legacy ad-operations modules and tests remain as reusable internals; their old guides do not describe this release.

## Local development

```bash
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3217
```

Open `http://127.0.0.1:3217/app`. The labelled sample workspace needs no account. Real workspace creation requires authentication and PostgreSQL. The optional `MAINTAINCODE_LOCAL_TEST=1` development identity applies only to loopback development, never to a deployed build. Use it only with a disposable local database.

## Deployment configuration

Copy `.env.example` into the deployment secret manager, supplying actual values. Do not commit an environment file. This release uses a **new Supabase project** for authentication and PostgreSQL, while retaining the existing user-owned domain and GitHub repository.

- Set `MAINTAINCODE_APP_ORIGIN=https://maintainflow.io`, plus the new project's public Supabase URL and publishable key at build time and runtime. Never use a Supabase secret/service-role key as a public key.
- Enable public self-service admission. Configure the Supabase site URL and allowed auth redirects for the actual domain. Successful sign-up, email delivery, sign-in, recovery and sign-out need browser proof.
- Apply all migrations in `src/lib/database/migration-manifest.json` using a separate database administrator. Enable LOGIN/password on the `maintaincode_app` role created by migration 024 and grant database CONNECT. The runtime connection uses this role, never `postgres`, `service_role` or the legacy bypass-RLS role.
- Configure exactly one `sslmode=verify-full` parameter and the new project's authentic database root CA. On Supabase's pooler, the username is typically project-qualified (`maintaincode_app.PROJECT_REFERENCE`). Keep the credential keyring and independent readiness/maintenance secrets on the server.
- Configure HubSpot and OpenAI credentials inside the relevant workspace. They are encrypted server-side. Provider availability is separate from database readiness. Leave advertiser write and conversion-submit flags disabled.
- Configure Stripe test prices and signed webhooks before testing billing. Pricing, payment completion and cancellation remain unverified until exercised against the actual Stripe test account.

`npm run check:production-config` validates required settings without contacting providers. `npm run build` builds the tracker and Next.js artifact. `npm start` additionally checks that public auth settings match the browser build. The Docker entrypoint performs the same check. Vercel runs the new deployment gate before building; legacy ad-operations schedules have been removed.

Vercel schedules a daily GET to `/api/attribution/maintenance` at 02:15 UTC, authenticated with `CRON_SECRET`. Migration 025 registers every workspace in a durable queue. A run processes at most eight workspaces within a 210-second work budget; ten-minute leases prevent overlapping claims, and unfinished backlog remains queued. Retention runs for all workspaces; provider refresh runs only for active subscriptions or unexpired trials. The manual per-workspace POST remains available with the separate maintenance secret. Verify the actual hosted cron registration and execution after deployment; successful manual sync is not scheduled-run proof. See the implementation guide for capacity limits.

## Verification

```bash
npm run verify
npm run test:db
```

CI runs application/unit/provider-contract checks, a sample browser journey against a production build, and a production-container smoke against disposable TLS PostgreSQL. The sample browser checks do not prove authenticated or persistent user workflows. The PostgreSQL test command has its own disposable-database requirements documented in [database integration](docs/database-integration.md).

After deploying an exact committed revision:

```bash
MAINTAINCODE_PROBE_ORIGIN=https://maintainflow.io \
MAINTAINCODE_EXPECTED_BUILD_SHA=FULL_DEPLOYED_COMMIT_SHA \
MAINTAINFLOW_READINESS_PROBE_SECRET=SERVER_PROBE_SECRET \
npm run probe:deployment
```

Supply the probe secret through a secret manager or an already exported environment variable instead of shell history. `/api/health` identifies process liveness and the immutable compiled revision. The protected `/api/attribution/ready` separately verifies the runtime role, table privileges and required isolation policies; neither route contacts CRM, Ads or Stripe. The probe refuses stale revisions, redirects while handling a secret and local-only readiness as hosted proof. The manual hosted-smoke workflow runs the same read-only checks on maintainflow.io.

Release acceptance additionally requires the live-domain new-user journey, two populated workspaces with isolation checks, actual form-to-HubSpot delivery, provider sync, Stripe test lifecycle, scheduled maintenance and retention/deletion behavior. No build, screenshot or health check substitutes for those results.
