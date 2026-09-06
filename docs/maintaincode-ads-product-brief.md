# MaintainCode Ads — product and build brief

Prepared 6 September 2026. The user has selected this product direction and requested implementation by repurposing the existing MaintainFlow Ads application. This describes the intended product; it is not a claim that these capabilities are already implemented, deployed, or validated with paying customers.

## Product description

MaintainCode Ads is a subscription web application that helps businesses understand which marketing channels bring enquiries, which enquiries become qualified leads, and which leads become paying customers. It follows the practical Attributer workflow: capture acquisition information on the customer's website, preserve it as visitors browse, add it to lead forms, and carry it into the customer's existing CRM. ChatGPT Ads is a first-class paid channel within this broader attribution product.

The customer-facing promise is: **See which marketing channels become qualified leads and paying customers, including ChatGPT Ads.**

A marketing manager should be able to open a campaign report, inspect its spend and associated sales outcomes, and trace a reported result to the captured acquisition evidence and CRM deal. An agency should be able to provide the same reporting for several clients with isolated data and clear access permissions.

The first buyers are small B2B businesses and agencies whose websites generate enquiries, consultations, demo requests, or registrations. Their sales often finish in a CRM after the initial website visit. Ecommerce checkout analytics and enterprise attribution modelling are later expansion options.

## The problem and paid value

Advertising platforms report delivery; form tools collect enquiries; CRMs record sales progress. Source information is often lost or overwritten between these steps. Businesses consequently struggle to distinguish campaigns that generate form fills from campaigns associated with valuable customers.

MaintainCode Ads connects those records and exposes missing evidence. Its recurring value comes from continued source capture, CRM outcome updates, campaign cost imports, reporting, and tracking diagnostics. Customers continue using their websites, forms and CRM.

An illustrative report might show EUR 1,000 campaign spend, 30 enquiries, 8 qualified leads, 2 won customers and EUR 6,000 in booked deal value. Those are example numbers, not observed customer results. Booked revenue, collected payments, attributed revenue, profit and incremental impact must remain distinct.

## Core customer journey

1. Create a company workspace, add a website, and select the site's forms and CRM.
2. Install the small tracking script directly or through an existing tag manager. Configure its interaction with the site's consent controls.
3. Map dedicated attribution fields to the customer's forms. A guided test confirms both successful form submission and arrival of the attribution fields in the CRM.
4. Connect the first supported CRM, HubSpot, and map qualified-lead stages, deal stages, amounts and dates.
5. Optionally connect an eligible ChatGPT Ads account for campaign and cost reporting. Businesses without this account can still use the multichannel capture product.
6. Review channels, campaigns, leads and won deals. Inspect source evidence and unresolved matches when a number needs explaining.
7. Receive opted-in tracking-health and summary reports, manage subscriptions, and export data through the application.

Onboarding must distinguish script installed, consent configured, form delivery verified, CRM reporting connected, and ad-spend data available. A successful connection to one component does not mark the entire workflow complete.

## Attribution capture and channel coverage

The website script captures the observed landing page, available referrer, timestamp, allowed campaign parameters, supported click references, and first/latest acquisition evidence. It does not read arbitrary form contents. Use explicit allowlists and redact sensitive URL query values; do not store complete URLs containing customer details or tokens by default.

The product supports these channel families through observed referrers and tagged links:

| Channel | Intended classification |
| --- | --- |
| Google and Microsoft advertising | Paid search or the correctly identified paid campaign type |
| Meta, LinkedIn and other tagged social campaigns | Paid social with source and campaign details |
| ChatGPT advertisements | Paid AI / ChatGPT Ads, with the underlying paid evidence retained |
| Search engine referrals | Organic search |
| Unpaid social referrals | Organic social |
| Email and newsletters | Email, when identifiable from supplied tags |
| Affiliates and referring websites | Affiliate or referral when supported by evidence |
| ChatGPT, Perplexity, Gemini and other identifiable AI referrals | Organic AI referral only when that classification is supported |
| Visits without sufficient acquisition evidence | Direct / unknown, preserving the distinction where possible |

