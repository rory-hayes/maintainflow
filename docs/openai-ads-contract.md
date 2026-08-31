# OpenAI Ads API contract

Verified against the official OpenAI Ads documentation on 31 August 2026.

## Authentication boundary

- Base URL: `https://api.ads.openai.com/v1`
- Header: `Authorization: Bearer $OPENAI_ADS_API_KEY`
- Keys are issued in OpenAI Ads Manager, not the standard OpenAI API Platform.
- Advertiser API keys are scoped to one ad account. Shared partner keys and
  OAuth access tokens select the client account with `OpenAI-Ad-Account`;
  advertiser keys may omit that header, and any supplied value must match their
  authorized account.
- MaintainFlow keeps every credential in a server-side secret manager.
- MaintainFlow never exposes a key through a `NEXT_PUBLIC_` variable or returns
  it to a client component. A signed-in customer may submit a key once through a
  secure same-origin form; the server validates and encrypts it before storage.

The server transport models account API keys, shared API keys, and OAuth access
tokens as separate credential types. It sends `OpenAI-Ad-Account` for scoped
credentials, rejects a credential/header account mismatch locally, supports the
documented `GET`, `POST`, `PATCH`, and `DELETE` methods plus JSON or multipart
bodies, and can attach a validated `Idempotency-Key` to the operations that
document it. The current customer connection flow still accepts only an
account-scoped Ads Manager key; OAuth/shared-key onboarding is foundation code,
not a live-tested customer feature.

The OpenAPI document does not define a universal provider error body. The read
adapter therefore exposes the HTTP status and optional `Retry-After` value but
keeps any unknown error payload opaque; it does not assume an invented
`error.code` or `error.message` contract.

## Resource hierarchy used by the MVP

```text
Ad account
└── Campaign
    └── Ad group
        └── Ad
```

Campaigns hold daily and/or lifetime spend limits, objective, dates, and targeting. Ad
groups hold context hints and the bid configuration. Ads hold the complete
creative, review details, appeal state, and optional serving issues.

A campaign with `mode: product_feed` also references the linked
`product_feed_id`. The official Product Feeds guide says feed connections and
full-catalogue transfer use Ads Manager/SFTP and are not available through the
public Advertiser API, while OpenAPI 2.3.0 exposes create/list and SFTP-access
operations. MaintainFlow therefore treats all of those conflicting operations
as capability-gated and unverified; it must not expose them until an eligible
real account and clarified official documentation confirm access. Delta product
updates are documented separately and are also enabled per ad account.

## Read model

| MaintainFlow view | Official endpoint | Important fields |
| --- | --- | --- |
| Account connection | `GET /ad_account` | `id`, `name`, `url`, `timezone`, `currency_code`, `review.status` |
| Campaign list | `GET /campaigns` | `status`, `bidding_type`, `mode`, `product_feed_id`, daily/lifetime budget |
| Ad group review | `GET /ad_groups?campaign_id=...` | `context_hints`, billing event, max bid, custom-audience multipliers |
| Creative review | `GET /ads?ad_group_id=...` | full `creative`, `status`, `review_status`, `review.reason`, `appeal`, optional `serving_issues` |
| Conversion setup | `GET /conversions/event_settings` | event type, 30-day attribution, source, archived state, version |
| Delivery evidence | `GET /ad_account/insights` | `impressions`, `clicks`, `spend`, `ctr`, `cpc`, `cpm` |
| Conversion evidence | `POST /conversions/insights` | `conversions`, `click_through_conversions`, `view_through_conversions` |

CPA and post-click conversion rate must be calculated from click-attributed
conversions. View-through conversions remain a separate reporting metric and
must not be included in CPA or bidding decisions.

Account, campaign, ad-group, ad-creative, and insight responses are
schema-validated before use. Campaigns, ad groups, ads, and insights consume
every documented cursor page with repeated-cursor and page-count safety limits;
partial pagination is rejected rather than shown as a complete account. Read
requests have a 15-second timeout, and the already verified account response is
reused during the full sync. One request-scoped budget caps a sync at 256
provider attempts, 10,000 returned resources, five concurrent requests, and a
45-second wall-clock deadline across the complete provider sync.
Each successful JSON response is streamed through a 16 MiB byte limit before
schema validation; both declared and chunked oversized bodies are cancelled and
discarded. Provider error bodies remain unread and opaque.
Safe `429` retries honour bounded `Retry-After` metadata; mutations and
timeouts are never retried. A failure in any required dataset aborts the sync,
so no partially assembled live account is returned or cached across requests.

The current ad response includes a required `review` object with `status` and
optional provider-supplied `reason` and `screenshot_url`; ads may also include
an `appeal` and requested `serving_issues`. MaintainFlow may surface those exact
provider values and keep rejected or in-review creatives on a watchlist, but it
must not invent a rejection diagnosis, imply that serving issues were requested
when they were not, or present a provider-review override. Unknown future reason
and issue codes must be preserved for review rather than silently discarded.
The first successful live sync establishes an account-scoped baseline from the
documented ad `updated_at`, `status`, and `review_status` fields. Later syncs
append a durable event only when review or delivery state changes; an older
`updated_at` snapshot cannot replace newer stored state.

