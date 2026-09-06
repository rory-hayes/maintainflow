# Runtime database role

MaintainFlow production uses a dedicated `maintainflow_app` login through the
Supabase transaction pooler on port `6543`. This is an application credential,
not the `postgres` migration credential and not a Supabase browser, `anon`, or
`service_role` key.

## Security boundary

The runtime role is `LOGIN NOINHERIT BYPASSRLS` with a connection limit of ten,
no superuser, database-create, role-create, or replication capability, and a
fixed `search_path=pg_catalog,public`. `BYPASSRLS` is deliberate: migrations
`018` through `022` keep all 20 application tables behind RLS with zero
policies so the Supabase Data API remains deny-all, while authorization for the
server-only application connection is enforced by Clerk identity,
organization/account lookups, transaction-scoped authorization checks, and
these exact SQL grants.

The role also enforces `statement_timeout=20s`, `lock_timeout=18s`, and
`idle_in_transaction_session_timeout=30s`. These are role defaults rather than
session `SET` commands because Supavisor transaction mode does not preserve
session-level timeout configuration; the 30-second idle-transaction bound
still permits the current 15-second provider-send fence to finish or fail.

`maintainflow_app` owns no application table. Supabase automatically retains
the hosted `postgres` role as an admin member of a role it creates, with
inheritance and `SET ROLE` disabled; provisioning accepts only that exact
platform-required admin link and rejects every other role membership. This lets
the operator rotate the login without letting the administrative session
silently present itself as the runtime role.

The platform Data API must also be disabled at the project level. That switch
and those migrations are independent controls: the project setting removes the
HTTP surface, while database RLS and privilege revocations remain the fallback
if the setting drifts.

## Exact table privileges

Every persistent privilege not shown is revoked. The role has `CONNECT` on
database `postgres`, `USAGE` on schema `public`, and the following table
actions:

| Table | Select | Insert | Update | Delete |
| --- | --- | --- | --- | --- |
| `ads_approval_records` | Yes | Yes | Lifecycle fields only | No |
| `maintainflow_change_approval_requests` | Yes | Packet fields only | Decision, retirement, and execution-link fields only | No |
| `maintainflow_approval_notification_deliveries` | Yes | Request, event, and recipient identity only | Delivery lifecycle fields only | No |
| `maintainflow_organizations` | Yes | Yes | Lock key only | No |
| `maintainflow_organization_memberships` | Yes | Yes | Lock key only | No |
| `maintainflow_advertiser_accounts` | Yes | Yes | Yes | No |
| `maintainflow_account_access` | Yes | Yes | Lock key only | No |
| `maintainflow_advertiser_credentials` | Yes | Yes | Yes | No |
| `maintainflow_creative_review_state` | Yes | Yes | Yes | No |
| `maintainflow_creative_review_events` | Yes | Yes | No | No |
| `maintainflow_rate_limit_buckets` | Yes | Yes | Yes | Yes |
| `maintainflow_recommendation_dismissals` | Yes | Yes | Yes | No |
| `maintainflow_conversion_credentials` | Yes | Yes | Yes | No |
| `maintainflow_readiness_audit_runs` | Yes | Yes | No | No |
| `maintainflow_live_workbench_snapshots` | Yes | Yes | Yes | Yes |
| `maintainflow_ads_config_integrity_state` | Yes | Yes | Confirmed baseline fields only | No |
| `maintainflow_ads_config_integrity_events` | Yes | Yes | Review fields only | No |
| `maintainflow_customer_lifecycle_records` | Yes | No | No | No |
| `maintainflow_monitoring_account_schedule` | Yes | Yes | Yes | No |
| `maintainflow_schema_migrations` | Yes | No | No | No |

That is exactly 20 `SELECT`, 16 table-level `INSERT`, 2 column-limited `INSERT`,
8 table-level `UPDATE`, 8 column-limited `UPDATE`, and 2 `DELETE` grants. The
approval-request insert grant excludes every database-owned lifecycle field;
its update grant is limited to status, decision actor/note/time, optimistic
version, `updated_at`, one-way retirement, and the live-execution link. The
reviewed account, requester, request, rollback, evidence, safeguard, and
fingerprint columns are immutable after insert. The approval-record update grant
likewise excludes the reviewed identity and payload columns. Three single-key
authorization-table update grants exist only so `SELECT ... FOR UPDATE` can lock
the exact organization, membership, and account-access rows; migration `020`
guards reject any material change through those grants.

