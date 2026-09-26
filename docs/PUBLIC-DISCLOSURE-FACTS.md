# Public disclosure completion facts

This is a technical fact sheet for backlog L22, not a published privacy notice, service contract or legal approval. It prevents missing operator facts from being silently invented while policies are prepared.

## Confirmed operator decisions — 26 September continuation

The operator confirmed **Rory Hayes**, no current VAT registration and no discretionary refunds. Application wording preserves cancellation/refund rights required by applicable law; an absolute “no refunds under any circumstances” statement is not used. Existing configured support/privacy contact is `roryh1@gmail.com`. The operator has no business postal address to supply yet and will provide a support telephone number later; these disclosures remain unfinished. Inbox monitoring and delivery have not been inferred from the configured address.

The selected monthly offer is free/50 pages, Standard €19/300 and Team €49/1,000, with shared monthly AI-helper allowances 3/5/20 and explicit UTC calendar-month reset. Payment, provider and complete legal-policy activation remain separate from those choices. See [CCPC digital-service obligations](https://www.ccpc.ie/information-for-businesses/selling-goods-and-services/selling-digital-content-or-services/) for mandatory rights; the operator's chosen discretionary policy does not override them.

## Current public configuration

Read from the canonical site's public `/api/config` on 26 September 2026. The site reports private preview, required invitations, available password recovery and required signup verification. Public-service configuration is **partial**.

| Field | Observed status | Remaining work |
| --- | --- | --- |
| Operator identity | Configured | Confirm that the configured individual/entity is the intended contracting service operator. |
| Support and privacy contact | Configured | Confirm actual monitored handling, response ownership and escalation. A configured address is not inbox acceptance. |
| Full privacy notice URL | Missing | Supply the approved full notice; the current technical notes must not link back to themselves as completion. |
| Full service terms URL | Missing | Supply approved terms covering the actual paid service, cancellation and service limits. |
| Subprocessor disclosure URL | Missing | Confirm current providers, roles and applicable account/service arrangements before publishing. |
| Retention notice | Missing | Decide and disclose actual live-document, backup, operational-record and provider-copy periods. |
| Processing-location/transfer notice | Missing | Verify actual account regions and provider processing arrangements; do not infer all processing locations from the storage region. |

No configuration values were changed. The exact settings and validation rules are in [the operator runbook](OPERATIONS-RUNBOOK.md) and `server/core/installation.ts`.

## Application behaviour already available to the policy author

- Existing accounts, sessions, workspace membership/roles, parser configuration, private originals, extraction results, raw values, corrections, approvals, exports, integration configuration, usage and audit records form the application's stored data. [Architecture](ARCHITECTURE.md).
- The hosted application uses its existing PostgreSQL/private-original architecture. Private access controls and a working read/write route do not prove disaster recovery. Current hosted capture, off-host schedules and recovery remain pending. [Backup contract](BACKUP-RESTORE.md).
- Bank extraction sends document content to the configured AI provider, including native statements. Missing or uncertain values require review; a balanced reconciliation is not a guarantee of correct extraction. [Bank contract](BANK-STATEMENTS.md).
- Account and invitation mail, incoming email, Sheets writes and webhook deliveries are separate integrations with their own configuration, destinations and delivery evidence. Describe only the integrations actually offered at activation. [Account recovery](ACCOUNT-RECOVERY.md), [invitation mail](INVITATION-EMAIL.md), [webhooks](WEBHOOK-EVENTS.md).
- Retention removes the documented application records and queues retryable original deletion. Minimal usage/audit/tombstone records have separate lifecycles. A retained PDF/TIFF/ZIP original can still contain omitted pages or deleted-child bytes while another child references the bundle. [Retention contract](NOTIFICATIONS-RETENTION.md).
- Downloaded files, copies sent to a customer's chosen destination and previous backups do not disappear when a live document is deleted. Do not promise one universal deletion deadline.
- Bank CSV/XLSX downloads contain reviewed transactions with statement/account/currency references and approved-revision identity. They are not implemented QuickBooks/Xero/OFX/QBO imports. [Bank contract](BANK-STATEMENTS.md).
- Payment configuration distinguishes mock, test and live. The current service is still mocked. Final price, tax treatment, cancellation terms and production activation must be deliberate; controlled tests are not payment evidence. [Billing acceptance](BILLING-LAUNCH-ACCEPTANCE.md).

## Facts still needed before publication

Record the intended operator/contact ownership; actual hosting and processing locations; final provider inventory and contractual arrangements; selected retention and backup periods; support/privacy-request handling; approved service/payment/cancellation conditions; and any policy review required for the intended market. Customer-controller/processor responsibilities and legal bases must come from the operator's actual service arrangements, not guesses made from code.

## Acceptance

After approval, configure the five missing public fields with the final information. Check the public configuration and rendered privacy/terms links on desktop/mobile, including reachable HTTPS destinations and accurate limits. Verify support/privacy inbox handling separately. Keep `legalReviewVerified` and production activation status unverified unless independent evidence actually establishes them; filling fields alone does not.
