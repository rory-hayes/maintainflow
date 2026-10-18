# Offer economics and account-tier decisions

The offline model in `scripts/unit-economics.ts` reads the current plan catalogue and shared suggestion allowances. It does not access environment files, credentials, a database or a provider. It neither changes prices/limits nor authorizes an upgrade. Positive scenario contribution is not evidence of profitability.

Run with Node 24 and the existing dependencies, from the checkout:

```sh
node --import tsx scripts/unit-economics.ts docs/unit-economics.example.json > /tmp/maintainflow-economics.json
node --import tsx --test tests/unit-economics.test.ts
```

The example deliberately has eight missing evidence references, no attributed project limits, unmeasured workload/operating assumptions and an **unadopted** 70% contribution target. Every input group/scenario has a basis and source. The output retains the complete numerical input/provenance, actual catalogue allowances, cost components and missing references. Supplied references are operator attestations, not verified by this tool. Even a filled evidence object always returns `planning_model_requires_operator_review`.

## Installed behavior and measurement limits

- Explore: €0/50 pages; Standard: €19/300; Team: €49/1,000. Field and split suggestions **share** monthly admissions of 3/5/20, with 10 per rolling day and three pending. Do not allocate both types the entire shared allowance.
- Default extraction and suggestion jobs permit three attempts. Automatic retries add provider requests without another page charge; manual reprocessing consumes page credits. The model prices each attempt, includes both suggestion lanes, and permits a separate explicit additional-job ratio only for jobs absent from credited pages. **Leave that ratio zero for failures already represented in the page ledger.** Do not count the same failure in both ratios and attempts.
- Current requests pin `gpt-5.4-mini-2026-03-17`. Requested output caps are 16,000 extraction, 16,000 fields and 4,096 split tokens. Public standard USD rates, verified 17 October 2026, are $0.75 uncached input, $0.075 cached input and $4.50 output per million. Input counts include the cached subset; output counts already include reasoning. [Official pricing](https://developers.openai.com/api/docs/pricing), [model/snapshot and regional uplift](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [accounting guidance](https://developers.openai.com/cookbook/examples/agent_optimization/optimizing_agents_for_cost_and_quality#metrics-helpers).
- Requested caps and post-response token validation are not a hard spending ceiling. PDF text **and page images**, prompts/schema and output affect cost. Failures, incomplete/malformed responses, lost leases and timeouts can be billed without retained usage. Input bytes/pages do not establish input-token cost. [PDF usage](https://developers.openai.com/api/docs/guides/file-inputs#usage-considerations).
- Usage keeps its existing successful-extraction and ready-field cost fields for compatibility. A separate AI cost coverage summary combines durable extraction, field-suggestion and split-suggestion attempts with legacy successful results. Each attempt is recorded before dispatch; reported usage is priced only with a recognized model/rate. Failed, invalid, incomplete or discarded responses can contribute a known estimate when usage is available. Missing usage remains unknown, never a fabricated zero. A successful result can supply a fallback estimate for its exact attempt if observation failed; the attempt/result is counted once. If an extraction job is removed but its run survives, an exact same-workspace/kind marker still prevents legacy duplication; without operation identity the run cannot supply a fallback estimate. Unlinked legacy successes use only explicitly estimated result costs, while historical failed attempts remain unavailable. The view exposes these coverage gaps and is not the provider bill.
- Attempt estimates use the attempt's start month in UTC; unlinked legacy successes use the existing saved-result month. Successful results linked to earlier attempts do not move costs into a later month. A dispatch-intent row is not proof the provider received a request, and observation failures can leave gaps. Page counters and charging rules are unchanged. Invoice reconciliation, workload distributions and the operating inputs below remain necessary before a margin or tier decision.
- Originals accept 10 MiB/30 pages per file. Temporary reservation/concurrency bounds are not a retained-storage quota. Default retention is 90 days; owner settings permit 1–3,650 days. The model makes retention, copies, new-original ratio and reads/downloads explicit. Manual reprocessing can reuse an original; it must not automatically create another retained copy in the model.

## Formula and inputs

For each plan and scenario:

1. Credited pages = allowance × utilization; credited jobs = pages ÷ mean pages per job. Rules and AI shares sum to one. AI requests = credited AI jobs × (1 + additional **uncredited** AI jobs per credited AI job) × attempts. Attempts and token footprints are averages across **all** attempts, including terminal failures; these are not successful-response averages.
2. Suggestion jobs = shared allowance × utilization. Divide between fields and splits, then multiply each by attempts. Suggestions can have AI and operating costs even when extraction pages are zero.
3. Request USD = `((input − cached) × input_rate + cached × cached_rate + output × output_rate) / 1,000,000`. Multiply extraction/field/split request costs by their counts, then EUR/USD settlement assumption and provider-invoice multiplier. The multiplier can represent a verified service-tier/regional/tax adjustment; it must not double count any adjustment already in rates. No Batch/Flex discount is assumed for the installed direct requests.
4. Steady-state retained GiB = newly retained originals × MiB per original × stored copies × retention months ÷ 1,024. New-original ratios separate uploads from repeated processing. Egress uses new originals × size × reads/downloads; include extraction reads, repeated reads and backup transfers in that factor. Cleanup lag and growth must be reflected in the retention/copy assumptions. Provider GB/GiB accounting must be converted consistently when entering real unit rates.
5. Include per-attempt extraction operations (one attempt for each rules job in this model), a separate per-attempt suggestion allowance for staging/storage/read/render/egress, per-job/workspace email, and support minutes × hourly value. Suggested operating allowances must include non-AI costs rather than treating them as zero. Global setup/support time belongs in fixed costs. Only use **marginal** overage rates for variable storage/email/compute where the fixed plan fee already includes capacity; otherwise the model conservatively double counts allowances.
6. Paid accounts each subsidize the explicit active-free-account ratio and an equal allocation of fixed monthly costs. Explore's own result is its standalone cost, not an extra portfolio fee. Model multiple free cohorts separately if their costs differ. Self-service signup abuse and unlimited new workspaces have no global cost ceiling implied by this ratio.
7. Revenue is price excluding any gross-inclusive sales tax. Payment and Billing percentages, one fixed payment fee and refund/dispute reserve apply to the charged gross amount. Refund reserve does not assume original processing fees are returned. Net contribution subtracts all modeled variable costs, free subsidy and allocated fixed costs. Support labour is included; CAC, income tax and unlisted business expenses are not implied covered.

`targetHeadroomEur` is contribution minus the unadopted target. A negative `maxOwnAiUsdPerCreditedPageForTarget` means other costs already exhaust the target budget, even before the plan's own AI. The own-AI budget covers extraction **and both suggestion types**; free AI is already inside free subsidy. These are cost budgets, not page-price margins or enforcement.

Fixed-cost and target payer thresholds assume **every paying workspace has that row's identical plan/workload**, the free ratio stays constant and fixed costs do not step up with volume. They are sensitivities, not a mixed-portfolio forecast. A null threshold means no positive denominator in that scenario. Zero fixed costs can yield zero as a mathematical threshold; it does not predict zero-cost customers.

Quota output covers shared RPM, combined TPM and separately documented input/output TPM. Absent project limits remain null. Do not turn a single combined TPM limit into two independent allowances. All peak inputs must cover the whole project, other products and all lanes. Provider admission estimates can use requested output limits rather than eventual output; use the actual quota accounting basis. Positive token headroom does not prove worker/DB/memory/latency capacity.

## Illustrative results, not actual margins

The committed example assumes 25 paying workspaces, one active free workspace per payer, €71/month fixed costs, €30/hour support, €0.92/USD, standard EEA cards plus PAYG Billing and a 1% reserve. Its 50% and full-use cases assume two-page jobs, 6,000 uncached input/1,200 output extraction tokens and 1.1 attempts. These numerical choices have **no measured business evidence**.

| Scenario | Standard contribution / target headroom | Team contribution / target headroom |
| --- | ---: | ---: |
| Half allowance, assumed mix | €13.03 / −€0.27 | €39.88 / €5.58 |
| Full allowance, same assumed mix | €11.95 / −€1.35 | €36.81 / €2.51 |
| Retry/output/storage/FX/card stress | −€136.24 / −€149.54 | −€389.52 / −€423.82 |

The stress uses single-page jobs, 50,000 uncached input tokens, requested output caps, three attempts, 10 MiB originals/two copies/12-month retention, five reads, more support, €1.05/USD, a 10% provider adjustment, international-card conversion and a 3% reserve. It is a sensitivity, **not the maximum bill**. Both offer assumptions and reserve need owner adoption after real measurement; these results do not justify automatic repricing.

## Provider-tier decisions

Public list facts below were checked against official sources on **17 October 2026**. Actual account plan/organization, shared allowances, invoices, contractual pricing and taxes are separate inputs. Do not infer current paid/free account state from repository documentation.

| Service | Public facts relevant to the decision | Decision and verification |
| --- | --- | --- |
| Vercel | Hobby permits personal non-commercial use only. Commercial use includes advertising products/services; invitation-only access alone does not establish eligibility. Pro starts $20/month with one deploying seat, $20 usage credit; extra deploying seats $20, Viewers free. | Resolve commercial eligibility separately from load. Pro is the minimum listed commercial plan for this deployment approach; root owns adoption/change and post-change verification. [Fair use](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage), [Pro](https://vercel.com/docs/plans/pro-plan). |
| Vercel compute | Source selects Frankfurt. Public Pro rates: $0.184 active CPU-hour, $0.0152 provisioned GB-hour and $0.60/million invocations. On-demand Functions billing starts at first use, offset by applicable usage credit. Memory is charged while waiting for a provider; failures still use invocations. | Measure CPU, memory duration and requests across the whole team. Do not add old free Pro compute quotas on top of the credit. Include other metered services and deployers. [Compute pricing](https://vercel.com/docs/functions/usage-and-pricing). |
| Supabase | Free: 500 MB DB, 1 GB files, separate 5 GB cached/uncached egress, inactivity pause/no automatic backup. Pro starts $25/month with $10 compute credit, 8 GB DB, 100 GB files, separate 250 GB egress classes, daily DB backups/seven days. Files overage $0.0213/GB; uncached egress $0.09/GB, cached $0.03/GB. | Choose from measured retained growth, connections/CPU/egress and recovery requirements. Another persistent project may add compute cost. DB backups exclude Storage objects; paid DB backups do not complete hosted originals recovery. [Pricing](https://supabase.com/pricing), [egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress), [backups](https://supabase.com/docs/guides/platform/backups). |
| Resend | Free: 3,000/month and 100/day; received mail and sent recipients count. Pro $20/month for 50,000, no daily quota; optional overage $0.90/additional 1,000-email bucket. | Include denied inbound mail, verification/resets/invites and monitoring, then compare peak UTC day/month. Paying does not automatically lift shared API rate limits. [Pricing](https://resend.com/pricing), [quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits). |
| Healthchecks | Hobbyist free supports 20 jobs; Business $20/month supports 100. | A single independent heartbeat does not need a capacity upgrade. Receiver setup/terms/delivery remain separate. [Pricing](https://healthchecks.io/pricing/). |
| Stripe Ireland | Standard EEA 1.5%+€0.25; premium EEA 2.8%+€0.25; UK 2.5%+€0.25; international 3.15%+€0.25; conversion adds 2% if required. Billing PAYG adds 0.7% of Billing volume. | Actual card mix, product/contract and settlement determine fees. Received dispute fee €20 and manual counter fee €20 are material tails. The example reserves are assumptions; original processing/FX fees are not refunded. [Payments](https://stripe.com/ie/pricing), [Billing](https://stripe.com/ie/billing/pricing), [refunds](https://support.stripe.com/questions/understanding-fees-for-refunded-payments). |

Supabase's Spend Cap excludes compute and several provisioned extras; it is not a universal bill maximum. [Cost control](https://supabase.com/docs/guides/platform/cost-control). A paid plan does not repair missing monitoring, backups, permission checks or customer acceptance.

### Minimal commercial Vercel proposal for coordinator adoption

Use **one-seat Pro**, no additional paid seat/add-on and the included eligible CDN tier. Keep the existing source settings: Frankfurt, 2 GB memory and 300-second function duration. No evidence here justifies Enterprise, more memory or a longer execution deadline. Plan adoption and affected-behavior verification remain root-owned; this is not an account mutation.

For one deploying seat, the base is **$20/month before tax**, with $20 credit against eligible managed-infrastructure usage. The credit expires monthly; it does not offset the platform fee, extra seats or fixed add-on subscriptions. The included Flat Rate CDN tier provides one million requests/1 TB transfer; paid tiers and bulk-file distribution need a separate eligibility/price check. [Pro](https://vercel.com/docs/plans/pro-plan), [CDN](https://vercel.com/docs/pricing/flat-rate-cdn).

```text
eligible_metered_USD = 0.184 × active_CPU_hours
                    + 0.0152 × provisioned_memory_GB_hours
                    + 0.60 × invocations / 1,000,000
                    + billable_builds + eligible_storage + origin_transfer + other_team_meters
hosting_USD = 20 + max(0, eligible_metered_USD − 20)
             + additional_seats + fixed_CDN/add-ons + marketplace/domains + tax
```

Account for memory during provider waits, shared-instance concurrency and every team project rather than multiplying every request by the full provisioned memory separately. Builds and retained deployment/function bundles also cost; the October storage/retention rollout needs account readback before quoting or shortening rollback history. Deployment and Functions Storage list $0.10/GB-month each. The existing-team announcement describes deletion of eligible deployments older than 30 days starting 23 October unless configured otherwise. Do not delete preserved releases or alter retention as an incidental cost fix. [Regional rates](https://vercel.com/docs/pricing/regional-pricing/fra1), [builds](https://vercel.com/docs/pricing#builds), [storage](https://vercel.com/docs/deployment-storage), [retention rollout](https://vercel.com/changelog/deployment-storage-pricing-expands-to-existing-teams).

**Unadopted initial control proposal:** $20 On-Demand Budget per billing cycle with web/email alerts at 50%, 75% and 100%. This is a concrete small-start option, not an owner-approved amount. Pro's default new-team budget notification is $200; do not confuse it with the included $20 credit. The budget measures team metered spend **above credit** and excludes seats, Marketplace and fixed add-ons. [Pro spending](https://vercel.com/docs/plans/pro-plan#managing-your-spend-amount).

Budget alone does not stop usage. Enabling Pause Production Deployments stops **all team production projects** and requires an adopted outage decision after enumerating shared projects. It is checked every few minutes, can overshoot and leaves storage/AI Gateway/v0 charges running. Projects resume individually. A $20 overage budget targets roughly $40 before excluded charges/tax/overshoot; it is not a hard total bill. Root must verify the amount, recipients, pause setting, shared scope and retained-release policy in the actual account before adoption. [Spend Management](https://vercel.com/docs/spend-management).

## Reconciliation and adoption required

1. Owner identifies the MaintainFlow OpenAI project/organization and exact UTC interval. Never attribute Default or another named product merely because a dashboard is accessible. Obtain project totals for **all** attempts/lanes and the same interval's invoice/credits/service tier. Capture unsettled adjustments explicitly.
2. Compare retained successful extraction/field/split estimates with project usage. Missing usage is unknown, not zero. Explain residual bill differences, failures/timeouts/lease losses and retention gaps. Do not force a synthetic exact match or infer per-tenant invoices from aggregate residuals.
3. Measure pages per job, source/row/format distributions, AI/rules mix, cached input, all-attempt token tails, retries and reprocessing; active free cohorts; storage/cleanup/backup copies; inbound/outbound email; payment/FX net receipts; provider taxes/credits; support time and fixed operations. Use a representative window and retain finite stress cases.
4. Get actual whole-project RPM/TPM, database/storage/email limits and sustained hosted workload results. Define a reserve for measured bursts, retry waves and response-time targets. Evidence from a five-second local contention test is not hosted capacity.
5. Owner adopts the offer, target contribution reserve, support/operating assumptions and maximum monthly spend. Root prepares necessary commercially permitted tiers with reviewed budgets/alerts and verifies affected behavior after any change. No upgrade/spend/public activation is performed by this lane.
