# Privacy and offboarding gate

MaintainFlow must not run any production stage, including `demo`, without an
identified legal entity and monitored privacy and support contacts. The
executable production configuration gate requires:

- `MAINTAINFLOW_LEGAL_ENTITY_NAME`;
- `MAINTAINFLOW_PRIVACY_CONTACT_EMAIL`;
- `MAINTAINFLOW_SUPPORT_CONTACT_EMAIL`.

The public privacy and private-beta terms pages describe only behavior that is
implemented or explicitly constrained. They are an operational baseline, not a
replacement for Irish/EU legal review or a signed customer pilot agreement.

Before a public readiness fetch, the quota layer derives independent
HMAC-SHA-256 identifiers from the source IP address and target hostname. The
quota table stores those derived identifiers, counts, and hourly window times,
not the raw IP address or hostname. Its bounded daily cleanup targets buckets
older than 48 hours and surfaces a cleanup backlog or failure for operator
retry.

## Live-pilot admission checklist

Before connecting an advertiser account, record the customer controller/contact,
processor list, transfer mechanism where applicable, retention schedule,
support route, breach-notification route, and the authorized people who may
request export or deletion. Confirm whether readiness URLs, advertising data,
approval evidence, and monitoring records contain personal or commercially
sensitive information for that customer.

## Current offboarding boundary

Self-service deletion is not implemented. Until it is, every private pilot must
use a reviewed manual runbook that:

1. verifies the requesting customer and affected organizations/accounts;
2. removes Clerk and database access before handling stored data;
3. exports only the customer-scoped records the agreement requires;
4. revokes active Ads and Conversions ciphertext versions and instructs the
   customer to revoke the source credentials in Ads Manager;
5. deletes or retains account-scoped live workbench snapshots and refresh
   metadata, approval, monitoring, creative, decision, readiness, and credential
   records according to the signed schedule;
6. records the operator, exact scope, completion time, exceptions, and restore
   or backup-expiry implications.

Run the procedure on a disposable customer fixture and verify the export,
authorization revocation, deletion scope, backup expiry, and audit evidence
before treating offboarding as production-proven. Broader self-service release
remains blocked until this lifecycle is automated and independently tested.
