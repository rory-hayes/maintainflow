# OpenAI Ads contract drift guard

MaintainFlow keeps a reviewed metadata and coverage snapshot in
`contract-manifest.json`. It records the official OpenAPI version and checksum,
base URL, operation inventory, authentication and idempotency expectations, and
the schemas that currently matter to the product.

Run the live drift check explicitly:

```sh
npm run check:openai-ads-contract
```

The checker downloads the official specification from
`https://developers.openai.com/ads/openapi.json` and fails on a checksum,
version, server, operation, header, OAuth-scope, response-code, or selected
schema change. It is a review/CI tool only: it is not imported by the Next.js
application and a network failure cannot affect normal MaintainFlow runtime.

GitHub also runs `.github/workflows/openai-ads-contract-watch.yml` once per day
and on demand. A failed scheduled run is a review signal, not permission to
update the checksum: the semantic change must still be compared with the
adapter, schemas, simulator, UI assumptions, and first-account gates below.

## Reviewing an upstream change

1. Keep the failing output as evidence that the upstream contract changed.
2. Compare the new official OpenAPI document and the linked first-party guides
   with the adapter, validation schemas, fixtures, and UI assumptions.
3. Add or update adapter contract tests before accepting a semantic change.
4. Update the relevant coverage classification, expected fields, version, and
   checksum only after that review; then rerun the checker and focused tests.

The official Product Feeds guide and OpenAPI document currently conflict. The
guide says the public Advertiser API cannot create or list feed connections or
upload a full catalogue, while OpenAPI 2.3.0 exposes feed creation, listing, and
SFTP-access operations. Those operations remain `capability_gated` and
unverified until an eligible real account and clarified official documentation
establish what customers can actually use. The separately documented Delta
Feeds `PATCH /feeds/{feed_id}/products` operation is also account-enabled and
stays capability-gated.

Official sources:

- https://developers.openai.com/ads/openapi.json
- https://developers.openai.com/ads/api-overview
- https://developers.openai.com/ads/api-reference/authentication
- https://developers.openai.com/ads/product-feeds
- https://developers.openai.com/ads/delta-feeds
