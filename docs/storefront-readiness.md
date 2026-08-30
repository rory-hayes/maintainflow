# Storefront readiness audit

Verified against official OpenAI publisher and advertiser guidance on
30 August 2026.

## Purpose

The readiness workflow gives MaintainFlow a useful, honest product before an
OpenAI Ads API key is available. It makes read-only requests to one public
landing page, `/robots.txt`, and `/sitemap.xml`; it does not access an Ads
account or imply that OpenAI has approved the destination.

The same response is inspected for static ChatGPT Ads measurement evidence.
OpenAI documents a browser SDK loaded from `bzrcdn.openai.com`, initialization
with a Pixel ID, standard event calls, consent control, an image-tag path, and
the CSP origins required to load the SDK and send events. MaintainFlow checks
those public signals without executing page JavaScript or making a request to
OpenAI's measurement endpoint.

OpenAI's advertiser guidance says OAI-AdsBot is required for ChatGPT Ads landing
page validation and recommends also allowing OAI-SearchBot. Its publisher
guidance says public pages can appear in ChatGPT search and recommends not
blocking OAI-SearchBot when the publisher wants content to be discovered,
surfaced, cited, and linked.

## Checks and weights

| Check | Weight | Evidence |
| --- | ---: | --- |
| Landing page returns crawlable HTML | 20 | Final HTTP status and content type after safe public redirects |
| OAI-AdsBot allowed | 25 | Applicable `robots.txt` group and longest matching path rule |
| OAI-SearchBot allowed | 15 | Applicable `robots.txt` group and longest matching path rule |
| Page is indexable | 10 | HTML robots metadata and `X-Robots-Tag` |
| Final destination uses HTTPS | 5 | Final URL after redirects |
| Product structured data | 10 | Valid JSON-LD containing a `Product` type |
| Machine-readable offer facts | 8 | Price and availability in JSON-LD or product metadata |
| Core page metadata | 4 | Title, description, and canonical URL |
| Sitemap discovery | 3 | Successful `/sitemap.xml` or a declaration in `robots.txt` |

Passes receive full weight, warnings receive half weight, and failures receive
no weight. A score below 60, an unreachable page, an OAI-AdsBot block, or a
`noindex` directive is labelled `not ready`. The `ready` label additionally
requires a score of at least 85, complete Product and Offer signals, and no core
metadata failure; all other results are labelled `needs work`.

## Measurement installation evidence

Measurement is shown as a separate static preflight and does not silently alter
the destination score above. MaintainFlow reports:

| Check | Static evidence |
| --- | --- |
| Measurement tag installation | Exact `oaiq.min.js` SDK URL plus an `oaiq("init", ...)` call with a non-placeholder Pixel ID, or the documented `bzr.openai.com/v1/sdk/events` image-tag path |
| Supported event calls | Literal supported web event names in `measure`, `measureSingle`, or image-tag query parameters |
| Consent control signal | A literal `oaiq("consent", ...)` call in the returned HTML |
| CSP compatibility | `script-src` access to `bzrcdn.openai.com`, `connect-src` access to both documented OpenAI hosts, and `img-src` access to `bzr.openai.com` when a CSP is present |

The response never includes the detected Pixel ID. A positive result means only
that the public response contains a documented installation path and no visible
CSP source conflict. It does not mean an event was received, deduplicated,
matched, attributed, accepted by Ads Manager, or used for optimization.

The Conversions API remains intentionally outside this public-page probe because
it is server-to-server and its key must not be present in browser HTML. A
separate Readiness tool now validates request-body JSON locally without a Pixel
ID, key, or network request. Its clean result prepares—but does not replace—the
later server-side `validate_only` test once an eligible account is available.

## Safety boundary

- Only HTTP and HTTPS URLs on ports 80 and 443 are accepted.
- Local, private, link-local, reserved, and documentation IP ranges are blocked
  before every request and redirect.
- Every hostname is resolved once per request hop; mixed public/private answer
  sets are rejected, and the exact approved public addresses are supplied to
  the socket connection so a later DNS answer cannot redirect the audit into a
  private network.
- Redirects, response size, and request duration are capped.
- Request bodies are capped by streamed bytes even when `Content-Length` is
  absent. A shared fixed-window quota allows six audits per trusted client IP
  per hour and 30 per initial target host per hour before any outbound fetch.
- PostgreSQL stores only independent HMAC-SHA-256 subject hashes, counts, and
  window timestamps. It never stores the raw client IP or target hostname;
  buckets older than 48 hours are removed by the protected daily job.
- On Vercel the client identity comes from `X-Vercel-Forwarded-For`, which the
  platform documents as its protected equivalent of the public client address.
  A custom host must explicitly enable `READINESS_TRUST_X_FORWARDED_FOR` only
  behind a reverse proxy that overwrites that header.
- Production returns `503` rather than performing an unmetered fetch if the
  database, 32-character rate-limit secret, migration, or trusted address is
  unavailable. Local development may run without this shared quota.
- MaintainFlow identifies itself with its own user agent; it does not impersonate
  an OpenAI crawler to bypass bot controls.
- One successful request cannot prove that a CDN, WAF, geographic rule, CAPTCHA,
  or bot-verification product will allow OpenAI's crawler infrastructure.
- Structured-data presence is not a policy-compliance or ad-approval decision.
- Static HTML cannot reveal tag-manager triggers, external application bundles,
  consent-manager behavior, or server-side Conversions API requests. A missing
  static signal is therefore a prompt for runtime/manual verification, not
  proof that no integration exists.
- MaintainFlow never loads the detected SDK and never calls the measurement
  event endpoint during an audit, so the audit cannot create a conversion.
- This application limit reduces ordinary abuse but is not DDoS protection.
  Configure and observe a Vercel WAF rule for `/api/readiness/audit` before a
  broad public launch.

## Official sources

- [Advertiser guidance for allowing OpenAI web crawlers](https://help.openai.com/en/articles/20001243-advertiser-guidance-for-allowing-openai-web-crawlers)
- [Publishers and developers FAQ](https://help.openai.com/en/articles/12627856-publishers-and-developers-faq)
- [OpenAI crawlers](https://platform.openai.com/docs/bots)
- [Measurement Pixel](https://developers.openai.com/ads/measurement-pixel)
- [Multiple Pixel IDs](https://developers.openai.com/ads/multiple-pixels)
- [Image Tag](https://developers.openai.com/ads/image-tag)
- [Conversions API](https://developers.openai.com/ads/conversions-api)
- [Supported Events](https://developers.openai.com/ads/supported-events)
- [Vercel request headers](https://vercel.com/docs/headers/request-headers)
- [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting-sdk)
