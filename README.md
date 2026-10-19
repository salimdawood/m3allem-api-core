# M3allem API

The database schema is defined in [schema.sql](database/schema.sql), using numeric IDs and soft deletion for every resource. Prisma, HTTP feature modules and reminder/push workers have been aligned. See [backend alignment](docs/archive/BACKEND_ALIGNMENT.md) for the current contract and remaining work, and [schema deployment](docs/DEPLOYMENT.md) before database changes.

Express and PostgreSQL API for the Android app. [API.md](docs/API.md), [openapi.yaml](openapi.yaml) and the [Postman guide](postman/README.md) describe the implemented numeric-ID contract. The Android client is not included in this workspace; its payloads still need reconciliation in its repository.

See [code readiness](docs/CODE_READINESS.md) for local verification and remaining work. Run `npm test` with the dedicated local test PostgreSQL instance running, or `npm run test:runtime` for database-free runtime checks.

## Project layout

| Folder | Contents |
| --- | --- |
| `src/` | API modules, middleware, configuration and background jobs |
| `tests/` | Runtime and isolated database integration tests |
| `database/` | Authoritative SQL, preflight, validation and archived legacy SQL |
| `prisma/` | ORM model mappings for client generation only |
| `scripts/` | Active schema, seed, storage and documentation commands |
| `docs/` | API reference, deployment, seed and readiness guides; historical reports in `docs/archive/` |
| `postman/` | Shareable collection, environments and Android guide |

Ignored local state: `.env` is the active configuration; `.seed-data/` contains fixture evidence; `.schema-validation/` holds the local test PostgreSQL cluster; `.archive/` preserves retired environment backups and one-off tools. See [cleanup notes](docs/CLEANUP.md).

## Run locally

1. Install Node.js 20+ and PostgreSQL 15+ with `citext`, `pg_trgm`, and `btree_gist` available. Validation currently uses PostgreSQL 17.4.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `JWT_ACCESS_SECRET`, and `OTP_HMAC_SECRET`. Staging defaults to fixed OTP `111111`.
3. Install dependencies with `npm install`.
4. Run `npm run db:preflight` to inspect the target. For an empty database, `npm run db:migrate` applies the finalized SQL atomically, including catalog seeds. Set `PSQL_BIN` to the psql executable if it is not on PATH.
5. Generate Prisma Client with `npm run db:generate`.
6. Start the API with `npm run dev`.

The API listens on port 3000 by default; the current local `.env` selects port 3001. The app API base path is `/v1`; liveness and readiness are `/health/live` and `/health/ready`.

## Development database and seed

Production branch `production`, database `neondb`, was explicitly reset on October 17 and rebuilt with the finalized numeric-ID schema and large synthetic seed. The pre-reset snapshot is `snap-lively-lab-b5rnjxa7`. The local API configuration selects production database/storage while retaining staging OTP `111111`, `DELIVERY_MODE=mock` and disabled push processing. Previous environment configurations are archived in ignored `.archive/environments/`. See [PRODUCTION_RESET.md](docs/archive/PRODUCTION_RESET.md) for historical verification artifacts.

For now, `production` is the only Neon branch: database `neondb`, public bucket `seed-public-profiles`, and private bucket `seed-private-identities`. The app remains in staging/mock mode for testing. The older branch `dev-schema-seed-20261016` was deleted on October 19, 2026; its historical local seed configuration no longer points to an existing branch. See [SEEDING.md](docs/SEEDING.md) for the dataset and staging accounts.

```bash
# Another empty development database, using an explicit seed environment:
npm run db:seed -- --env-file .env.new-seed --bootstrap --size large
```

The large preset creates 5,000 accounts, 500 workers, 10,000 requests and 50,000 messages plus related resources. The ordinary development seed requires an empty application dataset, uses numeric generated IDs and ordinary schema checks, and refuses reruns. It never resets retained data. Development artifacts are in ignored `.seed-data/`; production reset artifacts and actual IDs are separately inventoried in `.seed-data/production/`. Each target has its own private document bucket and 649 synthetic PDF fixtures. Login normally with staging OTPs; the seed creates no tokens or auth bypass.