A ChatGPT referrer alone does not establish that a visitor clicked an advertisement. Ambiguous ChatGPT visits remain unclassified rather than being forced into paid or organic. Preserve conflicts between tags and click-reference evidence for review. Captured parameters are observed input, not independently authenticated proof of an ad purchase.

First observed touch is the earliest recorded qualifying visit within retained history. Last non-direct touch is the latest qualifying non-direct visit before the lead or conversion. Direct returns must not silently overwrite a known acquisition source. Keep the original evidence, the applied attribution model, and the classification-rule version. Use a configurable first-party retention window, initially proposed at 90 days, subject to consent and browser limitations.

Do not claim first-ever exposure, complete cross-device tracking, access to ChatGPT conversations, or recovery of all missing acquisition data. Do not add fingerprinting.

## Forms and CRM delivery

Match the core Attributer job before expanding the dashboard. Capture source information and populate documented hidden fields while letting the customer's existing form submission carry those values into their sales tools.

The initial tested matrix is standard same-origin HTML forms and one documented HubSpot form integration. WordPress/Gravity Forms and Webflow adapters follow as the first additional implementations. A script working on a CMS does not mean every embedded form on that CMS is supported. Cross-origin forms require their supported integration mechanism and a dedicated test.

Suggested field groups include first source/medium/campaign, latest non-direct source/medium/campaign, original landing page, campaign/ad identifiers when available, capture time and an opaque submission reference. Keep platform click references in protected fields rather than exposing them in share links or routine logs.

Preserve existing CRM fields and the customer's own form handling. Explicit field mapping controls any new property creation or updates. Fill first-source values once and update latest-source values under a documented rule. Do not overwrite a salesperson's manual corrections without an explicit configuration choice.

A tracker outage, blocked request or quota issue must not prevent the underlying business form from submitting. Retry attribution delivery safely, exclude diagnostic submissions from paid lead counts, and give operators an actionable error when capture and CRM arrival disagree.

## CRM outcomes and reporting

HubSpot is the first native CRM reporting connector. Read its currently documented API and permissions before implementing; verify supported account tiers and custom-property behaviour. CRM records provide lifecycle stages, deal associations, amounts and won dates. Generic field delivery and CSV export do not constitute native support for other CRMs.

Track successful submissions separately from deduplicated contacts and opportunities. Use stable identifiers and idempotency so retries do not create extra leads or revenue. Do not merge contacts solely by name, IP address or company name.

Let the customer define qualified-lead and closed-won stages. A contact can have several deals, and a deal can involve several contacts. Count each deal once. For the first release, use one explicit primary attribution contact for each deal; unresolved associations stay unattributed. Retain changes when a deal is reopened, amended or lost.

The app provides channel and campaign funnels, lead details, attribution timelines, won-deal reporting, exports, and tracking-health diagnostics. Every reported total must explain its model, evidence window, currency and freshness. First-touch and last-non-direct views are alternate models, not totals to add together.

Use these reporting rules:

- Show lead count, qualified leads, opportunities, won deals and booked deal value with their exact definitions.
- Label CRM deal amounts as booked revenue. Show collected revenue only after a verified billing/payment integration is implemented.
- Separate acquisition-cohort reporting from calendar-period sales reporting. Do not silently divide this month's revenue from old leads by this month's ad spend.
- Store timestamps consistently and report using the selected account timezone.
- Preserve original currencies. The initial release reports currencies separately; no cross-currency ROAS without a documented conversion method.
- Calculate cost per lead or attributed customer only for a compatible model, cohort and spend scope. Display unavailable ratios as unavailable.
- Show missing spend as unknown rather than zero, and keep organic sources free of invented ad-cost figures.
- Expose unmatched records, stale synchronizations and incomplete coverage.
- Attributed revenue and revenue-based ROAS do not establish causation, incremental sales or profit.

## ChatGPT Ads integration

ChatGPT support has three distinct layers:

