> Historical report. The development Neon branch was deleted on October 19, 2026. Retired environment backups now live in ignored `.archive/environments/`; one-time reset scripts and compatibility entry points have been removed. For current commands, use [README](../../README.md), [deployment](../DEPLOYMENT.md) and [seeding](../SEEDING.md).

# Authorized production reset, October 17, 2026

The user requested erasing the legacy production database and replacing it with the finalized numeric-ID schema and the large synthetic seed. This is a reset, not a migration preserving the previous records.

Target: project `orange-king-42207744`, branch `production` (`br-plain-glade-b50xod5j`), database `neondb`. The direct connection is held in ignored `.env.production-reset`; credentials are not stored here.

The pre-reset Neon snapshot is `snap-lively-lab-b5rnjxa7`, named `before-production-reset-20261017`. The snapshot was listed and verified before executing the reset. The original `uploads` bucket is retained; new fixture buckets are separate.

`scripts/reset-production.js` pins the exact production host/database/branch, requires `--confirm-target production/neondb`, a backup snapshot record, and staging/mock delivery settings. It refuses a rerun unless the target still has the legacy UUID schema. The ordinary development seed protections and disabled `db:reset` entry point remain in place.

The prepared SQL drops and recreates the application `public` schema, applies `schema.sql`, then runs the large seed under one transaction. Both embedded scripts' transaction boundaries are removed; any SQL failure before the final commit rolls back the schema reset and seed together. Ordinary triggers and deferred constraints remain enabled.

The preset contains 5,000 users, 500 workers, 10,000 requests, 50,000 messages and 5,000 reviews, plus related resources. Legacy records are replaced. The previous six unmatched reviews are retained only in the pre-reset snapshot, rather than assigned fabricated request history.

The reset committed successfully at `2026-10-17T09:16:53.930Z`. Independent verification on PostgreSQL 18.6 found all 29 application tables, BIGINT user IDs and the expected row counts, with no pending/processing/sent synthetic deliveries. All 649 production PDFs were uploaded and checksum verified; anonymous downloads returned 403 and signed downloads succeeded. All nine production HTTP smoke checks passed. The local API was restarted on port 3001 using this production database and storage.

Ignored `.seed-data/production/` contains the backup record, operation plan and SQL hashes, reset SQL/log, actual-ID manifest, synthetic PDFs and API smoke results. `manifest.json` with `successful: true` records the committed reset and verified row counts. `storageState: UPLOADED_AND_CHECKSUM_VERIFIED` records verified storage import. `api-smoke-result.json` records the HTTP journey outcome.

Storage verification uses `node --env-file=.env.production-seeded scripts/import-seed-storage.js --target production`. API verification uses `node --env-file=.env.production-seeded scripts/smoke-seed-api.js --target production`. Both explicitly pin the production target; omitting the target flag selects development artifacts and will refuse a production connection. The HTTP check creates and revokes its own staging sessions and reads existing seeded resources.

The branch is named production, while the local application deliberately remains `NODE_ENV=development`, `APP_ENV=staging`, `DELIVERY_MODE=mock`, OTP `111111`, and `PUSH_DELIVERY_ENABLED=false`. Real provider credentials will be supplied through environment variables later. This reset does not deploy application code or update the separate Android repository.

The preceding local API configuration is backed up in ignored `.env.before-production-reset`. The separate development database `m3allem_seed_dev` remains available on `dev-schema-seed-20261016`.