`DELIVERY_MODE=mock` simulates SMS, email and Firebase without provider credentials. Mock logs omit recipients, OTPs and message payloads; simulated push acknowledgements have `mock:` IDs. Push processing is independently controlled by `PUSH_DELIVERY_ENABLED` and remains off locally; set it to `true` to exercise mock queue processing with a newly registered test device. Staging login still uses `111111`. Mock mode is rejected in production. Set `DELIVERY_MODE=live` and provide deployment credentials through environment variables when ready to test real providers.

Run `npm run test:delivery-providers` for credential-free adapter checks. With the active connection, `npm run test:seed-api` runs the HTTP/storage smoke journey against `production`; `npm run test:production-seed-api` is its explicit equivalent. Storage import also selects `production`; the deleted development target is rejected. The check logs in the three seeded actors, reads existing resources, refreshes/logs out its sessions, and saves a credential-free result in the production artifact directory. The [Postman guide](postman/README.md) provides current account setup and Android instructions.

## Endpoint groups

- OTP authentication, registration, recovery, refresh, logout, and account phone/email changes.
- User profiles, catalog and banners, worker search and management, favorites, settings, and contact history.
- Identity uploads and verification admin review, conversations and messages, service requests, reviews, notifications, and device registration.
- Authenticated WebSocket events and server-side appointment reminders.

Live OTP delivery uses AWS SNS for SMS and SES for email. Uploads use S3-compatible storage, with separate public avatar and private identity buckets, checksums and encryption. Isolated validation substitutes storage and push adapters; real Firebase delivery and SMS/email operations remain mocked pending environment credentials. The API uses the AWS default credential chain and Firebase application-default credentials when explicit credentials are not set. The old Prisma UUID migration is retained as history; the authorized production reset replaced its records rather than migrating them.

Reminder jobs materialize the SQL schedule into inbox notifications. SQL enqueues device deliveries. Set `PUSH_DELIVERY_ENABLED=true` to run Firebase delivery; false leaves jobs queued without claiming or marking them sent. If absent, it defaults to enabled only in production; `.env.example` explicitly disables it. Firebase credentials are checked before claiming jobs. Claims have finite leases, fenced acknowledgements and bounded retries. Delivery is at least once: clients must deduplicate by `notificationId`. Shutdown stops new work and drains active jobs before closing the database, subject to `SHUTDOWN_TIMEOUT_MS` (default 60000).

Admin verification routes require an account whose `is_admin` flag was provisioned through a trusted database or operations process; the public API does not grant admin access.

The WebSocket at `/v1/realtime` expects `Authorization: Bearer <accessToken>` during the upgrade handshake. Tokens in query strings are rejected.

## Database development commands

Prisma generates the client; SQL owns schema changes. Do not run `prisma db push` or `prisma migrate` against the finalized schema: Prisma cannot reproduce its checks, triggers, partial indexes and exclusion constraints. The old UUID SQL is historical reference in `database/archive/`; there is no active Prisma migration/reset workflow.

```bash
npm run db:generate
npm run db:preflight
```

For isolated auth/account validation, start the dedicated local PostgreSQL test instance on `127.0.0.1:55436` with role `schema_test`, then run:

```bash
npm run test:auth-account
npm run test:worker-catalog
npm run test:upload-verification
npm run test:interactions
npm run test:delivery-workers
```

Each suite creates a uniquely named local database and synthetic fixtures. It ignores `.env` connection settings and leaves the database for inspection. Set `POSTGRES_BIN` if PostgreSQL binaries are elsewhere. Retired reset entry points have been removed. `db:seed` now runs the guarded development seed against its separate explicit environment; catalog English seeds are included in the SQL bootstrap.

## API documentation and Postman

The generated references cover all 84 HTTP operations, including challenge/session authentication, numeric IDs, typed targets, request versions, and supported deletion/restoration. Request definitions use current route validators; response schemas and lifecycle descriptions live in `scripts/api-contract.js`. SQL owns domain rules. Regenerate all artifacts together and check route coverage/examples/scripts without connecting to the database:

```bash
npm run docs:generate
npm run docs:check
```

Postman captures OTP challenges, token pairs and numeric response IDs. No account IDs or refresh tokens are seeded. Configure dedicated local accounts and obtain admin authority through trusted operations. The collection contains alternative lifecycle branches; use the ordered journeys in [postman/README.md](postman/README.md) instead of running the entire collection as one scenario. Notification/contact-history reads currently use ISO timestamps, while most other DTOs use epoch milliseconds; see API.md for exact schemas.

The existing regeneration command also updates all artifacts:

```bash
npm run postman:generate
```