The integrity-state update grant is limited to `projection_version`,
`snapshot_fingerprint`, `snapshot_payload`, `snapshot_resource_count`,
`observed_at`, and `updated_at`; the account identity and creation time remain
outside runtime update authority.
The role has no sequence or function privileges, and `postgres` default
privileges grant it nothing on future tables, sequences, or functions. Runtime
readiness also rejects an expected table if RLS is disabled. A new migration
therefore cannot silently expand runtime access; its required action must be
separately reviewed and granted.

PostgreSQL grants `TEMPORARY` database access to `PUBLIC` by default, so the
runtime role can create session-local temporary tables even though it cannot
create persistent database or schema objects. This ambient capability is
accepted for the managed PostgreSQL deployment rather than globally revoking it
from every provider role; the connection cap and database resource controls
remain the denial-of-service boundary. Readiness still rejects every persistent
table, column, schema, role, function, sequence, ownership, `MAINTAIN`,
`TRUNCATE`, `REFERENCES`, and `TRIGGER` privilege outside the matrix.

## Credential and operator separation

Store the transaction-pooler URL only as the Sensitive `DATABASE_URL` runtime
secret. It must contain exactly one `sslmode=verify-full` parameter. Store the
official Supabase server root as the separate Sensitive
`MAINTAINFLOW_DATABASE_CA_CERT` value; the client validates one current,
self-signed CA and supplies it with `rejectUnauthorized: true`, preserving both
chain and hostname verification.

For Supabase's shared transaction pooler on port `6543`, the URL login must be
project-qualified as `maintainflow_app.<project-ref>`; a bare
`maintainflow_app` username is valid only for a direct PostgreSQL endpoint and
will not authenticate through Supavisor. The database still reports
`current_user=maintainflow_app` after the pooler resolves that qualified login.

Never use `maintainflow_app` for migrations, backup/restore administration,
offboarding, retention purges, private-beta agency member provisioning,
privilege changes, or credential rotation. Those jobs intentionally require
short-lived operator credentials with only the additional capability needed for
that run. Keep operator URLs out of Vercel's application environment and inject
them from the operator secret manager. The agency member command explicitly
refuses `current_user=maintainflow_app`; do not widen the runtime table grants to
bypass that boundary. Follow the exact
[private-beta provisioning runbook](private-beta-agency-member-provisioning.md).

Rotate the runtime password through a controlled server-side session, verify a
real `select current_user` through the transaction pooler, verify this complete
privilege matrix, then write the replacement URL through secret-manager stdin
and redeploy. Never put the password or full URL in Git, command arguments,
shell history, logs, tickets, or chat.

The reviewed, password-free role and grant artifact is
[`scripts/database/maintainflow-runtime-role.sql`](../scripts/database/maintainflow-runtime-role.sql).
Run it as the database owner after migrations, provision the password through a
separate secret-bearing session, and then require the runtime-role readiness
check to pass. Keeping this outside `docs/database/` prevents cluster-level role
configuration from being mistaken for an immutable application migration.

## Release evidence

Before promotion, record non-secret evidence that:

1. the connection reports `current_user=maintainflow_app` and the expected
   database;
2. the role flags and membership boundary match this document;
3. every table/action result matches the matrix and there are no unexpected
   public tables;
4. all 22 migration ledger names and checksums match the deployed revision;
5. strict TLS succeeds through the transaction pooler using the configured CA;
6. the role's `rolconfig` and effective settings expose all three timeout
   bounds through a fresh pooler connection;
7. unauthenticated readiness is rejected and authenticated readiness commits
   its isolated driver transaction and passes for the exact deployed SHA; and
8. the Supabase project Data API schema list is empty.

Counts or a successful local test are not substitutes for the hosted role,
connection, deployment, and project-setting evidence.
