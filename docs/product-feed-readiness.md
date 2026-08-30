# Product feed readiness

Verified against the official OpenAI Ads and stable Commerce feed documentation
on 30 August 2026.

## Purpose

Product-feed campaigns depend on a merchant catalogue that keeps titles,
descriptions, prices, availability, images, and destination URLs current. The
MaintainFlow preflight lets a merchant audit a Google-compatible delimited feed
before sending it through the separate Ads Manager workflow.

The file is parsed in the browser. MaintainFlow retains only aggregate issue
counts, field names, and row numbers in component state; it does not send the
file, product values, or identifiers to a server.

## Local preflight contract

The preflight accepts UTF-8 `.csv`, `.tsv`, and `.txt` files up to 5 MB and
50,000 product rows. It supports quoted delimiters, escaped quotes, CRLF, and
quoted newlines.

Those file-size and row-count values are MaintainFlow browser safety caps, not
published OpenAI ingestion limits.

Every row is checked for the documented Google-compatible core fields:

- `id`, `title`, `description`, `link`, `image_link`, `availability`, `price`,
  and `brand`;
- canonical `is_ads_eligible=true` for Ads processing; the legacy
  `is_eligible_ads` alias is accepted with a migration warning;
- a valid GTIN or MPN unless `identifier_exists=no` genuinely applies;
- public HTTP(S) product and image URLs without embedded credentials;
- positive `amount CURRENCY` pricing and a lower same-currency `sale_price`;
- supported availability values and a future `availability_date` for preorder
  or backorder products;
- stable unique IDs and the published ID, title, description, and brand length
  limits.

Compressed files are supported by OpenAI but must be expanded before this local
preflight. JSON, spreadsheet, XML, RSS, and Atom files are outside the documented
Google-compatible delimited-file path and are not accepted.

## Evidence boundary

A green local result means the file passed the implemented static checks. It
does not prove that:

- a feed connection exists or is linked to the advertiser account;
- the SFTP transfer or OpenAI ingestion succeeded;
- downstream indexing has completed;
- an otherwise eligible product will serve as an ad;
- destination pages, images, categories, currency, or market-specific account
  configuration were accepted by OpenAI.

OpenAI documents feed connection and initial full-catalog upload in Ads Manager,
not through public Advertiser API endpoints. The Delta Feeds API can update the
title, price, or availability of variants that already exist in an enabled feed,
but `accepted: true` means only that processing accepted the update; it does not
prove downstream indexing, eligibility, or serving.

## Official sources

- [Ads product feeds](https://developers.openai.com/ads/product-feeds)
- [Stable product feed specification](https://developers.openai.com/commerce/specs/file-upload/products)
- [Delta Feeds API](https://developers.openai.com/ads/delta-feeds)
- [Advertiser API overview](https://developers.openai.com/ads/api-overview)
