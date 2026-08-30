# Conversions API payload preflight

Verified against the official OpenAI Conversions API and supported-events
documentation on 30 August 2026.

## Purpose

MaintainFlow can prepare server-side conversion batches before an eligible Ads
account, Pixel ID, or Conversions API key is available. The Readiness view
contains a local JSON preflight that checks the request body in browser memory;
it does not make a network request, accept credentials, or retain pasted values.

The app also contains a protected server-only seam for the first real provider
check. It accepts only a dry-run payload, repeats the static validation on the
server, and resolves the selected advertiser's active encrypted measurement
credential. An explicitly bound environment credential remains available only
as the legacy pilot fallback. No browser control calls this seam while the
required Irish Ads measurement credentials are unavailable.

This solves a distinct problem from the public landing-page audit. The page
audit can inspect static Measurement Pixel signals, while a server-to-server
Conversions API implementation cannot be discovered safely from public HTML.

## Documented request boundary

The eventual server request is:

```text
POST https://bzr.openai.com/v1/events?pid=<PIXEL-ID>
Authorization: Bearer <CONVERSIONS-API-KEY>
```

The Pixel ID is a query parameter and the Conversions API key belongs only in a
protected server-side header. Neither value belongs in the JSON body or the
MaintainFlow browser preflight.

For a first controlled integration test, the JSON body should include
`validate_only: true`. OpenAI documents this as schema validation without saving
the submitted events.

## Protected validate-only seam

`POST /api/measurements/conversions/validate-only` requires:

- a secure same-origin request in production;
- an authenticated Clerk operator;
- database-backed write access to the exact advertiser account;
- a JSON request no larger than MaintainFlow's local 1 MB safety cap plus its
  small account wrapper;
- `MAINTAINFLOW_RELEASE_STAGE=private_read` or `live_write`;
- `OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED=true`;
- an active purpose-bound Pixel/CAPI ciphertext for that account; or, for the
  single server-managed fallback, an exact `OPENAI_CONVERSIONS_ACCOUNT_ID`
  match plus `OPENAI_CONVERSIONS_PIXEL_ID` and
  `OPENAI_CONVERSIONS_API_KEY`.

The server forces `integration_source: "maintainflow"`, refuses a missing or
false `validate_only`, uses a fixed `bzr.openai.com` origin, applies a 15-second
timeout, and never retries an unconfirmed request. It does not parse, store, or
return OpenAI's response body because the current documentation does not define
a stable response schema.

The result contains only the mode, event count, and provider HTTP status. Error
responses contain only static messages, aggregate blocker counts, or the
provider status; event IDs, URLs, user values, hashes, Pixel IDs, and credentials
are never echoed.

## Per-account connection and rotation

`POST /api/connections/openai-conversions/:accountId` accepts a candidate Pixel
ID, Conversions API key, and documented dry-run payload. It requires the same
secure origin, identity, database write role, global validation switch, and
request-size controls as the validation route.

MaintainFlow checks that the encrypted store is ready before contacting OpenAI.
It then sends the candidate pair with `validate_only: true`; only a provider 2xx
allows the pair to be encrypted and rotated into the selected account. A local
schema blocker, provider rejection, timeout, or lost connection leaves the
previous active credential untouched.

Migration `010` stores one active credential version per advertiser account and
retains revoked versions, validation time, operator, acting organization, and
direct-advertiser or agency roles. It also retains only the provider 2xx status
and event count as bounded validation evidence, never the event payload.
AES-256-GCM additional authenticated data
binds each ciphertext to its credential ID, external account ID, provider
purpose, and key version, preventing cross-account or Ads-key substitution.

The provider dry run verifies that the supplied Pixel/key pair is accepted for
that request. The current response does not independently prove which Ads
account owns the Pixel, so MaintainFlow records the authorized operator's
selected account binding and still requires Ads Manager confirmation during the
first real setup.

## Workspace status and connection UI

The Workspace view projects a deliberately small status object for the selected
advertiser. It can report preview, unavailable, not connected, environment
fallback, or encrypted-vault state together with the credential version,
validation time, provider HTTP status, and event count when those values exist.
It never serializes the Pixel ID, CAPI key, ciphertext, initialization vector,
authentication tag, or dry-run event payload.

The connection dialog is enabled only for a ready signed-in workspace with
write access, a usable encrypted store, and
an account-backed release stage with
`OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED=true`. The browser repeats the local
privacy/schema audit before submitting the candidate pair and a
`validate_only: true` batch to the protected account route. Closing or
successfully completing the dialog clears the client-held credential fields;
the UI never redisplays a stored secret.

In demo mode the same card remains visible as an honest preview, reports that
dry runs are paused, and disables the connection action. A retained provider
2xx is labelled only as dry-run acceptance; the UI still withholds claims about
Pixel ownership, Ads Manager visibility, saved events, matching, attribution,
or production delivery.

## Static checks

The local validator currently checks:

- a top-level JSON object with only the documented batch fields;
- `validate_only` type and the safer first-request value of `true`;
- optional `integration_source` format and lowercase normalization;
- a batch of 1–1,000 events;
- non-empty event IDs and repeated event-name-plus-ID pairs;
- the 13 documented standard event types plus `custom`;
- integer millisecond timestamps within the previous seven days and no more
  than ten minutes in the future;
- custom event naming rules and canonical lowercase form;
- action-source values, `mobile_app` for app lifecycle events, and complete
  source URLs for web events;
- the required event-specific `customer_action`, `contents`,
  `plan_enrollment`, or `custom` data type;
- integer monetary values in minor units and three-letter currency formatting;
- content item, plan identifier, opt-out, attribution-reference, and variant
  dictionary shapes;
- lowercase 64-character SHA-256 user identifiers, user matching list limits,
  country/postal/location formats, GAID UUID format, and basic IP formatting;
- credential-like fields anywhere a documented or first-level custom field is
  inspected;
- MaintainFlow local-processing safety limits of 50,000 inspected validation
  steps and 200 diagnostics per payload.

Unknown first-level fields remain valid inside `data.type: "custom"`, because
custom event payloads need application-specific attributes. Credential-like
field names are still blocked there.

## Privacy and evidence boundary

The input is capped locally at 1 MB. MaintainFlow also stops after 50,000
inspected validation steps or 200 diagnostics, retains only bounded and
privacy-safe partial audit facts, adds a `payload_complexity` blocker, and
reports zero ready events. These byte, work, and diagnostic caps are
MaintainFlow safety limits, not OpenAI limits. The current
OpenAI documentation separately specifies at most 1,000 events. The audit
result contains only issue categories, documented field paths, severity counts,
event positions, and event-type counts; it never contains event IDs, URLs,
hashes, `oppref` values, user values, or credential values.

A clean local result means only that the body is ready for a real OpenAI
`validate_only` request under the documentation snapshot above. It does not
prove event receipt, deduplication, user matching, consent compliance,
attribution, Ads Manager acceptance, optimization, campaign delivery, or
billing. OpenAI's response and Ads Manager remain authoritative.

A 2xx response from the protected seam adds only one piece of evidence: the
provider endpoint accepted that exact dry-run request at that time. It still
does not prove a saved event, Ads Manager visibility, user matching, attribution,
or an operational production event pipeline.

## Official sources

- [Conversions API](https://developers.openai.com/ads/conversions-api)
- [Supported Events](https://developers.openai.com/ads/supported-events)