**Source capture:** retain configured campaign tags and the original OpenAI-provided `oppref` when present. Do not generate, decode or rewrite this opaque identifier. Use campaign/ad IDs when available; name-only matching requires a reviewed mapping and must not silently join ambiguous campaigns.

**Cost and outcome reporting:** connect an eligible advertiser account using supported account-scoped authentication. Import campaigns, ad groups, ads and supported spend/click/impression data. Keep provider-reported conversions separate from our CRM-attributed outcomes and explain differences. View-through conversions remain separate from click-through totals. Show the last successful sync, account timezone, data coverage and permission errors.

**Conversion feedback:** after the reporting workflow is verified, optionally send supported lead/sales events through OpenAI's Conversions API. This is an explicitly enabled integration, not an automatic side effect of connecting read-only reporting. Preserve the click reference, use stable event IDs across retries and browser/server delivery, respect event-age and payload requirements, and distinguish accepted events from provider-attributed conversions. Use the actual time of a later sale rather than backdating it to its original click. OpenAI's attribution window may exclude a delayed sale that remains visible in the customer's CRM report.

Programmatic conversion setup and other capabilities depend on account access. Provide a documented manual setup path when account provisioning is unavailable. Keep secrets exclusively server-side. Do not promise that a normal OpenAI API Platform key connects an Ads account.

Native ChatGPT cost sync is included in the first complete release. Google, Meta and LinkedIn source attribution also works at launch through tracking tags; their native spend APIs are later connectors. A validated CSV cost import is the initial fallback. The interface must clearly distinguish source tracking, cost import, CRM reporting and conversion feedback.

## Main application screens

1. **Overview:** channel outcomes, trends, attribution coverage and clearly scoped spend metrics.
2. **Leads:** filters for source, campaign, stage, date and evidence completeness, with CRM links.
3. **Lead detail:** source history, form delivery, classification explanation and associated deals.
4. **Campaigns and reports:** funnels, first-touch/last-non-direct views, cohorts and exports; dedicated ChatGPT campaign detail within the same reporting system.
5. **Websites and forms:** installation instructions, supported adapters, field mappings and test submissions.
6. **Tracking health:** missing fields, broken handoffs, stale connectors, unmatched campaigns and recovery actions.
7. **Integrations:** account connections, permissions, sync history and optional conversion feedback settings.
8. **Workspace settings:** agency/client workspaces, roles, retention, consent integration, billing and deletion/export controls.

Use a professional, readable web application with coherent typography, accessible tables, sensible information density and responsive layouts. Core numbers must lead to their underlying evidence. Every visible control must work or clearly state a real availability condition. Separate sample data from live data throughout the UI.

## Packaging and operating model

Use self-service monthly and annual subscriptions with transparent site and lead limits. Proposed pricing for testing is EUR 49/month for one website, one CRM connection, one ChatGPT ad account and 500 captured production lead submissions; EUR 149/month for an agency workspace with five websites and 2,500 pooled submissions. These are working hypotheses pending delivery-cost and paid-customer evidence.

A captured submission is a successful, distinct production form submission; retries and test submissions do not count again. Display usage before billing decisions, avoid surprise overages, and never interrupt the customer's underlying form delivery when a plan limit is reached. Provide a clearly bounded trial and self-service cancellation. Do not activate real charges as part of development verification.

The recurring support strategy is a narrow tested compatibility matrix, good setup diagnostics, recoverable integrations and useful documentation. Marketing should focus on concrete source-to-CRM workflows and ChatGPT campaign measurement. Do not claim exclusive ChatGPT support or that a new channel means an empty competitive market.

## Data handling and reliability

The capture-to-CRM path should work without centralizing complete form submissions. Native reporting stores only the identifiers, lifecycle fields, association data and amounts needed for the selected report. Customer names and contact details stay in the CRM unless a documented product requirement and customer configuration justify their use.

Enforce organization/site isolation, role-based access, encrypted provider credentials, verified webhook handling, bounded retries, idempotency, deletion and retention controls. Honor configured consent and withdrawal across browser collection and server-side forwarding. Use safe diagnostics without raw customer data or tokens. Verify export, connector revocation and recovery from provider failures. Do not place API secrets in the tracking script.

