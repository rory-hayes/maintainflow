# MaintainFlow launch pricing research — 26 September 2026

Decision recorded by the coordinator: **Explore €0 / 50 pages; Standard €19 / 300 pages; Team €49 / 1,000 pages per month.** Keep the existing three plan identities and monthly billing. The application implementation is tracked in the launch E2E audit. This research did not change Stripe products, provider settings, hosted account plans or purchase an upgrade. The recommendation is conditional on actual operating costs, not a guarantee of profitability.

## Current official comparisons

Public official sources checked on 26 September 2026. USD offers remain USD below; no invented exchange-rate comparison. These prices establish competitive positioning, not equivalent product quality or universal bank support.

| Product | Verified monthly offer | Relevant difference |
| --- | --- | --- |
| [ConvertMyBankStatement](https://convertmybankstatement.com/pricing) | $10 / 400 pages; $20 / 1,000; $40 / 4,000. One-time $19 / 400 also offered. | A substantially cheaper statement-conversion competitor; MaintainFlow should compete through review, discrepancies, approval history and the existing broader workflow, not claim cheapest pricing. |
| [DocuClipper](https://www.docuclipper.com/pricing/) | $29 / 60 pages; $39 / 120; $79 / 300; $159 / 640; $219 / 1,000. | Verified in the official page's structured Offer data, explicitly USD/MONTH; its visible selector defaults to annual pricing. Unlimited users and additional financial/accounting features mean this is not feature parity. |
| [Parseur](https://parseur.com/pricing) | Locally returned EUR price payload: €49 / 100 pages; €89 / 300; €129 / 1,000; €269 / 3,000. Free 20 pages/month. | Exact amounts came from the official page's embedded `priceur-payload`, used by its slider. Broader extraction benchmark; much dearer than the selected entry offer. |
| [Docparser](https://docparser.com/pricing) | $39 / 100 credits; $74 / 250; $159 / 1,000. | One credit is one document of up to five pages. Do not equate 100 credits to 500 pages for every mix of documents. |

The chosen €19 entry removes the €29 starting hurdle; €49 gives a clear next step for recurring bookkeepers. It undercuts the broader extraction benchmarks while remaining above the cheapest specialist. Retain free CSV/XLSX review/download so users can assess their own files before subscribing. Launch with monthly plans, no annual discount, rollover, unlimited plan or automatic overage until those behaviours are deliberately implemented and their cost is known. Do not advertise unimplemented accounting formats or an accuracy percentage.

## Our cost evidence and limitations

- `server/core/openai-provider.ts` pins `gpt-5.4-mini-2026-03-17`; standard rates are **$0.75/M input, $0.075/M cached input and $4.50/M output**, matching the current [official model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini). The request allows 16,000 output tokens. Source limits include 10 MiB / 30 pages per file, 1,000 rows per array and 512 KiB of native text; dense statements can cost more or hit output limits.
- Earlier hosted QA receipts `.local/bank-statement-release-2026-09-26/execution.json` and `first-pass-diagnosis.json` recorded **$0.006211** for a two-page native statement and **$0.010928** for its two-page scanned rendition. Those use the same sparse synthetic statement with two transactions.
- The newer `.local/bank-quality-2026-09-26/assessment.json` and `execution.json`, with snapshots `first-pass-a_native.json`, `first-pass-b_native.json` and `first-pass-a_raster.json`, record **$0.013014 / $0.013115 / $0.015085** for three two-page inputs, **$0.041214 across six pages**, each on its first attempt. There are two independent synthetic cases and one derived scan, not three independent cases. The highest observed cost is now **$0.0075425/page**. The quality assessment separately preserves semantic extraction failures and requires human review: successful processing is not correct extraction. These are successful-response token estimates, not measured real-world accuracy, provider invoice reconciliation or a production cost distribution.
- Automatic jobs can attempt up to three times (`migrations/001_core.sql`). Failed/cancelled/uncertain provider attempts may incur charges absent from saved successful-run estimates. Manual reprocessing uses pages again; automatic retries do not. Existing usage charges accepted uploads, so do not copy competitors' “successful pages only” wording without changing and testing that behaviour.
- The updated **€0.032153/page planning scenario** is explicit: $0.0075425 × 3 attempts × **€1.20 per $1 planning allowance** + **€0.005/page assumed variable infrastructure/storage/email** = €0.032153. The currency allowance is a deliberately adverse planning assumption, not a live exchange rate. The infrastructure allowance is an estimate, not measured billing. The earlier €0.025/page scenario is now a lower-cost sensitivity, not the current conservative reference. Even the updated assumption is not a bound for dense real statements, retries with different token consumption or abuse.
- Reserve **4% + €0.25** per monthly payment for processing and subscription billing. Official [Stripe Ireland Payments](https://stripe.com/ie/pricing) lists 1.5% + €0.25 for standard EEA cards and 3.15% + €0.25 for international cards; [Billing](https://stripe.com/ie/billing/pricing) adds 0.7% of billing volume. The 4% assumption covers those international fees without Stripe currency conversion; model 6% if that conversion applies. Disputes, unusual support, acquisition and taxes are additional.

## Full-quota scenario for the selected offer

These calculations exclude optional AI-helper expense because no dollar spend ceiling is currently implemented. They are contribution figures, not net profit.

| Monthly plan | Page allowance | Page cost at €0.032153 | Payment/Billing allowance | Contribution before support, helpers and fixed overhead | With illustrative support reserve, still before helpers/fixed overhead |
| --- | ---: | ---: | ---: | ---: | ---: |
| Explore €0 | 50 | €1.61 | €0 | **−€1.61** acquisition cost | Also bears its helper cost |
| Standard €19 | 300 | €9.65 | €1.01 | **€8.34 / 43.9%** | **€5.34 / 28.1%**, after €3 support reserve |
| Team €49 | 1,000 | €32.15 | €2.21 | **€14.64 / 29.9%** | **€8.64 / 17.6%**, after €6 support reserve |

At an illustrative €100/month fixed overhead, roughly 19 Standard or 12 Team subscriptions cover that overhead **after those support reserves but before free-user costs, helpers, acquisition and taxes**. This is a break-even illustration, not the actual hosting bill. Every 100 fully used free accounts adds about €160.77/month under this page-cost scenario, plus helper costs. Under the earlier, lower €0.025/page sensitivity, the selected paid plans would instead leave €10.49 / €21.79 before support/helpers/fixed overhead. A €0.05/page stress case leaves €2.99 Standard contribution before support/helpers/fixed overhead and makes Team **−€3.21** even before them; therefore profitability must not be described as guaranteed.

For the requested lower-price alternatives: €19/250 would leave €6.95 after the same €3 support reserve, versus €5.34 for the selected 300 pages. €49/750 would leave €16.68 after the €6 support reserve, versus €8.64 for the selected 1,000 pages. The selected offer deliberately trades that extra cushion for acquisition value; no assumed unused-page benefit is needed in the table.

## Concrete cost controls and delivery boundary

The coordinator assigned combined monthly helper caps of **3 / 5 / 20** for Explore / Standard / Team. Apply a single shared count across schema and split suggestions, in the existing workspace-locked admission path, while retaining current daily, pending-job and three-attempt limits. Replays reuse the original request; accepted failed/cancelled requests still occupy a helper slot. Bank presets need no schema setup, so helper exhaustion must leave ordinary upload/review/export and manual setup usable.

Caps bound request counts, **not money**. Neither a hard dollar budget nor an all-attempt cost ledger is currently assumed implemented. Illustratively, a deliberately loose reservation at 400,000 input and 16,000 output tokens is $0.372 per attempt; 20 helpers with three attempts could cost up to $22.32 at those assumed bounds before other processing. That is not an observed helper cost, but explains why count caps alone are not a profitability guarantee. A future spend guard should reserve before each provider attempt, retain reservations for uncertain calls, reconcile actual usage, and share the ledger across extraction/schema/split work; avoid hiding valid customer work behind an undisclosed routine spend cutoff.

Before paid activation, verify EUR prices, the selected quotas and helper caps consistently in shared plan definitions, workspace plan snapshots, Checkout/webhooks and UI. The selected public reset promise is UTC calendar months; explicit UTC query cutoffs and consistent helper admission/audit timestamps passed isolated boundary regression before deployment. Do not promise billing-anniversary resets, imply helper costs are included in the margin table or call successful-run estimates an invoice-level spend ceiling. Record real native/scanned statement costs and all retry/helper charges from the first paid cohort before increasing allowances or discounting annual plans.

No account upgrades are authorized or performed by this research. Legal/refund/tax wording is owned by the coordinator's separate policy work.
