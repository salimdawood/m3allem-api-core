# Development database and large seed

Android integration belongs to the other developer and comes after database/backend work.

## Current target

Use the single Neon branch `production`, database `neondb`, with staging/mock delivery, OTP `111111` and push disabled. The development branch `dev-schema-seed-20261016` was deleted on October 19. Its old environment files are preserved under ignored `.archive/environments/` and must not be used as a current connection. The current seed inventory is `.seed-data/production/manifest.json`. Existing seeded data needs no reset or rerun. See the [historical reset report](archive/PRODUCTION_RESET.md).

## Run on another fresh development database

1. Create a separate empty database whose name begins `m3allem_seed_`.
2. Copy [seed.env.example](../database/deployment/seed.env.example) to a new ignored file such as `.env.new-seed`. Supply its direct URI and exact expected host/database. Keep staging and push-disabled settings.
3. Run:

```powershell
npm.cmd run db:seed -- --env-file .env.new-seed --bootstrap --size large
```

For a schema already bootstrapped with **zero accounts**, omit `--bootstrap`. Use `--env-file <path>` for another explicit seed environment. `--size small` uses 100 accounts, 20 workers, 200 requests and 1,000 messages. `--size large` uses 5,000 accounts, 500 workers, 10,000 requests and 50,000 messages. `--output` changes the local artifact directory inside the workspace.

The seed never falls back to `DATABASE_URL`, never reads production `.env`, requires exact target matching, and refuses an occupied database or rerun. A rerun should use another fresh database; it never deletes existing resources, resets identities, truncates tables or disables triggers. The obsolete reset command and Prisma seed compatibility entry point have been removed.

The bootstrap and seed are separate transactions. A seed error rolls back application data while retaining the installed schema and consumed sequence values. Retry without `--bootstrap` if there are still zero accounts. IDs can have gaps; mappings come from returned numeric identities. All eight phases run through ordinary schema constraints, including deferred checks. The last phase commits, then updates planner statistics with ANALYZE.

## Dataset

- Accounts across ten Lebanese cities, separate private/public profile fields and independent admin/worker capability. No real contact details are imported; emails use `example.test`. Generated Lebanese-format phone numbers are synthetic fixtures, **not verified unassigned phone numbers**. Use staging fixed-code login; never send SMS to them.
- All six catalog categories and fourteen worker types in English/French/Arabic, ordered type memberships, services with priced/free/quote-required variants, USD/LBP and all supported units, discounts, split and overnight schedules.
- Verified profiles plus superseded, pending, rejected and deleted identity submissions, hidden/unavailable/deleted workers, suspended/deleted accounts.
- Requests with all five statuses, valid actor transitions, SQL-created versions/events/history/reminders, completed-request reviews and database-maintained rating aggregates. Completed seeded requests are unscheduled; future appointments belong to other status examples. Immutable creation/status times are actual seed-operation times, not forged historical timestamps.
- Conversations with messages from both original participants, numeric sequences, tombstones, favorites, call/WhatsApp history, read/unread typed inbox notifications and retained delivery metadata.
- Pending and failed upload examples; ready identity rows match generated local PDF bytes/checksums. No pre-issued OTPs, sessions, refresh tokens or bearer tokens. Those security tables populate through normal authentication.

The seed inserts initial request/verification/review/message inbox notifications, while SQL creates the related events, history, reminder schedules and delivery rows. It does not fabricate notification delivery success. Synthetic device bindings and deliveries are retired before commit, preventing accidental Firebase attempts and preserving their metadata. Register a real device through the API to test actual delivery later.

## Accounts and Postman

| Purpose | Staging login phone |
| --- | --- |
| Customer | `+96170000001` |
| Worker (public verified profile) | `+96170000002` |
| Admin | `+96170000003` |

The admin is provisioned by this trusted development seed only. Production signup cannot grant admin access. Send OTP then verify the exact challenge using the server's configured staging fixed code; the seed creates no authentication bypass. Phone/email changes, suspension and deletion retain normal session rules.

Import the shared collection and local environment from `postman/`. Default phones match the current synthetic seed; account IDs and tokens are captured through normal login. See the [Android/Postman guide](../postman/README.md).

## Local artifacts and storage

`.seed-data/production/manifest.json` records the target, schema hash, actual counts, account IDs and file inventory. `.seed-data/production/reset.log` contains phase output without the connection URI. These files are ignored.

Identity PDFs live under `.seed-data/production/objects/seed-private-identities/identities/`. They are visibly labeled **SYNTHETIC DEVELOPMENT SAMPLE — NOT A VALID IDENTITY DOCUMENT**, with actual SHA-256 and byte counts matching SQL. The separate storage import uploaded all 649 files into private bucket `seed-private-identities` on the current production branch. Every uploaded file was downloaded and checksum verified; anonymous access returned 403 and a signed download returned the expected bytes. Public bucket `seed-public-profiles` is configured separately for future profile uploads. Pending/failed avatar rows have no corresponding file, matching those lifecycle examples.

`npm run db:seed-storage` validates the target branch/database and the complete local inventory before writing. It verifies existing files, refuses differing content, and records successful completion in the manifest. The database seed itself still performs no object-storage writes. `npm run test:seed-api` checks health/readiness, localized catalog, three staging logins, worker discovery, request/conversation reads, admin access, a signed private download, refresh and logout. It revokes the sessions it creates; it does not change seeded domain resources.

SMS/email/Firebase currently use `DELIVERY_MODE=mock`; provider credentials are supplied through environment variables when switching to `live`. Mock push acceptance uses `mock:` IDs and does not mean handset delivery. Push processing remains disabled independently, and the original synthetic devices remain retired. Storage uses the real production-branch buckets, with synthetic fixtures.

## Existing database preflight

The October 17 read-only preflight of the original API database classified it as `LEGACY_UUID` and found six reviews without matching completed requests. The user subsequently authorized erasing that dataset and rebuilding production with the finalized schema and synthetic seed. The old records remain in the pre-reset snapshot; no historical request proof was fabricated. See [PRODUCTION_RESET.md](archive/PRODUCTION_RESET.md). The aggregate pre-reset report remains in ignored `.seed-data/original-database-preflight.txt`. Android integration remains in the separate client repository.

## Schema performance change

`validate_live_resource_links()` now compares typed primary/foreign-key columns instead of converting indexed columns to JSON. It still reads the final row and validates the same live-account/resource relationships. This allows ordinary key indexes to support large writes. Existing installed databases need a reviewed function migration; the seed bootstrap applies it only to the fresh target. The October 17 `database/validation/latest-result.json` validates the current SQL hash with all 51 schema checks passing. All 107 backend regression tests and the nine development API smoke checks also passed.
