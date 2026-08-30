# Client readiness report

Verified against the current MaintainFlow readiness result schemas on 30 August
2026. The underlying checks retain the OpenAI documentation snapshots recorded
in the linked readiness documents.

## Purpose

Direct advertisers need a usable launch checklist, while agencies need a
deliverable they can hand to a client or developer. MaintainFlow therefore
composes the completed readiness checks into a standalone, print-ready HTML
report without adding a second audit or uploading the local preflight data.

## Included sections

The report always displays four sections and explicitly marks each one as
evaluated or not evaluated:

1. public storefront, crawler, structured-data, and static Pixel evidence;
2. local product-feed structure and Ads eligibility findings;
3. local Conversions API batch/schema findings; and
4. read-only conversion event-setting evidence from a connected Ads account.

The overall label is deliberately conservative. A hard failure is `Not ready`,
a completed check with warnings or fixable failures is `Needs work`, an
otherwise clean but incomplete report is `Partial evidence`, and `Ready for
human review` is possible only when all four sections have affirmative evidence.
No report label claims OpenAI approval or guaranteed ad delivery.

## Privacy boundary

The report builder accepts only the existing bounded result objects. It does not
receive or serialize:

- raw product-feed rows or product values;
- pasted Conversions API event bodies, event IDs, URLs, hashes, or user values;
- Pixel IDs, Ads API keys, Conversions API keys, or bearer tokens; or
- encrypted credential payloads, initialization vectors, or authentication
  tags.

The local file name, public audited URL, documented field paths, row numbers,
event types, aggregate counts, evidence text, recommendations, and provider
configuration status can be included because these are already visible in the
corresponding sanitized result. Every interpolated value is HTML-escaped before
it enters the downloaded document.

## Download and evidence boundary

`Download client report` creates a browser Blob and triggers a local `.html`
download. No report route, database row, cloud object, analytics event, or
external message is created. The file includes print CSS so the operator can
use the browser's own print-to-PDF flow, but MaintainFlow does not claim that a
PDF was generated or delivered.

The report repeats the limitations for each included preflight and links to the
official OpenAI sources used by the underlying checks. Missing sections remain
visible so a one-section report cannot be mistaken for complete launch
evidence.

## Related contracts

- [Storefront readiness](storefront-readiness.md)
- [Product-feed readiness](product-feed-readiness.md)
- [Conversions API readiness](conversions-api-readiness.md)
- [Connected-account conversion measurement](conversion-measurement-readiness.md)