## First release and build sequence

The first complete release delivers multichannel capture, stable form handoff, native HubSpot outcomes, native ChatGPT cost reporting, source/campaign reports, health diagnostics, customer authentication, basic agency isolation and subscription administration. Do not build only a marketing page or a dashboard populated with sample rows.

Build in working slices:

1. Audit and repurpose the existing app shell and backend. Record reusable components, migrations and release blockers.
2. Deliver a complete website visit -> form -> attribution record path, including returning visitors, consent states and retry behaviour.
3. Add verified HubSpot field delivery and read-only deal/lifecycle reporting.
4. Add ChatGPT campaign/cost synchronization and reconcile its data with the captured records.
5. Finish the customer reports, diagnostics, agency permissions, billing and onboarding.
6. Run release verification with a real authorized advertiser and CRM account when available. Continue all independent implementation work if access is missing, but label unverified integrations honestly.

Later additions are more form/CRM connectors, native Google/Meta/LinkedIn spend imports, verified collected-payment reporting, configurable cross-currency reports, more attribution models and optional conversion-event feedback. Full ad creation, budget changes, creative generation and autonomous campaign optimization are outside this product's first release.

## Existing implementation to reuse

The source application is `/Users/rory/Documents/ChatGPT/MaintainFlow - Ads`. A clean local copy has been prepared at `/Users/rory/Documents/Ideation/maintaincode-ads`, preserving its commit history. The copy has no Git remote configured. Work in the copy for this task.

The previous read-only inspection found reusable server-side account credentials, Ads API transport, reporting adapters and account snapshots. The existing attribution-readiness module checks URL configuration; it is not a visitor collector. Existing conversion submission is validate-only. The inspected code did not contain the required form-to-CRM handoff, native CRM outcome connector or sales attribution pipeline.

Recheck those findings against the new task's exact checkout. Retain the established Next.js architecture where appropriate and read the repository's AGENTS.md and version-specific local framework documentation. Preserve useful authentication, billing, tenant isolation, logging and test infrastructure if it is actually present. Replace the ad-operations product surface with the attribution workflow. Do not carry legacy budget-control actions into the default new customer flow.

## Acceptance criteria

- A new user can complete the supported onboarding path and inspect a real test lead in the destination CRM.
- First source survives ordinary navigation and a later direct visit; latest non-direct source follows its documented rule.
- Paid ChatGPT, organic AI referral and ambiguous traffic remain distinguishable.
- Retried submissions, multiple deal contacts and reopened deals do not inflate lead or revenue totals.
- Reports reconcile to source records, distinguish booked from collected revenue and withhold unsupported ratios.
- Connector failures and missing access produce useful states rather than fabricated data or success messages.
- Script failures never break the customer's form submission.
- Two unrelated workspaces cannot read, write or export each other's data.
- All implemented flows pass meaningful automated checks and browser verification, including responsive layouts, keyboard navigation, loading/error/empty states and the core customer journey.
- Production readiness is evidenced separately for local code, backend/database migrations, deployment, provider access, payment behaviour and external customer use.

## Primary references

The Attributer reference establishes the source-capture and hidden-field workflow; this brief is our own proposed implementation and scope. [Attributer workflow](https://attributer.io/how-it-works), [integration catalogue](https://attributer.io/integrations), [pricing](https://attributer.io/pricing).

OpenAI documents account-scoped Ads authentication, reporting and conversion measurement. Recheck current capability availability during implementation. [Ads API overview](https://developers.openai.com/ads/api-overview), [insights](https://developers.openai.com/ads/api-reference/insights), [measurement pixel](https://developers.openai.com/ads/measurement-pixel), [Conversions API](https://developers.openai.com/ads/conversions-api).

Existing vendor coverage confirms that ChatGPT ad measurement is not an exclusive feature. [Attribution's ChatGPT integration](https://docs.attributionapp.com/docs/chatgpt).
