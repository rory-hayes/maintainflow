# Automation bridges: Zapier, Make, n8n, and Power Automate

These are concrete **API/webhook recipes**, not published native Folio marketplace connectors. Public platform documentation was checked on 6 September 2026. No workflow, external account, subscription, or destination was activated. The local examples use synthetic data and are validated against Folio's real approval-event contract; account permissions, trigger availability, delivery, and downstream actions remain external checks.

Files:

- [`fixtures/automations/document-approved.json`](../fixtures/automations/document-approved.json): complete original invoice example.
- [`document-approved.schema.json`](../fixtures/automations/document-approved.schema.json): general approved-event envelope schema; `values` follows each parser's schema.
- [`recipes.json`](../fixtures/automations/recipes.json): all four platform mappings and expected synthetic values.
- [`examples/automations/verify.ts`](../examples/automations/verify.ts): server-side raw-body signature/schema verifier, with no listener, forwarding, or account changes.
- [`tests/automations.test.ts`](../tests/automations.test.ts): two passing local tests for all mappings, literal identifiers, signature compatibility, tampering, timestamp expiry, and stable replay identity. `tests/integrations.test.ts` also validates actual enqueued approval payloads against the supplied envelope schema.

## Shared setup and event contract

Create a parser and a **Webhook** connection under Integrations. Select that parser and enter the public HTTPS receiving URL. Folio permits HTTPS port 443, validates resolved public destinations, pins DNS for requests, and does not follow redirects. Keep the returned connection signing secret in the receiver's protected server credential store; it is shown once. The connection delivers approvals created after the connection was created; it does not automatically backfill old approvals.

The receiving workflow should produce one downstream invoice record per approved revision, with optional separate line-item records. The original fixture contains:

```json
{
  "event": "document.approved",
  "id": "0b1456d2-5aa6-45e7-a574-7796e2b995c5",
  "document": {
    "id": "1da0132b-a8a4-4da5-9572-756a4ab76fbf",
    "name": "synthetic-automation-invoice.txt",
    "parserId": "6b931781-3a29-4687-87d7-63811583b2e9"
  },
  "runId": "f5231541-0a26-4df8-84a4-c8d03b3d2a80",
  "revision": 1,
  "correctionId": "f1e634ef-4d52-471f-a736-a955b0375770",
  "approvedAt": "2026-09-06T12:00:00.000Z",
  "values": {
    "invoice_number": "000127",
    "supplier": "Cedar Office Studio",
    "currency": "EUR",
    "total": 61.5
  }
}
```

This shortened excerpt omits the full fixture's date, subtotal, tax and two line items. Use the full file when learning a trigger's schema. `id` identifies the immutable approval event; `document.id` identifies the source, `runId` identifies extraction, `revision` is the numeric correction count at approval, and `correctionId` is a UUID or null. A later approval has a new event ID. Field names under `values` come from the parser; choose the matching workflow mapping. Missing values can remain null according to that schema.

| Destination field | Source path | Example and handling |
| --- | --- | --- |
| Approval key | `id` | Use as a unique downstream upsert key; keep as text |
| Source document | `document.id` | Correlation identifier, not original file bytes |
| Invoice reference | `values.invoice_number` | `000127`; configure destination as text to retain zeros |
| Supplier | `values.supplier` | `Cedar Office Studio` |
| Amount | `values.total` | Numeric `61.5`; keep currency separately |
| Currency | `values.currency` | `EUR` |
| Line records | `values.line_items` | Iterate the array; key each row by approval ID plus row index |

Original file contents are not attached to approval events. If an automation needs the original, use a separately stored scoped Folio API credential to call `/api/documents/:id/original`; the event alone does not grant file access. Keep the credential on the automation/server side. Use text-safe/RAW insertion for untrusted strings in spreadsheet destinations so formula-like document values cannot become executable formulas.

## Receiving verification and deduplication

Every request supplies `X-Folio-Delivery`, `Idempotency-Key`, `X-Folio-Timestamp`, and `X-Folio-Signature`. Verify **before any downstream side effect**. The signature is `v1=` plus hex HMAC-SHA256 over the timestamp, a period, and the unchanged UTF-8 request bytes. Reject signatures outside a five-minute time window, a mismatched delivery/idempotency ID, invalid envelope data, and oversized payloads. Do not parse/re-serialize JSON before checking the signature.

The supplied `verifyApprovalDelivery({body, headers}, secret)` returns `{deliveryId,event}` after these checks. It is a tested building block for a trusted receiving endpoint or a compatible server-side workflow code step, not a deployed relay and not a durable deduplication service. If the chosen workflow cannot access the exact raw bytes, protected secret, cryptographic comparison, and transactional storage, put an owned verification receiver in front of it. Do not remove verification simply to make a test trigger fire.

A receiving service should atomically save `(connectionId, deliveryId)` with a unique constraint and a pending downstream/outbox record before returning 2xx. A previously accepted ID returns 2xx without creating another action. Its worker should forward only validated events and retain its own retries/error status. The automation's final destination should additionally upsert by approval ID so replay or a lost response cannot add duplicate invoices. The verifier intentionally does not pretend to implement this persistence.

Folio retries non-2xx/timeouts up to five attempts and keeps the same delivery identity. Manual replay retains that identity too. Folio's Delivered status proves HTTP acceptance by the configured receiver; it does not prove that an asynchronous Zap/scenario/flow's final destination action succeeded. Inspect that platform's execution history and the resulting record separately.

## Zapier recipe

