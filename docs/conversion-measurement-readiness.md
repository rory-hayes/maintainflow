# Conversion measurement readiness

Verified against the official OpenAI Ads Conversion Setup and Insights
references on 30 August 2026.

## Purpose

A conversion-bid recommendation is unsafe when its campaign has no usable
conversion definition. MaintainFlow therefore treats measurement integrity as a
read gate before it evaluates CPA or offers an external bid change.

## Live read

MaintainFlow consumes every cursor page from:

```text
GET /conversions/event_settings?limit=500&order=desc
```

For each active `conversions` campaign, its
`conversion_event_setting_ids` must resolve to returned settings. The current
documented contract also requires:

- the setting is not archived;
- `attribution_window_days` is `30`; and
- exactly one `source_id` and resolved source are present.

Missing references, archived settings, or incomplete sources fail the campaign.
An attribution value that differs from the current contract is surfaced as
schema drift and also withholds the recommendation.

## Failure boundary

Event-setting availability does not control whether the rest of the live account
can be read. If this endpoint is unavailable, MaintainFlow shows the limitation
in Readiness but supplies an empty eligible-campaign set to the recommendation
builder. This preserves campaign visibility while failing closed on a mutation
decision that depends on conversion measurement.

The check proves configuration references returned by the Ads API. It does not
prove that a Pixel or Conversions API event is firing now, that deduplication is
correct, or that purchases reconcile with the shop's order system. OpenAI's
recent Pixel event endpoint additionally requires a Pixel ID and only returns a
short test stream; that operational check remains a later live-account gate.

## Official sources

- [Conversion Setup](https://developers.openai.com/ads/api-reference/conversion-setup)
- [Insights](https://developers.openai.com/ads/api-reference/insights)