`npm run test:ads-contract` runs the complete live-read adapter against an
in-process Ads API contract simulator. It asserts the production base URL,
Bearer header, resource hierarchy, list limits, insight field projections,
JSON-encoded time ranges, conversion POST bodies, and documented response
schemas without requiring or exposing a real advertiser key. This is local
contract evidence, not proof that an advertiser account can connect to OpenAI.
The simulator also follows the documented encoding distinction: delivery
insight query ranges use numeric Unix bounds, while the conversion-insights POST
example uses string Unix bounds inside each JSON-encoded range string.

`npm run check:openai-ads-contract` separately downloads the official OpenAPI
document and compares it with the reviewed manifest in
`docs/openai-ads/contract-manifest.json`. The version, checksum, base URL,
operation coverage, auth headers, idempotency surface, OAuth scopes, response
codes, and selected schemas must be reviewed before upstream drift is accepted;
this check is not imported by application runtime.

## Write model and safeguards

OpenAI documents core campaign, ad-group, and ad updates as `POST`. The separate
Delta Feeds product-update operation uses `PATCH` and remains capability-gated.

- Campaign: `POST /campaigns/{campaign_id}`. If `budget` is included, send the
  full budget object. The documented writable budget supports daily and lifetime
  spend limits.
- Ad group: `POST /ad_groups/{ad_group_id}`. If `bidding_config` is included,
  send the full bidding object. For conversion campaigns, billing is `click` and
  `max_bid_micros` represents the CPA bid. MaintainFlow also preserves the
  documented `custom_audience_bid_multipliers` array and validates each
  multiplier before any write.
- Ad: `POST /ads/{ad_id}`. If `creative` is included, send the full creative
  object. An edited ad can return to review.
- Reversible state actions use `POST /{resource}/{id}/activate` and
  `POST /{resource}/{id}/pause`.
- Archive is intentionally excluded from the MVP because OpenAI documents it as
  irreversible.

Every MaintainFlow recommendation therefore stores:

1. the evidence window and derived metric;
2. the exact resource ID and request payload;
3. a complete rollback request;
4. a human approval record;
5. a monitoring window and explicit rollback condition.

For the first live bid rule, the monitoring plan stores the exact Insights Unix
range, spend, click-attributed conversion count, derived CPA, configured
`max_bid_micros`, currency, seven-day duration, and 15% conversion-decline
rollback threshold. View-through conversions are deliberately excluded. A
confirmed or manually reconciled apply starts at the next full UTC hour. A later
live sync reads the same seven-day duration from the scoped ad-group Insights
endpoint and conversion Insights, then persists one result. Missing rows remain
insufficient evidence. A strict breach is shown as human rollback review; the
evaluation path never sends a mutation or claims an automatic rollback.

Only one active or unresolved approval may exist for the same account,
recommendation, and entity. Pending, applied, reconciliation-required,
rollback-pending, rollback-failed, and rollback-reconciliation-required records
suppress the recommendation and are protected by a PostgreSQL partial unique
index before the external request is sent.

## Demo-to-live switch

The server adapter validates supported request and response bodies with Zod.
Live reads and live writes are separate release gates:

```text
OPENAI_ADS_API_KEY=<account-scoped secret>
MAINTAINFLOW_RELEASE_STAGE=live_write
OPENAI_ADS_DATA_MODE=live
OPENAI_ADS_LIVE_WRITES_ENABLED=true
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<public Clerk key>
CLERK_SECRET_KEY=<server Clerk key>
MAINTAINFLOW_APP_ORIGIN=<canonical public HTTPS origin>
MAINTAINFLOW_ADMISSION_MODE=private_beta
MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS=<approved Clerk user IDs>
MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS=<initial account-claim operators>
DATABASE_URL=<PostgreSQL connection string>
MAINTAINFLOW_CREDENTIAL_KEYRING=<JSON key-id to base64 32-byte key map>
MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID=<active key id>
CRON_SECRET=<server-only scheduled monitoring bearer secret>
```

`OPENAI_ADS_DATA_MODE=live` first verifies the account, campaigns, ad groups,
ads, delivery insights, and click-attributed conversions. If that sync fails,
the connected workspace shows no live metrics or recommendations, retains its
account identity for credential recovery, and disables writes; it never
substitutes demo fixtures under a real advertiser name. The final
write flag only applies to recommendations generated from live resource IDs and
is not sufficient by itself. MaintainFlow also requires an authenticated
operator with database-backed organization/account access and verified approval
and tenancy migrations. The bootstrap operator list only controls the first
unclaimed account connection; it does not grant ongoing access. Demo IDs can
never be sent to the Ads API.

Before a live request, MaintainFlow stores the exact request, rollback payload,
evidence, safeguard, account, operator, and recommendation in PostgreSQL. An HTTP
4xx rejection is recorded as failed. A network error, timeout, HTTP 408, or 5xx
response is marked `reconciliation_required` because the provider may have
committed the non-idempotent request before the response became uncertain.
Applied records retain an exact account-scoped rollback request. The rollback is
claimed atomically before it is sent; uncertain rollback outcomes are marked
`rollback_reconciliation_required`, and an operator must verify Ads Manager and
record the result with a reconciliation note rather than resend automatically.

