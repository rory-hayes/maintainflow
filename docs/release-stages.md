# MaintainFlow release stages

MaintainFlow has three explicit release stages. A stage describes what the
deployed product is allowed to prove; it is not inferred from whether an API key
happens to be present.

## `demo`

This is the account-free stage available today. The application uses bounded,
labelled fixtures and the stateful local provider simulator, keeps all OpenAI
Ads and Conversions API writes disabled, and must never label simulated results
as advertiser delivery evidence.

The demo can be used to validate the complete customer journey, responsive UI,
recommendation review, approvals, rollback planning, monitoring presentation,
storefront readiness, product-feed checks, event-payload preflight, and report
export. It cannot validate OpenAI authentication, account permissions, live
delivery data, attribution, or external write acceptance.

A deployed production demo still exposes the public readiness scanner and legal
pages. It therefore requires an identified legal entity, monitored privacy and
support contacts, PostgreSQL with `sslmode=verify-full`, a strong readiness
quota secret, and closed workspace admission. It does not require Clerk, an Ads
credential, the credential vault, or the monitoring cron secret.

## `private_read`

This is the first account-backed pilot stage. It requires Clerk, PostgreSQL over
TLS, the encrypted credential keyring, strong job and quota secrets, private-beta
admission, and live Ads reads; the global live-write switch must remain off.

The customer's account-scoped Ads key is connected through the protected vault
flow. The first-account acceptance suite then verifies account identity,
hierarchy, pagination, and insights without mutating the account.

## `live_write`

This is the controlled mutation stage after the read-only acceptance gates pass.
It has the same identity, tenancy, storage, encryption, and admission requirements
as `private_read`, plus the explicit live-write flag.

Every mutation still requires an eligible live recommendation, an authorized
human approval, a persisted rollback payload, an idempotency key where the Ads
contract supports it, exact response validation, and a canonical readback before
MaintainFlow calls the change confirmed. Ambiguous outcomes enter reconciliation
and are never retried automatically.

## Deployment check

Set `MAINTAINFLOW_RELEASE_STAGE` and run:

```bash
npm run check:production-config
```

The checker fails closed when the selected stage is missing required boundaries
or enables a capability that the stage must not allow. It validates configuration
shape only: it does not prove that Clerk, PostgreSQL, a scheduled job, OpenAI Ads,
or a public deployment is reachable.

Vercel production builds always run the gate. A preview remains
secret-independent only when it is a strict demo; declaring a non-demo stage,
live provider access, external writes, Conversions contact, open admission, or
public sign-up makes the preview run the full gate before build.

`npm run build` records a SHA-256 digest of the Clerk-related `NEXT_PUBLIC_`
values in non-secret build metadata. `npm start` and the standalone container
compare the runtime public configuration with that digest before loading the
server, so a build cannot silently start against a different Clerk tenant or
auth-route configuration.

The OpenAI Ads key is deliberately not a global deployment requirement. Each
pilot customer can connect an account-scoped key into the encrypted vault when
OpenAI makes the account and credential available.
