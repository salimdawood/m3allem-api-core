# Schema deployment and validation

[`database/schema.sql`](../database/schema.sql) defines the schema. Historical UUID SQL lives in `database/archive/`, outside Prisma's migration discovery. The authorized October 17 reset applied the current schema and large synthetic seed to `production/neondb`; see [PRODUCTION_RESET.md](archive/PRODUCTION_RESET.md).

## New database

Apply `database/schema.sql` to an empty PostgreSQL 15+ database with `psql -X -v ON_ERROR_STOP=1 -f database/schema.sql`. The script includes its own transaction, extensions, tables, functions, views, constraints and catalog seed. It rejects an occupied public schema and rolls back on error. Runtime validation currently uses PostgreSQL 17.4; compatibility with PostgreSQL 15/16 has not been exercised here.

Required extensions are `citext`, `pg_trgm` and `btree_gist`. Grant the future backend access deliberately; never expose raw database access to public clients. Read public worker data through `public_worker_profiles`, ordinary resources through `active_*` views, and localized catalog data through `catalog_categories`, `catalog_worker_types` and `catalog_banners`.

## Existing database

Run `database/deployment/preflight.sql` through a read-only connection first. It reports structure and aggregate counts without exposing account data. It makes no changes. The standalone schema is **not** a migration for the old UUID database. Historical SQL is retained at `database/archive/initial-uuid-schema.sql`.

An existing-data upgrade needs stable old-to-new numeric ID maps, a mapping of category/type slugs to numeric IDs, reconciliation of duplicate user/worker fields, a storage inventory to populate upload ownership/metadata, and a treatment for historical records that fail the new rules. Reviews without completed requests must be preserved/reconciled rather than assigned fabricated requests. Existing refresh tokens need retirement because the old schema has no independent session lineage. Status history must not invent actors or timestamps for events that were never recorded. Prepare and validate that migration against the actual data on an isolated branch before a cutover.

Prisma, Express feature endpoints, reminder/push workers and API/OpenAPI/Postman references have been aligned; see [historical alignment](archive/BACKEND_ALIGNMENT.md). The client implementation is in a separate repository and still requires reconciliation and full journey validation before deployment. Legacy reset scripts have been removed; the replacement `db:seed` only accepts a separate explicit development target with no application accounts. Deploying the schema does not make existing clients compatible.

The worker phase corrected `sync_account_operational_state()` to soft delete devices during suspension, replacing a physical DELETE that conflicted with the deletion guard. For an already installed numeric schema, prepare a reviewed function migration; do not rerun the standalone bootstrap. The validation artifact records its tested SQL hash. No live database was changed during that local alignment phase.

The large-seed phase also changed `validate_live_resource_links()` to use typed key comparisons, allowing key indexes to support final-row/parent lookups. The October 17 validation artifact records the current SQL revision with all 51 schema checks passing. See [SEEDING.md](SEEDING.md) for the current single-branch seed setup, actual seed manifest and schema hash. Synthetic data is created through constraints with immutable timestamps assigned normally. The authorized production reset replaced legacy data; the data-preserving migration guidance above applies only to future retained-data upgrades.

## Soft deletion

Every application table has `deleted_at`. Use a tombstone-only update:

```sql
UPDATE worker_services SET deleted_at=clock_timestamp() WHERE id=123;
```

`DELETE` and `TRUNCATE` are blocked. There is no automatic record purge or identifier reuse for entities. Numeric IDs remain stable. Core history remains stored. New relationships cannot target deleted resources, while existing historical links remain intact when another party later leaves. Account deletion tombstones owned resources and retires sessions/devices/work queues; another party's requests and conversations remain retained.

Restore supported domain records with a separate `SET deleted_at=NULL` update. Parents and required children must also be live by transaction commit. Favorites, translations and conversations retain their unique relationship keys and are restored rather than reinserted. Accounts and security/delivery resources cannot be restored; obtain new authorization/work records instead. Deleted device tokens can be registered as new device rows. Restore does not replay old notifications or automatically restore all children.

Soft deletion is distinct from physically deleting a stored object. Upload rows use `storage_deleted_at` to record confirmed object deletion. `cleanup_after` identifies orphans for review; it does not authorize an automatic purge. Attached files cannot be tombstoned or physically deleted while live references exist. Physical storage operations still require an explicit backend/operations workflow.

## Agreed working assumptions

- A user may hire other workers and own one individual worker profile. Admin access is separate.
- Reviews require a completed request, with one live review per user/worker.
- Request details and appointment time are fixed after submission; rescheduling needs a separate workflow.
- A new verification submission replaces the current one and returns the worker to pending. Removing the newest submission does not reuse an older approval.
- Suspension is reversible; account deletion is terminal soft deletion, reserving phone/email.
- Search reads current names, services, keywords and translations. Its joined document is computed at query time, so there is no stale joined cache to refresh. This trades additional query work for consistency; production-scale performance has not been benchmarked.

## Repeatable isolated validation

Start an isolated PostgreSQL instance on `127.0.0.1:55436`, with an administrative test role named `schema_test`. Then run from the repository root:

```powershell
python database/validation/validate.py --postgres-bin 'C:/Program Files/PostgreSQL/17/bin'
```

Override host, port and user with explicit arguments if needed. The runner creates a uniquely named `m3allem_schema_test_*` database, applies the standalone schema and synthetic fixtures, then tests valid/invalid writes, restoration, retained history and concurrent operations. It never reads `.env` or `DATABASE_URL`, and does not modify an existing application database. It leaves test databases for inspection. `validation/latest-result.json` records the tested schema SHA-256, PostgreSQL version and result.

Failed OTP checks and refresh-token reuse outcomes must be committed: rolling back would undo attempt counters/revocation. Aligned modules bind actors to authenticated accounts and use SQL helpers/active views. Upload/verification and worker transactions retry deadlock/serialization failures as complete database transactions; external storage and push operations are outside those retries. Local backend suites substitute storage/push providers and exercise concrete races, not every possible production interleaving. Real bucket policies, Firebase credentials/delivery and SMS/email operations still require validation. Enable push explicitly when ready; retries can deliver duplicates, so clients must deduplicate by notification ID.