A documented HTTP `200` is necessary but not sufficient for an applied state.
MaintainFlow parses the campaign, ad-group, or ad acknowledgement through its
official resource schema, verifies the resource ID, then performs the matching
account-scoped detail GET with the same credential. The readback must contain
the requested fields, or the requested active/paused state for an action. An
invalid acknowledgement, unexpected success status, failed readback, or state
mismatch becomes reconciliation-required because the non-idempotent write may
already have taken effect; the mutation is never retried automatically.
Mutation and rollback acknowledgements have a stricter 1 MiB streamed response
limit. If that body is oversized or cannot be safely read after the request was
sent, MaintainFlow stores no response body, marks the operation for manual
reconciliation, and preserves the must-not-retry rule.

Completed monitoring does not depend on a browser refresh. The protected daily
scheduler resolves each selected advertiser's credential independently, claims
due rows with a recoverable lease, and persists only observations. It never
sends an Ads mutation or automatic rollback.

The first live recommendation rule is deliberately narrow: for active
conversion campaigns, compare click-attributed CPA with the ad group's
documented CPA bid (`bidding_config.max_bid_micros`). A 20% bid reduction is only
prepared when CPA is at least 20% above that bid and at least three conversions
exist in a trailing seven-full-day measurement window. The campaign must also
reference an unarchived event setting returned by the account, with the current
30-day attribution contract and exactly one conversion source. If event settings
cannot be verified, the account can remain readable but the bid recommendation
fails closed. Campaign reporting stays month to date, so dashboard presentation
and comparable safeguard evidence are not conflated.

The current conversion-setup contract requires a 30-day attribution window.
MaintainFlow therefore labels the seven-day result as a directional safeguard,
not causal lift or an incrementality result.

## Website measurement boundary

The Measurement Pixel and Conversions API use the measurement hosts documented
by OpenAI rather than `api.ads.openai.com`. The browser SDK loads from
`https://bzrcdn.openai.com/sdk/oaiq.min.js`; browser and image-tag events use
`https://bzr.openai.com`, while server events use
`POST https://bzr.openai.com/v1/events?pid=...` with a separate Conversions API
key.

MaintainFlow's public storefront audit only inspects returned HTML and CSP for
the documented static installation signals. It does not run the SDK, fire an
event, read or return a Pixel ID, or infer that a server-side Conversions API
request exists.

The separate Conversions API preflight parses request-body JSON locally in the
browser. It checks the documented batch, timestamp, event, data, and user-field
contract, but accepts neither a Pixel ID nor a key and makes no request.

MaintainFlow now also has a disabled-by-default server transport for the first
controlled `validate_only: true` test. It requires authenticated account write
access and resolves the selected account's purpose-bound encrypted Pixel/CAPI
pair, uses the separately issued Conversions API key and Pixel ID, fixes the
destination to `bzr.openai.com`, and overwrites the integration source with
`maintainflow`. Missing configuration, account mismatch, a non-dry-run body, or
any local schema blocker prevents the network request.

The transport treats only a 2xx HTTP status as provider acceptance and ignores
the undocumented response body. A timeout or network error is unconfirmed and
is never retried automatically. A successful dry run is not event receipt,
Ads Manager visibility, matching, deduplication, attribution, or a production
event pipeline; those still require real account evidence.

The connection route validates a candidate pair before encrypting it. Rotation
uses a short PostgreSQL transaction after the provider call, keeps exactly one
active version per advertiser account, and rolls revocation back if the
replacement insert fails. Direct-advertiser and agency actor roles are retained;
no provider credential or event value is returned to the client.

For a shared deployment, each authorized account read resolves its own active
vault credential after database authorization. `GET /ad_account` must return
the selected external account ID before MaintainFlow accepts live data or sends
a mutation. Credential replacement uses the same verification and retains the
old version unless the encrypted replacement transaction succeeds.

## Official sources

- [Advertiser API overview](https://developers.openai.com/ads/api-overview)
- [Authentication](https://developers.openai.com/ads/api-reference/authentication)
- [API partner setup](https://developers.openai.com/ads/api-partner-setup)
- [Campaigns](https://developers.openai.com/ads/api-reference/campaigns)
- [Ad groups](https://developers.openai.com/ads/api-reference/ad-groups)
- [Ads](https://developers.openai.com/ads/api-reference/ads)
- [Insights](https://developers.openai.com/ads/api-reference/insights)
- [Product feeds](https://developers.openai.com/ads/product-feeds)
- [Delta Feeds API](https://developers.openai.com/ads/delta-feeds)
- [Stable product feed specification](https://developers.openai.com/commerce/specs/file-upload/products)
- [Measurement Pixel](https://developers.openai.com/ads/measurement-pixel)
- [Image Tag](https://developers.openai.com/ads/image-tag)
- [Conversions API](https://developers.openai.com/ads/conversions-api)
- [Supported Events](https://developers.openai.com/ads/supported-events)
