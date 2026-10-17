# Explicit Checkout policy catalogue

The normal `buildApp` now supplies a lazy Checkout policy reader. Capture stays disabled unless an operator explicitly selects a complete, versioned policy and pins every displayed field. No policy text, legal decision, provider eligibility, customer eligibility, publication, notification or canonical setting is supplied by this mechanism. Signup terms remain a separate mechanism.

## Configuration contract

All fields are server-only. This source change does not set them on any deployment.

| Variable | Required meaning |
| --- | --- |
| `FOLIO_CHECKOUT_POLICY_ENABLED` | Exact `true` opts in. Exact `false` explicitly disables capture and permits staging/withdrawal without parsing other fields. All four variables absent also disables capture. Any other flag value, or an omitted flag with nonempty catalogue/version/digest fields, fails closed. |
| `FOLIO_CHECKOUT_POLICY_CATALOGUE_JSON` | Strict JSON object with one `policies` array, containing 1–10 policy objects. Maximum 65,536 UTF-8 bytes before parsing. No other top-level or policy fields. Every entry must be valid; duplicate versions are rejected. |
| `FOLIO_CHECKOUT_POLICY_VERSION` | Exact version identifier of one catalogue entry, with no trimming, normalization, inference or fallback. |
| `FOLIO_CHECKOUT_POLICY_SHA256` | Lowercase 64-character SHA256 of the selected six-field canonical object below. This pins configured content; it does not prove operator adoption or legal approval. |

Each policy has exactly six string fields: `version`, `language`, `title`, `text`, `url`, `agreementText`. Their existing Checkout limits remain: version 80 characters, language 35 with language-tag syntax, title 160, text 16,000 UTF-16 units/60,000 UTF-8 bytes, URL 2048, agreement 1000. Configured content additionally rejects blank fields and unpaired surrogates. Text preserves literal whitespace/newlines; short fields reject tab/newline. URL must be HTTPS with no credentials or fragment. The final escaped Stripe agreement message must fit 1,200 characters; URLs with parentheses are escaped safely. Catalogue validation does not fetch the URL or prove its published content.

The digest is SHA256 over UTF-8 `JSON.stringify` of the following fixed field order, with the exact selected strings:

```js
{version, language, title, text, url, agreementText}
```

JSON whitespace/property order does not change this digest; any change to a displayed field does. The existing persisted contract `policy.sha256` remains the **text-only** digest for historical compatibility. Do not use that legacy text digest as the configuration pin.

There is no bundled/default policy or sample catalogue accepted as real content. To prepare a pin from an already selected operator catalogue, run this local calculation from the repository using its Node24 runtime; replace the path and version with the actual supplied values:

```sh
node --import tsx --input-type=module - /path/to/operator-catalogue.json selected-version <<'JS'
import {readFileSync} from 'node:fs';
import {validateCheckoutPolicy,checkoutPolicyConfigurationDigest} from './server/integrations/checkout-policy.ts';
const [file,version]=process.argv.slice(2);
const policy=JSON.parse(readFileSync(file,'utf8')).policies.find(p=>p.version===version);
validateCheckoutPolicy(policy);
console.log(checkoutPolicyConfigurationDigest(policy));
JS
```

This calculation reads only the provided policy file. It does not configure a deployment or validate the whole catalogue. The runtime reader validates the entire bounded catalogue and selection. Policy adoption, version-specific accessible publication, customer scope, receipts/confirmation and any other applicable operating facts must be supplied and tested separately.

## Failure and recovery behavior

Enabled missing, malformed, oversized, duplicate-version, unsafe or digest/version-mismatched configuration raises an internal503 error when a new terms reservation is needed. The normal application returns HTTP503 with its generic sanitized server-error message; it does not expose the internal exception text, raw JSON, policy text or parse error. It never returns a legacy policy/null fallback on those errors.

The reader is lazy at the existing new-reservation point. It does not fail the application at startup or prevent historical record access. Existing reservations replay their pinned creation parameters/key even when current configuration changes, breaks or is explicitly disabled; no current policy overwrites historical evidence. The authenticated history list can report capture disabled/unavailable while retaining existing records.

This validation occurs before a **new Checkout Session/reservation is committed**, at the same point as the existing injected-policy validation. Earlier Stripe account/price/customer checks can already have run. An idempotently created provider Customer may survive local rollback; this is not a promise of zero Stripe transport on invalid configuration. No new payment/Session or invented acceptance follows from that Customer.

The reader has no DB, network, application-environment-file or URL-fetch dependency. `buildApp` passes `()=>configuredCheckoutPolicy()` to `registerProviders`; the existing contracts module reexports its prior policy API while retaining stored digest and Session-binding behavior. Mock billing is unchanged.

## Evidence scope

`tests/checkout-policy-configuration.test.ts` covers positive explicit selection/composition, all-field content pinning, disabled/staged behavior, incomplete/mismatched rejection, strict/duplicate catalogue, text/link/byte/message bounds and returned-object independence without a DB or provider. `tests/checkout-contract-evidence.test.ts` adds the configured callback through actual controlled Checkout routing: initial pinned attempt, broken selection, identical retry, historical read and rejected fresh Session/reservation. Run the latter only in its guarded disposable DB/CI fixture.

These synthetic checks do not establish an adopted catalogue, deployed setting, real customer consent, contractual delivery or legal completeness. Actual Stripe TEST and policy acceptance remain separate.
