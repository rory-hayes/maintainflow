# Isolated Supabase database setup

Folio uses its own PostgreSQL schema and two restricted runtime roles. Existing MaintainFlow tables, roles, and Data API configuration stay outside the migration scope. Folio continues to use its own password/session authentication; Supabase Auth and browser database keys are not used.

## Runtime configuration

| Variable | Hosted value or purpose |
| --- | --- |
| `DATABASE_SCHEMA` | `folio`; lower-case SQL identifier, no commas, quoting, or reserved system schemas |
| `DATABASE_ADMIN_URL` | Connection URL for the new `folio_admin` backend role |
| `DATABASE_URL` | Connection URL for the new `folio_app` tenant role |
| `DATABASE_CA_CERT` | Supabase CA PEM, with real newlines or escaped `\n` |
| `DATABASE_POOL_MAX` | Small per-process limit; default is 1 for an isolated schema |
| `DATABASE_ADMIN_ROLE` | Migration role name override; defaults to `folio_admin` |
| `DATABASE_APP_ROLE` | Migration role name override; defaults to `folio_app` |
| `DATABASE_MIGRATION_URL` | Separate migration identity, used only for a deliberate migration run; never needed by the hosted runtime |

The verified shared transaction pooler for this project is `aws-0-eu-central-1.pooler.supabase.com:6543/postgres`. Its usernames are `folio_admin.dhbevbimoajwkuzcunwz` and `folio_app.dhbevbimoajwkuzcunwz`. Passwords must be URL encoded. Both roles use the same database and private `folio` schema.

Remote connections always verify TLS certificates. URL SSL options cannot downgrade `rejectUnauthorized: true`. The project CA is supplied through `DATABASE_CA_CERT`; do not use `sslmode=no-verify` or disable certificate verification.

## Bootstrap through SQL Editor

1. Review existing schemas and roles first. The bootstrap refuses to modify an existing `folio` schema or either runtime role. It also refuses runtime roles with inherited access to tables in `public`, `auth`, or `storage`, or access to executable `SECURITY DEFINER` functions there. Those functions can indirectly expose legacy tables using their owner's privileges. PostgreSQL has no per-role deny that can override a `PUBLIC` grant; review that condition separately instead of revoking legacy access automatically.
2. Generate distinct random URL-safe passwords locally, using at least 32 random bytes each. Keep them in an ignored private file with mode `0600`.
3. Generate the reviewable SQL template without a database connection:

   ```sh
   DATABASE_SCHEMA=folio node --import tsx scripts/migrate.ts --sql > /private/tmp/folio-bootstrap-template.sql
   ```

4. Replace the two `__FOLIO_*_SCRAM_VERIFIER__` placeholders locally with the output of the exported `scramVerifier(password)` helper. The helper accepts generated URL-safe ASCII passwords and creates PostgreSQL SCRAM-SHA-256 verifiers. Keep the filled SQL file private with mode `0600`; verifiers are sensitive even though the SQL does not contain plaintext passwords. Do not commit it or upload it as evidence.
5. Review and run the filled payload in the existing project's SQL Editor as its migration owner. One transaction creates the new roles/schema, applies all migrations, verifies RLS, and grants access only inside the selected schema. Failure rolls the complete operation back.
6. Configure the private runtime URLs and CA, then verify the actual application connection and tenant isolation. SQL Editor success alone does not prove pooler authentication or runtime behavior.

The backend role is `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`. It receives explicit backend policies on Folio RLS tables so authentication, worker claims, and cross-workspace maintenance can operate. It cannot create schema objects or edit the append-only document journal. The tenant role can access only the tenant tables granted by migrations, under transaction-local workspace RLS. Neither runtime role owns application objects or can modify the migration ledger.

The migration owner remains separate from both runtime roles. For future changes, generate `--sql --existing` for SQL Editor, or run `npm run db:migrate` with a separately authorized `DATABASE_MIGRATION_URL`. Do not put that migration credential in the runtime deployment. Migration replay uses the schema-local ledger and a transaction advisory lock. Default local installs continue to use `public` and their existing administrator setup.

## Pooling and schema guarantees

The private-schema pool wrapper covers both direct `pool.query()` calls and checked-out clients. Each standalone statement runs in its own transaction. Explicit transactions set `search_path`, `statement_timeout=10000`, and `lock_timeout=5000` immediately after `BEGIN`. Tenant context uses `SET LOCAL` in that same transaction. This works with transaction pooling without relying on session state or asynchronous connection hooks. Releasing an unfinished transaction destroys its connection; named prepared statements are rejected. Migrations use a separate raw connection without runtime statement timeouts.

All application paths resolve against `folio,pg_catalog,pg_temp`; the document journal trigger derives its target schema from the table that fired it. Migrations grant only within the selected schema and remove default Data API roles' access there. Do not add `folio` to the project's exposed Data API schemas or change existing public-schema API configuration.

Storage is a separate deployment concern. A private Storage bucket and server-only access credentials do not require exposing the Folio database schema. Object access must still be authorized by the API against the current workspace before returning a signed URL.

## Local regression check

Run against a disposable local database whose administrator can create temporary test roles:

```sh
PGHOST=/path/to/local/socket PGPORT=55432 PGDATABASE=folio_hosted_qa \
  node --import tsx --test --test-concurrency=1 tests/database-schema.test.ts
```

The test creates uniquely named roles, an isolated schema, and a public sentinel table; it removes only those owned resources afterward. It covers fresh/replayed migrations, legacy isolation, backend/tenant RLS, transaction pooling boundaries, bounded timeouts, trigger schema selection, and abandoned transaction rollback.

References: [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres), [PostgreSQL roles](https://supabase.com/docs/guides/database/postgres/roles), and [Data API security](https://supabase.com/docs/guides/api/securing-your-api).
