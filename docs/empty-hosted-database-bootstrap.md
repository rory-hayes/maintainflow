# One-time empty hosted database bootstrap

Use this workflow only for the first initialization of a new hosted PostgreSQL
database whose `public` schema is confirmed empty. It exists because there is no
customer state to back up before the first table is created; every later hosted
migration must use the backup/restore-gated `npm run db:migrate` workflow.

The generated SQL is not a general migration shortcut. Its first transaction
step takes the same application advisory lock as the migration runner and
refuses to continue if the `public` schema contains any relation, function,
type, operator family, collation, conversion, extended statistic, or text-search
object. It then applies the complete immutable migration set and records every
exact SHA-256 checksum in
`public.maintainflow_schema_migrations`. Any failure rolls back the complete
transaction.

## Generate the reviewed SQL artifact

Use a new absolute path outside the repository from the exact clean Git
revision approved for deployment. The generator refuses an existing path,
refuses a dirty or mismatched checkout, verifies every migration against the
compiled runtime manifest, and creates the file with mode `0600`:

```bash
npm run db:bootstrap:empty:sql -- \
  --output /restricted/evidence/maintainflow-empty-bootstrap.sql \
  --expected-build-sha <full-approved-git-sha>
```

Review the generated header, pristine-schema guard, ordered migration names,
and final `commit`. Record the SHA-256 printed by the generator. Do not edit the
generated SQL: the ledger records the approved migration-file checksums, so an
edited SQL payload could otherwise claim checksums for statements that were not
actually executed.

## Apply through the hosted provider

1. Confirm the intended provider project and region in the provider dashboard.
2. Confirm the `public` schema shows no application objects or customer data.
3. Open the provider's authenticated SQL editor for that exact project.
4. Load the complete generated artifact without editing it. Immediately before
   running, hash the exact editor contents and require an exact match with the
   recorded artifact SHA-256.
5. Run the verified editor contents once.
6. Retain the artifact SHA-256, provider query/job reference, and UTC completion
   time as release evidence. Do not retain database credentials in the evidence
   artifact.

If the pristine-schema exception is raised, stop. Inventory the existing
objects and use the normal backup/restore workflow; never weaken or remove the
guard to make the bootstrap run.

## Verify before deployment

The bootstrap is not complete until all three checks pass:

1. the provider shows the complete application table set and no SQL failure;
2. a read-only query confirms the migration ledger contains the exact compiled
   migration names and checksums; and
3. the deployed, authenticated `/api/ready` check returns HTTP 200 for the exact
   build revision.

On Supabase, keep the Data API disabled for this server-only database or verify
the deny-all RLS and privilege posture installed by the current migration set.
The application uses Clerk for identity and a server-only PostgreSQL pool; it
does not use the Supabase browser client or Supabase Auth.