Create a Zap with **Webhooks by Zapier → Catch Raw Hook** when verification runs inside the workflow; it exposes the raw request and headers. If an owned receiver already verifies and durably accepts Folio, use **Catch Hook** for the receiver's trusted forwarded JSON. Zapier documents a 2 MiB raw-hook limit and distinguishes parsed versus raw triggers. [Official trigger guide](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zap-workflows-from-webhooks).

1. Test the trigger using the complete synthetic approval fixture through the verification path.
2. Verify/deduplicate before any action. Parse the verified body and require `event = document.approved` and the intended `document.parserId`.
3. Map Approval ID, Invoice number, Supplier and Amount using the Zapier entries in `recipes.json`. Select their parsed fields from the trigger/code-step output. Upsert an invoice record keyed by Approval ID in the chosen destination.
4. For line-item records, iterate `values.line_items` and carry the parent approval key.
5. Publish only after checking a real approved document, repeated delivery, and the final destination record. A successful webhook response can precede downstream action completion.

## Make recipe

Create **Webhooks → Custom webhook**. For in-scenario verification, enable **JSON pass-through** and **Get request headers**; validate the raw input before Parse JSON and mapping. A verified relay may instead send trusted parsed JSON. Make can validate an explicitly configured data structure; learning sample fields alone does not provide equivalent validation. [Official webhook settings](https://apps.make.com/gateway).

1. Define the structure using the supplied envelope and full fixture, then verify/deduplicate the received event.
2. Parse the verified JSON and filter `event`/parser ID.
3. Map `id`, `values.invoice_number`, and `values.currency`; use an Iterator over `values.line_items` for detail rows. The first synthetic description is `Recycled paper`.
4. Use a unique Approval ID upsert key in the destination, and approval ID plus iteration index for detail rows.
5. Test scenario failures and repeat delivery; inspect execution history and destination values.

Folio's direct connection does not send Make's optional `x-make-apikey` header. If that extra authentication is enabled, the verified receiver must supply it from its protected configuration. Do not claim that the generic Folio connection already supports custom destination headers.

## n8n recipe

Use a **Webhook** node with POST and **Raw Body** for in-workflow verification, or receive authenticated JSON from the owned verifier. n8n distinguishes test and production URLs and provides a **Respond to Webhook** response mode. Its conditional “Only Run If” option can allow a request when an expression errors, so it is not an authentication boundary. [Official node documentation](https://github.com/n8n-io/n8n-docs/blob/main/docs/integrations/builtin/core-nodes/n8n-nodes-base.webhook/README.md).

1. Listen on the test URL. In a code environment that permits the necessary crypto/secret access, adapt the supplied verifier to the node's raw byte/header representation; otherwise use the owned receiver.
2. Pass `{deliveryId,event}` onward only after verification and durable acceptance. Respond 2xx at that boundary.
3. In Edit Fields, use `{{ $json.event.id }}`, `{{ $json.event.values.invoice_number }}`, and `{{ $json.event.values.total }}`. Split Out `event.values.line_items` only after carrying the approval ID.
4. Upsert destination records with the keys above; route failures into an operational retry path.
5. Publish the workflow and change the receiver to its production URL only after account-specific verification. Those workflow actions were not performed here.

## Power Automate recipe

Create a flow using **When an HTTP request is received** and paste the supplied JSON schema into the request-body schema field. Microsoft's current default authentication requires a tenant identity; a Folio HMAC header is not an Entra token. Use an owned receiver that verifies Folio and calls the flow with the appropriate Entra-authenticated identity. Do not change the flow to “Anyone” as a substitute for implementing this boundary. [Official HTTP-trigger authentication](https://learn.microsoft.com/en-us/power-automate/oauth-authentication).

1. Configure the permitted tenant/service identity and protected credentials in the relay; keep the flow URL out of public clients.
2. Forward the verified event unchanged as JSON.
3. Map `triggerBody()?['id']` as the unique record key, `triggerBody()?['values']?['invoice_number']` as text, and `triggerBody()?['values']?['total']` as the numeric amount.
4. Apply to each `triggerBody()?['values']?['line_items']` for child rows; carry the approval ID and index.
5. Verify unauthorized calls fail, valid calls create/upsert the expected records, and repeat calls do not duplicate them. Relay hosting, Entra registration, flow availability and destination permissions remain account-specific external gates.

## Sending documents into Folio

The same platforms can feed documents through an HTTP action using a scoped Folio API key. Retrieve the source file through that platform's authorized file connector, then POST its actual bytes as multipart `file` to `/api/parsers/:id/documents` with `Authorization: Bearer <stored key>` and a stable `Idempotency-Key` derived from the source's file/version ID. Do not send only a storage URL and call it a completed upload. HTTP 202 means accepted; read `/api/jobs/:id` and `/api/documents/:id` until processed/review/failed. Approval is a separate review step.

Use `/help/api` for the exact endpoints/scopes/error codes. This common intake pattern does not establish a native Drive/Dropbox/OneDrive/SharePoint connector or a tested account-specific source recipe.

## Local and external evidence

Run `node --import tsx --test --test-concurrency=1 tests/automations.test.ts` for the two local checks. The integrated suite also compares real `enqueueApprovals()` output with the example schema. These checks verify fixture shape, field paths, scalar types, HMAC compatibility and rejection behavior. They do not compile/import a Zap, Make blueprint, n8n workflow or Power Automate package; `recipes.json` is explicitly a mapping manifest, not a platform export.

For each actual account, record trigger settings, verification/dedupe proof, a real approved-document delivery, destination identifiers and literal values, retry behavior, and execution history before marking its bridge externally verified. No platform-specific success has been claimed from the local fixtures.
