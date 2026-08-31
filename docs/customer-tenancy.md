# Customer tenancy and advertiser access

MaintainFlow models the buyer and the advertiser account separately so the same
MVP can serve a direct advertiser or an agency managing a client.

## Authorization model

```text
Clerk user
└── organization membership: owner | admin | analyst
    └── advertiser-account access: owner | manager | viewer
```

- A direct advertiser workspace normally receives `owner` account access.
- An agency workspace normally receives `manager` account access.
- Read access requires an active membership and any active account role.
- Apply, rollback, and reconciliation require an `owner` or `admin` membership
  plus `owner` or `manager` account access.
- Every live approval records the acting organization and both roles.

The account ID is taken from `GET /ad_account` using the server-held,
account-scoped Ads key. It is never accepted from a browser request as proof of
authorization.

## Initial workspace claim

The first claim is deliberately fail-closed. A signed-in customer supplies the
account-scoped client key, the server verifies it with `GET /ad_account`, and the
external Ads account must not already exist. An existing account can never be
silently claimed by a second workspace; an owner-managed invitation flow is
required for that future case.

Workspace creation also has an explicit admission gate. Keep
`MAINTAINFLOW_ADMISSION_MODE=private_beta` and list approved Clerk user IDs in
`MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS` while pilots are manually contracted.
Setting the mode to `open` permits any authenticated user with a valid,
unclaimed account key to create a workspace and must wait for paid entitlement,
support, abuse-control, and offboarding gates.

`MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS` remains a narrower compatibility path for
the server-managed pilot key. It is not required when a signed-in customer
supplies and validates the key for their own unclaimed account.

## Additional agency client accounts

An active agency owner or admin can connect another client from the Workspace
screen. The browser sends only the account-scoped advertiser key to
`POST /api/organizations/{organizationId}/advertiser-accounts`; the server
checks agency authority before contacting OpenAI, derives the account ID and
name from `GET /ad_account`, encrypts the key, and checks authority again inside
the database transaction.

Account attachment is serialized by provider account identity. A retry for an
already-complete connection to the same agency returns the existing manager
access without replacing its stored credential. A direct-owned account, an
account managed by another agency, an incomplete prior connection, or an
offboarded identity returns a conflict and is never transferred or resurrected
automatically.

## Credential boundary

The one-time Workspace form sends a client key only to a secure same-origin
server route. The server validates the account before encrypting the key with
AES-256-GCM; ciphertext, a unique initialization vector, authentication tag,
and key-version identifier are stored in PostgreSQL. Plaintext is never written
to the database, returned to the browser, or included in application logs.

Authenticated data and mutation routes resolve the selected account's active
credential only after database authorization. The encryption additional data
binds ciphertext to its credential ID, external advertiser account ID, provider,
and key ID, preventing a stored blob from being replayed as another account.
Key rotation keeps the previous credential active unless the replacement first
validates to the same account and the replacement transaction succeeds.

Conversions API credentials are separate from Ads API credentials. A Pixel ID
and CAPI key are encrypted together with a distinct provider purpose and the
same external-account binding, then stored in migration `010` with their own
version history. Authorized direct-advertiser owners and agency managers can
replace a pair only after OpenAI accepts a `validate_only` request; rejected or
unconfirmed candidates never reach the database.

Unlike `GET /ad_account`, the documented CAPI response does not independently
return an advertiser account identity. The pair is therefore bound to the
operator's already-authorized selected account, and the first real setup still
requires confirmation in that account's Ads Manager.

The legacy `OPENAI_ADS_API_KEY` remains available for a single pilot account.
Shared deployments use `MAINTAINFLOW_CREDENTIAL_KEYRING` and
`MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID`; old key IDs must remain in the keyring
until their stored credentials have been rotated.
